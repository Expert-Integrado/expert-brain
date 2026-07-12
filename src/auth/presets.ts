// Presets de credencial (spec 80-frota-agentes/91) — a UI mostra PAPÉIS nomeados;
// o CSV de scopes é o motor. Os presets são os ÚNICOS escritores dos tokens de
// restrição (notes:none / contacts:none / tasks:assigned): o form de criação em
// /app/config oferece este select (+ "Personalizado…", que expõe só os controles
// legados base+private), então token desconhecido nunca entra no DB por UI.
// A matriz CRUD crua (recurso × verbo × sensibilidade ≈ 28 toggles) foi REJEITADA
// de propósito: erro de configuração vira vazamento; papel nomeado não.

import { SCOPE_NOTES_NONE, SCOPE_CONTACTS_NONE, SCOPE_TASKS_ASSIGNED } from './api-keys.js';

export interface ScopePreset {
  id: string;
  label: string;
  hint: string;
  scopes: string; // CSV canônico do preset
}

// Hints em voz de produto (spec 101): é o texto dos radio-cards da criação
// guiada — leigo, mas preciso sobre o que a chave VÊ e FAZ. label/id/scopes
// são contrato (whoami, badge da listagem) e não mudam.
export const SCOPE_PRESETS: readonly ScopePreset[] = [
  {
    id: 'personal-full',
    label: 'Dispositivo pessoal total',
    hint: 'Faz tudo, inclusive ler e editar o que é privado — só pra máquina que é sua',
    scopes: 'full,private',
  },
  {
    id: 'personal',
    label: 'Dispositivo pessoal',
    hint: 'Faz tudo no vault, menos ver o que você marcou como privado',
    scopes: 'full',
  },
  {
    id: 'reader',
    label: 'Leitor',
    hint: 'Só consulta: lê e busca, não muda nada e não vê itens privados',
    scopes: 'read',
  },
  {
    id: 'fleet-worker',
    label: 'Robô de frota',
    hint: 'Trabalha em todas as tarefas não-privadas e no mural de recados; não vê suas notas nem seus contatos',
    scopes: `full,${SCOPE_NOTES_NONE},${SCOPE_CONTACTS_NONE}`,
  },
  {
    id: 'task-worker',
    label: 'Robô colaborador',
    hint: 'Só vê tarefas atribuídas ou mencionadas a ele; não vê notas nem contatos — o mais seguro pra máquina compartilhada',
    scopes: `full,${SCOPE_NOTES_NONE},${SCOPE_CONTACTS_NONE},${SCOPE_TASKS_ASSIGNED}`,
  },
] as const;

export function presetById(id: string): ScopePreset | null {
  return SCOPE_PRESETS.find((p) => p.id === id) ?? null;
}

// Reverse-map CSV → preset (badge na listagem, campo `preset` no /api/whoami).
// Match por CONJUNTO normalizado (ordem/espaços irrelevantes); sem match = null
// ("Personalizado" na UI).
export function presetForScopes(csv: string | undefined): ScopePreset | null {
  const norm = (s: string): string => s.split(',').map((t) => t.trim()).filter(Boolean).sort().join(',');
  const target = norm(csv ?? 'full');
  return SCOPE_PRESETS.find((p) => norm(p.scopes) === target) ?? null;
}
