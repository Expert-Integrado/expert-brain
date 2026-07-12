// Núcleo ÚNICO de visibilidade por credencial (spec 80-frota-agentes/91).
// Antes desta spec o conceito "esta credencial vê itens privados?" tinha TRÊS
// definições paralelas (mcp/helpers.ts, web/media.ts com cópia local, web/mailbox-api.ts
// com hasScope direto) — que já haviam divergido uma vez (comment_task lendo public-only
// até pro dono). Este módulo é a fonte; os outros são wrappers finos por superfície.
// Depende só de auth/api-keys.js — importável de db/queries, mcp/helpers, web/* sem ciclo.

import { hasScope, SCOPE_TASKS_ASSIGNED } from './api-keys.js';

// "Vê itens privados?" — regra canônica (specs 17 + 31), fail-closed:
// nível dono (sessão OAuth / sessão de browser / bearer owner) sempre vê;
// PAT só com o token `private` no CSV. `full` dá CRUD, não confidência.
export function scopesSeePrivate(scopes: string | undefined, ownerLevel: boolean): boolean {
  return ownerLevel || hasScope(scopes, 'private');
}

// A credencial carrega o token `tasks:assigned`? (row-level, spec 91)
export function scopesAssignedOnly(scopes: string | undefined): boolean {
  return hasScope(scopes, SCOPE_TASKS_ASSIGNED);
}

// Visibilidade row-level de TASK (spec 91). Substitui o boolean `includePrivate`
// nas funções base de leitura de task: além do eixo private, carrega o eixo
// assigned-only (`tasks:assigned`) — quando `assignedOnlyUserId` não é null, a
// query restringe às linhas atribuídas/mencionadas/criadas-por esse usuário.
// SEM default em nenhuma assinatura: cada call-site declara a intenção
// explicitamente (o compilador vira o checklist da migração).
export interface TaskVisibility {
  includePrivate: boolean;
  assignedOnlyUserId: string | null; // null = sem restrição row-level
}

// Superfícies do DONO (board SSR, cron, digest, push): vê tudo, sempre.
export const OWNER_TASK_VIS: TaskVisibility = { includePrivate: true, assignedOnlyUserId: null };

// Credencial SEM restrição assigned-only — o comportamento histórico de todo
// PAT (`full`/`read`), parametrizado só pelo eixo private.
export function taskVisPublic(includePrivate: boolean): TaskVisibility {
  return { includePrivate, assignedOnlyUserId: null };
}
