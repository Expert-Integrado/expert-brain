// Smoke da command palette Ctrl+K (specs/60-ux-reforma/61). A palette é criada
// on-demand pelo shell (client/shell.ts ensurePalette) — só existe após o atalho.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/app/notes');
  await page.waitForTimeout(600);
});

test('Ctrl+K abre a palette com o input focado', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const root = page.locator('#cmd-palette');
  await expect(root).toBeVisible();
  await expect(root.locator('.cmd-input')).toBeFocused();
});

test('modo comando (>) lista comandos', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.locator('#cmd-palette .cmd-input').fill('>');
  const items = page.locator('#cmd-palette li');
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThan(0);
});

test('Escape fecha a palette', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.locator('#cmd-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cmd-palette')).toBeHidden();
});
