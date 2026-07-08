import type { Env } from '../env.js';

// ─────────────── Novidades / release notes (spec 50-console-v2/71) ───────────────
// Fonte única das releases mostradas em /app/novidades e no banner do shell.
// Cada deploy relevante adiciona UMA entrada no TOPO (mais recente primeiro).
// O id é estável e ordenável (data + slug); `last_seen_release` na tabela `meta`
// guarda o último id visto pelo dono — banner aparece enquanto forem diferentes.

export interface ReleaseEntry {
  id: string; // ex: '2026-07-06-console-v2' — estável, único, mais recente no topo
  date: string; // exibição (BRT)
  title: string;
  highlights: string[]; // bullets curtos, sem HTML (escapado no render)
}

export const RELEASES: ReleaseEntry[] = [
  {
    id: '2026-07-08-ux-reforma',
    date: '08/07/2026',
    title: 'Reforma de interface — identidade Nebula Refinada',
    highlights: [
      'Visual novo em todo o console: superfícies opacas, contraste AA em todos os textos e hierarquia de cores por estado',
      'Arrastar cartões no board reescrito: funciona no touch (segure 300ms), indicador de destino discreto e coluna vazia sinalizada',
      'Cartão de tarefa inteiro clicável — sem botão "abrir"',
      'Visibilidade unificada em 3 níveis (Privado / Normal / Link público) numa régua só, em notas e tarefas',
      'Início absorveu o Journal: feed "Atividade" com filtros e "carregar mais" na própria home — um lugar só pra ver tudo',
      'Configurações reorganizadas em 3 abas: Conexões, Organização e Sistema',
      'Mobile revisado de ponta a ponta: navegação inferior compacta, telas sem corte em 390px e 320px',
      'Acessibilidade: foco visível em tudo, animações respeitam "reduzir movimento", rótulos e textos 100% em português',
    ],
  },
  {
    id: '2026-07-06-console-v2',
    date: '06/07/2026',
    title: 'Console v2+v3 — o segundo cérebro completo',
    highlights: [
      'Home nova em /app: o que vence hoje, inbox, "Do seu cérebro" e últimas interações numa tela só',
      'Kanban com colunas customizáveis (crie estágios como Backlog nas Configurações) e cards com tags, comentários e compartilhamento',
      'Projetos/pastas de tarefas: agrupe tasks e filtre o board (funciona também via agente: list_tasks com project)',
      'Comentários em tarefas — inclusive de convidados no link público, sem login',
      'Contatos viraram dossiê: página própria, múltiplos canais (e-mails, Instagram, LinkedIn, CRM), timeline de interações e vínculos de 1º/2º nível',
      'Observações sobre contatos entram na busca semântica — "quem era o cara das licitações?" agora encontra',
      'Privacidade fim a fim: notas, tarefas, contatos e eventos podem ser privados — invisíveis pra qualquer credencial sem o escopo certo',
      'Chaves de API com escopo (leitura / completa / + privados) e revogação',
      'Inbox de captura com triagem: jogue ideias cruas e transforme em nota ou tarefa depois',
      'Menções @contato em notas e tarefas — a rede social do seu conhecimento',
      'Digest "Do seu cérebro": perguntas abertas paradas, notas centrais esquecidas e contatos esfriando voltam sozinhos',
      'Busca unificada Ctrl+K: notas, tarefas e contatos numa paleta só, com ações rápidas',
      'Journal cronológico em /app/journal: tudo que aconteceu, dia a dia',
      'PWA: compartilhe qualquer texto do celular direto pro inbox do Brain',
      'Backup automático semanal pro R2 + export completo em ZIP nas Configurações',
      'Instruções do dono: um "CLAUDE.md do Brain" em Configurações que todo agente conectado recebe automaticamente',
    ],
  },
];

export const LATEST_RELEASE_ID = RELEASES[0].id;
const META_KEY = 'last_seen_release';

export async function readLastSeenRelease(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(META_KEY)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function markLatestReleaseSeen(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(META_KEY, LATEST_RELEASE_ID)
    .run();
}

/**
 * Banner "novidades" do shell: aparece em toda página logada enquanto o dono
 * não visitar /app/novidades após uma release nova. Soft-fail: qualquer erro
 * na meta retorna '' e NUNCA derruba o render (mesmo contrato do badge do inbox).
 */
export async function releaseBannerHtml(env: Env): Promise<string> {
  try {
    const seen = await readLastSeenRelease(env);
    if (seen === LATEST_RELEASE_ID) return '';
    return `<a href="/app/novidades" class="release-banner" style="display:block;margin:0 0 16px;padding:10px 14px;border-radius:10px;background:linear-gradient(90deg,rgba(56,189,248,.14),rgba(167,139,250,.14));border:1px solid rgba(56,189,248,.35);color:inherit;text-decoration:none;font-size:14px"><strong>Novidades:</strong> esta instância foi atualizada — veja o que chegou nesta versão</a>`;
  } catch (err) {
    console.error('releaseBannerHtml: falha ao ler last_seen_release (banner oculto)', err);
    return '';
  }
}
