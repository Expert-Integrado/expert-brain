// Fonte ÚNICA dos atalhos de teclado do console (spec 91-experiencia-premium/97).
// O shell (client/shell.ts) consome SHORTCUT_DEFS duas vezes: pra fazer os binds
// do onKey (via o mapa de ações dele) e pra gerar o modal de ajuda ("?") — um
// atalho novo entra AQUI e aparece na ajuda de graça. Módulo folha sem estado:
// shell importa daqui; testes jsdom cobrem a lista e o filtro de digitação.

export interface ShortcutDef {
  id: string;      // chave do bind no shell (mapa de ações)
  combo: string;   // rótulo canônico ("Ctrl+K", "?") — ⌘ substitui Ctrl no Mac
  key: string;     // e.key esperado (minúsculo pra letras)
  meta: boolean;   // exige Ctrl/⌘
  desc: string;
  group: 'Global' | 'Navegação';
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: 'palette', combo: 'Ctrl+K', key: 'k', meta: true, desc: 'Busca e comandos (paleta)', group: 'Global' },
  { id: 'sidebar', combo: 'Ctrl+B', key: 'b', meta: true, desc: 'Recolher ou expandir o menu', group: 'Global' },
  { id: 'help', combo: '?', key: '?', meta: false, desc: 'Atalhos do teclado (esta ajuda)', group: 'Global' },
  { id: 'graph', combo: 'Ctrl+G', key: 'g', meta: true, desc: 'Ir pro Grafo', group: 'Navegação' },
  { id: 'notes', combo: 'Ctrl+N', key: 'n', meta: true, desc: 'Ir pras Notas', group: 'Navegação' },
  { id: 'tasks', combo: 'Ctrl+T', key: 't', meta: true, desc: 'Ir pras Tarefas', group: 'Navegação' },
  { id: 'config', combo: 'Ctrl+,', key: ',', meta: true, desc: 'Configurações', group: 'Navegação' },
];

// Alvo de digitação? Bloqueia atalhos sem modificador (o "?" nunca pode
// sequestrar um campo de texto). Mesmo critério do isTypingInInput do shell.
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  // isContentEditable não existe em jsdom; o atributo cobre os dois mundos.
  const ce = el.getAttribute('contenteditable');
  return (el as HTMLElement).isContentEditable === true || ce === '' || ce === 'true';
}

function comboLabel(combo: string, isMac: boolean): string {
  return isMac ? combo.replace('Ctrl', '⌘') : combo;
}

// HTML do corpo do modal — gerado da lista, agrupado por contexto. O shell
// injeta dentro do .modal genérico do design system.
export function shortcutsModalHtml(isMac: boolean): string {
  const groups = ['Global', 'Navegação'] as const;
  const section = (g: (typeof groups)[number]) => `
    <div class="shortcuts-group">
      <h3>${g}</h3>
      ${SHORTCUT_DEFS.filter((s) => s.group === g).map((s) => `
        <div class="shortcuts-row"><kbd>${comboLabel(s.combo, isMac)}</kbd><span>${s.desc}</span></div>`).join('')}
    </div>`;
  return groups.map(section).join('');
}
