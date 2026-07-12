import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { handleProvision } from '../src/auth/setup';
import { signSession } from '../src/web/session';
import { totpCode } from '../src/auth/totp';
import { startTwoFactor, confirmTwoFactor } from '../src/auth/twofactor';
import {
  verifyOwnerPassword,
  setOwnerPassword,
  passwordPolicyError,
  generateRecoveryCode,
  verifyRecoveryCode,
  recoveryCodeInfo,
} from '../src/auth/owner-password';

// Spec 100-seguranca-conta/103: senha efetiva (meta > env), "Esqueci a senha"
// por código de recuperação e troca de senha logado. isolatedStorage=false —
// o afterAll limpa owner_password_hash/recovery/totp pra não vazar pras outras
// suites (que logam com a senha do env).

const E = env as any;
const ENV_PASSWORD = 'correct-horse-battery-staple';

async function wipeAccountMeta(): Promise<void> {
  await E.DB.prepare(
    `DELETE FROM meta WHERE key IN ('owner_password_hash', 'recovery_code_hash', 'recovery_code_created_at') OR key LIKE 'totp_%'`
  ).run();
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

function recoverPost(fields: Record<string, string>, ip: string): Request {
  return new Request('https://example.com/app/login/recover', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeAll(async () => {
  const res = await handleProvision(
    new Request('https://example.com/setup/provision', {
      method: 'POST',
      headers: { authorization: 'Bearer setup-tok' },
    }),
    E
  );
  expect(res.status).toBe(200);
});

beforeEach(async () => {
  await wipeAccountMeta();
});

afterAll(async () => {
  await wipeAccountMeta();
});

describe('senha efetiva (module)', () => {
  it('fallback pro env quando a meta não existe; meta vence após setOwnerPassword', async () => {
    expect(await verifyOwnerPassword(E, ENV_PASSWORD)).toBe(true);
    expect(await verifyOwnerPassword(E, 'outra-senha-qualquer')).toBe(false);
    await setOwnerPassword(E, 'senha-nova-do-dono');
    expect(await verifyOwnerPassword(E, 'senha-nova-do-dono')).toBe(true);
    // A antiga (env) DEIXA de valer — a meta manda.
    expect(await verifyOwnerPassword(E, ENV_PASSWORD)).toBe(false);
  });

  it('política de senha nova: mínimo 10 chars e confirmação igual', () => {
    expect(passwordPolicyError('curta', 'curta')).toMatch(/10 caracteres/);
    expect(passwordPolicyError('senha-com-tamanho', 'diferente-total')).toMatch(/não bate/);
    expect(passwordPolicyError('senha-com-tamanho', 'senha-com-tamanho')).toBeNull();
  });

  it('código de recuperação: formato, verificação tolerante e regenerar invalida o anterior', async () => {
    expect(await recoveryCodeInfo(E)).toBeNull();
    const code = await generateRecoveryCode(E, Date.now());
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await recoveryCodeInfo(E))?.createdAt).toBeGreaterThan(0);
    expect(await verifyRecoveryCode(E, code.toLowerCase().replaceAll('-', ' '))).toBe(true);
    expect(await verifyRecoveryCode(E, 'AAAA-BBBB-CCCC')).toBe(false);
    const newer = await generateRecoveryCode(E, Date.now());
    expect(await verifyRecoveryCode(E, code)).toBe(false);
    expect(await verifyRecoveryCode(E, newer)).toBe(true);
  });
});

describe('fluxo "Esqueci a senha" (/app/login/recover)', () => {
  it('tela de login linka a recuperação; GET renderiza o form', async () => {
    const login = await SELF.fetch('https://example.com/app/login', { redirect: 'manual' });
    expect(await login.text()).toContain('/app/login/recover');
    const page = await SELF.fetch('https://example.com/app/login/recover', { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Recuperar acesso');
    expect(html).toContain('name="recovery"');
    // Sem 2FA ligado, não pede código do app.
    expect(html).not.toContain('name="code"');
  });

  it('código válido troca a senha, CONSOME o código e o login novo funciona', async () => {
    const code = await generateRecoveryCode(E, Date.now());
    const res = await SELF.fetch(
      recoverPost({ recovery: code, password: 'senha-trocada-via-recover', confirm: 'senha-trocada-via-recover' }, '10.88.0.1')
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/login?recovered=1');
    // Banner na tela de login.
    const login = await SELF.fetch('https://example.com/app/login?recovered=1', { redirect: 'manual' });
    expect(await login.text()).toContain('Senha trocada com sucesso');
    // Senha nova entra; a antiga não.
    const ok = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: 'senha-trocada-via-recover' }, '10.88.0.2'));
    expect(ok.status).toBe(302);
    const old = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: ENV_PASSWORD }, '10.88.0.3'));
    expect(old.status).toBe(401);
    // Código consumido: segunda recuperação com ele falha.
    const again = await SELF.fetch(
      recoverPost({ recovery: code, password: 'outra-senha-valida-x', confirm: 'outra-senha-valida-x' }, '10.88.0.4')
    );
    expect(again.status).toBe(401);
  });

  it('código errado não troca nada; senha fraca/confirmação errada NÃO consomem o código', async () => {
    const code = await generateRecoveryCode(E, Date.now());
    const bad = await SELF.fetch(
      recoverPost({ recovery: 'AAAA-BBBB-CCCC', password: 'senha-valida-longa', confirm: 'senha-valida-longa' }, '10.88.1.1')
    );
    expect(bad.status).toBe(401);
    expect(await verifyOwnerPassword(E, ENV_PASSWORD)).toBe(true);

    const weak = await SELF.fetch(recoverPost({ recovery: code, password: 'curta', confirm: 'curta' }, '10.88.1.2'));
    expect(weak.status).toBe(400);
    const mismatch = await SELF.fetch(
      recoverPost({ recovery: code, password: 'senha-valida-longa', confirm: 'senha-diferente-9' }, '10.88.1.3')
    );
    expect(mismatch.status).toBe(400);
    // O código sobreviveu às falhas de política — ainda vale.
    expect(await verifyRecoveryCode(E, code)).toBe(true);
  });

  it('com 2FA ligado, recuperar senha EXIGE o segundo fator', async () => {
    const secret = await startTwoFactor(E);
    await confirmTwoFactor(E, await totpCode(secret, Date.now()), Date.now());
    const code = await generateRecoveryCode(E, Date.now());

    // Form passa a pedir o código do app.
    const page = await (await SELF.fetch('https://example.com/app/login/recover', { redirect: 'manual' })).text();
    expect(page).toContain('name="code"');

    // Sem/errado o segundo fator: nega e NÃO consome o recovery.
    const sem = await SELF.fetch(
      recoverPost({ recovery: code, password: 'senha-valida-longa', confirm: 'senha-valida-longa' }, '10.88.2.1')
    );
    expect(sem.status).toBe(401);
    expect(await verifyRecoveryCode(E, code)).toBe(true);

    // Com TOTP válido: troca.
    const ok = await SELF.fetch(
      recoverPost(
        {
          recovery: code,
          code: await totpCode(secret, Date.now()),
          password: 'senha-valida-longa',
          confirm: 'senha-valida-longa',
        },
        '10.88.2.2'
      )
    );
    expect(ok.status).toBe(302);
    expect(await verifyOwnerPassword(E, 'senha-valida-longa')).toBe(true);
  });

  it('rate limit por IP: enxurrada de códigos errados vira 429', async () => {
    await generateRecoveryCode(E, Date.now());
    const ip = '10.88.3.1';
    for (let i = 0; i < 6; i++) {
      await SELF.fetch(recoverPost({ recovery: 'AAAA-BBBB-CCCC', password: 'senha-valida-longa', confirm: 'senha-valida-longa' }, ip));
    }
    const blocked = await SELF.fetch(
      recoverPost({ recovery: 'AAAA-BBBB-CCCC', password: 'senha-valida-longa', confirm: 'senha-valida-longa' }, ip)
    );
    expect(blocked.status).toBe(429);
  });

  it('POST sem Origin correto é negado (CSRF)', async () => {
    const res = await SELF.fetch('https://example.com/app/login/recover', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'recovery=x&password=y&confirm=y',
    });
    expect(res.status).toBe(403);
  });
});

