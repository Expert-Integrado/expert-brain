// Rótulos PT-BR do vault de CONTATOS, compartilhados pelos bundles client
// (graph.ts e contact-page.ts) — mesmo racional do event-kind-labels.ts: módulo
// FOLHA (zero import), seguro pros bundles do browser via esbuild.
//
// Os slugs espelham o canon do Worker expert-contacts (src/canon.ts):
// ENTITY_KINDS e CONN_TYPES. Kind/rel novo lá = entrada nova aqui no mesmo PR.

export const CONTACT_TYPE_LABELS: Record<string, string> = {
  person: 'Pessoa',
  company: 'Empresa',
  group: 'Grupo',
  place: 'Lugar',
  event: 'Evento',
  other: 'Outro',
};

// 21 CONN_TYPES do vault de contatos (espelha REL_OPTIONS_CONTACTS do console
// standalone expert-contacts/src/web/client/detail.ts).
export const CONTACT_REL_LABELS: Record<string, string> = {
  colleague: 'Colega',
  friend: 'Amigo(a)',
  family: 'Família',
  client: 'Cliente',
  mentor: 'Mentor(a)',
  alum_g4: 'Alumni G4',
  peer_tech: 'Par (tech)',
  introduced_by: 'Apresentado por',
  works_at: 'Trabalha em',
  founded: 'Fundou',
  advisor_of: 'Conselheiro de',
  studied_at: 'Estudou em',
  member_of: 'Membro de',
  partner_of: 'Parceiro de',
  supplier_of: 'Fornecedor de',
  competitor_of: 'Concorrente de',
  parent_of: 'Controladora de',
  subsidiary_of: 'Subsidiária de',
  invested_in: 'Investiu em',
  client_of: 'Cliente de',
  other: 'Outro',
};

export function contactRelLabel(rel: string): string {
  return CONTACT_REL_LABELS[rel] ?? rel;
}
