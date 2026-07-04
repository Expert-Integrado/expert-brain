import { describe, it, expect } from 'vitest';
import { createSaveQueue, type SaveResult } from '../../src/web/client/save-queue.js';

// Helper: promise controlável (resolve manualmente) pra simular fetch em voo.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('createSaveQueue — serialização de rajada (spec 36 fase 5)', () => {
  it('rajada de 2 patches: 2º espera o 1º e reenvia com o updated_at FRESCO', async () => {
    let expected = 1000;
    const calls: Array<{ patch: Record<string, unknown>; expected: number | null }> = [];
    const gates = [deferred<SaveResult>(), deferred<SaveResult>()];
    let i = 0;

    const q = createSaveQueue({
      getExpected: () => expected,
      setExpected: (v) => { expected = v; },
      send: (patch, exp) => {
        calls.push({ patch, expected: exp });
        return gates[i++].promise;
      },
    });

    // Duas edições em rajada (kind, depois domínio) antes de qualquer resposta.
    q.enqueue({ kind: 'insight' });
    q.enqueue({ domains: ['sales'] });

    // Só o 1º saiu (fila de profundidade 1); o 2º está coalescido, aguardando.
    expect(calls).toHaveLength(1);
    expect(calls[0].patch).toEqual({ kind: 'insight' });
    expect(calls[0].expected).toBe(1000);
    expect(q.isBusy()).toBe(true);

    // 1º responde com updated_at fresco 2000.
    gates[0].resolve({ ok: true, updatedAt: 2000 });
    await Promise.resolve(); await Promise.resolve();

    // Agora o 2º saiu, com o expected ATUALIZADO pra 2000 (não o 1000 velho).
    expect(calls).toHaveLength(2);
    expect(calls[1].patch).toEqual({ domains: ['sales'] });
    expect(calls[1].expected).toBe(2000);

    gates[1].resolve({ ok: true, updatedAt: 3000 });
    await Promise.resolve(); await Promise.resolve();
    expect(expected).toBe(3000);
    expect(q.isBusy()).toBe(false);
  });

  it('coalesce: múltiplas edições enquanto em voo viram UM patch mesclado', async () => {
    let expected = 1000;
    const calls: Array<Record<string, unknown>> = [];
    const gates = [deferred<SaveResult>(), deferred<SaveResult>()];
    let i = 0;
    const q = createSaveQueue({
      getExpected: () => expected,
      setExpected: (v) => { expected = v; },
      send: (patch) => { calls.push(patch); return gates[i++].promise; },
    });

    q.enqueue({ a: 1 });        // dispara
    q.enqueue({ b: 2 });        // pendente
    q.enqueue({ b: 3, c: 4 });  // coalesce no pendente (b vira 3, +c)

    expect(calls).toHaveLength(1);
    gates[0].resolve({ ok: true, updatedAt: 2000 });
    await Promise.resolve(); await Promise.resolve();

    // O 2º envio é o merge dos pendentes: { b: 3, c: 4 }.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ b: 3, c: 4 });
  });

  it('conflito (ok=false): não avança a base e descarta o pendente', async () => {
    let expected = 1000;
    const calls: Array<Record<string, unknown>> = [];
    const gates = [deferred<SaveResult>()];
    let i = 0;
    const q = createSaveQueue({
      getExpected: () => expected,
      setExpected: (v) => { expected = v; },
      send: (patch) => { calls.push(patch); return gates[i++].promise; },
    });

    q.enqueue({ a: 1 });
    q.enqueue({ b: 2 }); // pendente

    gates[0].resolve({ ok: false, updatedAt: null }); // 409
    await Promise.resolve(); await Promise.resolve();

    // Base intacta; o pendente foi descartado (não reenviou).
    expect(expected).toBe(1000);
    expect(calls).toHaveLength(1);
    expect(q.isBusy()).toBe(false);
  });
});
