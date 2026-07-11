import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Roda no pool 'node' (vitest.auth.config.ts) — o pool de Workers (vitest.config.ts)
// não tem fs de host. Valida o manifest ESTÁTICO (assets/manifest.webmanifest,
// servido direto pelo binding de assets, sem passar por rota do Worker) contra
// os critérios de aceite de specs/50-console-v2/68-pwa-instalavel.md: JSON válido,
// share_target/shortcuts novos presentes e nada do PWA existente (ícones, display,
// start_url da spec 65) regredindo.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(__dirname, '../assets/manifest.webmanifest');

function loadManifest(): any {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

describe('assets/manifest.webmanifest', () => {
  it('é JSON válido', () => {
    expect(() => loadManifest()).not.toThrow();
  });

  it('share_target nível 2: POST multipart pro /app/inbox/share com title/text/url + arquivo (spec 68)', () => {
    const m = loadManifest();
    expect(m.share_target).toEqual({
      action: '/app/inbox/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [
          {
            name: 'media',
            accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/*'],
          },
        ],
      },
    });
  });

  it('id estável e screenshots wide+narrow presentes (rich install UI)', () => {
    const m = loadManifest();
    expect(m.id).toBe('/app');
    expect(Array.isArray(m.screenshots)).toBe(true);
    const forms = m.screenshots.map((s: any) => s.form_factor);
    expect(forms).toContain('wide');
    expect(forms).toContain('narrow');
    for (const s of m.screenshots) {
      expect(s.src.startsWith('/')).toBe(true);
      expect(typeof s.sizes).toBe('string');
    }
  });

  it('shortcuts cobrem capturar/tarefas/hoje com URLs válidas', () => {
    const m = loadManifest();
    expect(Array.isArray(m.shortcuts)).toBe(true);
    const urls = m.shortcuts.map((s: any) => s.url);
    expect(urls).toEqual(['/app/inbox', '/app/tasks', '/app']);
    for (const s of m.shortcuts) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.url.startsWith('/')).toBe(true);
    }
  });

  it('não regride o PWA existente (start_url, display, ícones)', () => {
    const m = loadManifest();
    expect(m.start_url).toBe('/app');
    expect(m.display).toBe('standalone');
    expect(m.name).toBe('Expert Brain');
    const sizes = m.icons.map((i: any) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
  });
});
