// Fluxos de visibilidade da task: share opt-in e toggle privada (specs/60-ux-reforma/61).
// Comportamento que a reforma PRESERVA (decisão do Eric): private default 0, share
// sempre opt-in, marcar privada revoga o link público na mesma escrita.
//
// ATENÇÃO Onda 4 (specs/60-ux-reforma/65): a UI vira um seletor único de 3 níveis
// (Privado / Normal / Link público) — reescrever os seletores deste arquivo no MESMO
// commit. Os POSTs de backend (share, /app/tasks/private) NÃO mudam.
import { test, expect } from '@playwright/test';

test('gerar link público mostra URL /s/ e revogar esconde', async ({ page }) => {
  await page.goto('/app/tasks/seed-task-02');

  const shared = page.waitForResponse((r) => r.url().includes('/app/tasks/share') && r.ok());
  await page.click('[data-share-generate]');
  await shared;
  const linkBox = page.locator('[data-share-link]');
  await expect(linkBox).toBeVisible();
  await expect(page.locator('[data-share-url]')).toHaveValue(/\/s\/ebs_/);
  await expect(page.locator('[data-share-revoke]')).toBeVisible();

  // o link público abre SEM sessão (contexto anônimo) enquanto ativo.
  // O endpoint devolve URL absoluta com o host de PRODUÇÃO (config do worker) —
  // no dev local só o PATH interessa; remontar contra o origin desta run.
  const url = await page.locator('[data-share-url]').inputValue();
  const shareUrl = new URL(page.url()).origin + new URL(url).pathname;
  const anon = await page.context().browser()!.newContext();
  const anonPage = await anon.newPage();
  const res = await anonPage.goto(shareUrl);
  expect(res!.status()).toBe(200);
  await expect(anonPage.getByText('Revisar contrato de fornecedor fictício').first()).toBeVisible();

  // revogar mata o link na hora (o client pede confirm() — aceitar o dialog,
  // senão o Playwright o DESCARTA por default e o POST nunca acontece)
  page.once('dialog', (d) => d.accept());
  const revoked = page.waitForResponse((r) => r.url().includes('/app/tasks/unshare') && r.ok());
  await page.click('[data-share-revoke]');
  await revoked;
  const after = await anonPage.goto(shareUrl);
  expect(after!.status()).toBeGreaterThanOrEqual(400);
  await anon.close();
});

test('tornar privada esconde o painel de share; tornar pública restaura', async ({ page }) => {
  await page.goto('/app/tasks/seed-task-04');

  // pública -> privada (form POST recarrega a página)
  await Promise.all([page.waitForNavigation(), page.click('[data-task-private-toggle]')]);
  await expect(page.locator('.task-private-state')).toContainText('privada');
  await expect(page.locator('.task-share [data-share-state]')).toContainText('não pode ter link público');
  await expect(page.locator('[data-share-generate]')).toHaveCount(0);

  // privada -> pública (restaura o estado do seed pros demais testes)
  await Promise.all([page.waitForNavigation(), page.click('[data-task-private-toggle]')]);
  await expect(page.locator('.task-private-state')).toContainText('pública');
  await expect(page.locator('[data-share-generate]')).toBeVisible();
});
