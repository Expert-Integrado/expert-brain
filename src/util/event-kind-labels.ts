// Rótulos PT-BR dos kinds de interação de contato (expert-contacts). Compartilhado
// entre SSR (journal, home) e bundles client (home, contact-page, graph) pra
// tradução nunca divergir — kind desconhecido cai no valor cru (onda 6, spec 67).
export const EVENT_KIND_LABELS: Record<string, string> = {
  met: 'Encontro',
  talked: 'Conversa',
  meeting: 'Reunião',
  email: 'E-mail',
  message: 'Mensagem',
  note: 'Nota',
  saw_post: 'Vi post',
  recommended: 'Indicação',
  birthday_reminder: 'Aniversário',
  mentioned_in_brain: 'Citado no Brain',
};

export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? kind;
}
