// Serializador de autosave em rajada (spec 36 fase 2, fix do backlog da fase 1).
//
// Problema: mudar 2 campos estruturados em <1s (ex. kind e depois domínio) dispara
// 2 POSTs quase simultâneos, ambos com o MESMO expected_updated_at. O 1º grava e
// avança o updated_at; o 2º chega com o valor VELHO → 409 auto-infligido, mesmo
// sem nenhuma edição concorrente real.
//
// Solução: fila de profundidade 1 por página. Enquanto um save está em voo, o
// PRÓXIMO save não dispara — só guarda o patch mais recente (coalescendo os
// intermediários). Quando o save em voo resolve, o patch pendente é reenviado com o
// updated_at FRESCO devolvido pela resposta anterior. Assim edições rápidas viram
// uma cadeia sequencial, cada uma com o expected_updated_at correto.
//
// `send(patch, expected)` recebe o patch e o expected_updated_at ATUAL (a fila
// sobrescreve esse expected pelo valor fresco quando reenvia). Deve resolver com
// { updatedAt } em sucesso (pra a fila avançar a base), ou lançar/retornar null.
// A fila NÃO conhece HTTP — o caller passa `send` que faz o fetch + trata 409.

export interface SaveResult {
  // updated_at fresco devolvido pelo servidor em sucesso; null = não avançar a base
  // (ex. 409 ou erro — a fila para de reenviar e deixa o caller lidar).
  updatedAt: number | null;
  // ok=false interrompe a cadeia pendente (não reenvia o que estava na fila) — usado
  // em 409/erro pra não amplificar o problema.
  ok: boolean;
}

export type SaveFn = (patch: Record<string, unknown>, expected: number | null) => Promise<SaveResult>;

// getExpected/setExpected leem e escrevem a base de versionamento onde o caller a
// guarda (variável local, dataset do card, etc.) — a fila mantém isso em dia.
export interface SaveQueueOpts {
  send: SaveFn;
  getExpected: () => number | null;
  setExpected: (v: number) => void;
}

export interface SaveQueue {
  // Enfileira um patch. Coalesce campos: se já há um pendente, mescla (o mais novo
  // vence chave a chave) em vez de descartar.
  enqueue(patch: Record<string, unknown>): void;
  // true se há um save em voo ou pendente (pra o beforeunload avisar).
  isBusy(): boolean;
}

export function createSaveQueue(opts: SaveQueueOpts): SaveQueue {
  let inFlight = false;
  let pending: Record<string, unknown> | null = null;

  async function drain(): Promise<void> {
    if (inFlight) return;
    if (!pending) return;
    inFlight = true;
    const patch = pending;
    pending = null;
    try {
      const res = await opts.send(patch, opts.getExpected());
      if (res.ok && typeof res.updatedAt === 'number') {
        opts.setExpected(res.updatedAt);
      }
      if (!res.ok) {
        // Conflito/erro: descarta o pendente pra não reenviar em cima de um estado
        // que o caller já sinalizou como problemático (o caller mostra o aviso).
        pending = null;
      }
    } finally {
      inFlight = false;
      // Se algo chegou enquanto estávamos em voo, drena de novo (com base fresca).
      if (pending) void drain();
    }
  }

  return {
    enqueue(patch: Record<string, unknown>): void {
      pending = pending ? { ...pending, ...patch } : { ...patch };
      void drain();
    },
    isBusy(): boolean {
      return inFlight || pending !== null;
    },
  };
}
