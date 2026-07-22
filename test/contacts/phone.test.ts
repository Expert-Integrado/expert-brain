import { describe, it, expect } from 'vitest';
import { normalizePhone, phoneVariants } from '../../src/contacts/util/phone';

// Funções puras — zero setup, zero D1. Coração do lookup determinístico
// /get_contact_by_phone (9º dígito BR nos dois sentidos).

describe('normalizePhone', () => {
  it('strip de não-dígitos', () => {
    expect(normalizePhone('(11) 98765-4321')).toBe('11987654321');
    expect(normalizePhone('+55 11 98765-4321')).toBe('5511987654321');
  });

  it('undefined => null', () => {
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('string vazia => null', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('< 8 dígitos => null', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('1234567')).toBeNull();
  });

  it('exatamente 8 dígitos => passa', () => {
    expect(normalizePhone('12345678')).toBe('12345678');
  });
});

describe('phoneVariants — 9º dígito BR', () => {
  // Tabela de casos: entrada => variantes esperadas (ordem-agnóstica, checamos
  // presença de cada variante e ausência de ruído com toHaveLength quando faz sentido).
  const table: Array<{ label: string; input: string; expected: string[] }> = [
    {
      label: '13 dígitos COM 9º (551187...) => também a versão SEM o 9',
      input: '5511987654321',
      expected: ['5511987654321', '551187654321'],
    },
    {
      label: '12 dígitos SEM 9º => também a versão COM o 9 adicionado',
      input: '551187654321',
      expected: ['551187654321', '5511987654321'],
    },
    {
      label: '11 dígitos sem DDI (com 9º) => normaliza pra 55... nos dois sentidos',
      input: '11987654321',
      expected: ['11987654321', '5511987654321', '551187654321'],
    },
    {
      label: '10 dígitos sem DDI (sem 9º) => adiciona 55 e o 9',
      input: '1187654321',
      expected: ['1187654321', '551187654321', '5511987654321'],
    },
    {
      label: 'zeros à esquerda => strip do prefixo 0',
      input: '011987654321',
      expected: ['11987654321', '5511987654321', '551187654321'],
    },
  ];

  for (const { label, input, expected } of table) {
    it(label, () => {
      const out = phoneVariants(input);
      for (const e of expected) expect(out).toContain(e);
      expect(out).toHaveLength(expected.length);
    });
  }

  it('COM 9º gera a variante SEM (mão dupla, sentido 1)', () => {
    expect(phoneVariants('5511987654321')).toContain('551187654321');
  });

  it('SEM 9º gera a variante COM (mão dupla, sentido 2)', () => {
    expect(phoneVariants('551187654321')).toContain('5511987654321');
  });

  it('< 8 dígitos => []', () => {
    expect(phoneVariants('1234567')).toEqual([]);
    expect(phoneVariants('')).toEqual([]);
  });

  it('número longo não-BR (14 dígitos sem 55) => só o próprio número', () => {
    expect(phoneVariants('99999999999999')).toEqual(['99999999999999']);
  });

  it('sem duplicatas (Set)', () => {
    const out = phoneVariants('5511987654321');
    expect(new Set(out).size).toBe(out.length);
  });
});
