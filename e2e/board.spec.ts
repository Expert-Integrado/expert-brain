// Smoke do board Kanban (specs/60-ux-reforma/61). Estado vem do seed
// determinístico (global-setup roda seed-dev.mjs --reset a cada execução).
//
// ATENÇÃO Onda 4 (specs/60-ux-reforma/65): o DnD vai trocar de HTML5 drag events
// pra Pointer Events — o teste 'arrastar card' abaixo DEVE ser reescrito com
// page.mouse (down/move/up) no MESMO commit dessa mudança.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/app/tasks');
  // o client re-renderiza o board via /app/tasks/data e só então wira os cards
  await page.waitForTimeout(1200);
});

test('board renderiza as colunas default com cards do seed', async ({ page }) => {
  await expect(page.locator('.task-col-body[data-dropzone="col_aberto"]')).toBeVisible();
  await expect(page.locator('.task-col-body[data-dropzone="col_progresso"]')).toBeVisible();
  await expect(page.locator('.task-col-body[data-dropzone="col_concluido"]')).toBeVisible();
  await expect(page.locator('.task-card[data-id="seed-task-01"]')).toBeVisible();
});

test('task privada aparece pro dono com o selo de privada', async ({ page }) => {
  const card = page.locator('.task-card[data-id="seed-task-08"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.private-badge')).toBeVisible();
});

test('arrastar card entre colunas persiste a mudança (HTML5 DnD)', async ({ page }) => {
  const moved = page.waitForResponse((r) => r.url().includes('/app/tasks/move') && r.ok());
  await page.evaluate(() => {
    const card = document.querySelector('.task-card[data-id="seed-task-01"]')!;
    const zone = document.querySelector('.task-col-body[data-dropzone="col_progresso"]')!;
    const dataTransfer = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
  await moved;
  // move() recarrega o board — o card precisa REAPARECER dentro da coluna destino
  await expect(
    page.locator('.task-col-body[data-dropzone="col_progresso"] .task-card[data-id="seed-task-01"]')
  ).toBeVisible();
});

test('link do título do card navega pro detalhe', async ({ page }) => {
  await page.click('.task-card[data-id="seed-task-02"] a.task-card-title');
  await expect(page).toHaveURL(/\/app\/tasks\/seed-task-02/);
  await expect(page.locator('.task-detail-sidebar')).toBeVisible();
});

test('botão concluir move a task pra coluna de concluídas sem navegar', async ({ page }) => {
  const done = page.waitForResponse((r) => r.url().includes('/app/tasks/complete') && r.ok());
  await page.click('.task-card[data-id="seed-task-03"] .task-complete');
  await done;
  await expect(page).toHaveURL(/\/app\/tasks$/);
  await expect(
    page.locator('.task-col-body[data-dropzone="col_concluido"] .task-card[data-id="seed-task-03"]')
  ).toBeVisible();
});
