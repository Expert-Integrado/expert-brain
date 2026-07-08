// Smoke do fluxo de login (specs/60-ux-reforma/61). Usa contexto SEM o storage
// state logado pra exercitar o form real.
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('página de login renderiza o form', async ({ page }) => {
  await page.goto('/app/login');
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toHaveText('Entrar');
});

test('rota autenticada sem sessão redireciona pro login', async ({ page }) => {
  await page.goto('/app/tasks');
  await expect(page).toHaveURL(/\/app\/login/);
});

test('login com credencial válida cria sessão e navega', async ({ page }) => {
  const email = process.env.E2E_EMAIL!;
  const password = process.env.E2E_PASSWORD!;
  await page.goto('/app/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  // Destino default pós-login é a HOME desde a Onda 5 (specs/60-ux-reforma/66).
  await expect(page).toHaveURL(/\/app\/?$/);
  await expect(page.getByRole('heading', { name: 'Início' })).toBeVisible();
});

test('login com senha errada mostra erro e não cria sessão', async ({ page }) => {
  await page.goto('/app/login');
  await page.fill('input[name="email"]', process.env.E2E_EMAIL!);
  await page.fill('input[name="password"]', 'senha-errada-nao-e');
  await page.click('button[type="submit"]');
  await expect(page.locator('.error')).toContainText('Credenciais inválidas');
});
