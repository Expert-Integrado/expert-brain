#!/usr/bin/env node
// Backfill ONE-TIME das similar edges (migration 0005) pras notas que já existiam
// ANTES dessa feature. Dirige o endpoint /setup/backfill-similar em loop por cursor,
// porque cada lote é limitado a ~20 notas pra caber no cap de subrequests do Cloudflare.
//
// Uso:
//   node scripts/backfill-similar.mjs <worker-url>
//   WORKER_URL=https://expert-brain.SEU.workers.dev node scripts/backfill-similar.mjs
//
// Idempotente: pode re-rodar a qualquer momento (sobrescreve, não acumula). Notas novas
// salvas DEPOIS do deploy já populam sozinhas pelo write path — isto é só pro acervo antigo.

const url = (process.argv[2] || process.env.WORKER_URL || '').replace(/\/+$/, '');
if (!url) {
  console.error('Faltou a URL do Worker. Uso: node scripts/backfill-similar.mjs <worker-url>');
  process.exit(1);
}

// O endpoint exige Bearer (spec 10-backend/18) — cada lote custa ate 41 subrequests
// + writes reais. Token vem do ambiente, nunca de argumento (some do history).
const bearer = process.env.GRAPH_EXPORT_TOKEN || process.env.BRAIN_SETUP_TOKEN;
if (!bearer) {
  console.error(
    'Faltou credencial: sete GRAPH_EXPORT_TOKEN (ou BRAIN_SETUP_TOKEN) no ambiente com o Bearer do Worker.\n' +
      'Ex.: GRAPH_EXPORT_TOKEN=... node scripts/backfill-similar.mjs <worker-url>'
  );
  process.exit(1);
}
const AUTH_HEADERS = { authorization: `Bearer ${bearer}` };

async function sweep(passLabel) {
  let cursor = '';
  let totals = { processed: 0, edges: 0, missing: 0, failed: 0, calls: 0 };
  for (;;) {
    const res = await fetch(`${url}/setup/backfill-similar?after=${encodeURIComponent(cursor)}`, {
      method: 'POST',
      headers: AUTH_HEADERS,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} no lote (cursor='${cursor}'): ${body.slice(0, 200)}`);
    }
    const r = await res.json();
    totals.calls++;
    if (r.done) break;
    totals.processed += r.processed ?? 0;
    totals.edges += r.edges ?? 0;
    totals.missing += r.missing ?? 0;
    totals.failed += r.failed ?? 0;
    cursor = r.cursor;
    process.stdout.write(
      `\r[${passLabel}] lotes:${totals.calls} processadas:${totals.processed} edges:${totals.edges} ` +
      `missing:${totals.missing} failed:${totals.failed}   `
    );
  }
  process.stdout.write('\n');
  return totals;
}

(async () => {
  console.log(`Backfill de similar edges em ${url} ...`);
  const first = await sweep('passe 1');
  console.log(`Passe 1: ${first.processed} notas, ${first.edges} edges, ${first.missing} sem vetor indexado, ${first.failed} com erro.`);

  // Notas 'missing' tinham vetor ainda não indexado (consistência eventual do Vectorize).
  // Um segundo passe, após dar tempo do índice assentar, costuma capturá-las.
  if (first.missing > 0) {
    console.log(`Aguardando 90s pro Vectorize indexar as ${first.missing} pendentes e re-varrendo...`);
    await new Promise((r) => setTimeout(r, 90_000));
    const second = await sweep('passe 2');
    console.log(`Passe 2: +${second.processed} notas, +${second.edges} edges, ${second.missing} ainda sem vetor, ${second.failed} com erro.`);
    if (second.missing > 0) {
      console.log(`Ainda há ${second.missing} notas sem vetor indexado — provavelmente nunca foram embedadas. Use reembed nelas se precisar que entrem na teia.`);
    }
  }
  console.log('Backfill concluído. O grafo invalida o cache sozinho (sourceHash inclui similar_edges).');
})().catch((err) => {
  console.error('\nFalhou:', err.message);
  process.exit(1);
});
