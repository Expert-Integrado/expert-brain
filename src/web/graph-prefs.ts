import type { Env } from '../env.js';
import { requireSession } from './session.js';

// Preferências do grafo (forças, cores, anti-sobreposição etc) salvas POR DONO na
// tabela meta — sincroniza entre máquinas (PC, notebook) sem binding novo.
//
// POR SUPERFÍCIE (spec 29): Notas e Contatos têm configurações independentes —
// salvar sliders num não pode sobrescrever o outro. 'notes' fica na chave legada
// (zero migração: quem já salvou mantém tudo); 'contacts' ganha chave própria,
// com fallback de LEITURA na legada (a primeira carga herda o estado atual em
// vez de resetar os sliders). A separação notas-2D × notas-3D já existe DENTRO
// do blob (forces/visual legados = 2D; forces3d/visual3d = 3D).
export const GRAPH_PREFS_META_KEY = 'graph_prefs';
export const GRAPH_PREFS_CONTACTS_META_KEY = 'graph_prefs:contacts';

export type PrefsSurface = 'notes' | 'contacts';

function prefsKeyFor(surface: PrefsSurface): string {
  return surface === 'contacts' ? GRAPH_PREFS_CONTACTS_META_KEY : GRAPH_PREFS_META_KEY;
}

export interface GraphPrefs {
  forces: { center: number; repel: number; link: number; distance: number };
  // Aditivo (2026-07): perfil de forças PRÓPRIO do palco 3D. `forces` (nome
  // legado) segue sendo o perfil 2D. Motivação: mexer nos sliders no 3D não pode
  // destruir a config do 2D — cada palco tem física/escala própria. Prefs antigas
  // sem o campo caem nos defaults 3D calibrados (ver FORCE3D_DEFAULTS abaixo).
  forces3d: { center: number; repel: number; link: number; distance: number };
  colorMode: 'neutral' | 'domain' | 'kind' | 'degree';
  similarOpacity: number; // 0..1
  hideSimilar: boolean;
  // Legado: perfil VISUAL do palco 2D (nome mantido pra compat — era global até
  // 2026-07, agora é só o 2D). nodeSizeMult/lineSizeMult 0.3..3 / 0..3; textFadeMult
  // -3..3 (sem equivalente no 3D — rótulo só aparece no hover lá).
  nodeSizeMult: number;   // 0.3..3
  lineSizeMult: number;   // 0..3
  textFadeMult: number;   // -3..3
  // Aditivo (2026-07): perfil visual PRÓPRIO do palco 3D — mesma motivação do
  // forces3d acima (mexer no slider "Tamanho das bolinhas" no 3D não pode mudar
  // o 2D e vice-versa). textFadeMult não existe aqui (sem equivalente no 3D).
  // Prefs antigas sem o campo caem nos defaults 3D (ver VISUAL3D_DEFAULTS abaixo).
  // `glow` (spec 104): bloom/pós-processamento do palco 3D — a pref é o DESEJO do
  // dono; o efetivo ainda depende de tema escuro + desktop (guards no client).
  visual3d: { nodeSizeMult: number; lineSizeMult: number; glow: boolean };
  hideOrphans: boolean;
  noOverlap: boolean;
  // `mode` foi REMOVIDO do shape persistido (spec 29): salvar padrão estando no
  // 3D prendia o boot no 3D. O palco inicial agora é SEMPRE 2D — 3D só via
  // ?mode=3d ou toggle na sessão. Blobs antigos com `mode` são ignorados pelo
  // sanitize (campo dropado na releitura).
}

const clampNum = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
};
const asBool = (v: unknown, def = false): boolean => (typeof v === 'boolean' ? v : def);

// Defaults do perfil 3D — calibrados no repro visual (2026-07): center mais alto
// (nuvem coesa perto da origem), repel mais baixo (o mundo 3D da lib tem escala
// própria; ver o /8 em graph3d.ts) e distance moderada (links 3D longos demais
// viram poeira). MANTER EM SINCRONIA com FORCE3D_DEFAULTS do client
// (src/web/client/graph.ts) — é o mesmo número dos dois lados.
const FORCE3D_DEFAULTS = { center: 0.2, repel: 8, link: 1, distance: 150 };

// Defaults do perfil VISUAL 3D — nodeSizeMult=1, lineSizeMult=1 (mesmos defaults
// "neutros" do 2D; NÃO alteram a calibração/baseline de render do three.js, só o
// multiplicador aplicado por cima). MANTER EM SINCRONIA com VISUAL3D_DEFAULTS do
// client (src/web/client/graph.ts).
const VISUAL3D_DEFAULTS = { nodeSizeMult: 1, lineSizeMult: 1, glow: true };

