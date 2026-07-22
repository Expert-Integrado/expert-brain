// Funções puras de normalização de telefone BR — extraídas de src/index.ts pra
// testabilidade (eram privadas ao módulo). Lógica IDÊNTICA (copiar/colar); zero
// mudança de comportamento. index.ts importa de volta daqui.

export function normalizePhone(p?: string): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

// Variantes canônicas de um telefone BR (com e sem o 9º dígito do celular) —
// usado pelo lookup determinístico /get_contact_by_phone pra casar números
// salvos em formatos diferentes (ex: 55DD9XXXXXXXX vs 55DDXXXXXXXX).
export function phoneVariants(p: string): string[] {
  const d = (p || "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length < 8) return [];
  const out = new Set<string>([d]);
  let rest: string | null = null;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) rest = d.slice(2);
  else if (d.length === 10 || d.length === 11) rest = d;
  if (rest) {
    const ddd = rest.slice(0, 2), num = rest.slice(2);
    if (num.length === 9 && num[0] === "9") { out.add("55" + ddd + num); out.add("55" + ddd + num.slice(1)); }
    else if (num.length === 8) { out.add("55" + ddd + num); out.add("55" + ddd + "9" + num); }
    else out.add("55" + ddd + num);
  }
  return [...out];
}
