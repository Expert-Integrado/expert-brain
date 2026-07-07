import { describe, it, expect } from 'vitest';
import { toolError, toolSuccess, safeToolHandler } from '../src/mcp/helpers.js';

describe('helpers', () => {
  it('toolError shape', () => {
    const r = toolError('x');
    expect(r).toEqual({ content: [{ type: 'text', text: 'x' }], isError: true });
  });

  it('toolSuccess stringifies objects', () => {
    const r = toolSuccess({ a: 1 });
    expect(r.content[0].text).toContain('"a": 1');
  });

  it('safeToolHandler catches D1 error', async () => {
    const h = safeToolHandler(async () => { throw new Error('D1_ERROR: something'); });
    const r = await h();
    expect((r as any).isError).toBe(true);
    expect((r as any).content[0].text).toContain('vault database');
  });

  // spec 10-backend/23: a mensagem do Workers AI não pode afirmar "nothing was
  // saved" universalmente — update_note grava o D1 ANTES de embedar.
  it('Workers AI error message instructs verify-then-reembed, never claims universal no-write', async () => {
    const h = safeToolHandler(async () => { throw new Error('Workers AI: model overloaded'); });
    const r = await h();
    const text = (r as any).content[0].text as string;
    expect((r as any).isError).toBe(true);
    expect(text).toContain('get_note');
    expect(text).toContain('reembed');
    // continua comunicando que save_note é retry seguro (embeda antes de gravar)
    expect(text).toContain('save_note embeds BEFORE writing');
    expect(text).toContain('update_note writes to the database BEFORE embedding');
    // a afirmação antiga (falsa pro update_note) não pode voltar
    expect(text).not.toContain('was NOT saved');
    expect(text).not.toContain('there are no partial writes');
  });
});
