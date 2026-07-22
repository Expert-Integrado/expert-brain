// Fix "Similares por nome" (pedido do dono 10/07/2026): o nome saiu do texto de
// embedding (src/embedding.ts) — grafia parecida de nome (Cíntia ~ Cíntias) gerava
// pares de similaridade sem relação real. Consequências cobertas aqui:
//   1. reembedEntity: entidade sem substância além do nome → vetor DELETADO do
//      índice + similar_edges limpas (action 'removed_empty').
//   2. Busca por NOME vira responsabilidade do LIKE determinístico, mesclado no
//      topo do recall semântico (nameMatchesFor + mergeRecallResults).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { reembedEntity } from '../../src/contacts/entity-write';
import { embeddingTextFor, semanticNotesText } from '../../src/contacts/embedding';
import { nameMatchesFor, mergeRecallResults } from '../../src/contacts/index';

const seed = async (id: string, fields: Record<string, any> = {}) => {
  const e = { kind: 'person', name: 'Fulano', source: 'seed', private: 0, ...fields };
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, role, company, category, private, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, e.kind, e.name, e.role ?? null, e.company ?? null, e.category ?? null, e.private, e.source).run();
};

describe('semanticNotesText — boilerplate de import fora do vetor', () => {
  // Reembed de 10/07/2026 revelou: 3.848 contatos só com o carimbo do Google viravam
  // vetores IDÊNTICOS (pares score 1.0 entre pessoas sem relação real).
  it('carimbo puro do Google Contacts → null (sem semântica)', () => {
    expect(semanticNotesText('imported from Google Contacts 2026-06-20')).toBeNull();
  });

  it('Google labels: preserva os rótulos, descarta o prefixo e o carimbo', () => {
    const out = semanticNotesText('Google labels: FLMA | ADM | imported from Google Contacts 2026-06-20');
    expect(out).toContain('FLMA');
    expect(out).toContain('ADM');
    expect(out).not.toMatch(/imported from/i);
    expect(out).not.toMatch(/google labels/i);
  });

  it('rede de grupos: preserva os nomes de grupo, descarta o prefixo constante', () => {
    const out = semanticNotesText('Mapeado da rede de grupos do Eric. Participa de: Comunidade Avalanche de estudos, Mentoria G4');
    expect(out).toContain('Comunidade Avalanche de estudos');
    expect(out).toContain('Mentoria G4');
    expect(out).not.toContain('Mapeado da rede de grupos');
  });

  it('CRM Pipedrive: preserva o título do negócio, descarta o andaime de contagem', () => {
    const out = semanticNotesText('CRM Pipedrive: 2 negocio(s) (1 aberto, 1 perdido). Destaque: "Projeto Casa Alfa" (R$ 10.000)');
    expect(out).toContain('Projeto Casa Alfa');
    expect(out).not.toMatch(/negocio\(s\)/);
    expect(out).not.toMatch(/CRM Pipedrive:/);
  });

  it('texto livre sem boilerplate passa intacto; null/vazio → null', () => {
    expect(semanticNotesText('arquiteta, fez o projeto da casa de Cotia')).toBe('arquiteta, fez o projeto da casa de Cotia');
    expect(semanticNotesText(null)).toBeNull();
    expect(semanticNotesText('   ')).toBeNull();
  });

  it('embeddingTextFor usa a versão limpa: contato só com carimbo → texto VAZIO', () => {
    expect(embeddingTextFor({ name: 'Fulano', notes_text: 'imported from Google Contacts 2026-06-20' })).toBe('');
  });
});

describe('reembedEntity — entidade só-nome sai do índice (nome fora do vetor)', () => {
  it('texto vazio → deleta o vetor, limpa similar_edges e retorna removed_empty', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await seed(a, { name: 'Cíntia' });
    await seed(b, { name: 'Cíntias' });
    await env.DB.prepare(`INSERT INTO similar_edges (from_id, to_id, score) VALUES (?, ?, 0.9)`).bind(a, b).run();

    const deleted: string[][] = [];
    const mock = { ...env, VECTORIZE: { deleteByIds: async (ids: string[]) => { deleted.push(ids); } } } as any;
    const r = await reembedEntity(mock, a, {
      embeddingTextFor,
      computeEmbedding: async () => { throw new Error('não deveria embedar texto vazio'); },
      upsertVectorize: async () => { throw new Error('não deveria upsertar'); },
      vectorMetadataFor: () => ({}),
    });
    expect(r.action).toBe('removed_empty');
    expect(r.vector).toBeNull();
    expect(deleted).toEqual([[a]]);
    const edges = await env.DB.prepare(`SELECT COUNT(*) AS n FROM similar_edges WHERE from_id = ?`)
      .bind(a).first<{ n: number }>();
    expect(edges?.n).toBe(0);
  });

  it('entidade com substância segue o caminho normal e o texto embedado NÃO contém o nome', async () => {
    const a = crypto.randomUUID();
    await seed(a, { name: 'Cíntia', role: 'arquiteta', company: 'Estúdio X' });
    const upserts: any[] = [];
    const mock = { ...env, VECTORIZE: { deleteByIds: async () => { throw new Error('não deveria deletar'); } } } as any;
    const r = await reembedEntity(mock, a, {
      embeddingTextFor,
      computeEmbedding: async (_e, text) => {
        expect(text).not.toContain('Cíntia');
        expect(text).toContain('arquiteta');
        return [0.1, 0.2];
      },
      upsertVectorize: async (_e, id, vec, meta) => { upserts.push({ id, vec, meta }); },
      vectorMetadataFor: (e: any, text: string) => ({ name: e.name, text }),
    });
    expect(r.action).toBe('upserted');
    expect(r.vector).toEqual([0.1, 0.2]);
    expect(upserts).toHaveLength(1);
    // metadata mantém o nome (exibição/filtro raw) mesmo com o nome fora do texto
    expect(upserts[0].meta.name).toBe('Cíntia');
  });
});

