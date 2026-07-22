import { describe, it, expect } from 'vitest';
import { vectorMetadataFor } from '../../src/contacts/index';

// Spec 10-backend/20 — vectorMetadataFor é o ÚNICO ponto que monta metadata de
// vetor. Garante raw derivado do nome + propagação de category/source.

describe('vectorMetadataFor', () => {
  it('raw=true pra nome só-dígitos', () => {
    const m = vectorMetadataFor({ name: '5511987654321', kind: 'person' }, 'texto');
    expect(m.raw).toBe(true);
  });

  it('raw=false pra nome com letra', () => {
    const m = vectorMetadataFor({ name: 'Fulano de Tal', kind: 'person' }, 'texto');
    expect(m.raw).toBe(false);
  });

  it('propaga category quando presente', () => {
    const m = vectorMetadataFor({ name: 'X', kind: 'person', category: 'cliente' }, 't');
    expect(m.category).toBe('cliente');
  });

  it('category=null quando ausente', () => {
    const m = vectorMetadataFor({ name: 'X', kind: 'person' }, 't');
    expect(m.category).toBeNull();
  });

  it('propaga source e null quando ausente', () => {
    expect(vectorMetadataFor({ name: 'X', kind: 'person', source: 'pipedrive' }, 't').source).toBe('pipedrive');
    expect(vectorMetadataFor({ name: 'X', kind: 'person' }, 't').source).toBeNull();
  });

  it('name/kind e text truncado em 500', () => {
    const long = 'a'.repeat(600);
    const m = vectorMetadataFor({ name: 'Ana', kind: 'company' }, long);
    expect(m.name).toBe('Ana');
    expect(m.kind).toBe('company');
    expect(m.text.length).toBe(500);
  });
});
