// Google Fonts preconnect + font stylesheet are injected in <head> via FONT_LINKS.
// Poppins é a fonte de marca da Expert Integrado (display: títulos, logo, headings).
// Manrope continua pra body — ambas geometric sans, complementam.
// Substituiu Fraunces (serif) em 01/05/2026 alinhando com identidade visual EI.
export const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
`;

// Midnight Nebula — distinctive aesthetic: Fraunces display + Manrope body, deep nebula
// gradient, soft grain, lavender-accented cards with hover-lift, focus-visible rings.
export const NEBULA_CSS = `
:root {
  --bg: #070a13;
  --bg-mid: #0b0f19;
  --bg-accent: #111827;
  --text: #f8fafc;
  --text-dim: rgba(248, 250, 252, 0.58);
  --text-faint: rgba(248, 250, 252, 0.35);
  --border: rgba(167, 139, 250, 0.14);
  --border-strong: rgba(167, 139, 250, 0.32);
  --surface: rgba(255, 255, 255, 0.035);
  --surface-raised: rgba(255, 255, 255, 0.06);
  --accent-lav: #a78bfa;
  --accent-cyan: #5eead4;
  --accent-pink: #f0abfc;
  --accent-violet: #7c3aed;
  --accent-lav-rgb: 167, 139, 250;
  --accent-violet-rgb: 124, 58, 237;
  --danger: #ff7a90;
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --font-display: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-body: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}

* { box-sizing: border-box; }
*:focus { outline: none; }
*:focus-visible { outline: 2px solid var(--accent-lav); outline-offset: 2px; border-radius: 4px; }

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
  background:
    radial-gradient(ellipse 90% 60% at 30% 0%, rgba(124, 58, 237, 0.22) 0%, transparent 60%),
    radial-gradient(ellipse 80% 70% at 85% 100%, rgba(94, 234, 212, 0.09) 0%, transparent 55%),
    radial-gradient(ellipse at 50% 50%, var(--bg-mid) 0%, var(--bg) 75%);
  background-attachment: fixed;
}

/* Soft grain overlay (SVG noise, data URI — no network, CSP-safe) */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: 0.22;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.08 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
}

a { color: var(--accent-lav); text-decoration: none; transition: color 180ms var(--ease); }
a:hover { color: var(--text); }

::selection { background: rgba(167, 139, 250, 0.4); color: var(--text); }

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

.sidebar .bottom { margin-top: auto; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-faint); }
.sidebar .bottom > div { margin-bottom: 6px; font-family: var(--font-body); }
.sidebar .bottom form { margin: 0; }
.sidebar .bottom button {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 4px 0;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  transition: color 180ms var(--ease);
}
.sidebar .bottom button:hover { color: var(--accent-lav); }

/* nav-item agora carrega ícone + label. Ícone fixo, label some no modo recolhido. */
.sidebar .nav-item svg { flex-shrink: 0; }
.sidebar .nav-label { white-space: nowrap; overflow: hidden; }

