// Prioridade nomeada estilo ClickUp (spec 36 fase 3). O BANCO continua 1-4/null —
// isto é SÓ a camada de apresentação. 1=Crítica, 2=Alta, 3=Normal, 4=Baixa,
// null=sem prioridade. Cada nível carrega uma cor de "bandeirinha" (flag) e um
// rótulo. Compartilhado entre o SSR (server) e os bundles de client (esbuild
// compila daqui) pra os selects/cards NUNCA divergirem.

export interface PriorityMeta {
  value: number;
  label: string;
  color: string; // cor da bandeirinha (hex)
}

// Cores mapeadas na semântica do tema (vermelho→laranja→azul→cinza), no espírito
// do ClickUp mas dentro da paleta Nebula (mesma família dos badges de status/due).
export const PRIORITIES: PriorityMeta[] = [
  { value: 1, label: 'Crítica', color: '#f87171' },
  { value: 2, label: 'Alta', color: '#fb923c' },
  { value: 3, label: 'Normal', color: '#60a5fa' },
  { value: 4, label: 'Baixa', color: '#94a3b8' },
];

export function priorityMeta(p: number | null): PriorityMeta | null {
  if (p === null) return null;
  return PRIORITIES.find((x) => x.value === p) ?? null;
}

// Rótulo curto p/ leitura ("Crítica"). null → "Sem prioridade".
export function priorityLabel(p: number | null): string {
  return priorityMeta(p)?.label ?? 'Sem prioridade';
}

// SVG inline de bandeirinha preenchida com a cor do nível. Reusado no card e no
// select. `currentColor` não serve (o select herda cor do texto), então a cor vai
// embutida no fill. Sem dependência externa; CSP-safe (inline no bundle/SSR).
export function flagSvg(color: string, size = 12): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0"><path d="M4 2v12" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/><path d="M4.8 2.6h7.2c.5 0 .8.6.5 1L11 6l1.5 2.4c.3.5 0 1-.5 1H4.8V2.6Z" fill="${color}"/></svg>`;
}
