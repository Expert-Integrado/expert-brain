import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { provisionContacts, ensureContactsBinding } from '../../src/contacts-gateway.js';
import { registerContactsTools } from '../../src/mcp/tools/contacts.js';
import type { AuthContext } from '../../src/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fusão F6: as 6 write tools de contato do MCP, exercitadas de PONTA A PONTA —
// handler real (schema já validado pelo SDK em prod; aqui chamamos o handler
// direto) → callContactsWrite (Bearer CONTACTS_OWNER_TOKEN) → adapter in-process
// (env.CONTACTS) → router vendorizado do contacts → D1 DB_CONTACTS. Prova que a
// escrita fechou o círculo sem W2W, com o token de dono. A visibilidade por
// escopo (read/contacts:none suprimem) é coberta por test/registry-scope.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const E = env as any;
const AUTH: AuthContext = { email: 'owner@example.com', loggedInAt: 0, scopes: 'full' };

// Coletor de tools (mesmo padrão de registry-scope.test.ts): registra os handlers
// por nome, num env com o adapter in-process de contatos injetado.
function contactsToolset(overrideEnv?: any) {
  const wEnv = { ...(overrideEnv ?? E) };
  ensureContactsBinding(wEnv); // injeta wEnv.CONTACTS (Fetcher in-process)
  const tools: Record<string, { config: any; handler: any }> = {};
  const server = {
    registerTool: (name: string, config: any, handler: any) => { tools[name] = { config, handler }; },
  };
  registerContactsTools(server, wEnv, AUTH);
  return tools;
}

function ok(r: any): any {
  expect(r.isError, `esperava sucesso, veio erro: ${r?.content?.[0]?.text}`).toBeFalsy();
  return JSON.parse(r.content[0].text);
}
function errText(r: any): string {
  expect(r.isError).toBe(true);
  return r.content[0].text as string;
}

beforeAll(async () => {
  await runMigrations(E);
  await provisionContacts(E);
});

describe('F6 write tools — ciclo de vida completo in-process', () => {
  it('save_contact cria pessoa, dedupe por telefone no 2º save (update)', async () => {
    const t = contactsToolset();
    const created = ok(await t.save_contact.handler({ name: 'Ana F6', phone: '+5511970001111', role: 'CEO', category: 'cliente' }));
    const id = created.id ?? created.entity?.id;
    expect(id).toBeTruthy();
    expect(created.action).toBe('created');
    // mesmo telefone (variante sem 9 → o dedupe do endpoint resolve pra MESMA entidade)
    const again = ok(await t.save_contact.handler({ name: 'Ana F6 (atualizada)', phone: '5511970001111', notes_text: 'nota nova' }));
    expect(again.action).toBe('updated');
    expect((again.id ?? again.entity?.id)).toBe(id);
  });

  it('connect_contacts liga duas pessoas; delete_contact_connection remove só a aresta', async () => {
    const t = contactsToolset();
    const a = ok(await t.save_contact.handler({ name: 'Bruno F6', phone: '+5511970002222' }));
    const b = ok(await t.save_contact.handler({ name: 'Carla F6', phone: '+5511970003333' }));
    const aId = a.id ?? a.entity?.id, bId = b.id ?? b.entity?.id;

    const conn = ok(await t.connect_contacts.handler({
      a_id: aId, b_id: bId, type: 'friend', strength: 0.8,
      why: 'trabalharam juntos na mesma equipe por anos',
    }));
    expect(conn.id).toBeTruthy();

    // get_contact (read tool no mesmo toolset) mostra a conexão
    const detail = ok(await t.get_contact.handler({ id: aId }));
    const conns = detail.connections ?? detail.edges ?? [];
    expect(Array.isArray(conns) && conns.length >= 1).toBe(true);

    const del = ok(await t.delete_contact_connection.handler({ id: conn.id, confirm: true }));
    expect(del.ok).toBe(true);
    // ambos os contatos continuam existindo
    expect(ok(await t.get_contact.handler({ id: aId })).id ?? true).toBeTruthy();
    expect(ok(await t.get_contact.handler({ id: bId })).id ?? true).toBeTruthy();
  });

  it('log_contact_event grava interação na timeline', async () => {
    const t = contactsToolset();
    const p = ok(await t.save_contact.handler({ name: 'Diego F6', phone: '+5511970004444' }));
    const pid = p.id ?? p.entity?.id;
    const ev = ok(await t.log_contact_event.handler({ entity_id: pid, kind: 'talked', context: 'call de alinhamento' }));
    expect(ev.ok).toBe(true);
    expect(ev.id).toBeTruthy();
  });

  it('merge_contacts funde duplicata do mesmo kind (winner sobrevive, loser some)', async () => {
    const t = contactsToolset();
    const winner = ok(await t.save_contact.handler({ name: 'Elisa F6', phone: '+5511970005555', role: 'CTO' }));
    const loser = ok(await t.save_contact.handler({ name: 'Elisa F6 dup', phone: '+5511970006666', email: 'elisa@ex.com' }));
    const wId = winner.id ?? winner.entity?.id, lId = loser.id ?? loser.entity?.id;

    const merged = ok(await t.merge_contacts.handler({ winner_id: wId, loser_id: lId, confirm: true }));
    expect(merged.ok !== false).toBe(true);
    // loser sumiu; winner permanece
    const gone = await t.get_contact.handler({ id: lId });
    expect(gone.isError).toBe(true); // 404 → contactsError
    expect(ok(await t.get_contact.handler({ id: wId })).id ?? true).toBeTruthy();
  });

  it('delete_contact faz HARD delete (get depois vira erro 404)', async () => {
    const t = contactsToolset();
    const p = ok(await t.save_contact.handler({ name: 'Fabio F6', phone: '+5511970007777' }));
    const pid = p.id ?? p.entity?.id;
    const del = ok(await t.delete_contact.handler({ id: pid, confirm: true }));
    expect(del.ok).toBe(true);
    const after = await t.get_contact.handler({ id: pid });
    expect(after.isError).toBe(true);
    expect(errText(after)).toContain('not found');
  });

  it('erro de endpoint mapeado: connect com id inexistente → 404 amigável', async () => {
    const t = contactsToolset();
    const r = await t.connect_contacts.handler({
      a_id: 'nao-existe-1', b_id: 'nao-existe-2', type: 'friend', strength: 0.5,
      why: 'contexto suficientemente longo pra passar no minimo',
    });
    expect(r.isError).toBe(true);
  });

  it('inerte sem CONTACTS_OWNER_TOKEN (modo dual / pré-cutover) → 503 explicado', async () => {
    // Sem o owner token, callContactsWrite nunca chama o módulo — reporta config.
    const bare = { ...E, CONTACTS_OWNER_TOKEN: undefined };
    const t = contactsToolset(bare);
    const r = await t.save_contact.handler({ name: 'Zé Inerte' });
    expect(r.isError).toBe(true);
    expect(errText(r)).toContain('not configured');
  });
});
