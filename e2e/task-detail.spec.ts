// Smoke do detalhe de task (specs/60-ux-reforma/61). A Onda 4 substitui as duas
// seções da sidebar (Compartilhamento público + Privacidade) por um seletor único
// de visibilidade (specs/60-ux-reforma/65) — atualizar as âncoras aqui no MESMO commit.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/app/tasks/seed-task-02');
});

test('detalhe renderiza título, sidebar e seções de visibilidade', async ({ page }) => {
  // o título é um campo EDITÁVEL (input), não texto — getByText não o encontra
  await expect(page.locator('input.task-edit-title')).toHaveValue('Revisar contrato de fornecedor fictício');
  const sidebar = page.locator('.task-detail-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText('Compartilhamento público')).toBeVisible();
  await expect(sidebar.getByText('Privacidade')).toBeVisible();
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
