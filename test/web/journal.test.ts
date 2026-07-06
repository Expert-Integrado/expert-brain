import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// GET /app/journal (specs/50-console-v2/65-home-hoje-e-journal.md §3). O service
// binding CONTACTS não é exercitado aqui — mesmo padrão do resto do repo (ver
// test/contacts-entity-event-proxy.test.ts): a fonte "interações" degrada
// graciosamente (critério de aceite) e o teste cobre notas+tasks, que já bastam
// pra validar merge de múltiplas fontes + paginação. Fixtures no ANO 2999 pra
// isolar do resto do banco compartilhado (isolatedStorage:false).

const E = env as any;
const NOTE_COLS = `(id,title,body,tldr,domains,kind,created_at,updated_at,private)`;
const TASK_COLS = `(id,title,body,tldr,domains,kind,status,created_at,updated_at,completed_at,private)`;

function futureTs(offsetMin: number): number {
  return Date.UTC(2999, 2, 1, 0, offsetMin, 0); // 2999-03-01 base
}

async function insertNoteRow(id: string, ts: number) {
  await E.DB.prepare(`INSERT INTO notes ${NOTE_COLS} VALUES (?,?,?,?,?,'insight',?,?,0)`)
    .bind(id, id, 'b', 't', '["operations"]', ts, ts).run();
}

async function insertTaskRow(id: string, ts: number) {
  await E.DB.prepare(`INSERT INTO notes ${TASK_COLS} VALUES (?,?,?,?,?,'task','open',?,?,null,0)`)
    .bind(id, id, 'b', 't', '["operations"]', ts, ts).run();
}

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  await runMigrations(E);
});

describe('GET /app/journal — auth e degradação (spec 65)', () => {
  it('sem sessão → 302', async () => {
    const res = await SELF.fetch('https://x.test/app/journal', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('com sessão, CONTACTS não configurado → 200 com aviso de degradação, sem quebrar', async () => {
    const res = await SELF.fetch('https://x.test/app/journal', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Interações de contato indisponíveis');
  });
});

describe('GET /app/journal — ordem cronológica + agrupamento por dia (spec 65 §3)', () => {
  it('notas e tasks intercaladas renderizam em ordem ts DESC com cabeçalho de dia', async () => {
    await insertNoteRow('jtest-note-new', futureTs(100));
    await insertTaskRow('jtest-task-mid', futureTs(90));
    await insertNoteRow('jtest-note-old', futureTs(80));

    const res = await SELF.fetch('https://x.test/app/journal', { headers: { cookie: await cookie() } });
    const html = await res.text();
    const idxNew = html.indexOf('jtest-note-new');
    const idxMid = html.indexOf('jtest-task-mid');
    const idxOld = html.indexOf('jtest-note-old');
    expect(idxNew).toBeGreaterThan(0);
    expect(idxMid).toBeGreaterThan(idxNew);
    expect(idxOld).toBeGreaterThan(idxMid);
    // Os 3 caem no MESMO dia BRT (2999-02-28) — nenhum cabeçalho de dia novo se
    // interpõe entre eles (o banco de teste é compartilhado entre arquivos —
    // isolatedStorage:false — então não assumimos a contagem TOTAL de cabeçalhos,
    // só que estes 3 específicos ficam sob o MESMO grupo).
    const between = html.slice(idxNew, idxOld);
    expect((between.match(/journal-day/g) || []).length).toBe(0);
  });
});

describe('GET /app/journal — "Carregar mais" (spec 65 §3, critério de merge)', () => {
  it('35 tasks futuras: página 1 (accept html) + página 2 (accept json) sem duplicar nem pular', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 35; i++) {
      // Zero-padded: sem isso, "jpage-t1" é PREFIXO de "jpage-t10".."jpage-t19" e o
      // .includes() do teste dá falso positivo.
      const id = `jpage-t${String(i).padStart(2, '0')}`;
      ids.push(id);
      await insertTaskRow(id, futureTs(1000 + i));
    }

    const page1 = await SELF.fetch('https://x.test/app/journal', { headers: { cookie: await cookie() } });
    const html1 = await page1.text();
    const loadMoreMatch = html1.match(/id="journal-load-more" class="notes-load-more" href="([^"]+)"/);
    expect(loadMoreMatch).toBeTruthy();
    const nextHref = loadMoreMatch![1].replace(/&amp;/g, '&');

    const seenOnPage1 = ids.filter((id) => html1.includes(id));
    expect(seenOnPage1.length).toBeGreaterThan(0);

    const page2 = await SELF.fetch(`https://x.test${nextHref}`, {
      headers: { cookie: await cookie(), accept: 'application/json' },
    });
    expect(page2.status).toBe(200);
    const j: any = await page2.json();
    expect(j.ok).toBe(true);

    const seenOnPage2 = ids.filter((id) => j.html.includes(id));
    expect(seenOnPage2.length).toBeGreaterThan(0);
    // Nenhum id aparece nas duas páginas.
    for (const id of seenOnPage2) expect(seenOnPage1).not.toContain(id);
    // Juntas, as duas páginas cobrem TODAS as 35 tasks (nenhuma pulada).
    const union = new Set([...seenOnPage1, ...seenOnPage2]);
    expect(union.size).toBe(35);
  });
});
