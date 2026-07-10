// Write-path compartilhado de nota de conhecimento (spec 36 fase 2).
//
// A tool MCP `update_note` e o endpoint web `POST /app/notes/update` precisam
// tomar a MESMA decisão pós-edição: se tldr/domains/kind mudou, re-embeda o vetor
// (Workers AI) + refresca as similar edges; se só title/body mudou, nada de vetor
// (o FTS se atualiza via trigger). Esta função centraliza essa decisão pra não
// duplicar a regra entre os dois callers (a spec EXIGE a extração).
//
// Entrada: os valores ANTERIORES (existing) + o patch (só os campos presentes).
// Saída: quais colunas mudaram de fato + se re-embedou. NÃO faz o UPDATE das
// colunas em D1 (isso é do caller, via updateNote — que também trata concorrência);
// esta função é só o efeito colateral de vetor/edges após o D1 já ter gravado.

import type { Env } from '../env.js';
import type { NoteRow } from './queries.js';
import { embed, upsertNoteVector, queryVector, type VectorMatch } from '../vector/index.js';
import { SIMILARITY_TOP_K, persistSimilarEdgesFromMatches } from '../web/similarity.js';

export interface NoteFieldPatch {
  title?: string;
  body?: string;
  tldr?: string;
  domains?: string[]; // já parseado (array), não a JSON string
  kind?: string;
}

export interface NoteChangeSummary {
  fieldsChanged: string[];
  reembedded: boolean;
  needsReembed: boolean;
}

// Retorno de reembedNoteIfNeeded (spec 70-grafo-higiene/76): além do flag de
// re-embed, devolve os matches da consulta de vizinhança pré-persist — o caller
// MCP (update_note) decide os possible_duplicates a partir deles, sem uma
// segunda chamada ao Vectorize (mesma filosofia 1-consulta-N-consumidores do
// save_note, spec 71). matches vem vazio quando não re-embedou OU quando a
// consulta falhou (best-effort preservado).
export interface ReembedResult {
  reembedded: boolean;
  matches: VectorMatch[];
}

// Decide o que mudou de fato entre `existing` e `patch`. Puro (sem side-effects) —
// separado pra ser testável e pra o caller saber se precisa re-embedar ANTES de
// disparar o Workers AI. Ordem de domínios é significativa (recall usa o 1º como
// bucket primário): reordenar conta como mudança.
export function diffNoteFields(existing: NoteRow, patch: NoteFieldPatch): {
  titleChanged: boolean; bodyChanged: boolean; tldrChanged: boolean;
  domainsChanged: boolean; kindChanged: boolean; needsReembed: boolean;
  fieldsChanged: string[];
} {
  const titleChanged = patch.title !== undefined && patch.title !== existing.title;
  const bodyChanged = patch.body !== undefined && patch.body !== existing.body;
  const tldrChanged = patch.tldr !== undefined && patch.tldr !== existing.tldr;
  const domainsChanged =
    patch.domains !== undefined && JSON.stringify(patch.domains) !== existing.domains;
  const kindChanged = patch.kind !== undefined && patch.kind !== existing.kind;
  const needsReembed = tldrChanged || domainsChanged || kindChanged;

  const fieldsChanged: string[] = [];
  if (titleChanged) fieldsChanged.push('title');
  if (bodyChanged) fieldsChanged.push('body');
  if (tldrChanged) fieldsChanged.push('tldr');
  if (domainsChanged) fieldsChanged.push('domains');
  if (kindChanged) fieldsChanged.push('kind');

  return { titleChanged, bodyChanged, tldrChanged, domainsChanged, kindChanged, needsReembed, fieldsChanged };
}

// Re-embeda uma nota SE tldr/domains/kind mudou, usando os valores finais
// (patch ?? existing). A edição em D1 já está persistida quando esta função
// roda — falha de vetor/vizinhança não deve derrubar o save (best-effort).
// Retorna { reembedded: false, matches: [] } se pulou (nada de semântico mudou).
//
// Spec 70-grafo-higiene/76: ao re-embedar, esta função FAZ a consulta de
// vizinhança (queryVector) e persiste as similar edges ELA MESMA — o antigo
// refreshSimilarEdges (que fazia sua PRÓPRIA query) sai deste caminho pra evitar
// consulta duplicada ao Vectorize. Os matches voltam pro caller decidir
// possible_duplicates (update_note MCP) sem chamar o Vectorize de novo.
export async function reembedNoteIfNeeded(
  env: Env, existing: NoteRow, patch: NoteFieldPatch
): Promise<ReembedResult> {
  const { needsReembed } = diffNoteFields(existing, patch);
  if (!needsReembed) return { reembedded: false, matches: [] };

  const finalTldr = patch.tldr ?? existing.tldr;
  const finalDomains: string[] = patch.domains ?? JSON.parse(existing.domains);
  // Rows legadas podem ter kind = null; preserva o null até a metadata do Vectorize
  // em vez de forçar um cast de NoteKind sobre null.
  const finalKind: string | null = patch.kind ?? existing.kind;

  const vec = await embed(env, finalTldr);
  await upsertNoteVector(env, existing.id, vec, {
    domains: finalDomains,
    kind: finalKind,
    created_at: existing.created_at,
  });

  // tldr/domains/kind mudou → vizinhança semântica pode ter mudado: UMA consulta
  // alimenta tanto as similar_edges persistidas quanto os possible_duplicates do
  // caller. Falha da consulta: matches fica vazio (edges ficam pro re-pass diário,
  // spec 72); falha SÓ do persist não descarta os matches já obtidos — o caller
  // ainda consegue avisar sobre quase-duplicatas mesmo se a escrita em D1 falhar.
  let matches: VectorMatch[] = [];
  try {
    matches = await queryVector(env, vec, SIMILARITY_TOP_K + 2);
  } catch (err) {
    console.error('reembedNoteIfNeeded: consulta de vizinhança falhou (edit persisted anyway)', err);
  }
  if (matches.length > 0) {
    try {
      await persistSimilarEdgesFromMatches(env, existing.id, matches);
    } catch (err) {
      console.error('reembedNoteIfNeeded: persistSimilarEdgesFromMatches falhou (edit persisted anyway)', err);
    }
  }
  return { reembedded: true, matches };
}
