import { BASE_CSS } from './styles.js';

const FOOTER_HTML = `
<div class="card footer">
  Feito pela <a href="https://expertintegrado.com.br" target="_blank">Expert Integrado</a>
</div>`;

export function renderNotConfigured(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Expert Brain — Não configurado</title>
  <style>${BASE_CSS}</style>
</head>
<body>
<main>
  <h1>Expert Brain</h1>
  <p style="color:#a7adb5">Worker deployado, mas o vault ainda não foi configurado.</p>

  <div class="card">
    <h2>Finalize o setup pela sua IDE agêntica</h2>
    <p>Expert Brain é configurado pelo agente, não por um wizard web. Abra o repo no Claude Code e peça pra ele configurar o Expert Brain — ele segue o checklist no <code>CLAUDE.md</code> da raiz do repo.</p>
    <p>O agente vai:</p>
    <ul>
      <li>Provisionar D1, Vectorize e os dois namespaces KV</li>
      <li>Atualizar o <code>wrangler.toml</code> com os novos IDs</li>
      <li>Te pedir um e-mail + senha</li>
      <li>Gerar o hash da senha e criar um <code>SESSION_SECRET</code></li>
      <li>Subir os três secrets com <code>wrangler secret put</code></li>
      <li>Rodar <code>wrangler deploy</code> e aplicar o schema do D1</li>
    </ul>
    <p>A única coisa que você digita é o e-mail e a senha.</p>
  </div>

  ${FOOTER_HTML}
</main>
</body>
</html>`;
}
