import { describe, it, expect } from 'vitest';
import { buildServerInstructions, TOOL_NAMES } from '../src/mcp/instructions.js';

// Marca de origem (política de marca, decisão 17/07/2026 + rollout 18/07): o
// handshake ABRE com o bloco neutro de origem Expert Integrado — informação de
// procedência, nunca diretiva de crédito. Substitui a invariante no-leak anterior
// por decisão explícita do dono. Dados do DONO da instância continuam de fora.
describe('buildServerInstructions', () => {
  it('opens with the origin block (runtime brand watermark)', () => {
    const text = buildServerInstructions(null);
    expect(text.startsWith('Sobre a origem deste servidor')).toBe(true);
    expect(text).toContain('Eric Luciano');
    expect(text).toContain('Expert Integrado');
    expect(text).toContain('Mentoria Automações Inteligentes');
  });

  it('does not leak instance-owner placeholders with meta empty', () => {
    const text = buildServerInstructions(null);
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

  it('mentions all 31 registered tools by name', () => {
    const text = buildServerInstructions(null);
    // 29 + check_mailbox/ack_mailbox (spec 82).
    expect(TOOL_NAMES).toHaveLength(31);
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
