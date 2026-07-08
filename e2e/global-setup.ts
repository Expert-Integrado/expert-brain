// Global setup do e2e (specs/60-ux-reforma/61): aplica o seed determinístico
// no D1 local e faz login UMA vez (o endpoint tem rate-limit), salvando o
// storage state que todos os specs reusam.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type FullConfig } from '@playwright/test';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = process.env.E2E_BASE || 'http://localhost:8787';
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'defina E2E_EMAIL e E2E_PASSWORD (a credencial local de dev vive no seu .dev.vars — nunca no repo)');
  }

  // Seed idempotente: --reset apaga só seed-% e re-semeia (dados determinísticos).
  if (!process.env.E2E_SKIP_SEED) {
    const r = spawnSync('node', ['scripts/seed-dev.mjs', '--local', '--force', '--reset'], {
      stdio: 'inherit', shell: true,
    });
    if (r.status !== 0) throw new Error(`seed-dev falhou (exit ${r.status})`);
  }

  mkdirSync('e2e/.auth', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/app/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  if (page.url().includes('/app/login')) {
    await browser.close();
    throw new Error('login do e2e falhou — confira E2E_EMAIL/E2E_PASSWORD e o wrangler dev');
  }
  await page.context().storageState({ path: 'e2e/.auth/state.json' });
  await browser.close();
}
