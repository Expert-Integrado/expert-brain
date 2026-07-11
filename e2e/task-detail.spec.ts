// Smoke do detalhe de task (specs/60-ux-reforma/61). Desde a Onda 4 a sidebar
// tem UM seletor de visibilidade de 3 níveis (specs/60-ux-reforma/65) no lugar
// das antigas seções "Compartilhamento público" + "Privacidade".
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/app/tasks/seed-task-02');
});

test('detalhe renderiza título, sidebar e o seletor de visibilidade', async ({ page }) => {
  // o título é um campo EDITÁVEL (input), não texto — getByText não o encontra
  await expect(page.locator('textarea.task-edit-title')).toHaveValue('Revisar contrato de fornecedor fictício');
  const sidebar = page.locator('.task-detail-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('heading', { name: 'Visibilidade' })).toBeVisible();
  await expect(sidebar.locator('input[name="visibility"]')).toHaveCount(3);
  // Reforma UX 10/07 (c3087ff): o hint textual saiu do seletor — os 3 níveis
  // agora são labels do radiogroup. Asserta os níveis, não a copy.
  await expect(sidebar.getByRole('radio', { name: 'Privado' })).toBeVisible();
  await expect(sidebar.getByRole('radio', { name: 'Normal' })).toBeVisible();
  await expect(sidebar.getByRole('radio', { name: 'Link público' })).toBeVisible();
});

test('comentário novo aparece na página após o post', async ({ page }) => {
  const body = `Comentário de teste e2e — ${Date.now()}`;
  await page.fill('.cmt-form textarea[name="body"]', body);
  await Promise.all([page.waitForNavigation(), page.click('.cmt-form .cmt-submit')]);
  await expect(page.getByText(body)).toBeVisible();
});

test('task inexistente responde página de não encontrada', async ({ page }) => {
  const res = await page.goto('/app/tasks/nao-existe-task');
  expect(res!.status()).toBe(404);
  await expect(page.getByText('Task não encontrada')).toBeVisible();
});
