// Redesign da /app/config (11/07): 4 abas, cards de integração com status dot
// e card de agente com prefill de criar-chave. Estado vem do seed determinístico
// (global-setup roda seed-dev.mjs --reset).
import { test, expect } from '@playwright/test';

test('aba Integrações mostra os 4 cards e hidrata os dots', async ({ page }) => {
  await page.goto('/app/config');
  // Default = Agentes.
  await expect(page.locator('#config-tab-agentes')).toHaveAttribute('aria-selected', 'true');

  await page.click('#config-tab-integracoes');
  await expect(page.locator('#panel-integracoes')).toBeVisible();
  await expect(page.locator('#panel-integracoes details.conn-card')).toHaveCount(4);

  // Dots hidratam eager ao ativar a aba (sem abrir card nenhum): o label sai
  // do "Verificando…" pra um estado real assim que o /status responde.
  await expect(page.locator('#gc-dot-label')).not.toHaveText('Verificando…');
  await expect(page.locator('#pd-dot-label')).not.toHaveText('Verificando…');
});

test('abrir o card do Pipedrive expande e mostra o corpo hidratado', async ({ page }) => {
  await page.goto('/app/config');
  await page.click('#config-tab-integracoes');
  await page.locator('#pipedrive-crm > summary').click();
  await expect(page.locator('#pd-status')).toBeVisible();
  await expect(page.locator('#pd-status')).not.toHaveText('Carregando estado da integração…');
});

test('deep-link legado #conexoes cai na aba Agentes', async ({ page }) => {
  await page.goto('/app/config#conexoes');
  await expect(page.locator('#config-tab-agentes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-agentes')).toBeVisible();
});

test('card de agente: "Criar chave" abre #api-keys com o dono pré-selecionado', async ({ page }) => {
  await page.goto('/app/config');
  // Abre o primeiro card de agente que tem o botão (perfis ativos).
  const card = page.locator('#users details.agent-card').filter({ has: page.locator('[data-create-key-for]') }).first();
  await card.locator('> summary').click();
  const btn = card.locator('[data-create-key-for]');
  const uid = await btn.getAttribute('data-create-key-for');
  await btn.click();

  const keysBox = page.locator('#api-keys');
  await expect(keysBox).toHaveAttribute('open', '');
  await expect(keysBox.locator('form[action="/app/api-keys/create"] select[name="user_id"]')).toHaveValue(uid!);
  await expect(keysBox.locator('form[action="/app/api-keys/create"] input[name="name"]')).toBeFocused();
});
