// Google Fonts preconnect + font stylesheet are injected in <head> via FONT_LINKS.
// Poppins é a fonte de marca da Expert Integrado (display: títulos, logo, headings).
// Manrope continua pra body — ambas geometric sans, complementam.
// Substituiu Fraunces (serif) em 01/05/2026 alinhando com identidade visual EI.
export const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
`;

// Cor do <meta name="theme-color"> — DEVE espelhar o token --bg abaixo (fonte única
// em TS porque meta tag não resolve custom property CSS). Consumida por render.ts e share.ts.
export const THEME_COLOR = '#070a13';
// Espelho claro (spec 91-experiencia-premium/96) — DEVE espelhar o --bg do bloco
// [data-theme="light"] em TOKENS_CSS. O client (shell.ts) troca o meta em runtime.
export const THEME_COLOR_LIGHT = '#f6f7fb';

// Boot anti-flash do tema (spec 96): carimba data-theme no <html> ANTES do CSS
// pintar. A CSP (script-src 'self') proíbe inline no head, então isto é servido
// como asset bloqueante minúsculo em /app/theme-boot.js, carregado antes do
// stylesheet. localStorage.theme: 'light' | 'dark' | 'auto' (default auto segue
// prefers-color-scheme). O toggle fica no shell (client/shell.ts).
export const THEME_BOOT_JS = `(function(){try{var p=localStorage.theme;var m=(p==='light'||p==='dark')?p:(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',m);}catch(e){}})();`;

// Midnight Nebula — distinctive aesthetic: Poppins display + Manrope body, deep nebula
// gradient, soft grain, lavender-accented cards with hover-lift, focus-visible rings.
//
// Onda 2 (specs/60-ux-reforma/63): o CSS do console é composto em camadas.
// NEBULA_CSS (o /app/styles.css completo) = TOKENS + BASE + SHELL + COMPONENTS + SURFACES,
// preservando a ordem relativa original das regras. PUBLIC_CSS (páginas /s/ sem sessão) =
// TOKENS + BASE + COMPONENTS. Trocar identidade/tema (Onda 6) = mexer SÓ em TOKENS_CSS.

// ---------------------------------------------------------------------------
// TOKENS_CSS — o que muda entre identidades/temas. Três sub-camadas no mesmo
// :root: primitiva (paleta bruta/fontes/raios), semântica (superfícies, texto,
// estados, prioridades) e escalas (espaçamento, tipografia, densidade).
// ---------------------------------------------------------------------------
export const TOKENS_CSS = `
:root {
  /* ============ Direção A — "Nebula Refinada" (Onda 6, specs/60-ux-reforma/62+67) ============
     Decisão do dono no gate da Onda 1: evolução do Midnight Nebula — mesma identidade
     (fundo espacial, lavanda + ciano, Poppins/Manrope), com contraste AA em todo texto
     informativo, gradiente mais calmo e escada REAL de superfícies (opacas, não véus
     translúcidos — viabiliza cálculo de contraste e o futuro tema claro).
     Breakpoint canônico do console: 767px (único @media mobile permitido).
     Tabela de contraste WCAG: docs/ux-contraste-aa.md (gate da Onda 6). */

  /* -- primitiva: paleta bruta, fontes, raios -- */
  --bg: #070a13;
  --bg-mid: #0b0f19;
  --bg-accent: var(--surface-1); /* legado — degrau 1 da escada de superfícies */
  --text: #f8fafc;
  --text-dim: #b9bfd0;    /* AA 9.7:1 sobre --surface-1 */
  --text-faint: rgba(248, 250, 252, 0.34); /* SÓ decorativo (divisores, ornamentos) — nunca texto informativo (reprova AA) */
  --border: rgba(167, 139, 250, 0.16);
  --border-strong: rgba(167, 139, 250, 0.38);
  --surface: #0c101d;
  --surface-raised: #121728;
  --accent-lav: #a78bfa;
  --accent-cyan: #5eead4;
  --accent-pink: #f0abfc;
  --accent-violet: #7c3aed;
  --accent-lav-rgb: 167, 139, 250;
  --accent-violet-rgb: 124, 58, 237;
  --accent-contrast: #0b0f19; /* texto SOBRE o acento sólido (botão primário, badge) — AA 7.2:1 */
  --danger: #ff8298;
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --font-display: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-body: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;

  /* -- semântica: aliases e escalas derivadas (adoção ampla nas Ondas 3-5) -- */
  --accent: var(--accent-lav);
  --accent-2: var(--accent-cyan);
  --surface-0: var(--surface);
  --surface-1: var(--surface-raised);
  --surface-2: #192036;
  --surface-3: #212a46;
  --backdrop: rgba(4, 6, 12, 0.72);
  --shadow-1: 0 1px 2px rgba(2, 4, 12, 0.4);
  --shadow-2: 0 6px 18px rgba(2, 4, 12, 0.5), 0 0 0 1px rgba(167, 139, 250, 0.08);
  --shadow-3: 0 18px 50px rgba(2, 4, 12, 0.6);
  --text-subtle: #8e96ad; /* terciário informativo — AA 6.0:1 sobre --surface-1, entre --text-dim e o decorativo --text-faint */
  --input-bg: var(--surface);
  --success: #4ade80;
  --success-bg: rgba(74, 222, 128, 0.12);
  --success-border: rgba(74, 222, 128, 0.4);
  --warning: #fbbf24;
  --warning-bg: rgba(251, 191, 36, 0.12);
  --warning-border: rgba(251, 191, 36, 0.4);
  --danger-bg: rgba(255, 130, 152, 0.12);
  --danger-border: rgba(255, 130, 152, 0.5);
  --info: #7db8ff;
  --info-bg: rgba(125, 184, 255, 0.12);
  --info-border: rgba(125, 184, 255, 0.4);
  --prio-1: var(--danger);
  --prio-2: var(--warning);
  --prio-3: var(--info);
  --prio-4: #9aa2b8;
  /* Palco do grafo (2D e 3D): neutro escuro, sem tint lavanda — mais profundo
     que o Obsidian (#1e1e1e) de propósito. graph3d.ts (BG_COLOR) espelha o valor
     em JS pro WebGL — mudar aqui = mudar lá. */
  --surface-canvas: #0c0c10;

  /* -- tema: fundo e grain tokenizados (gradiente calmo da direção A) -- */
  --bg-gradient:
    radial-gradient(ellipse 90% 55% at 30% 0%, rgba(124, 58, 237, 0.16) 0%, transparent 60%),
    radial-gradient(ellipse 75% 65% at 88% 100%, rgba(94, 234, 212, 0.06) 0%, transparent 55%),
    radial-gradient(ellipse at 50% 50%, var(--bg-mid) 0%, var(--bg) 75%);
  --grain-opacity: 0.22;

  /* -- escalas: espaçamento base 4px, tipografia pareada, densidade -- */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 28px;
  --space-8: 32px;
  --space-9: 36px;
  --space-10: 40px;
  --text-xs: 11px;
  --leading-xs: 1.45;
  --text-sm: 13px;
  --leading-sm: 1.5;
  --text-md: 15px;
  --leading-md: 1.6;
  --text-lg: 18px;
  --leading-lg: 1.45;
  --text-xl: 22px;
  --leading-xl: 1.3;
  --text-2xl: 28px;
  --leading-2xl: 1.15;
  --density: 1;
}

/* ============ Cartela CLARA (spec 91-experiencia-premium/96) ============
   Sobrescreve SÓ as camadas primitiva/semântica — nenhuma regra de componente
   muda (é a prova da arquitetura de tokens da Onda 2). data-theme é carimbado
   no <html> pelo theme-boot.js antes do primeiro paint; 'auto' segue o SO.
   Gate AA: tabela clara em docs/ux-contraste-aa.md — pares informativos >= 4.5:1
   (verificados com a mesma fórmula WCAG 2.1 do gate dark).
   Espelhos JS: THEME_COLOR_LIGHT (acima) = --bg; grafo 2D/3D lê --surface-canvas
   via getComputedStyle em runtime (nada hardcoded a atualizar). */
[data-theme="light"] {
  /* -- primitiva -- */
  --bg: #f6f7fb;
  --bg-mid: #eef0f8;
  --text: #171c2e;
  --text-dim: #454e66;    /* AA 7.6:1 sobre --surface-1 */
  --text-faint: rgba(23, 28, 46, 0.34); /* decorativo, mesma regra do dark */
  --border: rgba(109, 40, 217, 0.16);
  --border-strong: rgba(109, 40, 217, 0.4);
  --surface: #ffffff;
  --surface-raised: #f4f5fb;
  --accent-lav: #6d28d9;  /* violet-700 — o #a78bfa do dark reprova sobre claro */
  --accent-cyan: #0f766e;
  --accent-pink: #a21caf;
  --accent-violet: #7c3aed;
  --accent-lav-rgb: 109, 40, 217;
  --accent-violet-rgb: 124, 58, 237;
  --accent-contrast: #ffffff; /* texto SOBRE o acento sólido — AA 7.1:1 */
  --danger: #be123c;

  /* -- semântica -- */
  --surface-2: #e9ebf5;
  --surface-3: #dfe3f0;
  --backdrop: rgba(23, 28, 46, 0.4);
  --shadow-1: 0 1px 2px rgba(23, 28, 46, 0.08);
  --shadow-2: 0 6px 18px rgba(23, 28, 46, 0.1), 0 0 0 1px rgba(109, 40, 217, 0.06);
  --shadow-3: 0 18px 50px rgba(23, 28, 46, 0.16);
  --text-subtle: #5a6480; /* AA 5.4:1 sobre --surface-1 */
  --success: #166534;
  --success-bg: rgba(22, 101, 52, 0.1);
  --success-border: rgba(22, 101, 52, 0.45);
  --warning: #854d0e;
  --warning-bg: rgba(133, 77, 14, 0.1);
  --warning-border: rgba(133, 77, 14, 0.45);
  --danger-bg: rgba(190, 18, 60, 0.1);
  --danger-border: rgba(190, 18, 60, 0.5);
  --info: #1d4ed8;
  --info-bg: rgba(29, 78, 216, 0.08);
  --info-border: rgba(29, 78, 216, 0.4);
  --prio-4: #475569;
  --surface-canvas: #eef0f6;

  /* -- tema: gradiente calmo claro + grain quase imperceptível -- */
  --bg-gradient:
    radial-gradient(ellipse 90% 55% at 30% 0%, rgba(124, 58, 237, 0.08) 0%, transparent 60%),
    radial-gradient(ellipse 75% 65% at 88% 100%, rgba(15, 118, 110, 0.05) 0%, transparent 55%),
    radial-gradient(ellipse at 50% 50%, var(--bg-mid) 0%, var(--bg) 75%);
  --grain-opacity: 0.05;
}
`;

// ---------------------------------------------------------------------------
// BASE_CSS — reset, foco, html/body (fundo + grain via token), links, seleção.
// ---------------------------------------------------------------------------
export const BASE_CSS = `
* { box-sizing: border-box; }
*:focus { outline: none; }
*:focus-visible { outline: 2px solid var(--accent-lav); outline-offset: 2px; border-radius: 4px; }

/* Acessibilidade: usuário pediu menos movimento no SO = zera animação/transição
   em tudo (spec 67). Regras locais (ex: .skeleton) podem complementar o visual
   estático, mas a garantia global mora aqui. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

html, body {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  color: var(--text);
  font-family: var(--font-body);
  font-size: 15px;
  font-weight: 400;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  /* Mobile: evita swipe-from-edge disparar back-nav do browser e impede
     bounce/overscroll vertical interferindo nos gestos do canvas. */
  overscroll-behavior: contain;
  background: var(--bg-gradient);
  background-attachment: fixed;
}

/* Soft grain overlay (SVG noise, data URI — no network, CSP-safe) */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: var(--grain-opacity);
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.08 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
}

a { color: var(--accent-lav); text-decoration: none; transition: color 180ms var(--ease); }
a:hover { color: var(--text); }

::selection { background: rgba(167, 139, 250, 0.4); color: var(--text); }
`;

// ---------------------------------------------------------------------------
// SHELL_CSS — moldura do console logado: .shell, sidebar (+ modo recolhido),
// .main e page-header. Bottom-nav mobile e as regras responsivas do shell
// seguem em SURFACES_CSS até a Onda 5, pra preservar a ordem de cascata.
// Na cascata, SHELL vem ANTES de COMPONENTS: tipografia genérica do shell
// (ex. .main h2) não pode vencer componente (ex. .card h2) em especificidade
// igual — componente é mais específico em intenção.
// ---------------------------------------------------------------------------
export const SHELL_CSS = `
/* ---- Shell ---- */
.shell { display: flex; min-height: 100vh; position: relative; z-index: 1; }

.sidebar {
  width: 224px;
  flex-shrink: 0;
  padding: 32px 20px 24px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: linear-gradient(180deg, rgba(167, 139, 250, 0.05), transparent 30%);
  /* Fixa: não rola junto com a lista de notas. O botão Recolher (no .bottom)
     fica sempre visível, sem precisar descer a página. */
  position: sticky;
  top: 0;
  align-self: flex-start;
  height: 100vh;
  overflow-y: auto;
}
.sidebar .logo {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 19px;
  letter-spacing: -0.015em;
  margin-bottom: 32px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
}
.sidebar .logo::before {
  content: "";
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: url('/expert-integrado-logo.png') center/cover no-repeat #ffffff;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 0 16px rgba(167, 139, 250, 0.35);
}
.sidebar .nav-item {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  color: var(--text-dim);
  transition: all 180ms var(--ease);
  display: flex;
  align-items: center;
  gap: 10px;
}
.sidebar .nav-item::before {
  content: "";
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: transparent;
  transition: background 180ms var(--ease);
}
.sidebar .nav-item:hover { color: var(--text); background: rgba(167, 139, 250, 0.08); }
.sidebar .nav-item.active {
  background: rgba(167, 139, 250, 0.14);
  color: var(--text);
}
.sidebar .nav-item.active::before { background: var(--accent-lav); box-shadow: 0 0 10px rgba(167, 139, 250, 0.75); }

/* Botões da sidebar que não navegam (Buscar, spec 91/93; Tema, spec 91/96):
   mesmo desenho dos nav-item, com reset de button. */
.sidebar .nav-search,
.sidebar .nav-theme {
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.nav-kbd {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-subtle);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.sidebar-collapsed .nav-kbd { display: none; }

/* Rodapé da sidebar (Onda 5, decisão do gate): grupo coeso Recolher → Configurações
   → bloco do usuário (avatar + e-mail + Sair), separado da navegação por borda. */
.sidebar .bottom { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-subtle); display: flex; flex-direction: column; gap: 2px; }
.sidebar .bottom form { margin: 0; }

/* Badge numérico de pendências na nav (inbox) — antes vivia inline no <head> */
.nav-badge, .bottom-nav-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1;
  background: var(--accent-lav); color: var(--accent-contrast);
}
.nav-item .nav-badge { margin-left: auto; }
.sidebar-collapsed .nav-item .nav-badge {
  position: absolute; top: 4px; right: 4px; margin-left: 0;
  min-width: 16px; height: 16px; font-size: 10px;
}
.sidebar-collapsed .nav-item { position: relative; }
.bottom-nav-item { position: relative; }
.bottom-nav-badge { position: absolute; top: 3px; right: 22%; min-width: 16px; height: 16px; font-size: 10px; }

/* nav-item agora carrega ícone + label. Ícone fixo, label some no modo recolhido. */
.sidebar .nav-item svg { flex-shrink: 0; }
.sidebar .nav-label { white-space: nowrap; overflow: hidden; }

/* Botão de recolher: linha de ícone+texto, mesmo desenho dos nav-item. */
.sidebar .bottom .sidebar-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  transition: color 180ms var(--ease), background 180ms var(--ease);
}
.sidebar .bottom .sidebar-toggle svg { transition: transform 220ms var(--ease); flex-shrink: 0; }
.sidebar .bottom .sidebar-toggle:hover { color: var(--accent-lav); background: rgba(167, 139, 250, 0.08); }

/* Bloco do usuário: avatar com a inicial + e-mail truncado + Sair (ícone) */
.sidebar .sidebar-user {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 8px 10px 4px 14px;
}
.sidebar .sidebar-avatar {
  width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(167, 139, 250, 0.22);
  color: var(--accent-lav); font-size: 11px; font-weight: 700;
}
.sidebar .sidebar-email { flex: 1; min-width: 0; font-family: var(--font-body); font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar .sidebar-logout {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  background: none; border: none; padding: 6px; border-radius: var(--radius-sm);
  color: var(--text-dim); cursor: pointer;
  transition: color 180ms var(--ease), background 180ms var(--ease);
}
.sidebar .sidebar-logout:hover { color: var(--danger); background: rgba(167, 139, 250, 0.08); }

/* ---- Sidebar recolhida (régua de ícones, desktop) ---- */
.sidebar { transition: width 200ms var(--ease), padding 200ms var(--ease); }
.shell.sidebar-collapsed .sidebar {
  width: 60px;
  padding-left: 8px;
  padding-right: 8px;
  align-items: center;
}
.shell.sidebar-collapsed .sidebar .logo-text,
.shell.sidebar-collapsed .sidebar .nav-label,
.shell.sidebar-collapsed .sidebar .sidebar-email {
  display: none;
}
.shell.sidebar-collapsed .sidebar .logo { justify-content: center; margin-bottom: 28px; gap: 0; }
.shell.sidebar-collapsed .sidebar .nav-item,
.shell.sidebar-collapsed .sidebar-toggle,
.shell.sidebar-collapsed .sidebar .sidebar-logout {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
  width: 44px;
}
.shell.sidebar-collapsed .sidebar .nav-item::before { display: none; }
.shell.sidebar-collapsed .sidebar .bottom { align-items: center; }
.shell.sidebar-collapsed .sidebar .sidebar-user { flex-direction: column; gap: 6px; padding: 8px 0 0; width: 44px; justify-content: center; }
/* Chevron aponta pra fora (expandir) quando recolhido. */
.shell.sidebar-collapsed .sidebar-toggle svg { transform: rotate(180deg); }

/* ---- Main ---- */
.main { flex: 1; padding: 48px 56px 80px; min-width: 0; max-width: 980px; margin-inline: auto; }
.main h1 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(28px, 5.5vw, 42px);
  line-height: 1.1;
  letter-spacing: -0.025em;
  font-variation-settings: "opsz" 144;
  margin: 0 0 8px;
  color: var(--text);
}
.main > h1 + .meta { color: var(--text-dim); font-size: 13px; margin-bottom: 32px; }
.main h2 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
  letter-spacing: -0.015em;
  margin: 40px 0 14px;
  color: var(--text);
}

/* page header with count pill next to title */
.page-header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 32px; flex-wrap: wrap; }
.page-header h1 { margin: 0; }
.page-header .count {
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(167, 139, 250, 0.12);
  color: var(--accent-lav);
  border: 1px solid var(--border-strong);
}
`;

// ---------------------------------------------------------------------------
// COMPONENTS_CSS — biblioteca de componentes global (Onda 3, specs/60-ux-reforma/64).
// Só consome tokens da Onda 2. As telas ADOTAM esses componentes na Onda 5 via
// co-classe (ex. class="task-btn btn btn-sm") — classes protegidas por teste
// (task-tag-chip, task-detail-sidebar, nav-badge) nunca são renomeadas.
// CSS por página (SURFACES e folhas de cada tela) vem DEPOIS na cascata; a
// Onda 5 removeu as duplicatas que venciam empates (.btn-primary/.btn-danger).
// ---------------------------------------------------------------------------
export const COMPONENTS_CSS = `
/* ---- Card ---- */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5) 22px;
  margin-bottom: var(--space-4);
}
.card h2 {
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: 500;
  margin: 0 0 10px;
}
.card pre {
  background: rgba(0, 0, 0, 0.4);
  padding: var(--space-3) 14px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-size: 12px;
  border: 1px solid var(--border);
}
.card--interactive {
  cursor: pointer;
  transition: transform 160ms var(--ease), border-color 180ms var(--ease), background 180ms var(--ease), box-shadow 180ms var(--ease);
}
.card--interactive:hover {
  transform: translateY(-2px);
  border-color: var(--border-strong);
  background: var(--surface-1);
  box-shadow: var(--shadow-1);
}

/* ---- Botões: hierarquia única (primary > secondary > ghost; danger; -sm) ---- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: none;
  color: var(--text);
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  text-decoration: none;
  transition: background 180ms var(--ease), color 180ms var(--ease), border-color 180ms var(--ease), transform 150ms var(--ease), box-shadow 180ms var(--ease);
}
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
/* Direção A (Onda 6): primário é acento SÓLIDO com texto escuro (--accent-contrast,
   AA 7.2:1) — o gradiente lavanda->violeta com texto branco reprovava AA (2.2:1). */
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast);
  box-shadow: 0 8px 24px -6px rgba(var(--accent-lav-rgb), 0.45);
}
.btn-primary:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 12px 32px -6px rgba(var(--accent-lav-rgb), 0.6); }
.btn-primary:active { filter: none; transform: translateY(0); }
.btn-secondary {
  background: rgba(var(--accent-lav-rgb), 0.12);
  color: var(--accent);
  border-color: var(--border-strong);
}
.btn-secondary:hover { background: rgba(var(--accent-lav-rgb), 0.22); }
.btn-ghost {
  border-color: var(--border);
  color: var(--text-dim);
}
.btn-ghost:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface-0); }
.btn-danger {
  background: var(--danger-bg);
  color: var(--danger);
  border-color: var(--danger-border);
}
.btn-danger:hover { background: color-mix(in srgb, var(--danger) 20%, transparent); }
.btn-sm { padding: 6px 10px; font-size: var(--text-xs); border-radius: 6px; }

/* ---- Chips: pill compacta de metadado. Cor dinâmica via --chip (spec 54). ---- */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: var(--text-xs);
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  --chip: var(--accent-lav);
  color: var(--chip);
  background: color-mix(in srgb, var(--chip) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--chip) 32%, transparent);
}
.chip--tag { --chip: var(--accent-cyan); }
.chip--project { --chip: var(--accent-pink); }
.chip--prio-1 { --chip: var(--prio-1); }
.chip--prio-2 { --chip: var(--prio-2); }
.chip--prio-3 { --chip: var(--prio-3); }
.chip--prio-4 { --chip: var(--text-dim); }
.chip--due { --chip: var(--text-dim); }
.chip--due.overdue { --chip: var(--danger); }
.chip--privacy { --chip: var(--warning); }
.chip--status { --chip: var(--info); }
.chip--kind { --chip: var(--accent-lav); }

/* ---- Estados vazios / carregando / erro ---- */
.empty-state {
  padding: var(--space-5) var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: var(--text-sm);
  text-align: center;
}
/* Empty states guiados (spec 91/92): título + frase + CTA + dica. */
.empty-state-title { font-family: var(--font-display); font-size: 17px; color: var(--text); margin: 0 0 6px; }
.empty-state .btn { margin-top: 10px; }
.empty-state-hint { font-size: 12px; color: var(--text-subtle); margin-top: 10px; }
.notes-empty-state, .tasks-empty-state { margin: 8px 0 16px; }
/* Grafo/contatos com 0 nós: o box central vira mensagem clicável (o
   .center-loading padrão é pointer-events:none pro canvas continuar arrastável). */
.center-loading.graph-empty { pointer-events: auto; }
.center-loading.graph-empty p { margin: 0; max-width: 360px; }
.skeleton {
  border-radius: var(--radius-sm);
  background: linear-gradient(100deg, var(--surface-0) 40%, var(--surface-1) 50%, var(--surface-0) 60%);
  background-size: 200% 100%;
  animation: skeleton-pulse 1.4s ease-in-out infinite;
  color: transparent;
  user-select: none;
  pointer-events: none;
}
@keyframes skeleton-pulse {
  0% { background-position: 120% 0; }
  100% { background-position: -80% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; background: var(--surface-1); }
}
.error-state {
  padding: var(--space-3) 14px;
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--danger-bg);
  color: var(--danger);
  font-size: var(--text-sm);
}

/* ---- Formulário ---- */
.field { display: block; margin-bottom: var(--space-4); }
.field > .field-label {
  display: block;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.input, .textarea, .select {
  width: 100%;
  padding: var(--space-3) 14px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: var(--text-md);
  font-family: inherit;
  transition: border-color 180ms var(--ease), background 180ms var(--ease);
}
.input:focus, .textarea:focus, .select:focus {
  border-color: var(--accent);
  background: rgba(var(--accent-lav-rgb), 0.05);
}
.textarea { resize: vertical; min-height: 90px; line-height: 1.5; }
.select { cursor: pointer; }

/* ---- Modal genérico (task-modal e palette consomem na Onda 5) ---- */
.modal { position: fixed; inset: 0; z-index: 1000; }
.modal[hidden] { display: none; }
.modal-backdrop {
  position: absolute;
  inset: 0;
  background: var(--backdrop);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.modal-dialog {
  position: relative;
  max-width: 620px;
  margin: 10vh auto 0;
  background: var(--bg-accent);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) 18px;
  border-bottom: 1px solid var(--border);
}
.modal-x {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: color 180ms var(--ease), background 180ms var(--ease);
}
.modal-x:hover { color: var(--text); background: var(--surface-1); }
.modal-body { padding: var(--space-4) 18px; }

/* ---- Banner informativo (banner Novidades sai do style inline na Onda 5) ---- */
.banner-info {
  display: block;
  margin: 0 0 var(--space-4);
  padding: 10px 14px;
  border-radius: 10px;
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.14), rgba(var(--accent-lav-rgb), 0.14));
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: inherit;
  text-decoration: none;
  font-size: 14px;
}

/* ---- Note body (markdown) ----
   Componente compartilhado: detalhe de nota (/app) E página pública /s/ (PUBLIC_CSS). */
.note-body {
  line-height: 1.75;
  font-size: 16px;
  color: rgba(248, 250, 252, 0.86);
  max-width: 68ch;
}
.note-body h1, .note-body h2, .note-body h3 {
  font-family: var(--font-display);
  color: var(--text);
  font-weight: 500;
  letter-spacing: -0.015em;
  margin-top: 1.8em;
  margin-bottom: 0.5em;
}
.note-body h1 { font-size: 28px; }
.note-body h2 { font-size: 22px; }
.note-body h3 { font-size: 18px; }
.note-body p { margin: 0 0 1em; }
.note-body ul, .note-body ol { padding-left: 1.3em; margin: 0 0 1em; }
.note-body li { margin-bottom: 4px; }
.note-body blockquote {
  margin: 1em 0;
  padding: 4px 0 4px 18px;
  border-left: 2px solid var(--accent-lav);
  color: var(--text-dim);
  font-style: italic;
}
.note-body pre {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border);
  padding: 14px 18px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.55;
}
.note-body code {
  background: rgba(255, 255, 255, 0.07);
  padding: 1.5px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.note-body pre code { background: none; padding: 0; }
.note-body a { color: var(--accent-cyan); border-bottom: 1px solid rgba(140, 200, 255, 0.3); }
.note-body a:hover { border-bottom-color: var(--accent-cyan); }
.note-body hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
`;

// ---------------------------------------------------------------------------
// SURFACES_CSS — CSS restante das superfícies do console (notas, login, config,
// grafo, palette, bottom-nav mobile, ...). Categoria "resto" desta onda; as
// Ondas 3-5 promovem o que for componente e enxugam o que for por página.
// ---------------------------------------------------------------------------
export const SURFACES_CSS = `
/* ---- Note cards ---- */
.note-card {
  display: block;
  padding: 20px 22px;
  margin-bottom: 12px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  transition: transform 220ms var(--ease), border-color 220ms var(--ease), background 220ms var(--ease);
  position: relative;
}
.note-card:hover {
  transform: translateY(-1px);
  border-color: var(--border-strong);
  background: var(--surface-raised);
  color: var(--text);
}
.note-card .title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin-bottom: 8px;
  color: var(--text);
}
.note-card .meta {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  /* --chip (spec 54): setado inline por área quando há uma cor resolvida
     (customizada ou da paleta compilada). Fallback = lavanda original, pro
     badge de relação de edge (que não é de área) ficar igual a antes. */
  background: color-mix(in srgb, var(--chip, #a78bfa) 16%, transparent);
  color: color-mix(in srgb, var(--chip, #a78bfa) 88%, white);
  border: 1px solid color-mix(in srgb, var(--chip, #a78bfa) 32%, transparent);
  margin-right: 6px;
}

/* ---- Login ---- */
.login-wrap {
  max-width: 400px;
  margin: 12vh auto;
  padding: 40px 36px;
  background: rgba(7, 10, 19, 0.5);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 32px 80px -20px rgba(0, 0, 0, 0.65), 0 0 40px -10px rgba(167, 139, 250, 0.25);
  position: relative;
  z-index: 1;
}
.login-wrap h1 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 34px;
  letter-spacing: -0.02em;
  text-align: center;
  margin: 0 0 6px;
  font-variation-settings: "opsz" 144;
}
.login-wrap .subtitle { text-align: center; color: var(--text-dim); font-size: 13px; margin-bottom: 28px; }
.login-wrap label {
  display: block;
  margin-bottom: 16px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.login-wrap input {
  width: 100%;
  margin-top: 6px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 15px;
  font-family: inherit;
  text-transform: none;
  letter-spacing: normal;
  transition: border-color 180ms var(--ease), background 180ms var(--ease);
}
.login-wrap input:focus {
  border-color: var(--accent-lav);
  background: rgba(167, 139, 250, 0.05);
}
/* Direção A (Onda 6): mesma receita do .btn-primary — acento sólido + texto escuro AA */
.login-wrap button {
  width: 100%;
  padding: 13px;
  margin-top: 8px;
  background: var(--accent);
  color: var(--accent-contrast);
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  font-family: inherit;
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease);
  box-shadow: 0 8px 24px -6px rgba(var(--accent-lav-rgb), 0.45);
}
.login-wrap button:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 12px 32px -6px rgba(var(--accent-lav-rgb), 0.6); }
.login-wrap button:active { filter: none; transform: translateY(0); }

.error { color: var(--danger); font-size: 13px; margin-bottom: 14px; text-align: center; }

/* Aviso positivo nas telas de login/config (senha trocada etc. — spec 103). */
.login-notice {
  color: var(--success); font-size: 13px; margin-bottom: 14px; text-align: center;
  background: var(--success-bg); border: 1px solid var(--success-border);
  border-radius: var(--radius-sm); padding: 8px 12px;
}

/* ---- Misc wizard/setup cards (used by /setup/credentials) ---- */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 22px;
  margin-bottom: 16px;
}
.card h2 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 500;
  margin: 0 0 10px;
}
.card pre {
  background: rgba(0, 0, 0, 0.4);
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-size: 12px;
  border: 1px solid var(--border);
}

/* ---- Config page ---- */
.url-box {
  flex: 1;
  min-width: 260px;
  word-break: break-all;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  font-size: 13px;
  color: var(--text);
}
.row { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
/* Look default pra botões SEM classe dentro de .row (Salvar, Copiar, ↑↓...).
   O :not(.btn) evita atropelar a hierarquia .btn-* (Onda 5): .row button tinha
   especificidade (0,1,1) e vencia .btn-primary (0,1,0) — o backup ficava sem gradiente. */
.row button:not(.btn) {
  padding: 10px 14px;
  background: rgba(var(--accent-lav-rgb), 0.12);
  color: var(--accent-lav);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 180ms var(--ease);
}
.row button:not(.btn):hover { background: rgba(var(--accent-lav-rgb), 0.22); }

.badge-pill {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  vertical-align: middle;
  margin-left: 12px;
}
.badge-ok { background: var(--success-bg); color: var(--success); border: 1px solid var(--success-border); }
.badge-warn { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning-border); }

/* ---- Config page: disclosure progressivo (2 passos + gaveta avancada + rodape) ---- */
.config-subtitle { color: var(--text-dim); font-size: 14px; margin: 2px 0 12px; }
/* Atalho "Nova chave" no topo da aba Agentes (spec 98): a tarefa mais comum da
   config alcançável sem scroll — a âncora #api-keys abre e rola pro details. */
.config-subtitle-row { display: flex; align-items: flex-start; gap: 12px; }
.config-subtitle-row .config-subtitle { flex: 1; min-width: 0; }
.config-quick-key { flex: none; white-space: nowrap; }

/* Grupo "Conexoes": heading + abas-acordeao (reusa .disclosure-advanced) */
.conn-heading { font-family: var(--font-display); font-weight: 500; font-size: 20px; margin: 36px 0 2px; }
.conn-section { margin-top: 12px; }

/* Abas segmentadas da config (spec 69): Conexoes / Organizacao / Sistema */
.config-tabs {
  display: flex; gap: 4px; margin: 2px 0 18px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto; scrollbar-width: none;
}
.config-tabs::-webkit-scrollbar { display: none; }
.config-tabs [role="tab"] {
  appearance: none; background: none; border: none; cursor: pointer;
  font-family: var(--font-display); font-size: 14.5px; font-weight: 500;
  color: var(--text-subtle);
  padding: 10px 16px 12px;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  white-space: nowrap;
  transition: color 160ms var(--ease), border-color 160ms var(--ease);
}
.config-tabs [role="tab"]:hover { color: var(--text); }
.config-tabs [role="tab"][aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent-lav); }
.config-panel { display: none; }
.config-panel.active { display: block; }
/* Dentro de um painel o respiro entre gavetas e menor que o default de 32px */
.config-panel .disclosure-advanced { margin-top: 12px; }

/* ── Redesign da config (13/07/2026): UM padrão de card pras 4 abas.
   Anatomia: .cfg-head (título + status/resumo à direita) → .cfg-desc (UMA
   linha de contexto) → .cfg-actions (botões) → .cfg-help (o manual INTEIRO
   vive recolhido aqui — progressive disclosure; card mostra estado + ação,
   não um manual). Craft: highlight interno no topo, borda que acende no
   hover, easing custom — nada de ease-in-out genérico. */
.config-panel .card {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  transition: border-color 240ms cubic-bezier(0.32, 0.72, 0, 1);
}
.config-panel .card:hover { border-color: var(--border-strong); }
.cfg-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cfg-head h2 { margin: 0 !important; }
.cfg-desc { margin: 6px 0 0; color: var(--text-dim); font-size: 13px; max-width: 68ch; }
.cfg-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
.cfg-help { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.cfg-help > summary {
  cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-dim); user-select: none;
  transition: color 200ms cubic-bezier(0.32, 0.72, 0, 1);
}
.cfg-help > summary::-webkit-details-marker { display: none; }
.cfg-help > summary::before {
  content: "▸"; font-size: 10px;
  transition: transform 200ms cubic-bezier(0.32, 0.72, 0, 1);
}
.cfg-help[open] > summary::before { transform: rotate(90deg); }
.cfg-help > summary:hover, .cfg-help[open] > summary { color: var(--text); }
.cfg-help-body { margin-top: 8px; }
.cfg-help-body p { margin: 6px 0; color: var(--text-dim); font-size: 13px; }
/* Status padrão: dot + label — verde conectado/ok, âmbar aguardando, cinza
   indisponível (com title explicando o porquê). Reusa os badge-pill onde já
   existem; o .cfg-status é a versão SEM pílula, pro canto de card. */
.cfg-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.cfg-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--text-subtle); flex: none; }
.cfg-status.ok::before { background: var(--ok, #34d399); }
.cfg-status.warn::before { background: var(--warn, #fbbf24); }

/* Cards de passo numerado (trilha essencial) */
.card-step { border-left: 3px solid var(--accent-lav); }
.card-step h2.step-head { display: flex; align-items: center; gap: 12px; margin: 0; }
.step-num {
  flex-shrink: 0;
  width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font-family: var(--font-display); font-weight: 600; font-size: 15px;
  background: rgba(167, 139, 250, 0.16);
  color: var(--accent-lav);
  border: 1px solid var(--border-strong);
  box-shadow: 0 0 14px rgba(167, 139, 250, 0.25);
}

/* Hint/instrucao curta abaixo do titulo de um passo */
.config-hint { color: var(--text-dim); font-size: 13.5px; line-height: 1.55; margin: 8px 0 14px; }
.config-hint code, .callout-info code {
  background: rgba(255, 255, 255, 0.07); padding: 1.5px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px;
}

/* Callout OAuth (cyan do design system) */
.callout-info {
  margin-top: 16px; padding: 12px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px; line-height: 1.55; color: var(--text-dim);
  background: color-mix(in srgb, var(--accent-cyan) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-cyan) 20%, transparent);
}
.callout-info strong { color: var(--accent-cyan); }
.callout-info em { font-style: italic; color: var(--text); }

/* Erro de form (spec 91/94): banner do fallback sem JS + inline por campo */
.callout-error {
  margin: 12px 0; padding: 12px 14px;
  border-radius: var(--radius-sm);
  font-size: 13.5px; line-height: 1.55; color: var(--text);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
}
.field-error { color: var(--danger); font-size: 13px; margin: 6px 0 0; }
.field-invalid { border-color: var(--danger) !important; outline: none; }

/* Acao primaria (Salvar prompt): .btn .btn-primary do COMPONENTS_CSS (Onda 5) */

/* Textarea do prompt */
.prefs-textarea {
  width: 100%; box-sizing: border-box;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; line-height: 1.55;
  background: rgba(0, 0, 0, 0.4); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 12px 14px; resize: vertical;
  transition: border-color 180ms var(--ease), background 180ms var(--ease);
}
.prefs-textarea:focus { border-color: var(--accent-lav); background: rgba(167, 139, 250, 0.05); }

/* ---- Gaveta avancada (1 unico <details>) ---- */
.disclosure-advanced {
  margin-top: 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 180ms var(--ease);
}
.disclosure-advanced[open] { border-color: var(--border-strong); }
.disclosure-advanced > summary {
  list-style: none; cursor: pointer;
  padding: 16px 20px;
  display: flex; flex-direction: column; gap: 3px;
  color: var(--text-dim);
  transition: background 160ms var(--ease), color 160ms var(--ease);
}
.disclosure-advanced > summary::-webkit-details-marker { display: none; }
.disclosure-advanced > summary:hover { background: rgba(167, 139, 250, 0.06); color: var(--text); }
.disclosure-advanced > summary .adv-title {
  font-family: var(--font-display); font-weight: 500; font-size: 16px;
  display: flex; align-items: center; gap: 10px; color: var(--text);
}
.disclosure-advanced > summary .adv-title::before {
  content: "▸";
  font-size: 12px; color: var(--accent-lav);
  transition: transform 200ms var(--ease);
  display: inline-block;
}
.disclosure-advanced[open] > summary .adv-title::before { transform: rotate(90deg); }
.disclosure-advanced > summary .adv-sub {
  font-size: 12.5px; color: var(--text-subtle); padding-left: 22px;
}
.disclosure-advanced .adv-body {
  padding: 4px 20px 22px;
  display: flex; flex-direction: column; gap: 24px;
}
.adv-section h3 {
  font-family: var(--font-display); font-weight: 500; font-size: 15px;
  margin: 0 0 8px; color: var(--text);
}
.adv-section p { color: var(--text-dim); font-size: 13.5px; line-height: 1.55; margin: 0 0 8px; }
.adv-section p code, .adv-section code {
  background: rgba(255, 255, 255, 0.07); padding: 1.5px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px;
}
.adv-section label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }

/* Input de texto do bloco avancado */
.input-text {
  width: 100%; box-sizing: border-box; margin-top: 6px;
  padding: 9px 12px;
  background: rgba(0, 0, 0, 0.4); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-family: inherit; font-size: 14px;
  transition: border-color 180ms var(--ease);
}
.input-text:focus { border-color: var(--accent-lav); }

/* Tabela de chaves */
.keys-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.keys-table th {
  text-align: left; padding: 8px 10px;
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-subtle); border-bottom: 1px solid var(--border);
}
.keys-table td { padding: 10px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
.keys-table tr:last-child td { border-bottom: none; }
.keys-table code {
  background: rgba(255, 255, 255, 0.07); padding: 1.5px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px;
}
/* Acoes destrutivas (Arquivar/Revogar): .btn .btn-danger .btn-sm do COMPONENTS_CSS (Onda 5) */

/* Toast global dos bundles do /app (spec 72) — feedback de erro/sucesso de ações client. */
.app-toast {
  position: fixed; left: 50%; bottom: max(24px, env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%) translateY(10px);
  max-width: min(92vw, 480px);
  padding: 10px 16px; border-radius: var(--radius-sm);
  background: var(--bg-accent); color: var(--text);
  border: 1px solid var(--border-strong);
  font-size: 13px; line-height: 1.4;
  opacity: 0; pointer-events: none;
  transition: opacity 180ms var(--ease), transform 180ms var(--ease);
  z-index: 300;
}
.app-toast.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
.app-toast[data-kind='error'] { border-color: var(--danger-border); color: var(--danger); }
.app-toast[data-kind='ok'] { border-color: var(--success-border); }
/* Botão de ação do toast (spec 95): "Desfazer" pós-exclusão. */
.app-toast-action {
  margin-left: 12px; padding: 2px 10px;
  background: none; border: 1px solid var(--border-strong); border-radius: 6px;
  color: var(--accent-lav); font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background 180ms var(--ease), border-color 180ms var(--ease);
}
.app-toast-action:hover { background: var(--surface-1); border-color: var(--accent-lav); }

/* Confirmação com marca (spec 95) — substitui o window.confirm nativo. */
.confirm-dialog { max-width: 440px; }
.confirm-body-text { margin: 0 0 var(--space-4); color: var(--text-dim); font-size: 14px; line-height: 1.5; }
.confirm-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }

/* Zona de exclusão no detalhe da nota (spec 95) — sem confirm: o undo é o toast. */
.note-danger { margin-top: var(--space-5); }
.note-danger form { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.note-danger-hint { color: var(--text-dim); font-size: 12.5px; }

/* Páginas 404/5xx com marca (spec 97) — casca sem sessão, fora do shell. */
.error-page { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: var(--space-6); }
.error-card { max-width: 460px; text-align: center; padding: var(--space-8) var(--space-6); background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-2); }
.error-card .logo { justify-content: center; margin-bottom: var(--space-4); }
.error-card h1 { font-family: var(--font-display); font-size: var(--text-xl); margin: 0 0 var(--space-3); }
.error-card p { color: var(--text-dim); font-size: var(--text-sm); line-height: var(--leading-sm); margin: 0 0 var(--space-5); }
.error-card .error-hint { margin: var(--space-5) 0 0; font-size: var(--text-xs); color: var(--text-subtle); }
.error-card code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; }

/* Dashboard mensal "Seu cérebro" (spec 99) — tiles, barras SVG e split dono/agente. */
.insights-nav { display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-5); }
.insights-month { font-family: var(--font-display); font-size: var(--text-lg); text-transform: capitalize; }
.insights-nav-spacer { min-width: 90px; }
.insights-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: var(--space-5); }
.insights-stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
.insights-stat-value { font-family: var(--font-display); font-size: 26px; line-height: 1.1; display: flex; align-items: baseline; gap: 8px; }
.insights-stat-label { font-size: 12px; color: var(--text-dim); }
.insights-delta { font-size: 12px; font-weight: 600; border-radius: 999px; padding: 1px 8px; }
.insights-delta.up { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
.insights-delta.down { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.insights-delta.flat { color: var(--text-subtle); background: var(--surface-2); }
/* Na home o card é compacto: tiles sem borda própria, só os números. */
.insights-stats-card { grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 0; }
.insights-stats-card .insights-stat { padding: 10px 12px; }
.insights-stats-card .insights-stat-value { font-size: 22px; }
.insights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 18px; align-items: start; }
.insights-grid > * { min-width: 0; }
.insights-bars { display: block; margin-bottom: var(--space-3); }
.insights-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--space-3); }
.insights-domains { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--text-sm); }
.insights-domains li { display: flex; align-items: center; gap: 8px; }
.insights-domains strong { margin-left: auto; color: var(--text-dim); font-weight: 500; }
.insights-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; }
.insights-dot.owner { background: var(--accent-lav); }
.insights-dot.agent { background: var(--accent-cyan); }
.insights-big { font-family: var(--font-display); font-size: 30px; margin: 0 0 var(--space-3); }
.insights-big span { font-size: var(--text-sm); font-family: var(--font-body); color: var(--text-dim); }
.insights-note { font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading-sm); margin: 0; }
.insights-degree { color: var(--text-subtle); font-size: 12px; margin-left: 6px; }
.insights-split-bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--surface-2); margin-bottom: 8px; }
.insights-split-bar .owner { background: var(--accent-lav); }
.insights-split-bar .agent { background: var(--accent-cyan); }
.insights-split-legend { display: flex; gap: 16px; font-size: 12.5px; color: var(--text-dim); }
.insights-split-legend span { display: inline-flex; align-items: center; gap: 6px; }

/* Modal de atalhos "?" (spec 97) — corpo gerado de SHORTCUT_DEFS. */
.shortcuts-dialog { max-width: 420px; }
.shortcuts-group h3 { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-subtle); margin: var(--space-4) 0 var(--space-2); }
.shortcuts-group:first-child h3 { margin-top: 0; }
.shortcuts-row { display: flex; align-items: center; gap: var(--space-4); padding: 6px 0; }
.shortcuts-row kbd { min-width: 72px; text-align: center; font-size: 12px; padding: 3px 8px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.shortcuts-row span { color: var(--text-dim); font-size: var(--text-sm); }

/* Taxonomia configuravel (spec 54) — swatch de cor nativo + mensagens inline */
.tax-swatch {
  width: 40px; height: 30px; padding: 2px;
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  cursor: pointer;
}
.tax-inline-error { color: var(--danger); font-size: 13px; margin-top: 6px; }
.tax-inline-status { color: var(--text-dim); font-size: 13px; }

/* Rodada 3 (11/07) — polimento visual das tabelas de configuração (Quadro de
   tarefas / Projetos / Tags / Áreas e tipos). Só CSS: o HTML das seções fica
   intacto de propósito (contratos dos testes kanban/tags/taxonomy/projects). */
.keys-table tbody tr { transition: background 150ms var(--ease); }
.keys-table tbody tr:hover td { background: rgba(255, 255, 255, 0.025); }
/* Botões soltos dentro das tabelas (Salvar/Renomear/Desarquivar): mesma pele do
   .row button, em tamanho compacto de linha. Declarado DEPOIS de .row button
   :not(.btn) (mesma especificidade) pra vencer nos forms .row dentro de tabela.
   O :not(.btn) preserva a hierarquia .btn-danger/.btn-primary. */
.keys-table button:not(.btn) {
  padding: 6px 12px;
  background: rgba(var(--accent-lav-rgb), 0.12);
  color: var(--accent-lav);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 180ms var(--ease), color 180ms var(--ease);
}
.keys-table button:not(.btn):hover { background: rgba(var(--accent-lav-rgb), 0.22); }
/* Setas de reordenação (↑/↓ em Projetos): quadradinho neutro, acende no hover. */
.keys-table button[aria-label="Subir"],
.keys-table button[aria-label="Descer"] {
  min-width: 30px; padding: 6px 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-subtle);
}
.keys-table button[aria-label="Subir"]:hover,
.keys-table button[aria-label="Descer"]:hover {
  background: rgba(var(--accent-lav-rgb), 0.18);
  color: var(--accent-lav);
}
/* Tabela larga em tela estreita: rola horizontal dentro da própria tabela em
   vez de estourar o card (display block transforma a table em scroll container). */
@media (max-width: 640px) {
  .keys-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
}

/* Banner de chave recem-criada — tokens nebula (verde = sucesso) */
.key-flash {
  margin-bottom: 18px; padding: 16px 18px;
  border: 1px solid var(--success-border);
  background: color-mix(in srgb, var(--success) 8%, transparent);
  border-radius: var(--radius);
  box-shadow: 0 0 24px -10px color-mix(in srgb, var(--success) 30%, transparent);
}
.key-flash h2 { font-family: var(--font-display); font-weight: 500; font-size: 16px; margin: 0 0 6px; color: var(--success); }
.key-flash p { color: var(--text-dim); font-size: 13px; margin: 0 0 10px; }
.key-flash input.key-flash-value {
  width: 100%; box-sizing: border-box; padding: 12px 14px;
  background: rgba(0, 0, 0, 0.4); color: #b9f6ca;
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent); border-radius: var(--radius-sm);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px;
}

/* ---- Cards de integracao e de agente (redesign 11/07) ----
   O card colapsado e um <details class="conn-card"> cujo summary e a face:
   tile de icone + nome/descricao + status dot + engrenagem. Aberto, o card
   toma a largura toda do grid (o corpo .adv-body continua o mesmo de antes). */
.config-cards {
  display: grid; grid-template-columns: 1fr; gap: 12px;
  align-items: start; margin-top: 12px;
}
@media (min-width: 640px) { .config-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1280px) { .config-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.config-cards > .conn-card { margin-top: 0; }
.config-cards > .conn-card[open] { grid-column: 1 / -1; }

/* Face em GRID (redesign 13/07): antes era uma linha só (tile | info | estado |
   engrenagem) e no card estreito o título quebrava em 2 linhas espremido pelo
   label de estado. Agora: linha 1 = tile + título (1 linha, ellipsis) + estado
   + engrenagem; linha 2 = descrição atravessando embaixo com a largura toda. */
.conn-card > summary {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto auto;
  grid-template-areas:
    "tile title state gear"
    "tile sub   sub   sub";
  column-gap: 14px; row-gap: 3px;
  align-items: center;
  padding: 14px 16px;
}
/* A seta ::before do disclosure sai de cena — no card, quem sinaliza estado
   aberto e a engrenagem girada. */
.conn-card > summary .adv-title::before { display: none; }
.conn-card > summary .adv-title {
  grid-area: title; font-size: 15px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.conn-card > summary .adv-sub {
  grid-area: sub; padding-left: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
/* display:contents — os filhos (título/descrição) entram direto no grid. */
.conn-info { display: contents; }
.conn-card > summary .conn-tile { grid-area: tile; align-self: start; }
.conn-card > summary .conn-state { grid-area: state; }
.conn-card > summary .conn-gear { grid-area: gear; }

.conn-tile {
  flex-shrink: 0; width: 44px; height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 10px;
  background: rgba(167, 139, 250, 0.10);
  border: 1px solid var(--border);
  color: var(--text);
}
.conn-tile svg { width: 22px; height: 22px; }

.conn-state {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-subtle); white-space: nowrap;
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-subtle); opacity: 0.6;
}
.status-dot.is-on {
  background: var(--success); opacity: 1;
  box-shadow: 0 0 8px color-mix(in srgb, var(--success) 60%, transparent);
}
/* Âmbar = dá pra resolver aqui (falta configurar/conectar); cinza = fora do ar. */
.status-dot.is-warn { background: var(--warning, #fbbf24); opacity: 1; }
/* Na FACE do card o estado é só o dot colorido com tooltip (redesign 13/07):
   o label por extenso espremia o título até truncar — e o texto completo do
   estado já vive dentro do card aberto (gc-status etc.). */
.conn-card > summary .conn-state-label { display: none; }

.conn-gear {
  flex-shrink: 0; display: inline-flex; color: var(--text-subtle);
  opacity: 0; transition: opacity 160ms var(--ease), transform 220ms var(--ease);
}
.conn-gear svg { width: 17px; height: 17px; }
.conn-card > summary:hover .conn-gear { opacity: 1; color: var(--text); }
.conn-card[open] > summary .conn-gear { opacity: 1; transform: rotate(90deg); }
/* Touch: sem hover, a engrenagem fica sempre visivel (mais discreta). */
@media (hover: none) { .conn-gear { opacity: 0.55; } }

/* Card de agente (secao Usuarios na aba Agentes): mesma anatomia do conn-card,
   com avatar no lugar do tile e chips de chave no corpo. */
.agent-card .user-avatar-img { width: 44px; height: 44px; flex-shrink: 0; }
.agent-card .user-avatar-initials { font-size: 15px; }
.agent-badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
  background: rgba(167, 139, 250, 0.12); border: 1px solid var(--border);
  color: var(--text-subtle); vertical-align: middle;
}
.key-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 999px;
  background: rgba(167, 139, 250, 0.08); border: 1px solid var(--border);
  font-size: 12.5px;
}
.key-chip code { font-size: 11.5px; color: var(--text-subtle); }
.key-chip form { display: inline; }
.key-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

/* Listagem "Suas chaves" (pedido 11/07): grupo por sistema + 1 card por chave */
.key-group { margin-top: 18px; }
.key-group-title {
  font-family: var(--font-display); font-weight: 600; font-size: 12px;
  letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-subtle);
  margin: 0 0 8px;
}
.key-group-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px; margin-left: 6px;
  border-radius: 999px; font-size: 11px;
  background: rgba(167, 139, 250, 0.12); border: 1px solid var(--border);
  color: var(--text-dim); vertical-align: middle;
}
.key-rows { display: flex; flex-direction: column; gap: 8px; }
.key-row {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 10px 14px;
  background: rgba(167, 139, 250, 0.04);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  transition: border-color 160ms var(--ease);
}
.key-row:hover { border-color: var(--border-strong); }
.key-row-revoked { opacity: 0.55; }
.key-row-id { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
.key-row-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.key-row-name .badge-pill { margin-left: 0; }
.key-row-prefix { font-size: 11.5px; color: var(--text-subtle); }
.key-row-meta {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: 1;
  font-size: 12.5px; color: var(--text-dim);
}
.key-row-meta .badge-pill { margin-left: 0; }
.key-row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.key-system-form { display: inline-flex; gap: 6px; align-items: center; }
.key-system-input { width: 120px; font-size: 12.5px; padding: 5px 8px; }
@media (max-width: 640px) {
  .key-row-id { min-width: 0; }
  .key-row-actions { margin-left: 0; }
}

/* ---- Wizard de criacao de credencial (spec 101) ---- */
.wizard-nav { display: flex; gap: 8px; list-style: none; margin: 0 0 16px; padding: 0; flex-wrap: wrap; }
.wizard-nav li {
  font-size: 12px; color: var(--text-subtle);
  padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border);
  transition: border-color 160ms var(--ease), color 160ms var(--ease);
}
.wizard-nav li.active { color: var(--text); border-color: var(--accent-lav); }
.wizard-nav li.done { color: var(--accent-lav); }
.wizard-step { border: 0; padding: 0; margin: 0 0 4px; min-width: 0; }
.wizard-step legend {
  font-family: var(--font-display); font-weight: 500; font-size: 15px;
  padding: 0; margin-bottom: 2px; color: var(--text);
}
.wizard-js .wizard-step:not(.active) { display: none; }
.wizard-hint { color: var(--text-dim); font-size: 13px; margin: 4px 0 12px; }
.wizard-controls { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
.wizard-error { color: var(--danger, #f87171); font-size: 13px; }
.role-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
.role-cards-1col { grid-template-columns: 1fr; max-width: 560px; }
.role-card {
  position: relative; display: block;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 10px 12px; cursor: pointer;
  background: rgba(167, 139, 250, 0.04);
  transition: border-color 160ms var(--ease), background 160ms var(--ease);
}
.role-card:hover { border-color: var(--border-strong); }
.role-card input { position: absolute; opacity: 0; pointer-events: none; }
.role-card:has(input:checked) { border-color: var(--accent-lav); background: rgba(167, 139, 250, 0.12); }
.role-card:has(input:focus-visible) { outline: 2px solid var(--accent-lav); outline-offset: 2px; }
.role-card-body { display: flex; gap: 10px; align-items: center; min-width: 0; }
.role-card-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.role-card-text strong { font-size: 13px; color: var(--text); }
.role-card-sub { color: var(--text-dim); font-size: 12px; line-height: 1.35; }

/* ---- Card Seguranca: 2FA (spec 102) ---- */
.tf-secret {
  display: inline-block; font-size: 15px; letter-spacing: 0.12em;
  padding: 6px 10px; border-radius: var(--radius-sm);
  background: rgba(167, 139, 250, 0.08); border: 1px solid var(--border);
  word-break: break-all; user-select: all;
}
.tf-codes { display: flex; flex-wrap: wrap; gap: 8px; }
.tf-codes code {
  font-size: 14px; letter-spacing: 0.08em; padding: 4px 10px;
  border-radius: var(--radius-sm); border: 1px solid var(--border);
  background: rgba(167, 139, 250, 0.08); user-select: all;
}

/* ---- Rodape: status do vault (movido do topo) ---- */
.vault-stats-foot { margin-top: 44px; padding-top: 24px; border-top: 1px solid var(--border); }
.vault-stats-foot h3 {
  font-family: var(--font-display); font-weight: 500; font-size: 16px;
  color: var(--text-dim); margin: 0 0 14px;
}
.vault-stat-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.stat-pill {
  display: inline-flex; flex-direction: column; gap: 2px;
  padding: 8px 14px; border-radius: var(--radius-sm);
  background: rgba(167, 139, 250, 0.08); border: 1px solid var(--border);
}
.stat-pill .v {
  font-family: var(--font-display); font-size: 18px; font-weight: 600;
  color: var(--text); font-variant-numeric: tabular-nums;
}
.stat-pill .k { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-subtle); }
.vault-stats-foot .links { margin-top: 16px; font-size: 13px; color: var(--text-subtle); }
.vault-stats-foot .links a { color: var(--accent-lav); }
.vault-stats-foot .empty-hint { margin-top: 10px; font-size: 13px; color: var(--text-dim); }

@media (max-width: 767px) {
  .vault-stat-grid { display: grid; grid-template-columns: 1fr 1fr; }
  .disclosure-advanced > summary .adv-sub { padding-left: 0; }
}

/* ==========================================================================
   Graph page (Obsidian-style overlay + slide panel + filter chips)
   ========================================================================== */
.graph-wrap { position: relative; height: 100vh; height: 100dvh; overflow: hidden; }
/* touch-action: none entrega TODOS os gestos pro Sigma (pan/pinch/zoom) e
   impede o browser de interceptar swipe-from-edge ou pull-to-refresh. */
.graph-canvas { position: absolute; inset: 0; touch-action: none; }

/* Left overlay: search, filters, status */
.graph-overlay {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 10;
  width: 280px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  background: rgba(10, 6, 24, 0.82);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: auto;
  box-shadow: 0 20px 40px -20px rgba(0, 0, 0, 0.55);
}
.graph-overlay-row { display: block; }
.graph-overlay::-webkit-scrollbar { width: 6px; }
.graph-overlay::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 3px; }

/* Mobile-only toggle do overlay — escondido em desktop. Em mobile, fixa no
   canto top-left e abre/fecha o overlay pra liberar o canvas do grafo. */
.graph-overlay-toggle {
  display: none;
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 20;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  background: rgba(10, 6, 24, 0.82);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  cursor: pointer;
  transition: background 160ms var(--ease), color 160ms var(--ease);
}
.graph-overlay-toggle:hover { background: rgba(167, 139, 250, 0.18); color: var(--accent-lav); }
.graph-overlay-toggle:active { transform: scale(0.96); }
.graph-overlay-toggle[aria-expanded="true"] { background: rgba(167, 139, 250, 0.28); color: var(--accent-lav); border-color: var(--border-strong); }

/* Search */
.graph-search-row { position: relative; }
.graph-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-subtle);
  display: inline-flex;
}
.graph-search-input {
  width: 100%;
  padding: 8px 12px 8px 32px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
  transition: border-color 180ms var(--ease), background 180ms var(--ease);
}
.graph-search-input::placeholder { color: var(--text-subtle); }
.graph-search-input:focus { border-color: var(--accent-lav); background: rgba(0, 0, 0, 0.5); }
.graph-search-input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }

/* Dropdown typeahead da busca (lista de resultados sob a caixa) */
.graph-search-results {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 60;
  background: rgba(14, 12, 24, 0.97);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  max-height: 340px;
  overflow-y: auto;
  padding: 4px;
}
.graph-search-counter {
  font-size: 10.5px;
  color: var(--text-subtle);
  letter-spacing: 0.04em;
  padding: 4px 8px 6px;
}
.graph-search-empty { font-size: 12px; color: var(--text-subtle); padding: 8px 10px; }
.graph-search-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: 0;
  text-align: left;
  padding: 7px 8px;
  border-radius: 8px;
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
  font-size: 12.5px;
}
.graph-search-item:hover, .graph-search-item.active { background: rgba(167, 139, 250, 0.16); }
.graph-search-item .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.graph-search-item-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.graph-search-item-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.graph-search-item-tldr {
  font-size: 10.5px;
  color: var(--text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.graph-search-item-chip {
  font-size: 9.5px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  padding: 1px 7px;
  border-radius: 999px;
  flex: 0 0 auto;
  white-space: nowrap;
}
.graph-search-sem { color: #fbbf24; font-weight: 700; flex: 0 0 auto; }

/* Painel de CONTATO (aba Contatos — detalhe via proxy) */
.panel-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  margin: 6px 0 10px;
  border: 1px solid var(--border-strong);
}
.panel-fields { margin: 10px 0 0; display: grid; gap: 8px; }
.panel-field dt {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-subtle);
}
.panel-field dd { margin: 1px 0 0; font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
.panel-field dd a { color: var(--accent-lav); text-decoration: none; }
.panel-field dd a:hover { text-decoration: underline; }
.panel-section-title {
  margin: 16px 0 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-subtle);
}
.panel-conns { display: flex; flex-direction: column; gap: 6px; }
.panel-conn {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
  text-align: left;
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
}
.panel-conn:hover { background: rgba(167, 139, 250, 0.14); border-color: var(--border-strong); }
.panel-conn-label { font-size: 12.5px; font-weight: 600; }
.panel-conn-rel {
  font-size: 9.5px;
  color: var(--accent-lav);
  margin-left: 6px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.panel-conn-why { display: block; font-size: 11px; color: var(--text-subtle); margin-top: 2px; }
.panel-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.panel-events li { font-size: 12px; color: var(--text-dim); }
.panel-event-kind { font-weight: 600; color: var(--text); }
.panel-event-ts { color: var(--text-subtle); margin-left: 6px; font-size: 10.5px; }
.panel-event-ctx { font-size: 11px; color: var(--text-subtle); margin-top: 1px; }
.panel-empty { color: var(--text-dim); font-size: 13px; margin: 0; list-style: none; }
.panel-timeline-wrap { margin-top: 16px; }

/* Botão "Carregar mais" da timeline paginada (spec 50-console-v2/57) */
.panel-timeline-more {
  margin-top: 8px;
  padding: 7px 12px;
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 160ms var(--ease), border-color 160ms var(--ease);
}
.panel-timeline-more:hover { background: rgba(167, 139, 250, 0.1); border-color: var(--border-strong); }
.panel-timeline-more:disabled { opacity: 0.55; cursor: progress; }

/* Disclosure "Registrar interação" (spec 50-console-v2/57) — mesmo padrão visual
   do form de adicionar conexão do console standalone de contatos. */
.panel-addconn {
  margin-top: 12px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.panel-addconn[open] { border-color: var(--border-strong); }
.panel-addconn-summary {
  list-style: none;
  cursor: pointer;
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-lav);
  display: flex;
  align-items: center;
  gap: 8px;
  transition: background 160ms var(--ease);
}
.panel-addconn-summary::-webkit-details-marker { display: none; }
.panel-addconn-summary::before {
  content: "+";
  font-size: 16px;
  line-height: 1;
  color: var(--accent-lav);
  transition: transform 200ms var(--ease);
}
.panel-addconn[open] .panel-addconn-summary::before { transform: rotate(45deg); }
.panel-addconn-summary:hover { background: rgba(167, 139, 250, 0.08); }

.panel-form { display: flex; flex-direction: column; gap: 12px; padding: 4px 14px 16px; }
.panel-form-field { display: flex; flex-direction: column; gap: 5px; }
.panel-form-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-subtle);
}
.panel-form-input,
.panel-form-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 11px;
  background: rgba(0, 0, 0, 0.4);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 13px;
  transition: border-color 180ms var(--ease), background 180ms var(--ease);
}
.panel-form-textarea { resize: vertical; line-height: 1.5; }
.panel-form-input:focus,
.panel-form-textarea:focus { border-color: var(--accent-lav); background: rgba(167, 139, 250, 0.05); }
select.panel-form-input { cursor: pointer; }

.panel-form-feedback { font-size: 12.5px; line-height: 1.45; min-height: 0; }
.panel-form-feedback.error { color: var(--danger); }
.panel-form-feedback.ok { color: var(--accent-cyan); }
.panel-form-feedback:empty { display: none; }

/* Direção A (Onda 6): mesma receita do .btn-primary — acento sólido + texto escuro AA */
.panel-form-submit {
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--accent-contrast);
  background: var(--accent);
  box-shadow: 0 8px 24px -8px rgba(var(--accent-lav-rgb), 0.45);
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease), opacity 150ms var(--ease);
}
.panel-form-submit:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 12px 32px -8px rgba(var(--accent-lav-rgb), 0.6); }
.panel-form-submit:active { filter: none; transform: translateY(0); }
.panel-form-submit:disabled { opacity: 0.55; cursor: progress; transform: none; box-shadow: none; }

.graph-status {
  font-size: 11.5px;
  color: var(--text-subtle);
  letter-spacing: 0.015em;
  padding: 2px 0;
}

/* Filter section header */
.graph-filter-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-subtle);
  margin-top: 2px;
}
.graph-reset-btn {
  background: none;
  border: none;
  color: var(--accent-lav);
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  cursor: pointer;
  padding: 2px 4px;
}
.graph-reset-btn:hover { color: var(--text); }

/* Filter chips (domain + kind) */
.graph-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.graph-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 160ms var(--ease), border-color 160ms var(--ease), color 160ms var(--ease);
}
.graph-chip:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
.graph-chip.active {
  background: rgba(124, 58, 237, 0.22);
  border-color: rgba(167, 139, 250, 0.55);
  color: var(--text);
}
.graph-chip .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}
.graph-chip .label { font-weight: 500; }
.graph-chip .count {
  font-size: 10px;
  color: var(--text-subtle);
  font-variant-numeric: tabular-nums;
}
.graph-chip.graph-chip-kind { padding-left: 8px; }

/* Similar edges controls */
.graph-similar-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  margin-top: 4px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.graph-slider-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-subtle);
}
.graph-slider-label input[type="range"] {
  width: 100%;
  accent-color: var(--accent-lav);
  cursor: pointer;
}
.graph-check-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.graph-check-label input { accent-color: var(--accent-lav); cursor: pointer; }

/* Legend line */
.graph-legend-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-subtle);
  padding-top: 4px;
  border-top: 1px solid var(--border);
}
.legend-swatch {
  display: inline-block;
  width: 16px;
  border-top-width: 2px;
  border-top-style: solid;
  vertical-align: middle;
  margin-right: 2px;
}
.swatch-explicit { border-top-color: rgba(255, 255, 255, 0.55); }
.swatch-similar { border-top-color: #8cc8ff; opacity: 0.7; border-top-style: dashed; }

/* Right floating zoom controls */
.graph-zoom-controls {
  position: absolute;
  bottom: 20px;
  right: 20px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgba(10, 6, 24, 0.82);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
  box-shadow: 0 12px 24px -10px rgba(0, 0, 0, 0.5);
}
.graph-zoom-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 6px;
  transition: background 160ms var(--ease), color 160ms var(--ease);
}
.graph-zoom-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
.graph-zoom-fit svg { display: block; }

/* ---- Slide panel (right side, Obsidian-style) ---- */
#graph-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: min(380px, 90vw);
  height: 100vh;
  background: rgba(10, 6, 24, 0.94);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-left: 1px solid var(--border);
  z-index: 50;
  transform: translateX(100%);
  transition: transform 320ms var(--ease);
  padding: 32px 28px 28px;
  color: var(--text);
  overflow-y: auto;
  box-shadow: -20px 0 40px -10px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
#graph-panel.open { transform: translateX(0); }
.panel-close {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 30px;
  height: 30px;
  background: transparent;
  border: none;
  color: var(--text-subtle);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  border-radius: 6px;
  transition: background 160ms var(--ease), color 160ms var(--ease);
}
.panel-close:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }

.panel-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--text-subtle);
}
.panel-kind {
  display: inline-block;
  padding: 2px 8px;
  /* --chip (spec 54): cor do kind resolvida, setada inline pelo client/graph.ts. */
  background: color-mix(in srgb, var(--chip, #a78bfa) 22%, transparent);
  color: color-mix(in srgb, var(--chip, #a78bfa) 90%, white);
  border: 1px solid color-mix(in srgb, var(--chip, #a78bfa) 36%, transparent);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.panel-degree { font-size: 11.5px; color: var(--text-subtle); }

.panel-title {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 24px;
  line-height: 1.2;
  margin: 0;
  letter-spacing: -0.01em;
}
.panel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.panel-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  background: color-mix(in srgb, var(--chip) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--chip) 45%, transparent);
  color: color-mix(in srgb, var(--chip) 85%, white);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.panel-tldr {
  margin: 0;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 2px solid var(--accent-lav);
  border-radius: 0 8px 8px 0;
  color: var(--text-dim);
  font-size: 13.5px;
  line-height: 1.55;
}
.panel-open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
  padding: 10px 16px;
  background: rgba(124, 58, 237, 0.2);
  color: #c4b5fd;
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: background 160ms var(--ease), color 160ms var(--ease);
  align-self: flex-start;
}
.panel-open:hover { background: rgba(124, 58, 237, 0.32); color: var(--text); }

/* Bottom navigation — só em mobile (regra mobile no fim do arquivo).
   Em desktop fica escondida; a sidebar lateral continua sendo a navegação. */
.bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 80;
  height: calc(60px + env(safe-area-inset-bottom));
  padding: 0 4px env(safe-area-inset-bottom);
  background: rgba(10, 6, 24, 0.94);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-top: 1px solid var(--border);
  align-items: stretch;
  justify-content: space-around;
}
.bottom-nav-item {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  flex: 1;
  min-width: 0;
  padding: 6px 4px;
  background: none;
  border: none;
  color: var(--text-subtle);
  text-decoration: none;
  font: inherit;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: color 140ms var(--ease);
}
/* Onda 5: com 9 destinos a label textual truncava ("Jour…", "Cont…") — a barra é
   icon-only; o nome segue lendo pra leitores de tela (clip) e no aria-label. */
.bottom-nav-item span:not(.bottom-nav-badge) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.bottom-nav-item:hover { color: var(--text-dim); }
.bottom-nav-item.active { color: var(--accent-lav); }
.bottom-nav-item.active svg { filter: drop-shadow(0 0 6px rgba(167, 139, 250, 0.45)); }
.bottom-nav-logout-form { margin: 0; display: inline-flex; flex: 1; min-width: 0; }
.bottom-nav-logout { width: 100%; }
.bottom-nav-logout:hover { color: var(--danger); }

/* Loading central — sobreposto ao canvas/conteúdo enquanto carrega.
   Mostrado SOBRE o canvas no centro da tela (não no canto da overlay). */
.center-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-dim);
  font-size: 13px;
  letter-spacing: 0.02em;
  pointer-events: none;
}
.center-loading-spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid rgba(167, 139, 250, 0.18);
  border-top-color: var(--accent-lav);
  animation: centerSpin 800ms linear infinite;
}
.center-loading.hidden { display: none; }
@keyframes centerSpin { to { transform: rotate(360deg); } }

/* Mobile: bottom navigation substitui sidebar lateral; graph/notes ocupam
   toda a width do viewport. Bottom nav ocupa ~60px no rodapé. */
@media (max-width: 767px) {
  .graph-overlay-toggle { display: inline-flex; }

  /* Sidebar lateral some — navegação migra pra bottom nav */
  .sidebar { display: none; }

  /* Bottom nav fica visível */
  .bottom-nav { display: inline-flex; }

  /* Espaço pro bottom nav no final do conteúdo */
  .main { padding-bottom: calc(72px + env(safe-area-inset-bottom)); }

  /* Graph wrap deixa folga no fim pra não esconder controles atrás do bottom nav */
  .graph-wrap {
    height: calc(100vh - 60px - env(safe-area-inset-bottom));
    height: calc(100dvh - 60px - env(safe-area-inset-bottom));
  }

  /* Zoom controls sobem pra não colidir com o bottom nav */
  .graph-zoom-controls {
    bottom: calc(12px + env(safe-area-inset-bottom));
  }

  /* Overlay fica colapsado por padrão em mobile — usuário abre via botão.
     Quando aberto (.open), abre como drawer do topo, deixando ainda assim
     um pedaço do canvas visível embaixo pra contexto. */
  .graph-overlay {
    display: none;
    top: 60px;
    left: 12px;
    right: 12px;
    width: auto;
    max-width: none;
    max-height: calc(100vh - 72px);
    max-height: calc(100dvh - 72px);
  }
  .graph-overlay.open { display: flex; }

  #graph-panel { width: 100vw; padding: 32px 20px 20px; }
}

/* ==========================================================================
   Notes list toolbar (search + filter chips + sort + layout)
   ========================================================================== */
.notes-toolbar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
  margin-bottom: 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.notes-search-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
}
.notes-search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-subtle);
  display: inline-flex;
  pointer-events: none;
}
.notes-search-input {
  flex: 1;
  padding: 10px 14px 10px 36px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  transition: border-color 180ms var(--ease), background 180ms var(--ease);
}
.notes-search-input::placeholder { color: var(--text-subtle); }
.notes-search-input:focus { border-color: var(--accent-lav); background: rgba(0, 0, 0, 0.5); }

.notes-toolbar-actions { display: flex; gap: 8px; }
.notes-select {
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.notes-select:focus { border-color: var(--accent-lav); }
.sr-label {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

.notes-filter-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.notes-filter-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-subtle);
  min-width: 64px;
}
.notes-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.notes-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px 4px 7px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 160ms var(--ease), border-color 160ms var(--ease), color 160ms var(--ease);
}
.notes-chip:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
.notes-chip.active {
  background: rgba(124, 58, 237, 0.22);
  border-color: rgba(167, 139, 250, 0.55);
  color: var(--text);
}
.notes-chip .dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}
.notes-chip .count { font-size: 10.5px; color: var(--text-subtle); font-variant-numeric: tabular-nums; }

/* Notes list layout variants */
/* Lista de notas usa a largura toda da tela (detalhe da nota e config seguem
   capados em 980px pra leitura). Cards viram grade responsiva: várias colunas
   que se ajustam, em vez de uma coluna única de cards gigantes. */
.main:has(#notes-list) { max-width: none; }
/* Board de tarefas idem (Onda 8): N colunas usam a tela toda — o scroll lateral
   só aparece quando as colunas realmente não cabem, não por causa do cap de 980px. */
.main:has(#task-board) { max-width: none; }
/* Home idem (Onda 9): os cards e o feed de atividade espalham na tela toda em vez
   de espremer no cap de leitura. */
.main:has(.home-grid) { max-width: none; }
#notes-list[data-layout="cards"] {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 14px;
  align-items: start;
}
#notes-list[data-layout="cards"] .note-card { margin-bottom: 0; }
#notes-list[data-layout="compact"] { display: flex; flex-direction: column; gap: 0; }

/* Paginação SSR (no-JS) + "mostrar mais" da janela de render client (spec 23). */
.notes-load-more, .notes-show-more {
  display: block; width: fit-content; margin: 18px auto 4px;
  padding: 9px 20px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--surface); color: var(--text-dim);
  font-size: 13px; font-family: inherit; text-decoration: none; cursor: pointer;
  transition: border-color 160ms var(--ease), color 160ms var(--ease);
}
.notes-load-more:hover, .notes-show-more:hover { border-color: var(--border-strong); color: var(--text); }

.note-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--text-subtle);
}
.note-card-date { margin-left: auto; font-variant-numeric: tabular-nums; }
.note-card-tldr {
  color: var(--text-dim);
  font-size: 13.5px;
  line-height: 1.55;
  margin-bottom: 10px;
}
.kind-badge {
  display: inline-block;
  padding: 2px 9px;
  /* --chip (spec 54): cor do kind resolvida (customizada ou paleta fixa). Sem
     customização o resolver ainda manda uma cor (fallback da paleta), então
     --chip está SEMPRE setado aqui — o default abaixo é só defesa. */
  background: color-mix(in srgb, var(--chip, #a78bfa) 22%, transparent);
  color: color-mix(in srgb, var(--chip, #a78bfa) 90%, white);
  border: 1px solid color-mix(in srgb, var(--chip, #a78bfa) 36%, transparent);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
/* Selo de privacidade (spec 31): badge 🔒 no card de nota e no detalhe. Amarelo
   discreto — sinaliza confidencialidade sem gritar. */
.private-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  background: rgba(251, 191, 36, 0.12);
  color: #fcd34d;
  border: 1px solid rgba(251, 191, 36, 0.35);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

/* Compact rows */
.note-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  text-decoration: none;
  transition: background 140ms var(--ease);
}
.note-row:hover { background: var(--surface-raised); }
.note-row-title {
  font-family: var(--font-display);
  font-size: 15.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
}
.note-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  flex-wrap: wrap;
}
.note-row-date { color: var(--text-subtle); font-variant-numeric: tabular-nums; }

.notes-empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--text-dim);
}

/* Note detail: edges section + local graph */
.note-edges { display: flex; flex-direction: column; gap: 8px; }
.note-edges .note-card { margin-bottom: 0; }

.local-graph-wrap { margin: 0 0 28px; }
.local-graph-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: var(--radius) var(--radius) 0 0;
}
.local-graph-hops {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-subtle);
}
.local-graph-hops input[type=range] { width: 120px; }
.local-graph-hops #local-graph-hops-value {
  min-width: 48px;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}
.local-graph-wrap .local-graph {
  border-radius: 0 0 var(--radius) var(--radius);
  margin: 0;
}
.local-graph {
  position: relative;
  height: 240px;
  margin: 0 0 28px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.local-graph-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  margin: 0;
  color: var(--text-subtle);
  font-size: 13px;
}

/* Wikilinks in rendered markdown */
.wikilink {
  color: var(--accent-lav);
  text-decoration: none;
  border-bottom: 1px dashed rgba(167, 139, 250, 0.35);
  padding-bottom: 1px;
  transition: color 160ms var(--ease), border-color 160ms var(--ease);
}
.wikilink:hover {
  color: var(--text);
  border-bottom-color: var(--text);
}
.wikilink.broken {
  color: var(--danger);
  border-bottom-color: color-mix(in srgb, var(--danger) 40%, transparent);
  cursor: help;
}

/* ==========================================================================
   Command palette (Ctrl+K)
   ========================================================================== */
#cmd-palette {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: none;
  pointer-events: none;
}
#cmd-palette.open { display: block; pointer-events: auto; }
.cmd-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 2, 14, 0.72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: cmdFadeIn 160ms var(--ease);
}
.cmd-dialog {
  position: relative;
  max-width: 620px;
  margin: 10vh auto 0;
  background: rgba(16, 11, 36, 0.96);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  box-shadow: 0 40px 80px -20px rgba(0, 0, 0, 0.7);
  overflow: hidden;
  animation: cmdSlideIn 200ms var(--ease);
}
.cmd-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}
.cmd-input-icon { color: var(--text-subtle); display: inline-flex; }
.cmd-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text);
  font-family: inherit;
  font-size: 16px;
  letter-spacing: 0;
}
.cmd-input::placeholder { color: var(--text-subtle); }
.cmd-input:focus { outline: none; }
/* type="search" (spec 93, teclado mobile certo) sem o cromo nativo do browser. */
.cmd-input { appearance: none; -webkit-appearance: none; }
.cmd-input::-webkit-search-cancel-button, .cmd-input::-webkit-search-decoration { -webkit-appearance: none; display: none; }
.cmd-esc {
  font-size: 11px;
  padding: 3px 7px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-subtle);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

.cmd-list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  max-height: 380px;
  overflow-y: auto;
}
.cmd-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 18px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 13.5px;
  transition: background 120ms var(--ease), color 120ms var(--ease);
}
.cmd-row.active, .cmd-row:hover {
  background: rgba(124, 58, 237, 0.22);
  color: var(--text);
}
.cmd-kind {
  font-size: 13px;
  opacity: 0.7;
  width: 18px;
  display: inline-flex;
  justify-content: center;
}
.cmd-label { flex: 1; }
.cmd-hint {
  font-size: 11px;
  color: var(--text-subtle);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  text-transform: lowercase;
}
/* Grupos da busca unificada (spec 66): Notas / Tarefas / Contatos, sempre que a
   query não estiver vazia; ou Recentes / Comandos no estado zero. Não-selecionável
   (role="presentation") — a navegação por setas pula direto pros .cmd-row. */
.cmd-group-header {
  padding: 10px 18px 4px;
  color: var(--text-subtle);
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.cmd-group-header:first-child { padding-top: 6px; }
.cmd-empty {
  padding: 20px 18px;
  color: var(--text-subtle);
  text-align: center;
  font-size: 13px;
  font-style: italic;
}
/* Aviso inline por grupo (ex.: "contatos indisponíveis") — mesma linguagem visual
   do .cmd-empty geral, mas dentro de uma seção específica em vez da lista toda. */
.cmd-empty-inline {
  padding: 6px 18px 10px;
  text-align: left;
  font-size: 12px;
}
.cmd-help {
  display: flex;
  gap: 16px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-subtle);
}
.cmd-help kbd {
  display: inline-block;
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10.5px;
  margin-right: 3px;
  color: var(--text-dim);
}

@keyframes cmdFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes cmdSlideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Mobile */
@media (max-width: 767px) {
  /* Busca mobile (spec 91/93): palette ancorada no TOPO (o teclado virtual cobre
     o centro da tela) — input e primeiros resultados sempre visíveis; alvos 44px. */
  .cmd-dialog { margin: 8px 10px 0; }
  .cmd-list { max-height: 48vh; max-height: 48dvh; }
  .cmd-row { min-height: 44px; }
  .cmd-esc { display: none; }
  .notes-search-row { flex-direction: column; align-items: stretch; }
  .notes-toolbar-actions { width: 100%; }
  .notes-select { flex: 1; }

  /* Sidebar mobile: NADA aqui — ela é display:none no bloco @media do shell
     (a navegação mobile é a bottom-nav). O bloco de "sidebar 64px" que vivia
     aqui era CSS morto contraditório (Onda 5, specs/60-ux-reforma/66): nunca
     tinha efeito porque display:none vence sem depender de ordem. */
  .main { padding: 24px 18px 80px; }
}
`;

// ---------------------------------------------------------------------------
// Folhas servidas. NEBULA_CSS é o /app/styles.css completo do console logado
// (test/web/polish.test.ts asserta byte-a-byte contra este export). PUBLIC_CSS
// é o subconjunto pras páginas públicas /s/ (sem shell nem superfícies do
// console) — consumida por share.ts a partir da Onda 5.
// ---------------------------------------------------------------------------
export const NEBULA_CSS = TOKENS_CSS + BASE_CSS + SHELL_CSS + COMPONENTS_CSS + SURFACES_CSS;
export const PUBLIC_CSS = TOKENS_CSS + BASE_CSS + COMPONENTS_CSS;