describe('card "Senha e recuperação" em /app/config', () => {
  async function sessionCookieHeader(): Promise<string> {
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    return `eb_session=${token}`;
  }

  function configPost(path: string, fields: Record<string, string>, cookie: string): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('trocar senha exige a atual; sucesso passa a valer no login', async () => {
    const cookie = await sessionCookieHeader();
    const page = await (
      await SELF.fetch('https://example.com/app/config', { headers: { cookie }, redirect: 'manual' })
    ).text();
    expect(page).toContain('id="password"');
    expect(page).toContain('/app/config/password');
    expect(page).toContain('Nenhum código de recuperação');

    const wrong = await configPost(
      '/app/config/password',
      { current: 'senha-errada', password: 'senha-nova-valida', confirm: 'senha-nova-valida' },
      cookie
    );
    expect(wrong.headers.get('location')).toContain('pwerr=current');
    expect(await verifyOwnerPassword(E, ENV_PASSWORD)).toBe(true);

    const ok = await configPost(
      '/app/config/password',
      { current: ENV_PASSWORD, password: 'senha-nova-valida', confirm: 'senha-nova-valida' },
      cookie
    );
    expect(ok.headers.get('location')).toContain('pwok=1');
    expect(await verifyOwnerPassword(E, 'senha-nova-valida')).toBe(true);
  });

  it('gerar código de recuperação mostra UMA vez via flash e some no reload', async () => {
    const cookie = await sessionCookieHeader();
    const gen = await configPost('/app/config/recovery-code', {}, cookie);
    const loc = gen.headers.get('location')!;
    expect(loc).toContain('rcflash=');
    const qs = loc.slice(loc.indexOf('?'), loc.indexOf('#'));
    const withFlash = await (
      await SELF.fetch(`https://example.com/app/config${qs}`, { headers: { cookie }, redirect: 'manual' })
    ).text();
    const shown = withFlash.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(shown).not.toBeNull();
    expect(await verifyRecoveryCode(E, shown![0])).toBe(true);
    // One-time: mesmo link de novo não mostra o código, e o estado vira "ativo".
    const again = await (
      await SELF.fetch(`https://example.com/app/config${qs}`, { headers: { cookie }, redirect: 'manual' })
    ).text();
    expect(again.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)).toBeNull();
    expect(again).toContain('Código ativo');
  });

  it('endpoints exigem sessão', async () => {
    const res = await SELF.fetch('https://example.com/app/config/recovery-code', {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login/);
  });
});
