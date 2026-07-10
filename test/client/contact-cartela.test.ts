// Cartela da página de contato (pedido 10/07): rótulo repetido N vezes vira UM
// bloco de chips ("Grupo em comum" x N → "Grupos em comum" com N chips), campos
// únicos continuam linha a linha. jsdom (vitest.client.config.ts).
import { describe, it, expect } from 'vitest';
import { renderHeaderAndCartela } from '../../src/web/client/contact-page.js';

function mount(fields: Array<{ label: string; value: string; href?: string; primary?: boolean }>): HTMLElement {
  const el = document.createElement('div');
  renderHeaderAndCartela(el, 'ent-1', { ok: true, title: 'Fulana Teste', kind: 'person', fields });
  return el;
}

describe('cartela — agrupamento de rótulos repetidos em chips', () => {
  it('3 fields "Grupo em comum" viram UM bloco "Grupos em comum" com 3 chips', () => {
    const el = mount([
      { label: 'E-mail', value: 'a@b.c', primary: true },
      { label: 'Grupo em comum', value: 'Time Comercial' },
      { label: 'Grupo em comum', value: 'Mentoria G4' },
      { label: 'Grupo em comum', value: 'Família' },
    ]);
    const dts = [...el.querySelectorAll('.contact-page-field dt')].map((d) => d.textContent?.trim());
    expect(dts).toEqual(['E-mail ★', 'Grupos em comum']); // um bloco só, sem repetição
    const chips = [...el.querySelectorAll('.contact-page-chips .contact-page-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Time Comercial', 'Mentoria G4', 'Família']);
  });

  it('label repetido sem plural mapeado agrupa com o próprio label; href vira chip-link', () => {
    const el = mount([
      { label: 'Telefone', value: '11 90000-0001', href: 'https://wa.me/5511900000001' },
      { label: 'Telefone', value: '11 90000-0002' },
    ]);
    const dts = [...el.querySelectorAll('.contact-page-field dt')].map((d) => d.textContent?.trim());
    expect(dts).toEqual(['Telefone']);
    expect(el.querySelectorAll('a.contact-page-chip')).toHaveLength(1);
    expect(el.querySelectorAll('span.contact-page-chip')).toHaveLength(1);
  });

  it('campos únicos continuam como linha dt/dd normal, sem chips', () => {
    const el = mount([
      { label: 'Empresa', value: 'ACME' },
      { label: 'Cargo', value: 'CEO' },
    ]);
    expect(el.querySelector('.contact-page-chips')).toBeNull();
    const dts = [...el.querySelectorAll('.contact-page-field dt')].map((d) => d.textContent?.trim());
    expect(dts).toEqual(['Empresa', 'Cargo']);
  });
});
