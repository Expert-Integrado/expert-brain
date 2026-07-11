// Fluxo de criação de chave de API (specs/80-frota-agentes/87): form único com dono
// obrigatório + sistema, banner one-time com fechamento consciente e listagem agrupada.
// Estado vem do seed determinístico (global-setup roda seed-dev.mjs --reset).
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/app/config');
  await page.locator('#api-keys > summary').click();
});

test('criar chave: banner one-time, copiar, fechar só pelo "já salvei"', async ({ page }) => {
  await page.fill('#api-keys input[name="name"]', 'e2e-pat-frota');
  await page.fill('#api-keys input[name="system"]', 'frota');
  // Dono obrigatório (spec 86): primeiro usuário real do dropdown.
  await page.locator('#api-keys select[name="user_id"]').selectOption({ index: 1 });
  await page.click('#api-keys form[action="/app/api-keys/create"] button[type="submit"]');

  // Volta com ?flash= e o banner one-time visível, com o token completo.
  await expect(page).toHaveURL(/flash=[a-f0-9]{32}/);
  const banner = page.locator('#key-flash');
  await expect(banner).toBeVisible();
  await expect(page.locator('#key-flash-value')).toHaveValue(/^eb_pat_/);

  // Copiar dá feedback e arma a flag de "copiado".
  await page.click('#key-flash-copy');
  await expect(page.locator('#key-flash-copy')).toHaveText(/Copiado|Selecione/);

  // Fechar pelo botão de ack (com copiado = sem confirm) remove o banner.
  await page.click('#key-flash-ack');
  await expect(banner).toHaveCount(0);

  // Token não re-exibível: reload da config sem o flash — banner não volta, e a
  // chave nova aparece na listagem agrupada sob o sistema "frota".
  await page.goto('/app/config');
  await page.locator('#api-keys > summary').click();
  await expect(page.locator('#key-flash')).toHaveCount(0);
  await expect(page.locator('[data-key-group="frota"]')).toContainText('e2e-pat-frota');
});

test('fechar o banner SEM copiar pede confirmação', async ({ page }) => {
  await page.fill('#api-keys input[name="name"]', 'e2e-pat-sem-copia');
  await page.locator('#api-keys select[name="user_id"]').selectOption({ index: 1 });
  await page.click('#api-keys form[action="/app/api-keys/create"] button[type="submit"]');
  const banner = page.locator('#key-flash');
  await expect(banner).toBeVisible();

  // 1º ack sem copiar: confirm aparece; cancelar mantém o banner na tela.
  page.once('dialog', (d) => d.dismiss());
  await page.click('#key-flash-ack');
  await expect(banner).toBeVisible();

  // 2º ack: aceitar o confirm fecha.
  page.once('dialog', (d) => d.accept());
  await page.click('#key-flash-ack');
  await expect(banner).toHaveCount(0);
});
