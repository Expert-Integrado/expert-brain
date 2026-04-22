import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders basic markdown to HTML', () => {
    const out = renderMarkdown('# Hello\n\n**bold**');
    expect(out).toContain('<h1');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('strips raw HTML block tags', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips raw HTML img onerror', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
  });

  it('strips inline iframe', () => {
    const out = renderMarkdown('Text <iframe src="evil"></iframe> more');
    expect(out).not.toContain('<iframe');
  });

  it('resolves wikilinks by id', () => {
    const resolver = {
      titleIndex: new Map<string, string>(),
      idSet: new Set(['abc1234567ef']),
    };
    const out = renderMarkdown('See [[abc1234567ef]] for details', resolver);
    expect(out).toContain('<a class="wikilink" href="/app/notes/abc1234567ef"');
  });

  it('resolves wikilinks by title (case-insensitive)', () => {
    const resolver = {
      titleIndex: new Map([['my cool note', 'xyz999']]),
      idSet: new Set(['xyz999']),
    };
    const out = renderMarkdown('See [[My Cool Note]] for details', resolver);
    expect(out).toContain('/app/notes/xyz999');
    expect(out).toContain('>My Cool Note<');
  });

  it('marks unresolved wikilinks as broken', () => {
    const resolver = {
      titleIndex: new Map<string, string>(),
      idSet: new Set<string>(),
    };
    const out = renderMarkdown('Missing [[unknown]] here', resolver);
    expect(out).toContain('wikilink broken');
    expect(out).not.toContain('href');
  });

  it('supports label syntax [[id|display]]', () => {
    const resolver = {
      titleIndex: new Map<string, string>(),
      idSet: new Set(['abc1234567ef']),
    };
    const out = renderMarkdown('Click [[abc1234567ef|here]]', resolver);
    expect(out).toContain('/app/notes/abc1234567ef');
    expect(out).toContain('>here<');
  });
});
