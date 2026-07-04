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
});
