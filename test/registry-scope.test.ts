import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerAllTools, scopeGuard } from '../src/mcp/registry.js';
import { validateScopesCsv } from '../src/auth/api-keys.js';
import { SCOPE_PRESETS, presetById, presetForScopes } from '../src/auth/presets.js';

// Suíte da spec 80-frota-agentes/91 — snapshot LITERAL das tools registradas por
// preset de credencial. As listas abaixo são a superfície CONTRATUAL de cada papel:
// tool nova que entrar no registry SEM annotations.resource quebra o snapshot de
// 'full' (aparece a mais) e força o autor a classificar o recurso — é o mecanismo
// que impede vazamento silencioso pra credencial restrita (fail-closed provado no
// bloco scopeGuard no fim).
const E = env as any;
const OWNER = 'owner@example.com';

// Server fake que coleta { config, handler } por nome (mesmo padrão de api-keys.test.ts).
function makeCollector() {
  const tools: Record<string, { config: any; handler: any }> = {};
  const server = {
    registerTool: (name: string, config: any, handler: any) => { tools[name] = { config, handler }; },
  } as any;
  return { server, tools };
}

function toolsFor(scopes: string | undefined): { names: string[]; tools: Record<string, { config: any; handler: any }> } {
  const { server, tools } = makeCollector();
  registerAllTools(server, E, scopes === undefined
    ? { email: OWNER, loggedInAt: 0 }
    : { email: OWNER, loggedInAt: 0, scopes });
  return { names: Object.keys(tools).sort(), tools };
}

// ---- Superfície por família (resource) — MEDIA está bindado no pool de teste ----
const NOTES = [
  'save_note', 'update_note', 'mark_private', 'delete_note', 'restore_note',
  'recall', 'expand', 'get_note', 'link', 'delete_link', 'reembed', 'stats',
  'digest', 'capture', 'list_inbox', 'resolve_inbox',
];
const NOTES_MEDIA = ['attach_media_to_note', 'get_note_media', 'delete_note_media'];
const TASKS = [
  'save_task', 'list_tasks', 'list_tasks_due_today', 'get_task',
  'update_task', 'complete_task', 'comment_task', 'update_subtask', 'update_task_deps', 'claim_task',
];
const TASKS_SHARE = ['share_task', 'unshare_task'];
const CONTACTS = ['list_contacts', 'search_contacts', 'get_contact', 'get_contact_by_phone'];
// Escrita no vault de contatos (fusão F6): resource:'contacts', readOnlyHint:false
// — só presets full as veem (read + contacts:none as suprimem, provado abaixo).
const CONTACTS_WRITE = [
  'save_contact', 'connect_contacts', 'log_contact_event',
  'delete_contact', 'delete_contact_connection', 'merge_contacts',
];
const MAILBOX = ['check_mailbox', 'ack_mailbox'];
const USERS = ['list_users'];

const ALL_44 = [...NOTES, ...NOTES_MEDIA, ...TASKS, ...TASKS_SHARE, ...CONTACTS, ...CONTACTS_WRITE, ...MAILBOX, ...USERS].sort();

// readOnlyHint:true — o que o escopo base 'read' enxerga (spec 17, intocado).
const READ_ONLY_14 = [
  'recall', 'expand', 'get_note', 'stats', 'get_note_media',
  'list_tasks', 'list_tasks_due_today', 'get_task',
  ...CONTACTS, 'check_mailbox', 'list_users',
].sort();

// Robô de frota: zero notas/contatos, TODAS as tasks não-privadas + share + mailbox.
const FLEET_15 = [...TASKS, ...TASKS_SHARE, ...MAILBOX, ...USERS].sort();
// Robô colaborador: idem MENOS share (link público /s/ = exfiltração sob assigned-only).
const TASK_WORKER_13 = [...TASKS, ...MAILBOX, ...USERS].sort();

