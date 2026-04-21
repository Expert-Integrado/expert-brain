import { BASE_CSS } from './styles.js';

const FOOTER_HTML = `
<div class="card footer">
  Made by Robson Lins &nbsp;·&nbsp;
  <a href="https://www.instagram.com/orobsonn" target="_blank">Instagram</a> &nbsp;·&nbsp;
  <a href="https://x.com/orobsonnn" target="_blank">X / Twitter</a> &nbsp;·&nbsp;
  <a href="https://youtube.com/@orobsonnn" target="_blank">YouTube</a>
</div>`;

export function renderNotConfigured(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mind Vault — Not configured</title>
  <style>${BASE_CSS}</style>
</head>
<body>
<main>
  <h1>Mind Vault</h1>
  <p style="color:#a7adb5">Worker is deployed, but the vault is not configured yet.</p>

  <div class="card">
    <h2>Finish setup from your agentic IDE</h2>
    <p>Mind Vault is configured by the agent, not by a web wizard. Open the repo in Claude Code (or any MCP-capable IDE) and ask it to set up Mind Vault — it will follow the checklist in <code>CLAUDE.md</code> at the repo root.</p>
    <p>The agent will:</p>
    <ul>
      <li>Provision D1, Vectorize and the two KV namespaces</li>
      <li>Update <code>wrangler.toml</code> with the new IDs</li>
      <li>Prompt you for an email + passphrase</li>
      <li>Hash the passphrase and generate a <code>SESSION_SECRET</code></li>
      <li>Push the three secrets with <code>wrangler secret put</code></li>
      <li>Run <code>wrangler deploy</code> and apply the D1 schema</li>
    </ul>
    <p>The only thing you type is the email and the passphrase.</p>
  </div>

  ${FOOTER_HTML}
</main>
</body>
</html>`;
}
