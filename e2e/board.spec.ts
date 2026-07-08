// Smoke do board Kanban (specs/60-ux-reforma/61). Estado vem do seed
// determinístico (global-setup roda seed-dev.mjs --reset a cada execução).
//
// Onda 4 (specs/60-ux-reforma/65): DnD por Pointer Events (board-dnd.ts) — o
// arrasto aqui usa page.mouse de verdade (down/move/up com steps), não eventos
// sintéticos de HTML5 DnD. Card inteiro é clicável (abre o detalhe).
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

test('arrastar card entre colunas persiste a mudança (Pointer Events)', async ({ page }) => {
  const card = page.locator('.task-card[data-id="seed-task-01"]');
  const targetCol = page.locator('.task-col[data-col="col_progresso"]');
  const cb = (await card.boundingBox())!;
  const tb = (await targetCol.boundingBox())!;

  const moved = page.waitForResponse((r) => r.url().includes('/app/tasks/move') && r.ok());
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  // steps garantem que o threshold de 6px arma o drag antes de chegar no alvo
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 80, { steps: 15 });
  // affordance: a coluna-alvo (section) acende, nunca o fundo do corpo inteiro
  await expect(targetCol).toHaveClass(/drag-target/);
  await page.mouse.up();
  await moved;
  // move() recarrega o board — o card precisa REAPARECER dentro da coluna destino
  await expect(
    page.locator('.task-col-body[data-dropzone="col_progresso"] .task-card[data-id="seed-task-01"]')
  ).toBeVisible();
});

test('clicar no corpo do card (fora do título) abre o detalhe', async ({ page }) => {
  const card = page.locator('.task-card[data-id="seed-task-02"]');
  const box = (await card.boundingBox())!;
  // canto inferior direito do card = padding, longe do <a> do título e dos botões
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 6);
  await expect(page).toHaveURL(/\/app\/tasks\/seed-task-02/);
  await expect(page.locator('.task-detail-sidebar')).toBeVisible();
});

test('link do título do card navega pro detalhe', async ({ page }) => {
  await page.click('.task-card[data-id="seed-task-02"] a.task-card-title');
  await expect(page).toHaveURL(/\/app\/tasks\/seed-task-02/);
  await expect(page.locator('.task-detail-sidebar')).toBeVisible();
});

test('busca do toolbar filtra os cards por texto (Onda 8)', async ({ page }) => {
  const title = (await page.locator('.task-card[data-id="seed-task-01"] .task-card-title').textContent())!.trim();
  const term = title.split(/\s+/)[0];
  await page.fill('#task-search', term);
  await page.waitForTimeout(400); // debounce 120ms + re-render
  await expect(page.locator('.task-card[data-id="seed-task-01"]')).toBeVisible();
  await page.fill('#task-search', 'zzz-termo-que-nao-existe');
  await page.waitForTimeout(400);
  await expect(page.locator('.task-card')).toHaveCount(0);
  await page.fill('#task-search', '');
  await page.waitForTimeout(400);
  await expect(page.locator('.task-card[data-id="seed-task-01"]')).toBeVisible();
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
