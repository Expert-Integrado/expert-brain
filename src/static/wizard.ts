import { BASE_CSS } from './styles.js';

const FOOTER_HTML = `
<div class="card footer">
  Feito pela <a href="https://expertintegrado.com.br" target="_blank">Expert Integrado</a>
  &nbsp;·&nbsp; Fork de <a href="https://github.com/orobsonn/segundo-cerebro" target="_blank">orobsonn/segundo-cerebro</a>
</div>`;

export function renderNotConfigured(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Expert Brain — Not configured</title>
  <style>${BASE_CSS}</style>
</head>
<body>
<main>
  <h1>Expert Brain</h1>
  <p style="color:#a7adb5">Worker deployed, mas o vault ainda não foi configurado.</p>

  <div class="card">
    <h2>Finalize o setup pela sua IDE agêntica</h2>
    <p>Expert Brain é configurado pelo agente, não por um wizard web. Abra o repo no Claude Code e peça pra ele configurar o Expert Brain — ele segue o checklist no <code>CLAUDE.md</code> da raiz do repo.</p>
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
