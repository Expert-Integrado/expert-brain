// Fluxos de visibilidade da task via o seletor único de 3 níveis (Privado /
// Normal / Link público — specs/60-ux-reforma/65). Comportamento que a reforma
// PRESERVA (decisão do Eric): private default 0, share sempre opt-in, marcar
// privada revoga o link público na mesma escrita. Os POSTs de backend
// (/app/tasks/private, share, unshare) são os mesmos de antes.
import { test, expect } from '@playwright/test';

test('gerar link público mostra URL /s/ e revogar volta pro normal', async ({ page }) => {
  await page.goto('/app/tasks/seed-task-02');

  // estado do seed: normal → o painel de link começa fechado
  const section = page.locator('[data-visibility]');
  await expect(section).toHaveAttribute('data-state', 'normal');
  await expect(page.locator('[data-vis-panel]')).toBeHidden();

  // selecionar "Link público" abre o painel; o link só nasce no botão
  await page.check('input[name="visibility"][value="link"]');
  await expect(page.locator('[data-vis-panel]')).toBeVisible();

  const shared = page.waitForResponse((r) => r.url().includes('/app/tasks/share') && r.ok());
  await page.click('[data-share-generate]');
  await shared;
  await expect(section).toHaveAttribute('data-state', 'link');
  await expect(page.locator('[data-share-link]')).toBeVisible();
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
  await expect(section).toHaveAttribute('data-state', 'normal');
  const after = await anonPage.goto(shareUrl);
  expect(after!.status()).toBeGreaterThanOrEqual(400);
  await anon.close();
});

test('privado esconde o painel de link e persiste; normal restaura', async ({ page }) => {
  await page.goto('/app/tasks/seed-task-04');
  const section = page.locator('[data-visibility]');
  await expect(section).toHaveAttribute('data-state', 'normal');

  // normal → privado (sem link vivo = sem confirm; POST sem navegação)
  const toPrivate = page.waitForResponse((r) => r.url().includes('/app/tasks/private') && r.ok());
  await page.check('input[name="visibility"][value="private"]');
  await toPrivate;
  await expect(section).toHaveAttribute('data-state', 'private');
  await expect(page.locator('[data-vis-panel]')).toBeHidden();

  // persistiu no servidor (reload re-renderiza do banco)
  await page.reload();
  await expect(page.locator('[data-visibility]')).toHaveAttribute('data-state', 'private');
  await expect(page.locator('input[name="visibility"][value="private"]')).toBeChecked();

  // privado → normal (restaura o estado do seed pros demais testes)
  const toNormal = page.waitForResponse((r) => r.url().includes('/app/tasks/private') && r.ok());
  await page.check('input[name="visibility"][value="normal"]');
  await toNormal;
  await expect(page.locator('[data-visibility]')).toHaveAttribute('data-state', 'normal');
});

test('link vivo → privado pede confirmação e derruba o link no mesmo write', async ({ page }) => {
  await page.goto('/app/tasks/seed-task-05');

  // gera um link primeiro
  await page.check('input[name="visibility"][value="link"]');
  const shared = page.waitForResponse((r) => r.url().includes('/app/tasks/share') && r.ok());
  await page.click('[data-share-generate]');
  await shared;
  const url = await page.locator('[data-share-url]').inputValue();
  const shareUrl = new URL(page.url()).origin + new URL(url).pathname;

  // link → privado: confirm destrutivo; o server revoga o link na mesma escrita
  page.once('dialog', (d) => d.accept());
  const toPrivate = page.waitForResponse((r) => r.url().includes('/app/tasks/private') && r.ok());
  await page.check('input[name="visibility"][value="private"]');
  await toPrivate;
  await expect(page.locator('[data-visibility]')).toHaveAttribute('data-state', 'private');

  const anon = await page.context().browser()!.newContext();
  const anonPage = await anon.newPage();
  const res = await anonPage.goto(shareUrl);
  expect(res!.status()).toBeGreaterThanOrEqual(400);
  await anon.close();

  // restaura o seed: privado → normal
  const toNormal = page.waitForResponse((r) => r.url().includes('/app/tasks/private') && r.ok());
  await page.check('input[name="visibility"][value="normal"]');
  await toNormal;
});
