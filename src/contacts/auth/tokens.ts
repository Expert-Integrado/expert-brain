// FONTE ÚNICA de auth por bearer estático (spec 10-backend/24).
//
// - timingSafeEqualStr: comparação constante — toda checagem de token do repo
//   passa por aqui (requireAuth da API, proxyTokenOk/writeTokenOk do /app).
// - proxyTokenAllowsPath: escopo canônico do CONTACTS_PROXY_TOKEN na API de
//   entidades (rotas fora de /app*; as de /app* têm allowlist própria em
//   src/web/handler.ts). Quem quiser abrir rota nova pro proxy token edita AQUI
//   e justifica no commit — o default é FECHADO (qualquer GET novo nasce 401
//   pro proxy token).

// Comparação de strings em tempo constante (mesmo idioma de src/web/session.ts).
// O vazamento do TAMANHO do token é aceitável (padrão da indústria).
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Escopo do CONTACTS_PROXY_TOKEN — sempre GET, sempre leitura. Racional: o token
// existe pro Worker do Brain (service binding) embutir o vault contacts na UI e
// resolver contatos pontuais. Consumidores reais mapeados em 07/07/2026 no repo
// do Brain (grep por CONTACTS_PROXY_TOKEN):
//   /list_entities         — MCP list_contacts + resurface digest (spec 64; scan limitado)
//   /recall_entity|person  — MCP search_contacts + busca/autocomplete do console
//   /entities/:id          — MCP get_contact + SSR da página do contato
//   /get_contact_by_phone  — MCP lookup determinístico
//   /canon                 — enums (zero PII)
//   /media/:hash           — avatar passthrough do console do Brain (conteúdo
//                            endereçado por hash; sem listagem)
// FORA do escopo (401 pro proxy token): /graph/data da API, /entities/:id/media,
// /list_people, /list_companies e qualquer POST.
const PROXY_ALLOWED_EXACT = new Set([
  '/recall_entity',
  '/recall_person',
  '/get_contact_by_phone',
  '/list_entities',
  '/canon',
  // Google sync (specs/google-contacts-sync.md): o painel do Brain lê o estado da
  // conexão e as etiquetas disponíveis. Ambos GET, zero mutação, zero credencial
  // no payload (o refresh token nunca sai do KV).
  '/google/status',
  '/google/labels',
  // WhatsApp Agent grupos (specs/whatsapp-groups-sync.md): o painel do Brain lê o
  // estado da integração (catálogo/allowlist/último run). GET, zero mutação, zero
  // credencial no payload (o WHATSAPP_SYNC_TOKEN nunca aparece na resposta).
  '/whatsapp/status',
  // Instagram Agent contatos (specs/instagram-contacts-sync.md): mesmo racional.
  '/instagram/status',
  // Pipedrive (integração opcional com o CRM): o painel do Brain lê o estado do
  // sync incremental. GET, zero mutação, zero credencial no payload.
  '/pipedrive/status',
]);
const PROXY_ALLOWED_PATTERNS = [
  /^\/(?:entities|people)\/[0-9a-f-]+$/i, // detalhe de 1 entidade (mesmo regex do roteador)
  /^\/media\/[0-9a-f]{64}$/i, // blob endereçado por hash (avatar)
];

export function proxyTokenAllowsPath(path: string): boolean {
  if (PROXY_ALLOWED_EXACT.has(path)) return true;
  return PROXY_ALLOWED_PATTERNS.some((re) => re.test(path));
}

// Escopo do CONTACTS_WRITE_TOKEN na API de entidades (specs/google-contacts-sync.md).
// Racional: o painel do Brain precisa disparar ações do sync do Google SEM carregar
// o OWNER_TOKEN. São mutações de ESTADO DO SYNC (KV gsync:* + tabela de vínculos),
// nunca escrita direta de entidade — /save_person e afins seguem OWNER_TOKEN only.
// Mesma regra do proxy: rota nova entra AQUI com justificativa no commit; default FECHADO.
const WRITE_ALLOWED_EXACT = new Set([
  '/google/connect-start',
  '/google/config',
  '/google/sync',
  '/google/disconnect',
  // Credencial do OAuth client colada no wizard do painel (modo painel da spec):
  // grava SÓ o par id/secret em KV gsync:client — estado da integração, nunca
  // escrita de entidade. O secret jamais volta em resposta (id sai mascarado).
  '/google/client',
  // Toggle do write-back vault→Google (seção write-back da spec): grava SÓ o flag
  // em KV gsync:write_back — estado da integração; o push em si nasce das edições.
  '/google/write-back',
  // WhatsApp Agent grupos (specs/whatsapp-groups-sync.md): o painel do Brain grava
  // QUAIS grupos sincronizar (estado em KV, nunca escrita direta de entidade).
  '/whatsapp/allowlist',
  // Toggle "membro desconhecido vira contato" (default OFF). A rota grava SÓ o flag
  // em KV; a criação de entidade em si acontece no import autenticado do script.
  '/whatsapp/create-members',
  // Instagram Agent contatos (specs/instagram-contacts-sync.md): mesmo racional.
  '/instagram/allowlist',
  // Pipedrive: o painel do Brain dispara o sync incremental sob demanda (mesma
  // lógica do cron; idempotente, só preenche vazios em quem já existe).
  '/pipedrive/sync',
]);

export function writeTokenAllowsPath(path: string): boolean {
  return WRITE_ALLOWED_EXACT.has(path);
}
