// Utilitários de tempo pra tasks. Tudo gira em torno de BRT (America/Sao_Paulo),
// que é UTC-3 FIXO — o Brasil aboliu o horário de verão em 2019, então não há
// transição de offset pra tratar. O Worker roda em UTC, por isso datas locais
// sem timezone explícito precisam do offset -03:00 colado antes do parse.

export const BRT_OFFSET = '-03:00';

// Converte uma string de vencimento em unix ms (UTC).
// Aceita:
//   - ISO completo com timezone   → "2026-06-22T14:00:00-03:00" / "...Z"  (parse direto)
//   - ISO sem timezone            → "2026-06-22T14:00:00"  (assume BRT)
//   - data + hora curta           → "2026-06-22 14:00"     (assume BRT)
//   - só data                     → "2026-06-22"           (assume 23:59 BRT — "até o fim do dia")
// Retorna null se não conseguir parsear.
export function parseDueToMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;

  // Já tem timezone (Z ou ±HH:MM no fim)? Parse direto.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }

  // Normaliza o(s) espaço(s) entre data e hora pra um único "T". Antes usava
  // raw.replace(' ', 'T'), que troca só o PRIMEIRO espaço — input com espaços
  // extras ("2026-06-22  14:00") escapava do caminho BRT e caía no fallback UTC.
  // A regex ^(\S+)\s+ consome TODO o run de espaço numa substituição só.
  let s = raw.replace(/^(\S+)\s+/, '$1T');

  // Só data (sem hora) → fim do dia em BRT. Aceita mês/dia sem zero-pad.
  const dateOnly = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    s = `${y}-${pad(+mo)}-${pad(+d)}T23:59:00`;
  }

  // Data + hora (com ou sem segundos, com ou sem zero-pad em qualquer componente).
  const dt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (dt) {
    const [, y, mo, d, h, mi, se] = dt;
    const norm = `${y}-${pad(+mo)}-${pad(+d)}T${pad(+h)}:${pad(+mi)}:${pad(se ? +se : 0)}`;
    const ms = Date.parse(`${norm}${BRT_OFFSET}`);
    return Number.isNaN(ms) ? null : ms;
  }

  // Fallback UTC REMOVIDO (spec 15 item 5): Date.parse(raw) cru tratava ISO sem
  // timezone como UTC, gravando prazo 3h adiantado em silêncio. Melhor errar alto —
  // o toolError do save_task/update_task já guia o formato correto.
  return null;
}

// Componentes de um instante em BRT, sem depender de Intl (que pode não trazer a
// tz no runtime do Worker). Subtrai 3h do UTC e lê os getters UTC.
function brtParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const shifted = new Date(ms - 3 * 60 * 60 * 1000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

// "22/06/2026 14:00" em BRT.
export function formatBrtDateTime(ms: number): string {
  const p = brtParts(ms);
  return `${pad(p.d)}/${pad(p.mo)}/${p.y} ${pad(p.h)}:${pad(p.mi)}`;
}

// "22/06 14:00" — versão curta pra badges/cards.
export function formatBrtShort(ms: number): string {
  const p = brtParts(ms);
  return `${pad(p.d)}/${pad(p.mo)} ${pad(p.h)}:${pad(p.mi)}`;
}

// Texto relativo de vencimento, do ponto de vista de `now`. Ex: "vence em 2h",
// "vence em 35min", "vencida há 1d", "hoje 14:00". Usado nos lembretes e cards.
export function relativeDue(dueMs: number, nowMs: number): string {
  const diff = dueMs - nowMs; // >0 = futuro
  const absMin = Math.round(Math.abs(diff) / 60000);
  const part = (mins: number): string => {
    if (mins < 60) return `${mins}min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return mins % 60 === 0 ? `${h}h` : `${h}h${mins % 60}min`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  };
  if (diff >= 0) {
    if (absMin <= 1) return 'vence agora';
    return `vence em ${part(absMin)}`;
  }
  if (absMin <= 1) return 'venceu agora';
  return `vencida há ${part(absMin)}`;
}