describe('nameMatchesFor — LIKE determinístico por nome pro recall híbrido', () => {
  it('acha por substring do nome (case-insensitive), com score null e match "name"', async () => {
    const id = crypto.randomUUID();
    await seed(id, { name: 'ZzHibrido Fulano Teste' });
    const rows = await nameMatchesFor(env, 'zzhibrido fulano', { limit: 10, includePrivate: true });
    const row = rows.find((r: any) => r.id === id);
    expect(row).toBeTruthy();
    expect(row.score).toBeNull();
    expect(row.match).toBe('name');
  });

  it('NÃO acha por role/company — o merge é só de NOME (o resto é do vetor)', async () => {
    const id = crypto.randomUUID();
    await seed(id, { name: 'Beltrano Qualquer', role: 'zzroleunica999' });
    const rows = await nameMatchesFor(env, 'zzroleunica999', { limit: 10, includePrivate: true });
    expect(rows.some((r: any) => r.id === id)).toBe(false);
  });

  it('privacidade: entidade privada só volta pra quem vê privados', async () => {
    const id = crypto.randomUUID();
    await seed(id, { name: 'ZzPrivada Hibrida', private: 1 });
    const hidden = await nameMatchesFor(env, 'zzprivada hibrida', { limit: 10, includePrivate: false });
    expect(hidden.some((r: any) => r.id === id)).toBe(false);
    const shown = await nameMatchesFor(env, 'zzprivada hibrida', { limit: 10, includePrivate: true });
    expect(shown.some((r: any) => r.id === id)).toBe(true);
  });

  it('filtro por kind e por category', async () => {
    const p = crypto.randomUUID(), c = crypto.randomUUID();
    await seed(p, { name: 'ZzKindFiltro Pessoa', category: 'lead' });
    await seed(c, { name: 'ZzKindFiltro Empresa', kind: 'company' });
    const onlyCompany = await nameMatchesFor(env, 'zzkindfiltro', { limit: 10, includePrivate: true, kindFilter: 'company' });
    expect(onlyCompany.map((r: any) => r.id)).toEqual([c]);
    const onlyLead = await nameMatchesFor(env, 'zzkindfiltro', { limit: 10, includePrivate: true, categoryFilter: 'lead' });
    expect(onlyLead.map((r: any) => r.id)).toEqual([p]);
  });

  it('import cru (nome só-dígitos) escondido por padrão; include_raw mostra', async () => {
    const id = crypto.randomUUID();
    await seed(id, { name: '5511987650001' });
    const hidden = await nameMatchesFor(env, '5511987650001', { limit: 10, includePrivate: true });
    expect(hidden.some((r: any) => r.id === id)).toBe(false);
    const shown = await nameMatchesFor(env, '5511987650001', { limit: 10, includePrivate: true, includeRaw: true });
    expect(shown.some((r: any) => r.id === id)).toBe(true);
  });
});

describe('mergeRecallResults — nome primeiro, dedupe por id, corte no limit', () => {
  it('mescla com prioridade pros matches de nome e deduplica', () => {
    const nameRows = [{ id: 'a', match: 'name' }, { id: 'b', match: 'name' }];
    const semantic = [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }, { id: 'd', score: 0.7 }];
    const out = mergeRecallResults(nameRows as any, semantic as any, 3);
    expect(out.map((r: any) => r.id)).toEqual(['a', 'b', 'c']);
    // o duplicado mantém a versão de NOME (determinística), não a semântica
    expect(out[1].match).toBe('name');
  });

  it('sem matches de nome → devolve os semânticos como antes', () => {
    const semantic = [{ id: 'x', score: 0.9 }, { id: 'y', score: 0.8 }];
    expect(mergeRecallResults([], semantic as any, 10).map((r: any) => r.id)).toEqual(['x', 'y']);
  });
});
