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
import { embed, upsertNoteVector } from '../vector/index.js';
import { refreshSimilarEdges } from '../web/similarity.js';

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
// (patch ?? existing). Best-effort no refreshSimilarEdges (a edição em D1 já está
// persistida quando esta função roda — falha de edges não deve derrubar o save).
// Retorna true se re-embedou, false se pulou (nada de semântico mudou).
export async function reembedNoteIfNeeded(
  env: Env, existing: NoteRow, patch: NoteFieldPatch
): Promise<boolean> {
  const { needsReembed } = diffNoteFields(existing, patch);
  if (!needsReembed) return false;

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
  // tldr mudou → vizinhança semântica mudou: recomputa as similar edges desta nota.
  try {
    await refreshSimilarEdges(env, existing.id, vec);
  } catch (err) {
    console.error('reembedNoteIfNeeded: refreshSimilarEdges failed (edit persisted anyway)', err);
  }
  return true;
}
