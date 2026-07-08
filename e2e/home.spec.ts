// Smoke da home /app (specs/60-ux-reforma/61). Spec 69: o feed "Atividade"
// (antigo /app/journal) mora na home — container #journal-groups carrega lazy
// (data-lazy="1" + fetch JSON); se o id sumir, atualizar aqui no MESMO commit.
import { test, expect } from '@playwright/test';

test('home renderiza título e o feed de atividade (lazy)', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('h1')).toHaveText('Início');
  await expect(page.locator('#journal-groups')).toBeAttached();
  // O lazy-load troca o placeholder pelo conteúdo real (seed tem notas/tasks →
  // itens com dia agrupado) ou pelo estado vazio — nunca fica no "Carregando".
  await expect(page.locator('#journal-groups')).not.toContainText('Carregando a atividade', { timeout: 10_000 });
  await expect(page.locator('#journal-groups .journal-item').first()).toBeVisible();
});

test('/app/journal sem querystring redireciona pra home (spec 69)', async ({ page }) => {
  await page.goto('/app/journal');
  await expect(page).toHaveURL(/\/app$/);
});

test('navegação da shell leva ao board e às notas', async ({ page }) => {
  await page.goto('/app');
  await page.click('a[href="/app/tasks"]');
  await expect(page).toHaveURL(/\/app\/tasks/);
  await page.click('a[href="/app/notes"]');
  await expect(page).toHaveURL(/\/app\/notes/);
});

// Limpeza compartilhada dos specs de layout (Onda 9b): volta o layout salvo pro
// default via endpoint (mais previsível que desfazer gesto a gesto).
async function resetHomeLayout(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post('/app/home/prefs', {
    data: { heights: {}, order: ['today', 'inbox', 'digest', 'activity'] },
  });
}

test('arrastar caixa pelo título reordena e persiste (Onda 9b, spec 72)', async ({ page }) => {
  await page.goto('/app');
  const grid = page.locator('.home-grid');
  await expect(grid.locator('[data-home-item]').first()).toHaveAttribute('data-home-item', 'today');

  // drag real com mouse: pega o TÍTULO do card Hoje e solta sobre o card Inbox
  const handle = page.locator('[data-home-item="today"] .home-box-handle');
  const target = page.locator('[data-home-item="inbox"]');
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  const saved = page.waitForResponse((r) => r.url().includes('/app/home/prefs') && r.ok());
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  // passos intermediários: primeiro vence o threshold de 6px, depois cruza o alvo
  await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await saved;

  // ordem trocada ao vivo e persistida no reload
  await expect(grid.locator('[data-home-item]').first()).toHaveAttribute('data-home-item', 'inbox');
  await page.reload();
  await expect(grid.locator('[data-home-item]').first()).toHaveAttribute('data-home-item', 'inbox');

  await resetHomeLayout(page);
});

test('puxar a borda de baixo redimensiona e persiste (Onda 9b, spec 72)', async ({ page }) => {
  await page.goto('/app');
  const box = page.locator('[data-home-box="today"]');
  await expect(box).toHaveCSS('max-height', '420px');

  const rz = page.locator('[data-home-item="today"] .home-resize');
  const r = (await rz.boundingBox())!;
  const saved = page.waitForResponse((r2) => r2.url().includes('/app/home/prefs') && r2.ok());
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  await saved;

  await expect(box).toHaveCSS('max-height', '540px');
  await page.reload();
  await expect(box).toHaveCSS('max-height', '540px');

  await resetHomeLayout(page);
  await page.reload();
  await expect(box).toHaveCSS('max-height', '420px');
});

test('Inbox saiu do menu; card da home captura e descarta inline (Onda 8, spec 70)', async ({ page }) => {
  await page.goto('/app');
  // sem item de menu (sidebar E bottom-nav)
  await expect(page.locator('.sidebar a[href="/app/inbox"]')).toHaveCount(0);
  await expect(page.locator('.bottom-nav a[href="/app/inbox"]')).toHaveCount(0);

  // captura pela home volta pra home com o item no card
  const text = `captura e2e ${Date.now()}`;
  await page.fill('.home-inbox-capture input[name="text"]', text);
  await page.click('.home-inbox-capture button[type="submit"]');
  await expect(page).toHaveURL(/\/app$/);
  const row = page.locator('.home-inbox-item', { hasText: text }).first();
  await expect(row).toBeVisible();

  // descartar inline volta pra home e some com o item
  await row.locator('form[action="/app/inbox/resolve"] button').click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator('.home-inbox-item', { hasText: text })).toHaveCount(0);
});
