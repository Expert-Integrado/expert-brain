// ============================================================================
// CONTRATO CENTRAL — Interface de Vault Adapter + payload comum do grafo.
//
// CONGELADO na Fase 0. As fases seguintes (WS-2/3/4) implementam CONTRA esta
// interface, em paralelo, sem se tocar. Não alterar a forma das estruturas aqui
// sem coordenar — o renderer (WS-1) consome e os adapters (WS-3/WS-4) produzem.
//
// Decisão de payload (pós-spec, máximo reuso): adotamos o SHAPE DO BRAIN como
// formato comum. O renderer fica quase cópia do Brain. Node tem
// `label`+`domain`+`size`+`x`+`y` (NÃO `cat`). No Contacts o adapter mapeia
// `kind`→`domain` pra cor. Aresta é discriminada por `type`: 'explicit' | 'similar'.
// ============================================================================

import type { Env } from '../env';

// ---- Contrato A — Payload comum do grafo (shape do Brain) ----

export interface GraphNode {
  id: string;
  label: string;
  /** Dimensão de cor. Brain: domínio da nota. Contacts: kind mapeado (person/company/...). */
  domain: string;
  /** Tamanho do nó. Fórmula Obsidian: max(8, min(3*sqrt(grau+1), 30)). */
  size: number;
  x: number;
  y: number;
  /** Avatar opcional (ex.: /media/<hash>) — usado pelo Contacts. */
  img?: string;
}

export interface ExplicitGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'explicit';
  why: string;
  relation_type: string;
}

export interface SimilarGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'similar';
  score: number;
}

export type GraphEdge = ExplicitGraphEdge | SimilarGraphEdge;

export interface GraphPayload {
  /** Qual vault produziu este payload. */
  vault: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  computedAt: number;
  /** Hash da fonte — chave de cache em CACHE KV (vault:sourceHash). */
  sourceHash: string;
}

/** Parâmetros de busca do grafo. default = subgrafo conectado. */
export interface GraphParams {
  /** Foca a vizinhança de um nó. */
  focus?: string;
  /** Profundidade (hops) a partir do foco. */
  depth?: number;
  /** Busca semântica — subgrafo por query. */
  q?: string;
  /** Traz o grafo inteiro (cuidado com escala). */
  all?: boolean;
  /** Teto de nós/arestas. */
  limit?: number;
  /**
   * Selo de privacidade (spec 50-console-v2/61): quando true, o payload inclui
   * entidades/arestas privadas (só o dono). Default/ausente = fail-closed (privados
   * fora). Entra em serializeGraphParams → a CHAVE de cache separa payload privado
   * de público (proxy sem header nunca recebe cache com nó privado dentro).
   */
  includePrivate?: boolean;
}

// ---- Contrato B — Detalhe da entidade (painel) ----

export interface EntityDetailField {
  label: string;
  value: string;
  href?: string;
  /** Canal primário do seu kind (spec 55) — a UI marca com selo. */
  primary?: boolean;
}

/** Canal da cartela (spec 55) — cru pra CRUD no Console (editable.channels). */
export interface EntityChannel {
  id: string;
  kind: string;
  value: string;
  label: string | null;
  is_primary: boolean;
  position: number | null;
  href?: string | null;
}

export interface EntityDetailConnection {
  id: string;
  otherId: string;
  otherLabel: string;
  rel: string;
  why: string;
}

export interface EntityDetailEvent {
  kind: string;
  ts: string;
  context?: string;
}

// Valores CRUS editáveis de um contato (spec 30-features/36 fase 3). Só o vault
// contacts popula — o painel do Console usa isto pra renderizar os campos como
// inputs editáveis (o `fields` acima continua sendo a versão de LEITURA com hrefs).
// `updated_at` é o token de concorrência otimista que a UI reenvia no PATCH.
export interface EntityEditable {
  updated_at: string;
  name: string;
  phone: string;
  email: string;
  role: string;
  company: string;
  website: string;
  sector: string;
  birthday: string;
  last_contacted: string;
  notes_text: string;
  category: string;
  /** Cartela de canais crua pra CRUD (spec 55). */
  channels?: EntityChannel[];
}

export interface EntityDetail {
  id: string;
  vault: string;
  title: string;
  kind: string;
  /** Campos montados pelo adapter (pessoa/empresa/nota). */
  fields: EntityDetailField[];
  connections: EntityDetailConnection[];
  events?: EntityDetailEvent[];
  img?: string;
  /** Valores crus editáveis (só contacts). Ausente = painel read-only (brain). */
  editable?: EntityEditable;
  /** Selo de privacidade (spec 61): true = contato marcado como privado (só o dono
   * chega aqui). A UI mostra o badge 🔒 e o toggle "tornar público". */
  private?: boolean;
}

// ---- Corpo de criação de aresta (POST /app/graph/link) ----

export interface LinkBody {
  source: string;
  target: string;
  /** Tipo de relação (rel) — semântica do vault. */
  rel: string;
  /** Justificativa do mecanismo compartilhado (Latticework). */
  why: string;
  /** Força 0..1 (Contacts) — opcional. */
  strength?: number;
}

// ---- Entrada de legenda (cor por categoria) ----

export interface LegendEntry {
  key: string;
  label: string;
  color: string;
}

// ---- Contrato 0.6 — Interface de Vault Adapter ----

export interface VaultAdapter {
  /** Identificador do vault: 'contacts' | 'brain' | ... */
  id: string;
  /** Label exibido no switcher do header. */
  name: string;
  /** Cor do vault no header. */
  color: string;
  /** Campo do nó usado pra colorir ('domain' no shape comum). */
  colorBy: string;
  /** Busca o grafo já NORMALIZADO no shape comum (faz fetch + token + normalize). */
  fetchGraph(env: Env, params: GraphParams): Promise<GraphPayload>;
  /**
   * Detalhe de uma entidade pro painel (Contrato B). `includePrivate` (spec 61):
   * quando false (default, fail-closed), entidade privada → 404 (mesmo erro de
   * inexistente) e eventos/vizinhos privados somem do payload. Vaults sem eixo de
   * privacidade (brain) ignoram o parâmetro.
   */
  fetchEntity(env: Env, id: string, includePrivate?: boolean): Promise<EntityDetail>;
  /** Cria uma aresta no vault. */
  createLink(env: Env, body: LinkBody): Promise<{ ok: boolean; id?: string }>;
  /** Cores por categoria pra legenda dinâmica. */
  legend(): LegendEntry[];
}

// ---- Registry de vaults ----
// Vazio na Fase 0. Cada vault novo = +1 entrada (preenchido na Integração:
// VAULTS.contacts (WS-3), VAULTS.brain (WS-4)). +1 vault futuro = +1 adapter.
export const VAULTS: Record<string, VaultAdapter> = {};
