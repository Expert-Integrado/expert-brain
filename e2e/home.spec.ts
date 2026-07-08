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
