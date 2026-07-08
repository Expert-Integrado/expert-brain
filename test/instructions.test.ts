import { describe, it, expect } from 'vitest';
import { buildServerInstructions, TOOL_NAMES } from '../src/mcp/instructions.js';

// Espelha o assert negativo de src/web/config.test.ts:56 — a instância pública
// (alunos) não pode anunciar identidade do mantenedor original no handshake MCP.
describe('buildServerInstructions', () => {
  it('does not leak the original maintainer identity with meta empty', () => {
    const text = buildServerInstructions(null);
    expect(text).not.toContain('Eric Luciano');
    expect(text).not.toContain('Expert Integrado');
    expect(text).not.toContain('CEO');
    expect(text).not.toContain('[seu nome]');
    expect(text).not.toContain('12/05/2026');
  });

  it('falls back to the generic owner phrase when meta is empty', () => {
    const text = buildServerInstructions(null);
    expect(text).toContain('dono da instância');
  });

  it('includes the personalization prompt when present in meta', () => {
    const text = buildServerInstructions('Sou Fulana. Trabalho com produto.');
    expect(text).toContain('Sou Fulana. Trabalho com produto.');
    expect(text).toContain('Contexto do dono (definido em /app/config):');
  });

  it('trims whitespace-only prompt and falls back to generic text', () => {
    const text = buildServerInstructions('   \n  ');
    expect(text).not.toContain('Contexto do dono (definido em /app/config):');
  });

  it('mentions all 28 registered tools by name', () => {
    const text = buildServerInstructions(null);
    expect(TOOL_NAMES).toHaveLength(28);
    for (const name of TOOL_NAMES) {
      expect(text, `instructions devem citar a tool ${name}`).toContain(name);
    }
  });

  it('preserves the pedagogical content (edges, kinds, domains)', () => {
    const text = buildServerInstructions(null);
    expect(text).toContain('same_mechanism_as');
    // 7 kinds canônicos
    for (const kind of ['concept', 'decision', 'insight', 'fact', 'pattern', 'principle', 'question']) {
      expect(text).toContain(kind);
    }
    // 12 domínios canônicos
    for (const domain of [
      'management',
      'sales',
      'marketing',
      'education',
      'ai-applied',
      'leadership',
      'product',
      'operations',
      'personal-development',
      'entrepreneurship',
      'music',
      'cognitive-science',
    ]) {
      expect(text).toContain(domain);
    }
  });
});