describe('registerAllTools — snapshot literal por preset (spec 91)', () => {
  it('sanidade: as famílias somam exatamente 44 tools sem duplicata', () => {
    expect(ALL_44).toHaveLength(44);
    expect(new Set(ALL_44).size).toBe(44);
  });

  it("preset 'personal-full' (full,private) registra as 44", () => {
    expect(toolsFor(presetById('personal-full')!.scopes).names).toEqual(ALL_44);
  });

  it("preset 'personal' (full) registra as 44", () => {
    expect(toolsFor(presetById('personal')!.scopes).names).toEqual(ALL_44);
  });

  it('sessão OAuth (scopes ausente) = personal-full: 44', () => {
    expect(toolsFor(undefined).names).toEqual(ALL_44);
  });

  it("preset 'reader' (read) registra as 14 readOnlyHint:true", () => {
    const { names, tools } = toolsFor(presetById('reader')!.scopes);
    expect(names).toEqual(READ_ONLY_14);
    for (const [name, entry] of Object.entries(tools)) {
      expect(entry.config?.annotations?.readOnlyHint, `${name} deveria ser readOnlyHint:true`).toBe(true);
    }
  });

  it("preset 'fleet-worker' registra EXATAMENTE as 15 (tasks + share + mailbox + users)", () => {
    expect(toolsFor(presetById('fleet-worker')!.scopes).names).toEqual(FLEET_15);
  });

  it("preset 'task-worker' registra EXATAMENTE as 13 (fleet menos share)", () => {
    expect(toolsFor(presetById('task-worker')!.scopes).names).toEqual(TASK_WORKER_13);
  });

  it('toda tool registrada sob credencial restrita declara annotations.resource', () => {
    // Reforço do fail-closed: nas superfícies restritas, nenhuma sobrevivente
    // pode estar sem resource (se estivesse, o guard a teria suprimido — mas
    // este teste documenta o invariante pra quem ler o snapshot).
    const { tools } = toolsFor(presetById('fleet-worker')!.scopes);
    for (const [name, entry] of Object.entries(tools)) {
      expect(entry.config?.annotations?.resource, `${name} sem annotations.resource`).toBeTruthy();
    }
  });
});

describe('scopeGuard — fail-closed pra tool sem annotations.resource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('credencial restrita: tool sem resource é SUPRIMIDA com console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { server, tools } = makeCollector();
    const reg = scopeGuard(server, 'full,notes:none');
    reg.registerTool('rogue_tool', { annotations: { title: 'Rogue', readOnlyHint: true } }, () => {});
    expect(Object.keys(tools)).not.toContain('rogue_tool');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('rogue_tool');
  });

  it('credencial SEM restrição: fast path devolve o server cru (tool sem resource passa)', () => {
    const { server, tools } = makeCollector();
    const reg = scopeGuard(server, 'full');
    expect(reg).toBe(server);
    reg.registerTool('legacy_tool', { annotations: { title: 'Legacy', readOnlyHint: true } }, () => {});
    expect(Object.keys(tools)).toContain('legacy_tool');
  });

  it("tasks:assigned suprime tasks.share mas mantém 'tasks'", () => {
    const { server, tools } = makeCollector();
    const reg = scopeGuard(server, 'full,tasks:assigned');
    reg.registerTool('t_share', { annotations: { title: 'S', resource: 'tasks.share', readOnlyHint: false } }, () => {});
    reg.registerTool('t_task', { annotations: { title: 'T', resource: 'tasks', readOnlyHint: false } }, () => {});
    expect(Object.keys(tools)).toEqual(['t_task']);
  });

  it("notes:none derruba 'notes' E 'notes.media' (mídia herda a família)", () => {
    const { server, tools } = makeCollector();
    const reg = scopeGuard(server, 'full,notes:none');
    reg.registerTool('n_note', { annotations: { title: 'N', resource: 'notes', readOnlyHint: true } }, () => {});
    reg.registerTool('n_media', { annotations: { title: 'M', resource: 'notes.media', readOnlyHint: true } }, () => {});
    reg.registerTool('n_task', { annotations: { title: 'T', resource: 'tasks', readOnlyHint: true } }, () => {});
    expect(Object.keys(tools)).toEqual(['n_task']);
  });
});

describe('validateScopesCsv + presets — vocabulário (spec 91)', () => {
  it('todo preset embarcado passa na validação', () => {
    for (const p of SCOPE_PRESETS) {
      expect(validateScopesCsv(p.scopes), `preset ${p.id} inválido`).toBeNull();
    }
  });

  it('token desconhecido é rejeitado com o nome do token na mensagem', () => {
    const err = validateScopesCsv('full,banana');
    expect(err).toContain('banana');
  });

  it("CSV sem escopo base 'full'/'read' é rejeitado (polaridade subtrativa exige base)", () => {
    expect(validateScopesCsv('notes:none,tasks:assigned')).not.toBeNull();
    expect(validateScopesCsv('private')).not.toBeNull();
  });

  it('CSV vazio é rejeitado', () => {
    expect(validateScopesCsv('')).not.toBeNull();
    expect(validateScopesCsv(' , ')).not.toBeNull();
  });

  it('presetForScopes: match por conjunto (ordem/espaços irrelevantes)', () => {
    expect(presetForScopes('notes:none, full ,contacts:none')?.id).toBe('fleet-worker');
    expect(presetForScopes('full,private')?.id).toBe('personal-full');
    expect(presetForScopes(undefined)?.id).toBe('personal'); // default histórico = full
    expect(presetForScopes('full,notes:none')).toBeNull(); // combinação custom = Personalizado
  });
});
