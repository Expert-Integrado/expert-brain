import type { Env } from '../../env.js';
import { newId } from '../../util/id.js';
import {
  getProjectByIdOrLabel,
  createTaskProject,
  countTaskProjects,
  TASK_PROJECT_CAP,
  type TaskProject,
} from '../../db/queries.js';

// Resultado da resolução do param `project` (string) das tools save_task/update_task.
export type ProjectResolve =
  | { ok: true; projectId: string | null; project: TaskProject | null }
  | { ok: false; error: string };

// Resolve o param `project` (id OU label) num project_id concreto, com auto-create:
// - '' (vazio após trim) → DESVINCULA (projectId=null). É o caminho de update_task
//   `project: ""` = "remover do projeto".
// - match por id EXATO ou label (case-insensitive) entre projetos ATIVOS → vincula.
// - match só entre ARQUIVADOS (id ou label) → erro (orienta desarquivar) — a escrita
//   nunca vincula a projeto arquivado.
// - ref no formato de id (proj_...) sem match → erro. NÃO auto-cria: um ref com cara
//   de id era claramente uma referência, não um nome de pasta novo (evita
//   projeto-fantasma rotulado "proj_xxxx" por id digitado errado).
// - label sem match → AUTO-CRIA o projeto (label como veio, cor NULL), respeitando o
//   cap de 64. Justificativa: o fluxo é conversacional ("cria task do projeto X").
export async function resolveProjectForWrite(env: Env, ref: string, now: number): Promise<ProjectResolve> {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: true, projectId: null, project: null };

  const active = await getProjectByIdOrLabel(env, trimmed, true);
  if (active) return { ok: true, projectId: active.id, project: active };

  const archived = await getProjectByIdOrLabel(env, trimmed, false);
  if (archived) {
    return {
      ok: false,
      error: `Project '${archived.label}' is archived. Unarchive it in /app/config (Projetos) before assigning tasks to it, or use an active project.`,
    };
  }

  // ref com formato de id que não existe: não auto-cria (era uma referência, não label).
  if (/^proj_[a-z0-9]+$/i.test(trimmed)) {
    return {
      ok: false,
      error: `Project '${trimmed}' not found. Pass an existing project id/label, or a NEW label to create one.`,
    };
  }

  const count = await countTaskProjects(env);
  if (count >= TASK_PROJECT_CAP) {
    return {
      ok: false,
      error: `Project cap (${TASK_PROJECT_CAP}) reached. Archive an unused project in /app/config (Projetos) or reuse an existing one instead of creating a new project.`,
    };
  }
  const created = await createTaskProject(
    env,
    { id: `proj_${newId().slice(0, 8)}`, label: trimmed, color: null },
    now
  );
  return { ok: true, projectId: created.id, project: created };
}
