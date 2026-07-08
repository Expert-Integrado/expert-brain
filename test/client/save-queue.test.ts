// Testes do serializador de autosave (src/web/client/save-queue.ts) — camada
// client em jsdom (specs/60-ux-reforma/61). Cobre a garantia central: saves em
// rajada viram cadeia sequencial com expected_updated_at fresco, coalescendo
// patches intermediários.
import { describe, it, expect, vi } from 'vitest';
import { createSaveQueue, type SaveResult } from '../../src/web/client/save-queue.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('createSaveQueue', () => {
  it('envia o patch com o expected atual e avança a base no sucesso', async () => {
    let expected: number | null = 100;
    const send = vi.fn(async (): Promise<SaveResult> => ({ updatedAt: 200, ok: true }));
    const q = createSaveQueue({
      send,
      getExpected: () => expected,
      setExpected: (v) => { expected = v; },
    });
    q.enqueue({ kind: 'insight' });
    await vi.waitFor(() => expect(q.isBusy()).toBe(false));
    expect(send).toHaveBeenCalledWith({ kind: 'insight' }, 100);
    expect(expected).toBe(200);
  });

  it('coalesce: 3 enqueues durante um voo viram 1 reenvio com merge (o mais novo vence)', async () => {
    let expected: number | null = 1;
    const first = deferred<SaveResult>();
    const calls: Array<[Record<string, unknown>, number | null]> = [];
    const send = vi.fn(async (patch: Record<string, unknown>, exp: number | null) => {
      calls.push([patch, exp]);
      if (calls.length === 1) return first.promise;
      return { updatedAt: 3, ok: true };
    });
    const q = createSaveQueue({
      send,
      getExpected: () => expected,
      setExpected: (v) => { expected = v; },
    });
    q.enqueue({ a: 1 });               // entra em voo
    q.enqueue({ b: 2 });               // pendente
    q.enqueue({ b: 3, c: 4 });         // coalesce em cima do pendente
    expect(q.isBusy()).toBe(true);
    first.resolve({ updatedAt: 2, ok: true });
    await vi.waitFor(() => expect(q.isBusy()).toBe(false));
    expect(calls.length).toBe(2);
    expect(calls[1][0]).toEqual({ b: 3, c: 4 });
    expect(calls[1][1]).toBe(2); // reenvio usa a base FRESCA da resposta anterior
    expect(expected).toBe(3);
  });

  it('erro (ok=false) interrompe a cadeia: pendente é descartado e a base não avança', async () => {
    let expected: number | null = 10;
    const first = deferred<SaveResult>();
    const send = vi.fn(async (): Promise<SaveResult> => {
      if (send.mock.calls.length === 1) return first.promise;
      return { updatedAt: 99, ok: true };
    });
    const q = createSaveQueue({
      send,
      getExpected: () => expected,
      setExpected: (v) => { expected = v; },
    });
    q.enqueue({ a: 1 });
    q.enqueue({ b: 2 }); // ficaria pendente
    first.resolve({ updatedAt: null, ok: false });
    await vi.waitFor(() => expect(q.isBusy()).toBe(false));
    expect(send).toHaveBeenCalledTimes(1); // pendente NÃO foi reenviado
    expect(expected).toBe(10);
  });

  it('isBusy reflete voo e pendência', async () => {
    const first = deferred<SaveResult>();
    const q = createSaveQueue({
      send: () => first.promise,
      getExpected: () => null,
      setExpected: () => {},
    });
    expect(q.isBusy()).toBe(false);
    q.enqueue({ a: 1 });
    expect(q.isBusy()).toBe(true);
    first.resolve({ updatedAt: 1, ok: true });
    await vi.waitFor(() => expect(q.isBusy()).toBe(false));
  });
});