/* Botão de recolher + logout viram linha de ícone+texto no rodapé do menu. */
.sidebar .bottom .sidebar-toggle,
.sidebar .bottom .sidebar-logout {
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
.sidebar .bottom .sidebar-toggle { margin-bottom: 8px; }
.sidebar .bottom .sidebar-toggle svg { transition: transform 220ms var(--ease); flex-shrink: 0; }
.sidebar .bottom .sidebar-toggle:hover,
.sidebar .bottom .sidebar-logout:hover { color: var(--accent-lav); background: rgba(167, 139, 250, 0.08); }
.sidebar .bottom .sidebar-logout:hover { color: var(--danger); }
.sidebar .sidebar-email { font-family: var(--font-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
.shell.sidebar-collapsed .sidebar .bottom { align-items: center; display: flex; flex-direction: column; }
.shell.sidebar-collapsed .sidebar .bottom form { width: 44px; }
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
  background: rgba(167, 139, 250, 0.12);
  color: var(--accent-lav);
  border: 1px solid rgba(167, 139, 250, 0.22);
  margin-right: 6px;
}

/* ---- Note body (markdown) ---- */
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
.login-wrap button {
  width: 100%;
  padding: 13px;
  margin-top: 8px;
  background: linear-gradient(135deg, var(--accent-lav), var(--accent-violet));
  color: #ffffff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  font-family: inherit;
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease);
  box-shadow: 0 8px 24px -6px rgba(167, 139, 250, 0.55);
}
.login-wrap button:hover { transform: translateY(-1px); box-shadow: 0 12px 32px -6px rgba(167, 139, 250, 0.7); }
.login-wrap button:active { transform: translateY(0); }

.error { color: var(--danger); font-size: 13px; margin-bottom: 14px; text-align: center; }

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
.row button {
  padding: 10px 14px;
  background: rgba(167, 139, 250, 0.12);
  color: var(--accent-lav);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 180ms var(--ease);
}
.row button:hover { background: rgba(167, 139, 250, 0.22); }

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
.badge-ok { background: rgba(111, 227, 154, 0.12); color: #6fe39a; border: 1px solid rgba(111, 227, 154, 0.3); }
.badge-warn { background: rgba(255, 184, 112, 0.12); color: #ffb870; border: 1px solid rgba(255, 184, 112, 0.3); }

/* ---- Config page: disclosure progressivo (2 passos + gaveta avancada + rodape) ---- */
.config-subtitle { color: var(--text-dim); font-size: 14px; margin: 2px 0 12px; }

/* Grupo "Conexoes": heading + abas-acordeao (reusa .disclosure-advanced) */
.conn-heading { font-family: var(--font-display); font-weight: 500; font-size: 20px; margin: 36px 0 2px; }
.conn-section { margin-top: 12px; }

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
  background: rgba(94, 234, 212, 0.06);
  border: 1px solid rgba(94, 234, 212, 0.20);
}
.callout-info strong { color: var(--accent-cyan); }
.callout-info em { font-style: italic; color: var(--text); }

/* Acao primaria (Salvar prompt) — gradiente lavanda->violeta */
.btn-primary {
  padding: 10px 18px; border: none; border-radius: var(--radius-sm); cursor: pointer;
  font-family: inherit; font-size: 13px; font-weight: 700; letter-spacing: 0.02em; color: #fff;
  background: linear-gradient(135deg, var(--accent-lav), var(--accent-violet));
  box-shadow: 0 8px 24px -8px rgba(167, 139, 250, 0.55);
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease);
}
.btn-primary:hover { transform: translateY(-1px); box-shadow: 0 12px 32px -8px rgba(167, 139, 250, 0.7); }
.btn-primary:active { transform: translateY(0); }

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
  font-size: 12.5px; color: var(--text-faint); padding-left: 22px;
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
  color: var(--text-faint); border-bottom: 1px solid var(--border);
}
.keys-table td { padding: 10px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
.keys-table tr:last-child td { border-bottom: none; }
.keys-table code {
  background: rgba(255, 255, 255, 0.07); padding: 1.5px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px;
}
.btn-danger {
  padding: 6px 12px;
  background: rgba(255, 122, 144, 0.12); color: var(--danger);
  border: 1px solid rgba(255, 122, 144, 0.3); border-radius: var(--radius-sm);
  font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background 160ms var(--ease);
}
.btn-danger:hover { background: rgba(255, 122, 144, 0.22); }

/* Banner de chave recem-criada — tokens nebula (verde = sucesso) */
.key-flash {
  margin-bottom: 18px; padding: 16px 18px;
  border: 1px solid rgba(111, 227, 154, 0.4);
  background: rgba(111, 227, 154, 0.08);
  border-radius: var(--radius);
  box-shadow: 0 0 24px -10px rgba(111, 227, 154, 0.3);
}
.key-flash h2 { font-family: var(--font-display); font-weight: 500; font-size: 16px; margin: 0 0 6px; color: #6fe39a; }
.key-flash p { color: var(--text-dim); font-size: 13px; margin: 0 0 10px; }
.key-flash input.key-flash-value {
  width: 100%; box-sizing: border-box; padding: 12px 14px;
  background: rgba(0, 0, 0, 0.4); color: #b9f6ca;
  border: 1px solid rgba(111, 227, 154, 0.3); border-radius: var(--radius-sm);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px;
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
.stat-pill .k { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }
.vault-stats-foot .links { margin-top: 16px; font-size: 13px; color: var(--text-faint); }
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
  color: var(--text-faint);
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
.graph-search-input::placeholder { color: var(--text-faint); }
.graph-search-input:focus { border-color: var(--accent-lav); background: rgba(0, 0, 0, 0.5); }
.graph-search-input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }

.graph-status {
  font-size: 11.5px;
  color: var(--text-faint);
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
  color: var(--text-faint);
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
/* Legenda vault-aware: até o client popular os chips (busca /app/graph/meta),
   esconde a casca pra não aparecer um "Legenda" órfão sem itens. O título
   #graph-legend-title ganha .is-empty junto (controlado pelo client). */
.graph-chips.is-empty,
#graph-legend-title.is-empty { display: none; }
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
  color: var(--text-faint);
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
  color: var(--text-faint);
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
  color: var(--text-faint);
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
  color: var(--text-faint);
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
  color: var(--text-faint);
}
.panel-kind {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(167, 139, 250, 0.18);
  color: #c4b5fd;
  border: 1px solid rgba(167, 139, 250, 0.3);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.panel-degree { font-size: 11.5px; color: var(--text-faint); }

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

/* ---- Painel de detalhe (T3): avatar, campos, conexões, eventos, form ---- */
.panel-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border-strong);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 0 18px rgba(167, 139, 250, 0.25);
  background: rgba(255, 255, 255, 0.04);
}

.panel-fields { display: flex; flex-direction: column; gap: 8px; }
.panel-field-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  line-height: 1.4;
}
.panel-field-label {
  flex-shrink: 0;
  min-width: 88px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.panel-field-value { color: var(--text); word-break: break-word; }
a.panel-field-value { color: var(--accent-cyan); border-bottom: 1px solid rgba(94, 234, 212, 0.3); }
a.panel-field-value:hover { color: var(--text); border-bottom-color: var(--accent-cyan); }

/* ---- Cartela de canais (spec 55) ---- */
.panel-channel-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.panel-channel-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  line-height: 1.4;
  flex-wrap: wrap;
}
.panel-channel-kind {
  flex-shrink: 0;
  min-width: 72px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.panel-channel-value { color: var(--text); word-break: break-word; }
a.panel-channel-value { color: var(--accent-cyan); border-bottom: 1px solid rgba(94, 234, 212, 0.3); }
a.panel-channel-value:hover { color: var(--text); border-bottom-color: var(--accent-cyan); }
.panel-channel-primary {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--accent-cyan);
  border: 1px solid rgba(94, 234, 212, 0.35);
  border-radius: 4px;
  padding: 1px 5px;
}
.panel-channel-action {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.panel-channel-action:hover { color: var(--text); }
.panel-channel-action:disabled { opacity: 0.5; cursor: progress; }
.panel-channel-remove:hover { color: var(--danger); }
.panel-channel-form { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }

/* ---- Edição inline de contato (spec 36 fase 3) ---- */
/* Inputs discretos: parecem texto até hover/focus (padrão das fases 1-2). */
.panel-edit { display: flex; flex-direction: column; gap: 8px; }
.panel-edit-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  line-height: 1.4;
}
.panel-edit-label {
  flex-shrink: 0;
  min-width: 88px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding-top: 2px;
}
.panel-edit-control { flex: 1; min-width: 0; }
.panel-edit-input,
.panel-edit-select,
.panel-edit-textarea {
  width: 100%;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 6px;
  margin: -3px -6px;
  transition: background 0.12s, border-color 0.12s;
}
.panel-edit-input:hover,
.panel-edit-select:hover,
.panel-edit-textarea:hover {
  background: rgba(255, 255, 255, 0.03);
  border-color: var(--border);
}
.panel-edit-input:focus,
.panel-edit-select:focus,
.panel-edit-textarea:focus {
  outline: none;
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--accent-cyan);
}
.panel-edit-input::placeholder,
.panel-edit-textarea::placeholder { color: var(--text-faint); }
.panel-edit-textarea { resize: vertical; min-height: 46px; line-height: 1.45; }
.panel-edit-select { cursor: pointer; }
.panel-edit-select option { background: #14141b; color: var(--text); }
.panel-edit-status {
  min-height: 16px;
  font-size: 11px;
  color: var(--text-faint);
  transition: color 0.12s;
}
.panel-edit-status.saving { color: var(--text-dim); }
.panel-edit-status.ok { color: #4ade80; }
.panel-edit-status.error { color: #f87171; }
.panel-edit-conflict {
  font-size: 12px;
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.3);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-edit-conflict button {
  align-self: flex-start;
  font: inherit;
  font-size: 12px;
  color: #14141b;
  background: #fbbf24;
  border: none;
  border-radius: 5px;
  padding: 4px 12px;
  cursor: pointer;
}

.panel-section { display: flex; flex-direction: column; gap: 8px; }
.panel-section-head {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.panel-empty { color: var(--text-dim); font-size: 13px; margin: 0; }

.panel-conn-list { display: flex; flex-direction: column; gap: 6px; }
.panel-conn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition: background 160ms var(--ease), border-color 160ms var(--ease);
}
.panel-conn:hover { background: rgba(167, 139, 250, 0.1); border-color: var(--border-strong); }
.panel-conn-top { display: flex; align-items: center; gap: 8px; }
.panel-conn-name { font-weight: 600; font-size: 13.5px; flex: 1; min-width: 0; }
.panel-conn-rel {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(94, 234, 212, 0.12);
  color: var(--accent-cyan);
  border: 1px solid rgba(94, 234, 212, 0.25);
}
.panel-conn-why { font-size: 12px; color: var(--text-dim); line-height: 1.45; }

.panel-timeline { display: flex; flex-direction: column; gap: 2px; }
.panel-event { display: flex; gap: 10px; padding: 6px 0; }
.panel-event-dot {
  flex-shrink: 0;
  width: 8px; height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--accent-lav);
  box-shadow: 0 0 8px rgba(167, 139, 250, 0.5);
}
.panel-event-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.panel-event-head { display: flex; align-items: baseline; gap: 8px; }
.panel-event-kind { font-size: 12.5px; font-weight: 600; color: var(--text); }
.panel-event-ts { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.panel-event-ctx { font-size: 12px; color: var(--text-dim); line-height: 1.45; }

/* Botão "Carregar mais" da timeline paginada (spec 50-console-v2/57) */
.panel-timeline-more {
  margin-top: 8px;
  padding: 7px 12px;
  width: 100%;
  background: rgba(255, 255, 255, 0.035);
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

/* Form de adicionar conexão (disclosure) */
.panel-addconn {
  margin-top: 4px;
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
  color: var(--text-faint);
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

.panel-form-hint {
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  align-self: flex-end;
}
.panel-form-hint.ok { color: var(--accent-cyan); }

.panel-form-feedback { font-size: 12.5px; line-height: 1.45; min-height: 0; }
.panel-form-feedback.error { color: var(--danger); }
.panel-form-feedback.ok { color: var(--accent-cyan); }
.panel-form-feedback:empty { display: none; }

.panel-form-submit {
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(135deg, var(--accent-lav), var(--accent-violet));
  box-shadow: 0 8px 24px -8px rgba(167, 139, 250, 0.55);
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease), opacity 150ms var(--ease);
}
.panel-form-submit:hover { transform: translateY(-1px); box-shadow: 0 12px 32px -8px rgba(167, 139, 250, 0.7); }
.panel-form-submit:active { transform: translateY(0); }
.panel-form-submit:disabled { opacity: 0.55; cursor: progress; transform: none; box-shadow: none; }

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
  color: var(--text-faint);
  text-decoration: none;
  font: inherit;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: color 140ms var(--ease);
}
.bottom-nav-item span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
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
  color: var(--text-faint);
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
.notes-search-input::placeholder { color: var(--text-faint); }
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
  color: var(--text-faint);
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
.notes-chip .count { font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

/* Notes list layout variants */
/* Lista de notas usa a largura toda da tela (detalhe da nota e config seguem
   capados em 980px pra leitura). Cards viram grade responsiva: várias colunas
   que se ajustam, em vez de uma coluna única de cards gigantes. */
.main:has(#notes-list) { max-width: none; }
#notes-list[data-layout="cards"] {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 14px;
  align-items: start;
}
#notes-list[data-layout="cards"] .note-card { margin-bottom: 0; }
#notes-list[data-layout="compact"] { display: flex; flex-direction: column; gap: 0; }

.note-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--text-faint);
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
  background: rgba(167, 139, 250, 0.18);
  color: #c4b5fd;
  border: 1px solid rgba(167, 139, 250, 0.3);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
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
.note-row-date { color: var(--text-faint); font-variant-numeric: tabular-nums; }

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
  color: var(--text-faint);
}
.local-graph-hops input[type=range] { width: 120px; }
.local-graph-hops #local-graph-hops-value {
  min-width: 48px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
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
  color: var(--text-faint);
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
  color: #ff7a90;
  border-bottom-color: rgba(255, 122, 144, 0.4);
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
.cmd-input-icon { color: var(--text-faint); display: inline-flex; }
.cmd-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text);
  font-family: inherit;
  font-size: 16px;
  letter-spacing: 0;
}
.cmd-input::placeholder { color: var(--text-faint); }
.cmd-input:focus { outline: none; }
.cmd-esc {
  font-size: 11px;
  padding: 3px 7px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-faint);
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
  color: var(--text-faint);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  text-transform: lowercase;
}
.cmd-empty {
  padding: 20px 18px;
  color: var(--text-faint);
  text-align: center;
  font-size: 13px;
  font-style: italic;
}
.cmd-help {
  display: flex;
  gap: 16px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
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
  .cmd-dialog { margin: 4vh 16px 0; }
  .notes-search-row { flex-direction: column; align-items: stretch; }
  .notes-toolbar-actions { width: 100%; }
  .notes-select { flex: 1; }

  /* Sidebar collapses: compact width, icon-ish nav */
  .sidebar {
    width: 64px;
    padding: 20px 6px;
  }
  .sidebar .logo {
    font-size: 0;
    gap: 0;
    justify-content: center;
    margin-bottom: 20px;
  }
  .sidebar .logo::before {
    width: 24px;
    height: 24px;
  }
  .sidebar .nav-item {
    padding: 10px 0;
    justify-content: center;
    font-size: 11.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .sidebar .nav-item::before { display: none; }
  .sidebar .bottom {
    display: none;
  }
  .main { padding: 24px 18px 80px; }
}
`;
