import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { authHandler } from '../src/auth/handler';
import { handleProvision } from '../src/auth/setup';
import { verifySession } from '../src/web/session';
import { totpCode } from '../src/auth/totp';
import {
  twoFactorEnabled,
  startTwoFactor,
  cancelTwoFactorSetup,
  confirmTwoFactor,
  verifySecondFactor,
  disableTwoFactor,
  backupCodesRemaining,
  signTwoFactorToken,
  verifyTwoFactorToken,
} from '../src/auth/twofactor';

// Spec 100-seguranca-conta/102: verificação em duas etapas (TOTP) no login e no /authorize.
// isolatedStorage=false: o estado 2FA na meta VAZA entre arquivos — o afterAll
// limpa as chaves totp_* pra não quebrar os logins diretos das outras suites.

const E = env as any;
const PASSWORD = 'correct-horse-battery-staple';

async function wipeTwoFactor(): Promise<void> {
  await E.DB.prepare(`DELETE FROM meta WHERE key LIKE 'totp_%'`).run();
}

function appLoginPost(fields: Record<string, string>, ip: string): Request {
  return new Request('https://example.com/app/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
    },
    body: new URLSearchParams({ next: '/app/graph', ...fields }).toString(),
  });
}

function twoFaPost(fields: Record<string, string>, ip: string, cookie: string): Request {
  return new Request('https://example.com/app/login/2fa', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
      cookie,
    },
    body: new URLSearchParams({ next: '/app/graph', ...fields }).toString(),
  });
}

function authorizePost(fields: Record<string, string>, ip: string): Request {
  return new Request('https://example.com/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// getSetCookie existe no runtime (workerd/undici), mas não no lib.dom das
// typings do projeto — a helper isola o cast num lugar só.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(';')[0];
  }
  return null;
}

function setCookieFor(res: Response, name: string): string | null {
  return setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? null;
}

/** Liga o 2FA de verdade (setup + confirmação com código do "app") e devolve secret + backup codes. */
async function enableTwoFactor(): Promise<{ secret: string; backupCodes: string[] }> {
  await wipeTwoFactor();
  const secret = await startTwoFactor(E);
  const code = await totpCode(secret, Date.now());
  const backupCodes = await confirmTwoFactor(E, code, Date.now());
  expect(backupCodes).not.toBeNull();
  return { secret, backupCodes: backupCodes! };
}

async function wrongCode(secret: string): Promise<string> {
  const current = await totpCode(secret, Date.now());
  return current === '000000' ? '111111' : '000000';
}

beforeAll(async () => {
  // Schema idempotente (tabela meta) — mesmo padrão do setup-auth.test.ts.
  const res = await handleProvision(
    new Request('https://example.com/setup/provision', {
      method: 'POST',
      headers: { authorization: 'Bearer setup-tok' },
    }),
    E
  );
  expect(res.status).toBe(200);
  await wipeTwoFactor();
});

afterAll(async () => {
  await wipeTwoFactor();
});

describe('estado do 2FA (module)', () => {
  it('desligado por default; setup só liga após provar o código', async () => {
    expect(await twoFactorEnabled(E)).toBe(false);
    const secret = await startTwoFactor(E);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    // Ainda desligado: pending não conta como habilitado (sem lockout).
    expect(await twoFactorEnabled(E)).toBe(false);
    // Refresh do setup reusa o pending (não troca o secret embaixo do app).
    expect(await startTwoFactor(E)).toBe(secret);
    // Código errado não liga nada.
    expect(await confirmTwoFactor(E, await wrongCode(secret), Date.now())).toBeNull();
    expect(await twoFactorEnabled(E)).toBe(false);
    // Código certo liga e entrega 8 backup codes formato XXXX-XXXX.
    const codes = await confirmTwoFactor(E, await totpCode(secret, Date.now()), Date.now());
    expect(codes).toHaveLength(8);
    for (const c of codes!) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await twoFactorEnabled(E)).toBe(true);
    expect(await backupCodesRemaining(E)).toBe(8);
  });

  it('verifySecondFactor: TOTP, backup consumível, lixo rejeitado', async () => {
    const { secret, backupCodes } = await enableTwoFactor();
    expect(await verifySecondFactor(E, await totpCode(secret, Date.now()), Date.now())).toBe('totp');
    expect(await verifySecondFactor(E, await wrongCode(secret), Date.now())).toBeNull();
    // Backup code entra (case/hífen tolerantes) e é consumido — não repete.
    const spent = backupCodes[0];
    expect(await verifySecondFactor(E, spent.toLowerCase().replace('-', ' '), Date.now())).toBe('backup');
    expect(await backupCodesRemaining(E)).toBe(7);
    expect(await verifySecondFactor(E, spent, Date.now())).toBeNull();
    expect(await verifySecondFactor(E, 'nem-code', Date.now())).toBeNull();
  });

  it('cancelar setup limpa o pending; disable exige segundo fator', async () => {
    await wipeTwoFactor();
    await startTwoFactor(E);
    await cancelTwoFactorSetup(E);
    expect(await confirmTwoFactor(E, '123456', Date.now())).toBeNull();

    const { secret } = await enableTwoFactor();
    expect(await disableTwoFactor(E, await wrongCode(secret), Date.now())).toBe(false);
    expect(await twoFactorEnabled(E)).toBe(true);
    expect(await disableTwoFactor(E, await totpCode(secret, Date.now()), Date.now())).toBe(true);
    expect(await twoFactorEnabled(E)).toBe(false);
  });
});

