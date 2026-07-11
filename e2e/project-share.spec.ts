// Board compartilhado por projeto (specs/80-frota-agentes/85): criação no console,
// navegação SEM login pelo /p/<token>, comentário externo com selo, e revogação.
// Estado do seed: 'Lançamento Produto X' (seed-proj-01) tem tasks públicas e UMA
// privada (seed-task-08) — que NUNCA pode aparecer no recorte.
import { test, expect } from '@playwright/test';

test('cria link do board, navega sem login, comenta como externo e revoga', async ({ page, browser }) => {
  // 1. Console: cria o share (Organização → Projetos → Board compartilhado).
  await page.goto('/app/config');
  await page.click('button[data-tab="organizacao"]');
  await page.locator('#projects > summary').click();
  await page.selectOption('form[action="/app/project-shares/create"] select[name="project_id"]', { label: 'Lançamento Produto X' });
  await page.fill('form[action="/app/project-shares/create"] input[name="label"]', 'Parceiro E2E');
  await page.selectOption('form[action="/app/project-shares/create"] select[name="mode"]', 'comment');
  await page.click('form[action="/app/project-shares/create"] button[type="submit"]');

  // Banner one-time com a URL /p/.
  await expect(page).toHaveURL(/pflash=[a-f0-9]{32}/);
  const flashUrl = await page.locator('#pshare-flash-value').inputValue();
  expect(flashUrl).toMatch(/\/p\/ebp_/);
  // A URL do banner é absoluta no WORKER_URL (prod); no dev navega-se pelo path.
  const url = new URL(flashUrl).pathname;

  // 2. Contexto SEM login: o recorte abre, a privada não aparece, nada de /app.
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(url);
  await expect(gp.locator('h1')).toHaveText('Lançamento Produto X');
  await expect(gp.getByText('Follow-up com Empresa Exemplo Ltda sobre proposta')).toBeVisible();
  await expect(gp.getByText('Ajustar precificação do Produto X')).toHaveCount(0); // privada
  await expect(gp.getByText('Organizar mudança pra Casa Nova')).toHaveCount(0);   // outro projeto
  expect(await gp.locator('a[href^="/app"]').count()).toBe(0);

  // 3. Comenta como externo: assina o label do share e ganha o selo EXTERNO.
  const card = gp.locator('#task-seed-task-01');
  await card.locator('summary').click();
  await card.locator('textarea[name="body"]').fill('Comentário externo do e2e');
  await card.locator('button[type="submit"]').click();
  // O 303 volta pra página com o details fechado — reabrir pra ver a thread.
  await gp.locator('#task-seed-task-01 summary').click();
  await expect(gp.getByText('Comentário externo do e2e')).toBeVisible();
  await expect(gp.locator('.cmt-external').first()).toBeVisible();
  await expect(gp.getByText('Parceiro E2E').first()).toBeVisible();

  // 4. Revoga no console → o link morre na hora (404 neutro).
  await page.goto('/app/config');
  await page.click('button[data-tab="organizacao"]');
  await page.locator('#projects > summary').click();
  await page.click('form[action="/app/project-shares/revoke"] button[type="submit"]');
  const dead = await gp.goto(url);
  expect(dead!.status()).toBe(404);

  await guest.close();
});
