// Google Fonts preconnect + font stylesheet are injected in <head> via FONT_LINKS.
// Fraunces for the display/serif voice (characterful, optical-sized), Manrope for body.
// Both are on Google Fonts — no self-hosting needed and CSP 'self' stays strict because
// we only pull fonts, not scripts.
export const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
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
  --border: rgba(60, 131, 246, 0.14);
  --border-strong: rgba(60, 131, 246, 0.32);
  --surface: rgba(255, 255, 255, 0.035);
  --surface-raised: rgba(255, 255, 255, 0.06);
  --accent-lav: #3c83f6;
  --accent-cyan: #1abc9c;
  --accent-pink: #60a5fa;
  --accent-violet: #2563eb;
  --danger: #ff7a90;
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
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
  background:
    radial-gradient(ellipse 90% 60% at 30% 0%, rgba(60, 131, 246, 0.18) 0%, transparent 60%),
    radial-gradient(ellipse 80% 70% at 85% 100%, rgba(26, 188, 156, 0.12) 0%, transparent 55%),
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
  opacity: 0.4;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.08 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
}

a { color: var(--accent-lav); text-decoration: none; transition: color 180ms var(--ease); }
a:hover { color: var(--text); }

::selection { background: rgba(60, 131, 246, 0.35); color: var(--text); }

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
  background: linear-gradient(180deg, rgba(60, 131, 246, 0.04), transparent 30%);
}
.sidebar .logo {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
  letter-spacing: -0.02em;
  font-variation-settings: "opsz" 48;
  margin-bottom: 32px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
}
.sidebar .logo::before {
  content: "";
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, var(--accent-pink), var(--accent-lav) 60%, var(--accent-violet));
  box-shadow: 0 0 16px rgba(60, 131, 246, 0.65);
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
.sidebar .nav-item:hover { color: var(--text); background: rgba(60, 131, 246, 0.06); }
.sidebar .nav-item.active {
  background: rgba(60, 131, 246, 0.12);
  color: var(--text);
}
.sidebar .nav-item.active::before { background: var(--accent-lav); box-shadow: 0 0 8px rgba(60, 131, 246, 0.7); }

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

/* ---- Main ---- */
.main { flex: 1; padding: 48px 56px 80px; min-width: 0; max-width: 980px; }
.main h1 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 42px;
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
  background: rgba(60, 131, 246, 0.12);
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
  background: rgba(60, 131, 246, 0.12);
  color: var(--accent-lav);
  border: 1px solid rgba(60, 131, 246, 0.22);
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
  box-shadow: 0 32px 80px -20px rgba(0, 0, 0, 0.65), 0 0 40px -10px rgba(60, 131, 246, 0.25);
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
  background: rgba(60, 131, 246, 0.05);
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
  box-shadow: 0 8px 24px -6px rgba(60, 131, 246, 0.55);
}
.login-wrap button:hover { transform: translateY(-1px); box-shadow: 0 12px 32px -6px rgba(60, 131, 246, 0.7); }
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
  background: rgba(60, 131, 246, 0.12);
  color: var(--accent-lav);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 180ms var(--ease);
}
.row button:hover { background: rgba(60, 131, 246, 0.22); }

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

/* ==========================================================================
   Graph page (Obsidian-style overlay + slide panel + filter chips)
   ========================================================================== */
.graph-wrap { position: relative; height: 100vh; overflow: hidden; }
.graph-canvas { position: absolute; inset: 0; }

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
.swatch-explicit { border-top-color: #b48cff; }
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

/* Mobile: collapse overlay below, make panel full width */
@media (max-width: 767px) {
  .graph-overlay {
    width: calc(100vw - 32px);
    max-width: 320px;
  }
  #graph-panel { width: 100vw; padding: 32px 20px 20px; }
}
`;
