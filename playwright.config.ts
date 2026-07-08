import { defineConfig } from '@playwright/test';

// E2E do console (specs/60-ux-reforma/61). Suíte SEPARADA do vitest: vive em
// e2e/ (test/ tem a suíte de worker; test/e2e.test.ts é outra coisa — testa o
// worker via pool-workers). Roda contra wrangler dev local com o seed aplicado.
//
// Credenciais via env E2E_EMAIL / E2E_PASSWORD (a credencial local do dono vive
// em .dev.vars, fora do repo — este repo é público, nada de senha hardcoded).
export default defineConfig({
  testDir: 'e2e',
  workers: 1, // seed compartilhado + rate-limit de login: paralelismo aqui é flakiness
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE || 'http://localhost:8787',
    storageState: 'e2e/.auth/state.json',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8787/app/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