describe('token intermediário (cookie eb_2fa)', () => {
  it('NÃO valida como sessão (secret derivado) e expira em 5 min', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTwoFactorToken(E.OWNER_EMAIL, E, now);
    // Critério central da spec: colar o eb_2fa no cookie eb_session não loga.
    expect(await verifySession(token, E.SESSION_SECRET, now)).toBeNull();
    expect(await verifyTwoFactorToken(token, E, now)).toBe(E.OWNER_EMAIL);
    expect(await verifyTwoFactorToken(token, E, now + 299)).toBe(E.OWNER_EMAIL);
    expect(await verifyTwoFactorToken(token, E, now + 301)).toBeNull();
    // E o inverso: uma sessão de verdade não passa como token 2FA.
    const { signSession } = await import('../src/web/session');
    const session = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, now);
    expect(await verifyTwoFactorToken(session, E, now)).toBeNull();
  });
});

describe('login web em duas etapas', () => {
  it('com 2FA DESLIGADO o login segue direto (nada muda)', async () => {
    await wipeTwoFactor();
    const res = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: PASSWORD }, '10.77.0.1'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph');
    expect(cookieValue(res, 'eb_session')).toBeTruthy();
    expect(setCookieFor(res, 'eb_2fa')).toBeNull();
  });

  it('senha certa NÃO loga: manda pra tela do código com cookie eb_2fa', async () => {
    await enableTwoFactor();
    const res = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: PASSWORD }, '10.77.0.2'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login\/2fa\?next=/);
    expect(cookieValue(res, 'eb_2fa')).toBeTruthy();
    expect(setCookieFor(res, 'eb_session')).toBeNull();
  });

  it('GET da tela do código sem token intermediário volta pro login', async () => {
    const res = await SELF.fetch('https://example.com/app/login/2fa?next=/app/graph', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login\?next=/);
  });

  it('código certo emite a sessão e descarta o eb_2fa', async () => {
    const { secret } = await enableTwoFactor();
    const ip = '10.77.0.3';
    const step1 = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: PASSWORD }, ip));
    const twofa = cookieValue(step1, 'eb_2fa')!;

    const page = await SELF.fetch('https://example.com/app/login/2fa?next=/app/graph', {
      headers: { cookie: `eb_2fa=${twofa}` },
      redirect: 'manual',
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Verificação em duas etapas');

    const code = await totpCode(secret, Date.now());
    const done = await SELF.fetch(twoFaPost({ code }, ip, `eb_2fa=${twofa}`));
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/app/graph');
    expect(cookieValue(done, 'eb_session')).toBeTruthy();
    const cleared = setCookieFor(done, 'eb_2fa')!;
    expect(cleared).toContain('Max-Age=0');
  });

  it('código errado nega, backup code entra e é consumido', async () => {
    const { secret, backupCodes } = await enableTwoFactor();
    const ip = '10.77.0.4';
    const step1 = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: PASSWORD }, ip));
    const twofa = cookieValue(step1, 'eb_2fa')!;

    const bad = await SELF.fetch(twoFaPost({ code: await wrongCode(secret) }, ip, `eb_2fa=${twofa}`));
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain('Código inválido');

    const viaBackup = await SELF.fetch(twoFaPost({ code: backupCodes[1] }, ip, `eb_2fa=${twofa}`));
    expect(viaBackup.status).toBe(302);
    expect(cookieValue(viaBackup, 'eb_session')).toBeTruthy();
    expect(await backupCodesRemaining(E)).toBe(7);
  });

  it('POST sem token intermediário (expirou) recomeça do login, sem verificar código', async () => {
    await enableTwoFactor();
    const res = await SELF.fetch(twoFaPost({ code: '123456' }, '10.77.0.5', ''));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login\?next=/);
  });

  it('rate limit próprio: enxurrada de códigos errados vira 429', async () => {
    const { secret } = await enableTwoFactor();
    const ip = '10.77.0.6';
    const step1 = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: PASSWORD }, ip));
    const twofa = cookieValue(step1, 'eb_2fa')!;
    const bad = await wrongCode(secret);
    for (let i = 0; i < 6; i++) {
      await SELF.fetch(twoFaPost({ code: bad }, ip, `eb_2fa=${twofa}`));
    }
    const blocked = await SELF.fetch(twoFaPost({ code: bad }, ip, `eb_2fa=${twofa}`));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('/authorize com 2FA', () => {
  const provider = {
    parseAuthRequest: async () => ({ scope: ['mcp'] }),
    completeAuthorization: async () => ({ redirectTo: 'https://example.com/cb' }),
  };
  const EP = { ...E, OAUTH_PROVIDER: provider };

  it('desligado: form sem campo de código e senha sozinha autoriza', async () => {
    await wipeTwoFactor();
    const page = await authHandler.fetch(
      new Request('https://example.com/authorize?client_id=x', { method: 'GET' }), EP, {} as any);
    expect(await page.text()).not.toContain('name="code"');
    const ok = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: PASSWORD }, '10.77.1.1'), EP, {} as any);
    expect(ok.status).toBe(302);
  });

  it('ligado: form pede o código; senha certa sem código válido NÃO autoriza', async () => {
    const { secret } = await enableTwoFactor();
    const page = await authHandler.fetch(
      new Request('https://example.com/authorize?client_id=x', { method: 'GET' }), EP, {} as any);
    expect(await page.text()).toContain('name="code"');

    const semCodigo = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: PASSWORD }, '10.77.1.2'), EP, {} as any);
    expect(semCodigo.status).toBe(200);
    expect(await semCodigo.text()).toContain('Código de verificação inválido');

    const errado = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: PASSWORD, code: await wrongCode(secret) }, '10.77.1.2'),
      EP, {} as any);
    expect(await errado.text()).toContain('Código de verificação inválido');

    const certo = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: PASSWORD, code: await totpCode(secret, Date.now()) }, '10.77.1.2'),
      EP, {} as any);
    expect(certo.status).toBe(302);
    expect(certo.headers.get('location')).toBe('https://example.com/cb');
  });
});

