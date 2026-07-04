import { marked } from 'marked';
import { esc } from '../util/html.js';

marked.setOptions({
  gfm: true,
  breaks: false,
  async: false,
});

// Drop all raw HTML tokens (block and inline) so no raw HTML survives into output.
// In marked v18 the renderer receives a token object { text, ... }.
marked.use({
  renderer: {
    html: () => '',
  },
});

export interface WikilinkResolver {
  // Lowercased title → id. Used when [[some title]] is passed as display text.
  titleIndex: Map<string, string>;
  // Set of existing ids. Used when [[abc123def456]] is passed as a bare id.
  idSet: Set<string>;
  // Avoid linking a note to itself.
  currentId?: string;
}

// Resolve [[target]] and [[target|label]] wikilinks.
// - Bare nanoid (10-14 chars alphanumeric/_-) checked against idSet first
// - Otherwise falls back to lowercased title lookup
// - Unresolved → rendered as broken-link span
function renderWikilinks(html: string, resolver: WikilinkResolver): string {
  return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_match, target, label) => {
    const raw = String(target).trim();
    const display = (label ?? target).toString().trim();
    if (!raw) return _match;

    let id: string | undefined;
    // Bare id path
    if (/^[A-Za-z0-9_-]{10,24}$/.test(raw) && resolver.idSet.has(raw)) {
      id = raw;
    } else {
      const hit = resolver.titleIndex.get(raw.toLowerCase());
      if (hit) id = hit;
    }

    if (!id || id === resolver.currentId) {
      return `<span class="wikilink broken" title="Unresolved link">${esc(display)}</span>`;
    }
    return `<a class="wikilink" href="/app/notes/${encodeURIComponent(id)}">${esc(display)}</a>`;
  });
}

export function renderMarkdown(src: string, resolver?: WikilinkResolver): string {
  const html = marked.parse(src, { async: false }) as string;
  if (!resolver) return html;
  return renderWikilinks(html, resolver);
}
