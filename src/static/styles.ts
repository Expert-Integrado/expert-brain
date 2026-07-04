export const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#070a13; color:#f8fafc; font: 15px/1.55 ui-sans-serif,system-ui,sans-serif; }
  main { max-width: 680px; margin: 56px auto; padding: 0 24px; }
  h1 { font-size: 28px; letter-spacing:-.01em; margin:0 0 8px; }
  h2 { font-size: 18px; margin: 32px 0 8px; color:#94a3b8; }
  p  { color:#94a3b8; }
  a  { color:#3c83f6; }
  .card { background:#111827; border:1px solid rgba(60,131,246,0.18); border-radius:12px; padding:20px; margin:16px 0; }
  input[type=email],input[type=password] { width:100%; padding:10px 12px; background:#070a13; border:1px solid rgba(60,131,246,0.22); border-radius:8px; color:#f8fafc; }
  button { padding:10px 16px; background:#3c83f6; color:white; border:0; border-radius:8px; cursor:pointer; font-weight:600; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  code, pre { background:#070a13; border:1px solid rgba(60,131,246,0.18); border-radius:6px; padding:2px 6px; font-family:ui-monospace,Menlo,monospace; }
  pre { padding:12px; overflow-x:auto; }
  .footer { margin-top:56px; color:#6b7278; font-size:13px; }
  .tabs { display:flex; gap:8px; margin-top:8px; }
  .tab { padding:8px 14px; border:1px solid #1e242b; border-radius:8px; cursor:pointer; }
  .tab.active { background:#1a2230; border-color:#3390ff; }
`;