describe('card Segurança em /app/config', () => {
  async function sessionCookieHeader(): Promise<string> {
    const { signSession } = await import('../src/web/session');
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    return `eb_session=${token}`;
  }

  function configGet(cookie: string, qs = ''): Promise<Response> {
    return SELF.fetch(`https://example.com/app/config${qs}`, {
      headers: { cookie },
      redirect: 'manual',
    });
  }

  function configPost(path: string, fields: Record<string, string>, cookie: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('fluxo completo: ativar → confirmar → flash one-time → desativar', async () => {
    await wipeTwoFactor();
    const cookie = await sessionCookieHeader();

    // Desligado: card com o botão de ativar.
    let page = await (await configGet(cookie)).text();
    expect(page).toContain('id="twofactor"');
    expect(page).toContain('Ativar verificação em duas etapas');

    // Start: aparece o secret pendente + otpauth + form de confirmação.
    const start = await configPost('/app/config/2fa/start', {}, cookie);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('saved=2fa');
    page = await (await configGet(cookie)).text();
    const m = page.match(/id="tf-secret-value">([A-Z2-7]{32})</);
    expect(m).not.toBeNull();
    const secret = m![1];
    expect(page).toContain('otpauth://totp/');
    expect(page).toContain('/app/config/2fa/confirm');

    // Código errado: volta com banner de erro, segue desligado.
    const bad = await configPost('/app/config/2fa/confirm', { code: await wrongCode(secret) }, cookie);
    expect(bad.headers.get('location')).toContain('tferr=code');
    expect(await twoFactorEnabled(E)).toBe(false);
    page = await (await configGet(cookie, '?saved=2fa&tferr=code')).text();
    expect(page).toContain('Código inválido');

    // Código certo: liga e o redirect carrega o flash one-time com os 8 códigos.
    const ok = await configPost('/app/config/2fa/confirm', { code: await totpCode(secret, Date.now()) }, cookie);
    const loc = ok.headers.get('location')!;
    expect(loc).toContain('tfflash=');
    expect(await twoFactorEnabled(E)).toBe(true);
    const qs = loc.slice(loc.indexOf('?'), loc.indexOf('#'));
    page = await (await configGet(cookie, qs)).text();
    const shown = page.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g) ?? [];
    expect(new Set(shown).size).toBe(8);
    expect(page).toContain('não aparecem de novo');
    // One-time de verdade: o mesmo link não mostra os códigos de novo.
    const again = await (await configGet(cookie, qs)).text();
    expect(again.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g)).toBeNull();
    expect(again).toContain('códigos reserva restantes');

    // Desativar com código errado nega; com TOTP válido desliga.
    const noDis = await configPost('/app/config/2fa/disable', { code: await wrongCode(secret) }, cookie);
    expect(noDis.headers.get('location')).toContain('tferr=disable');
    expect(await twoFactorEnabled(E)).toBe(true);
    const dis = await configPost('/app/config/2fa/disable', { code: await totpCode(secret, Date.now()) }, cookie);
    expect(dis.headers.get('location')).not.toContain('tferr');
    expect(await twoFactorEnabled(E)).toBe(false);
  });

  it('endpoints exigem sessão (302 pro login sem cookie)', async () => {
    const res = await SELF.fetch('https://example.com/app/config/2fa/start', {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login/);
  });
});