// Sanitiza um objeto arbitrário (POST do cliente OU valor legado no meta) pro shape
// canônico, clampando cada campo nos MESMOS ranges dos sliders do graph.ts. Nunca
// confia no cliente — impede lixo/abuso inflando o meta. Retorna null se nem é objeto.
export function sanitizeGraphPrefs(raw: unknown): GraphPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const f = (r.forces && typeof r.forces === 'object') ? r.forces : {};
  // Aditivo: prefs antigas (sem forces3d) caem nos defaults 3D — nada quebra.
  const f3 = (r.forces3d && typeof r.forces3d === 'object') ? r.forces3d : {};
  // Aditivo: prefs antigas (sem visual3d) caem nos defaults visuais 3D.
  const v3 = (r.visual3d && typeof r.visual3d === 'object') ? r.visual3d : {};
  const mode = ['neutral', 'domain', 'kind', 'degree'].includes(r.colorMode) ? r.colorMode : 'neutral';
  return {
    forces: {
      center: clampNum(f.center, 0, 1, 0.1),
      repel: clampNum(f.repel, 0, 20, 10),
      link: clampNum(f.link, 0, 1, 1),
      distance: clampNum(f.distance, 30, 500, 250),
    },
    // Mesmos ranges dos sliders (compartilhados entre os palcos) — só os
    // DEFAULTS diferem do perfil 2D.
    forces3d: {
      center: clampNum(f3.center, 0, 1, FORCE3D_DEFAULTS.center),
      repel: clampNum(f3.repel, 0, 20, FORCE3D_DEFAULTS.repel),
      link: clampNum(f3.link, 0, 1, FORCE3D_DEFAULTS.link),
      distance: clampNum(f3.distance, 30, 500, FORCE3D_DEFAULTS.distance),
    },
    colorMode: mode,
    similarOpacity: clampNum(r.similarOpacity, 0, 1, 0.18),
    hideSimilar: asBool(r.hideSimilar),
    nodeSizeMult: clampNum(r.nodeSizeMult, 0.3, 3, 1),
    lineSizeMult: clampNum(r.lineSizeMult, 0, 3, 1),
    textFadeMult: clampNum(r.textFadeMult, -3, 3, 0),
    // Mesmos ranges dos sliders (compartilhados entre os palcos) — só os
    // DEFAULTS batem com o 2D aqui (1/1); sem textFadeMult (sem equivalente 3D).
    visual3d: {
      nodeSizeMult: clampNum(v3.nodeSizeMult, 0.3, 3, VISUAL3D_DEFAULTS.nodeSizeMult),
      lineSizeMult: clampNum(v3.lineSizeMult, 0, 3, VISUAL3D_DEFAULTS.lineSizeMult),
      glow: asBool(v3.glow, VISUAL3D_DEFAULTS.glow),
    },
    hideOrphans: asBool(r.hideOrphans),
    noOverlap: asBool(r.noOverlap),
  };
}

async function readPrefsKey(env: Env, key: string): Promise<GraphPrefs | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(key).first<{ value: string }>();
  if (!row?.value) return null;
  try { return sanitizeGraphPrefs(JSON.parse(row.value)); } catch { return null; }
}

// Lê as prefs salvas da SUPERFÍCIE; null se nada salvo (cliente usa defaults).
// Contatos sem chave própria ainda cai na legada (herda em vez de resetar).
export async function getGraphPrefs(env: Env, surface: PrefsSurface = 'notes'): Promise<GraphPrefs | null> {
  const own = await readPrefsKey(env, prefsKeyFor(surface));
  if (own) return own;
  if (surface === 'contacts') return readPrefsKey(env, GRAPH_PREFS_META_KEY);
  return null;
}

// POST /app/graph/prefs — salva a configuração atual como padrão do dono, na
// chave da superfície informada no body ({ surface: 'notes' | 'contacts' }).
export async function handleGraphPrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const surface: PrefsSurface =
    (body as Record<string, unknown> | null)?.surface === 'contacts' ? 'contacts' : 'notes';
  const prefs = sanitizeGraphPrefs(body);
  if (!prefs) {
    return new Response(JSON.stringify({ error: 'invalid prefs' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(prefsKeyFor(surface), JSON.stringify(prefs)).run();
  return new Response(JSON.stringify({ ok: true, surface }), { headers: { 'content-type': 'application/json' } });
}
