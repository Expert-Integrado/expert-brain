import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// Categoria 'mapeado' (decisão fh39xlmxi973, task 9zfjcquprh03): sub-vault
// default-off. Invisível em recall/listagem/grafo sem filtro explícito; MAS
// get_contact_by_phone e o dossiê por id SEMPRE retornam (caso de uso: "encontrei
// a pessoa, me dá tudo que ela já falou"). Nos testes o Vectorize não existe, então
// o recall roda em sql_like — o filtro default vale igual nos dois modos.

const OWNER = 'test-owner-token';
const authHeaders = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };

function post(path: string, body: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}
function get(path: string) {
  return SELF.fetch(`https://x${path}`, { headers: { authorization: `Bearer ${OWNER}` } });
}

let phoneSeq = 0;
const nextPhone = () => `5521${String(900000000 + phoneSeq++).padStart(9, '0')}`;

async function createMapeado(name: string): Promise<{ id: string; phone: string }> {
  const phone = nextPhone();
  const res = await post('/save_person', { name, phone, category: 'mapeado', source: 'whatsapp' });
  expect(res.status).toBe(200);
  const j: any = await res.json();
  return { id: j.id, phone };
}

describe('canon e escrita', () => {
  it('GET /canon expõe mapeado em contact_categories', async () => {
    const res = await get('/canon');
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.contact_categories).toContain('mapeado');
  });

  it('save_person aceita category mapeado', async () => {
    const { id } = await createMapeado('Mapeado Aceito');
    expect(id).toBeTruthy();
  });
});

describe('default-off nas superfícies de busca/listagem', () => {
  it('recall sem filtro NÃO retorna mapeado; com category=mapeado retorna', async () => {
    await createMapeado('Zulmira Mapeada Recall');
    const semFiltro: any = await (await get('/recall_person?q=Zulmira%20Mapeada')).json();
    expect((semFiltro.results || []).some((r: any) => r.name === 'Zulmira Mapeada Recall')).toBe(false);

    const comFiltro: any = await (await get('/recall_person?q=Zulmira%20Mapeada&category=mapeado')).json();
    expect((comFiltro.results || []).some((r: any) => r.name === 'Zulmira Mapeada Recall')).toBe(true);
  });

  it('list_entities sem filtro NÃO lista mapeado; com category=mapeado lista', async () => {
    await createMapeado('Waldete Mapeada List');
    const sem: any = await (await get('/list_entities?limit=1000')).json();
    expect(sem.ok).toBe(true);
    expect((sem.results || []).some((r: any) => r.name === 'Waldete Mapeada List')).toBe(false);

    const com: any = await (await get('/list_entities?category=mapeado&limit=1000')).json();
    expect(com.ok).toBe(true);
    expect((com.results || []).some((r: any) => r.name === 'Waldete Mapeada List')).toBe(true);
  });

  it('recall com OUTRO filtro de categoria segue sem vazar mapeado', async () => {
    await createMapeado('Xerxes Mapeado Cat');
    const r: any = await (await get('/recall_person?q=Xerxes%20Mapeado&category=cliente')).json();
    expect((r.results || []).some((x: any) => x.name === 'Xerxes Mapeado Cat')).toBe(false);
  });
});

describe('default-off no grafo', () => {
  it('GET /graph/data não traz nó mapeado nem aresta que toca nele', async () => {
    const { id } = await createMapeado('Yolanda Mapeada Grafo');
    const alvo = await post('/save_person', { name: 'Alvo Publico Grafo', phone: nextPhone() });
    const alvoId = ((await alvo.json()) as any).id;
    const conn = await post('/connect', {
      a_id: id, b_id: alvoId, type: 'peer_tech', strength: 0.5,
      why: 'teste de exclusão do grafo default-off (mapeado não pode aparecer)',
    });
    expect(conn.status).toBe(200);

    const g: any = await (await get('/graph/data')).json();
    expect((g.nodes || []).some((n: any) => n.id === id)).toBe(false);
    expect((g.edges || []).some((e: any) => e.a_id === id || e.b_id === id)).toBe(false);
    // o nó público segue elegível (não é derrubado junto)
    expect((g.nodes || []).some((n: any) => n.id === alvoId) || (g.edges || []).length === 0).toBe(true);
  });
});

describe('exceções deliberadas — sempre retornam', () => {
  it('get_contact_by_phone resolve mapeado normalmente', async () => {
    const { id, phone } = await createMapeado('Ubaldo Mapeado Fone');
    const r: any = await (await get(`/get_contact_by_phone?phone=${phone}`)).json();
    expect(r.match?.id).toBe(id);
    expect(r.match?.category).toBe('mapeado');
  });

  it('dossiê por id (GET /entities/:id) retorna mapeado completo', async () => {
    const { id } = await createMapeado('Tereza Mapeada Dossie');
    const res = await get(`/entities/${id}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.entity?.name).toBe('Tereza Mapeada Dossie');
    expect(j.entity?.category).toBe('mapeado');
  });
});
