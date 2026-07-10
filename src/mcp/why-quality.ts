// Segunda régua do `why` de edge (specs/70-grafo-higiene/71): além do mínimo de
// 20 caracteres (régua de TAMANHO, nos callers), o conteúdo precisa dizer algo
// além de "são relacionadas" — que é a única coisa que TODA edge já implica.
//
// Um why é preguiçoso quando, removidas as palavras de preenchimento, só resta
// vocabulário genérico de relação — nenhum substantivo de mecanismo. A régua é
// deliberadamente conservadora: qualquer token substantivo salva o why (falso
// positivo aqui bloquearia edge legítima, que é pior que deixar passar um raso —
// o digest de higiene, spec 73, pega os rasos que passarem).

const FILLER = new Set([
  // pt
  'essas', 'estas', 'as', 'os', 'duas', 'dois', 'ambas', 'ambos', 'notas', 'nota',
  'ideias', 'ideia', 'conceitos', 'conceito', 'sao', 'estao', 'ficam', 'se', 'entre',
  'si', 'e', 'de', 'do', 'da', 'dos', 'das', 'que', 'uma', 'um', 'muito', 'bem',
  'elas', 'eles', 'com', 'em', 'no', 'na', 'pois', 'porque', 'tem',
  // en
  'these', 'those', 'the', 'two', 'both', 'notes', 'note', 'ideas', 'idea',
  'concepts', 'concept', 'are', 'they', 'is', 'a', 'an', 'to', 'each', 'other',
  'and', 'very', 'of', 'in', 'with', 'because', 'have', 'be',
]);

const GENERIC = [
  /^relacionad\w*$/, /^related$/, /^relates?$/, /^relacao$/, /^relacoes$/,
  /^similar\w*$/, /^parecid\w*$/, /^semelhant\w*$/, /^alike$/,
  /^conectad\w*$/, /^connected$/, /^conexao$/, /^conexoes$/, /^connections?$/,
  /^ligad\w*$/, /^ligacao$/, /^ligacoes$/, /^linked$/, /^links?$/,
  /^associad\w*$/, /^associated$/, /^associacao$/,
  /^mesm[oa]s?$/, /^same$/, /^igual\w*$/, /^equal$/,
  /^temas?$/, /^topics?$/, /^assuntos?$/, /^subjects?$/,
  /^about$/, /^sobre$/, /^falam$/, /^tratam$/, /^talk$/,
];

export function isLazyWhy(why: string): boolean {
  const tokens = why
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let generic = 0;
  let substantive = 0;
  for (const t of tokens) {
    if (FILLER.has(t)) continue;
    if (GENERIC.some((re) => re.test(t))) generic++;
    else substantive++;
  }
  return generic > 0 && substantive === 0;
}

// Mensagem única dos dois callers (save_note e link) — mesma pedagogia do erro
// de tamanho: nomear o MECANISMO, com exemplo bom e ruim.
export function lazyWhyError(): string {
  return (
    'The why of this edge only says the notes are related — that is the one thing ' +
    'every edge already implies, so it adds nothing. Name the shared MECHANISM ' +
    '(what structure or dynamic both notes share). ' +
    'Good example: "Both are systems with delayed negative feedback, so both oscillate." ' +
    'Bad example: "essas notas são relacionadas entre si".'
  );
}
