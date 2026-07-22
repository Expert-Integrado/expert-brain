// src/canon.ts — fonte ÚNICA dos enums do vault de contatos.
// Worker (index.ts) e Console (vaults/contacts.ts) importam daqui.
// O MCP standalone (mcp/index.js, processo Node separado) NÃO importa este TS —
// consome as listas via GET /canon como fonte canônica; mantém cópias inline
// cobertas pelo teste anti-drift (test/canon-mcp-drift.test.ts).

export const CONN_TYPES = [
  // pessoa ↔ pessoa
  "family", "friend", "colleague", "client", "mentor", "alum_g4", "peer_tech", "introduced_by",
  // pessoa ↔ pessoa, derivado de INTERAÇÃO observada (grafo social, specs/
  // whatsapp-interactions.md): A e B conversam entre si em grupos — mais forte
  // que member_of (pertencimento), mais fraco que friend (vínculo declarado).
  "interacts_with",
  // pessoa ↔ empresa
  "works_at", "founded", "advisor_of", "studied_at", "member_of",
  // empresa ↔ empresa
  "partner_of", "supplier_of", "competitor_of", "parent_of", "subsidiary_of",
  // genérico / ambos
  "invested_in", "client_of", "other",
] as const;

// Tipos SIMÉTRICOS: a relação não tem direção (A friend B == B friend A).
// connect(B, A, 'friend') deve colidir com connect(A, B, 'friend') no UNIQUE.
export const SYMMETRIC_CONN_TYPES = [
  "family", "friend", "colleague", "peer_tech", "partner_of", "competitor_of",
  "interacts_with",
] as const;

export const ENTITY_KINDS = ["person", "company", "group", "place", "event", "other"] as const;

// Categorias canônicas (segmento da rede). Categoria é FILTRO: NÃO entra no
// embedding (o vetor cobre name/role/company/sector/website/notes_text).
// 'mapeado' (decisão 10/07/2026): sub-vault default-off — contato criado só por
// rastro de interação (grupos com categoria 'mapear' no WhatsApp). Fica FORA de
// recall/listagem/grafo sem filtro explícito category=mapeado; get_contact_by_phone
// e o dossiê por id SEMPRE retornam. Vira contato pleno trocando a categoria.
export const CONTACT_CATEGORIES = [
  "cliente", "lead", "lead-perdido", "aluno", "parceiro", "fornecedor",
  "equipe", "familia", "pessoal", "network", "vip", "outro", "mapeado",
] as const;

// Categoria default-off: superfícies de descoberta (recall, /entities, grafos)
// só a incluem com filtro explícito. Lookups dirigidos (telefone, id) ignoram.
export const HIDDEN_BY_DEFAULT_CATEGORY = "mapeado";

// Espelha o CHECK original da migration 0001 (dropado na 0002) — validação na app.
// meeting/email/message são aditivos (spec 50-console-v2/57 §1): distinguem reunião
// formal, e-mail e mensagem dentro do que antes só existia como 'talked' genérico.
// Sem CHECK no banco (dropado na 0002) — nenhuma migration necessária pra isso.
// 'categorized' (spec 40-ops/45): trilha de proveniência de categorização em massa
// (seeds/whatsapp). Não é interação: fica fora de MANUAL_EVENT_KINDS (não aparece
// no form da UI), de LAST_CONTACTED (não é contato real) e não reembeda
// (eventKindReembeds só reage a 'note' — um apply de 1451 seeds não pode disparar
// 1451 reembeds).
export const EVENT_KINDS = [
  "met", "talked", "saw_post", "recommended", "birthday_reminder", "note", "mentioned_in_brain",
  "meeting", "email", "message", "categorized",
] as const;

// 'seed' (spec 40-ops/45): curadoria em massa via scripts/apply-category-seeds.mjs.
// Precedência entre fontes: docs/categorias-fontes.md (manual > seed > whatsapp > pipedrive).
// 'instagram'/'email'/'telegram' (adendo 12/07 em 9zfjcquprh03): canais reais de
// interação — backfill de directs e passos da cron de nutrição gravam com a
// origem verdadeira em vez de 'manual'.
export const EVENT_SOURCES = ["manual", "whatsapp", "instagram", "email", "telegram", "brain_bridge", "pipedrive", "seed"] as const;

// Labels PT-BR de exibição na UI (timeline/console) — fonte única consumida pelos
// dois clients (contacts standalone + painel embutido no Brain, spec 57 §1/§4).
export const EVENT_KIND_LABELS: Record<string, string> = {
  met: "Encontro",
  talked: "Conversa",
  meeting: "Reunião",
  email: "E-mail",
  message: "Mensagem",
  note: "Nota",
  saw_post: "Vi post",
  recommended: "Indicação",
  birthday_reminder: "Aniversário",
  mentioned_in_brain: "Citado no Brain",
  categorized: "Categorização",
};

// Kinds MANUAIS oferecidos no form "Registrar interação" da UI (spec 57 §4) — os
// automáticos/derivados (saw_post, recommended, birthday_reminder, mentioned_in_brain)
// ficam de fora do select, mas continuam válidos via REST/MCP.
export const MANUAL_EVENT_KINDS = ["met", "talked", "meeting", "email", "message", "note"] as const;

// Kinds que atualizam entities.last_contacted ao serem registrados (spec 19 §1 +
// spec 57 §1: 'meeting' entra no mesmo conjunto de met/talked/note).
export const LAST_CONTACTED_EVENT_KINDS = ["met", "talked", "note", "meeting"] as const;

// Sets pra validação O(1) nos handlers.
export const CONN_TYPES_SET = new Set<string>(CONN_TYPES);
export const SYMMETRIC_CONN_TYPES_SET = new Set<string>(SYMMETRIC_CONN_TYPES);
export const ENTITY_KINDS_SET = new Set<string>(ENTITY_KINDS);
export const CONTACT_CATEGORIES_SET = new Set<string>(CONTACT_CATEGORIES);
export const EVENT_KINDS_SET = new Set<string>(EVENT_KINDS);
export const EVENT_SOURCES_SET = new Set<string>(EVENT_SOURCES);
export const LAST_CONTACTED_EVENT_KINDS_SET = new Set<string>(LAST_CONTACTED_EVENT_KINDS);

// Normaliza o par (a, b) pra tipos simétricos: ordena lexicograficamente de modo
// que connect(A,B,t) e connect(B,A,t) resolvam ao MESMO par ordenado e colidam no
// UNIQUE(a_id, b_id, type). Tipos direcionais passam sem alteração. UM lugar só —
// usado por handleConnect (index.ts) e createLink (vaults/contacts.ts).
export function normalizeConnPair(a: string, b: string, type: string): [string, string] {
  if (SYMMETRIC_CONN_TYPES_SET.has(type) && a > b) return [b, a];
  return [a, b];
}
