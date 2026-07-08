// Smoke da home /app (specs/60-ux-reforma/61). A Onda 5 reforma o layout da home
// (specs/60-ux-reforma/66) — os ids âncora (home-events-list) são MANTIDOS lá;
// se algum sumir, atualizar aqui no MESMO commit.
import { test, expect } from '@playwright/test';

test('home renderiza título e a lista de interações', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('h1')).toHaveText('Início');
  await expect(page.locator('#home-events-list')).toBeAttached();
});

test('navegação da shell leva ao board e às notas', async ({ page }) => {
  await page.goto('/app');
  await page.click('a[href="/app/tasks"]');
  await expect(page).toHaveURL(/\/app\/tasks/);
  await page.click('a[href="/app/notes"]');
  await expect(page).toHaveURL(/\/app\/notes/);
});
