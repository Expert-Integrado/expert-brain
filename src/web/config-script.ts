// Módulo FOLHA (spec 28): só a string do bundle inline da página /app/config, sem
// nenhuma dependência de runtime do Worker (env, D1, render). scripts/build-bundles.ts
// importa daqui pra hashear o conteúdo em ASSET_HASHES['config.bundle.js'] sem puxar
// o grafo de imports do config.ts. config.ts re-exporta pra não quebrar callers.
//
// Inline JS for the config page: fills the MCP URL with the current origin and
// wires up copy buttons. Served as /app/config/bundle.js so it respects the
// strict script-src 'self' CSP.
export function configPageScript(): string {
  return `(function () {
  // ── Abas segmentadas (spec 69): Conexões / Organização / Sistema ──
  // O servidor decide a aba do primeiro paint (?saved=...); aqui resolvemos deep
  // links por hash (#board, #backup, #organizacao...), o clique e as setas do teclado.
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.config-tabs [role="tab"]'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.config-panel'));
  // Status dots dos cards de integração (redesign 11/07): cada painel registra
  // seu loader (1-fetch, mesma flag do gate por toggle) e a ativação da aba
  // Integrações dispara todos — o dot hidrata sem precisar abrir card por card.
  var integLoaders = [];
  function runIntegLoaders() { integLoaders.forEach(function (fn) { fn(); }); }
  // Confirmação com marca (spec 95): bundle-string não importa módulo ES — o
  // shell expõe o confirmModal em window.__ebConfirm. Fallback pro confirm
  // nativo só se o shell ainda não carregou (defer race no primeiro paint).
  function askConfirm(opts) {
    if (window.__ebConfirm) return window.__ebConfirm(opts);
    var msg = opts.body ? opts.title + ' ' + opts.body : opts.title;
    return Promise.resolve(window.confirm(msg));
  }
  // 'on': true = verde (funcionando), 'warn' = ambar (da pra resolver aqui:
  // falta configurar/conectar), false = cinza (fora do ar). Na face do card so
  // o dot aparece (o label fica display:none e vira tooltip junto do motivo) --
  // o texto completo do estado vive dentro do card aberto.
  function setDot(id, on, label, reason) {
    var dot = document.getElementById(id);
    if (dot) dot.className = 'status-dot' + (on === true ? ' is-on' : on === 'warn' ? ' is-warn' : '');
    var lab = document.getElementById(id + '-label');
    if (lab) lab.textContent = label;
    var state = lab && lab.parentElement;
    if (state) state.setAttribute('title', label + (reason ? ' — ' + reason : ''));
  }
  function activateTab(slug, updateHash) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === slug;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-panel') === slug);
    });
    if (slug === 'integracoes') runIntegLoaders();
    if (updateHash && history.replaceState) history.replaceState(null, '', '#' + slug);
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { activateTab(t.getAttribute('data-tab'), true); });
    t.addEventListener('keydown', function (e) {
      var next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      activateTab(tabs[next].getAttribute('data-tab'), true);
      tabs[next].focus();
    });
  });
  // Deep link: hash pode ser uma aba (#organizacao) ou uma seção dentro dela (#board).
  // Roda no load E em hashchange (navegação same-document não reexecuta o script).
  function resolveHash() {
    if (!tabs.length || !location.hash) return;
    var hash = location.hash.slice(1);
    // Alias da aba antiga (pré-redesign 11/07): links salvos com #conexoes caem
    // na aba Agentes, que herdou o conteúdo dela.
    if (hash === 'conexoes') hash = 'agentes';
    var isTab = tabs.some(function (t) { return t.getAttribute('data-tab') === hash; });
    if (isTab) {
      activateTab(hash, false);
      return;
    }
    var target = document.getElementById(hash);
    var panel = target && target.closest ? target.closest('.config-panel') : null;
    if (panel) {
      activateTab(panel.getAttribute('data-panel'), false);
      if (target.tagName === 'DETAILS') target.open = true;
      target.scrollIntoView();
    }
  }
  resolveHash();
  window.addEventListener('hashchange', resolveHash);

  var url = location.origin + '/mcp';
  // Pode haver mais de um box de URL (aba "agente local" e aba "sistemas web").
  document.querySelectorAll('.js-mcp-url').forEach(function (el) { el.textContent = url; });
  document.querySelectorAll('.js-code-add').forEach(function (el) {
    el.textContent = 'claude mcp add --transport http expert-brain ' + url;
  });

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }
  document.querySelectorAll('button[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = btn.getAttribute('data-copy');
      var el = document.getElementById(id);
      if (!el) return;
      var text = ('value' in el ? el.value : (el.textContent || '')).trim();
      var ok = await copyText(text);
      var original = btn.textContent;
      btn.textContent = ok ? 'Copiado ✓' : 'Selecione + Ctrl+C';
      setTimeout(function () { btn.textContent = original; }, 1800);
    });
  });

  // Campo da chave recem-criada: selecionar tudo ao focar/clicar. Substitui o
  // onclick="this.select()" inline (bloqueado pela CSP script-src 'self').
  document.querySelectorAll('.key-flash-value').forEach(function (el) {
    el.addEventListener('focus', function () { el.select(); });
    el.addEventListener('click', function () { el.select(); });
  });

  // Banner one-time da chave criada (spec 87): fechar é ato consciente. O banner só
  // sai da tela pelo botão "Já salvei no 1Password"; fechar sem ter copiado pede
  // confirm — o token não é re-exibível (o KV single-use já foi consumido).
  (function () {
    var flash = document.getElementById('key-flash');
    if (!flash) return;
    var copied = false;
    var copyBtn = document.getElementById('key-flash-copy');
    var value = document.getElementById('key-flash-value');
    if (copyBtn) copyBtn.addEventListener('click', function () { copied = true; });
    if (value) value.addEventListener('copy', function () { copied = true; });
    var ack = document.getElementById('key-flash-ack');
    if (ack) ack.addEventListener('click', function () {
      if (copied) { flash.remove(); return; }
      askConfirm({ title: 'Fechar sem copiar a chave?', body: 'Depois de fechar não dá pra ver a chave de novo.', verb: 'Fechar mesmo assim' }).then(function (ok) {
        if (ok) flash.remove();
      });
    });
  })();

  // Wizard de criação de chave (spec 101): 3 passos client-side sobre o form
  // nativo. Sem JS o form renderiza inteiro (fieldsets empilhados) e funciona;
  // aqui adicionamos .wizard-js (o CSS esconde passos inativos), validamos por
  // passo e revelamos Voltar/Avançar. O POST continua sendo o submit nativo
  // (interceptado pelo data-ajax-form do shell).
  (function () {
    var form = document.getElementById('key-wizard');
    if (!form) return;
    var steps = Array.prototype.slice.call(form.querySelectorAll('.wizard-step'));
    var back = document.getElementById('wizard-back');
    var next = document.getElementById('wizard-next');
    var submit = document.getElementById('wizard-submit');
    var errEl = document.getElementById('wizard-error');
    if (!steps.length || !back || !next || !submit) return;
    var current = 1;
    form.classList.add('wizard-js');
    var STEP_MSGS = {
      1: 'Escolha um perfil pra ser o dono da chave.',
      2: 'Escolha um papel pra chave.',
      3: 'Dê um nome pra chave — é como você a reconhece na lista.',
    };
    function setError(msg) {
      if (!errEl) return;
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    }
    function stepValid(n) {
      if (n === 1) return !!form.querySelector('input[name="user_id"]:checked');
      if (n === 2) return !!form.querySelector('input[name="preset"]:checked');
      if (n === 3) {
        var name = form.querySelector('input[name="name"]');
        return !!(name && name.value.trim());
      }
      return true;
    }
    function show(n) {
      current = n;
      steps.forEach(function (s) {
        s.classList.toggle('active', Number(s.getAttribute('data-step')) === n);
      });
      form.querySelectorAll('[data-step-dot]').forEach(function (d) {
        var dn = Number(d.getAttribute('data-step-dot'));
        d.classList.toggle('active', dn === n);
        d.classList.toggle('done', dn < n);
      });
      back.hidden = n === 1;
      next.hidden = n === steps.length;
      submit.hidden = n !== steps.length;
      setError('');
    }
    back.addEventListener('click', function () { if (current > 1) show(current - 1); });
    next.addEventListener('click', function () {
      if (!stepValid(current)) { setError(STEP_MSGS[current]); return; }
      if (current < steps.length) show(current + 1);
    });
    // Marcar um card limpa o erro do passo; também mantém o bloco "Personalizado"
    // sincronizado (controles legados escopo+private só com o radio custom).
    var custom = document.getElementById('key-custom-scopes');
    function syncCustom() {
      if (!custom) return;
      var sel = form.querySelector('input[name="preset"]:checked');
      custom.hidden = !sel || sel.value !== 'custom';
    }
    form.addEventListener('change', function () { setError(''); syncCustom(); });
    syncCustom();
    // Submit precoce (Enter no nome com passo anterior pendente): em vez de o
    // browser brigar com um radio required invisível, voltamos pro primeiro
    // passo inválido com a mensagem. O preventDefault também segura o ajax-form.
    form.addEventListener('submit', function (e) {
      for (var i = 1; i <= steps.length; i++) {
        if (!stepValid(i)) {
          e.preventDefault();
          show(i);
          setError(STEP_MSGS[i]);
          return;
        }
      }
    });
    // O botão "Criar chave pra este perfil" do card de usuário usa isto pra
    // cair direto no passo 2 com o dono já marcado.
    window.__ebKeyWizardShow = show;
    show(1);
  })();

  // Revogar chave exige confirmação (spec 101) — mesmo padrão assíncrono do
  // tag-delete-form: cancela, pergunta no modal com o NOME da chave e re-submete
  // com a flag marcada (o segundo submit passa direto e cai no ajax-form).
  document.querySelectorAll('form.key-revoke-form').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (f.getAttribute('data-confirmed') === '1') return;
      e.preventDefault();
      var name = f.getAttribute('data-key-name') || 'esta chave';
      askConfirm({ title: 'Revogar a chave "' + name + '"?', body: 'Quem estiver usando ela perde o acesso na hora. Não dá pra desfazer — pra religar, crie outra chave.', verb: 'Revogar' }).then(function (go) {
        if (!go) return;
        f.setAttribute('data-confirmed', '1');
        if (f.requestSubmit) f.requestSubmit(); else f.submit();
      });
    });
  });

  // ── Áreas e tipos (taxonomia configurável — spec 54) ──
  // Slugifica um label pro mesmo formato exigido no servidor (DOMAIN_SLUG_REGEX:
  // minúsculo, kebab-case ASCII, começa com letra, 2-40 chars).
  var TAX_DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
  function taxSlugify(s) {
    var out = (s || '').normalize('NFD').replace(TAX_DIACRITICS_RE, '');
    out = out.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!out) return '';
    if (!/^[a-z]/.test(out)) out = 'a-' + out;
    if (out.length > 40) out = out.replace(/-+$/, '').slice(0, 40);
    if (out.length < 2) out = out + '-x';
    return out;
  }
  function taxEscape(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var taxAddBtn = document.getElementById('tax-add-domain');
  if (taxAddBtn) {
    taxAddBtn.addEventListener('click', function () {
      var input = document.getElementById('tax-new-label');
      var errEl = document.getElementById('tax-new-error');
      var label = (input.value || '').trim();
      errEl.style.display = 'none';
      if (!label) {
        errEl.textContent = 'Digite um nome pra área.';
        errEl.style.display = 'block';
        return;
      }
      var slug = taxSlugify(label);
      if (!slug) {
        errEl.textContent = 'Não foi possível gerar um slug válido pra esse nome.';
        errEl.style.display = 'block';
        return;
      }
      var tbody = document.getElementById('taxonomy-domains-body');
      var existing = tbody.querySelectorAll('tr[data-slug]');
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].getAttribute('data-slug') === slug) {
          errEl.textContent = "Área '" + slug + "' já existe.";
          errEl.style.display = 'block';
          return;
        }
      }
      var tr = document.createElement('tr');
      tr.setAttribute('data-slug', slug);
      tr.innerHTML =
        '<td><input type="color" class="tax-swatch" value="#64748b" aria-label="Cor de ' + taxEscape(slug) + '"></td>' +
        '<td><input type="text" class="input-text tax-label-input" maxlength="40" value="' + taxEscape(label) + '" aria-label="Nome de exibição de ' + taxEscape(slug) + '"></td>' +
        '<td><code>' + taxEscape(slug) + '</code></td>' +
        '<td>0</td>';
      tbody.appendChild(tr);
      input.value = '';
    });
  }

  function collectTaxonomy() {
    var domains = {};
    document.querySelectorAll('#taxonomy-domains-body tr[data-slug]').forEach(function (tr) {
      var slug = tr.getAttribute('data-slug');
      var colorEl = tr.querySelector('.tax-swatch');
      var labelEl = tr.querySelector('.tax-label-input');
      var label = labelEl ? labelEl.value.trim() : '';
      if (slug && label) domains[slug] = { label: label, color: colorEl ? colorEl.value : '#64748b' };
    });
    var kinds = {};
    document.querySelectorAll('#taxonomy-kinds-body tr[data-kind]').forEach(function (tr) {
      var kind = tr.getAttribute('data-kind');
      var colorEl = tr.querySelector('.tax-swatch');
      var labelEl = tr.querySelector('.tax-label-input');
      var label = labelEl ? labelEl.value.trim() : '';
      if (kind && label) kinds[kind] = { label: label, color: colorEl ? colorEl.value : '#64748b' };
    });
    return { domains: domains, kinds: kinds };
  }

  var taxSaveBtn = document.getElementById('taxonomy-save');
  if (taxSaveBtn) {
    taxSaveBtn.addEventListener('click', function () {
      var statusEl = document.getElementById('taxonomy-status');
      statusEl.textContent = 'Salvando...';
      statusEl.style.color = '';
      fetch('/app/config/taxonomy', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(collectTaxonomy()),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) {
              statusEl.textContent = data.error || ('Erro ao salvar (' + res.status + ')');
              statusEl.style.color = 'var(--danger)';
              return;
            }
            location.href = '/app/config?saved=taxonomy#taxonomy';
          });
        })
        .catch(function () {
          statusEl.textContent = 'Falha de rede ao salvar.';
          statusEl.style.color = 'var(--danger)';
        });
    });
  }

  var taxResetBtn = document.getElementById('taxonomy-reset');
  if (taxResetBtn) {
    taxResetBtn.addEventListener('click', function () {
      askConfirm({ title: 'Restaurar a taxonomia padrão?', body: 'Cores e nomes customizados (e áreas pré-criadas sem notas) somem.', verb: 'Restaurar' }).then(function (go) {
        if (!go) return;
        fetch('/app/config/taxonomy/reset', { method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(function () { location.href = '/app/config?saved=taxonomy#taxonomy'; })
          .catch(function () {
            var statusEl = document.getElementById('taxonomy-status');
            statusEl.textContent = 'Falha de rede ao restaurar.';
            statusEl.style.color = 'var(--danger)';
          });
      });
    });
  }

  // ── Google Contatos (sync mão única — expert-contacts specs/google-contacts-sync.md) ──
  // Hidrata o painel #google-contatos via /app/config/google/* (proxy same-origin
  // do Brain; credencial nunca chega aqui). ?google=connected|error:* vem do
  // callback do OAuth e vira banner.
  var gcRoot = document.getElementById('google-contatos');
  if (gcRoot) {
    var gcStatusEl = document.getElementById('gc-status');
    var gcFlash = document.getElementById('gc-flash');
    var gcConnect = document.getElementById('gc-connect');
    var gcSync = document.getElementById('gc-sync');
    var gcDisconnect = document.getElementById('gc-disconnect');
    var gcLabelsSection = document.getElementById('gc-labels-section');
    var gcLabels = document.getElementById('gc-labels');
    var gcLabelsStatus = document.getElementById('gc-labels-status');
    var gcSetup = document.getElementById('gc-setup');
    var gcCallbackUri = document.getElementById('gc-callback-uri');
    var gcClientId = document.getElementById('gc-client-id');
    var gcClientSecret = document.getElementById('gc-client-secret');
    var gcSaveClient = document.getElementById('gc-save-client');
    var gcSetupStatus = document.getElementById('gc-setup-status');
    var gcCredsRow = document.getElementById('gc-creds-row');
    var gcCredsLabel = document.getElementById('gc-creds-label');
    var gcChangeClient = document.getElementById('gc-change-client');
    var gcRemoveClient = document.getElementById('gc-remove-client');
    var gcAgentPrompt = document.getElementById('gc-agent-prompt');

    // Instrução pronta pro assistente de IA da pessoa executar o wizard sozinho
    // num navegador automatizado (Playwright etc.). Montada em runtime porque
    // depende da callback_uri desta instalação (vem do status).
    function gcBuildAgentPrompt(callbackUri) {
      var brainUrl = location.origin + '/app/config#google-contatos';
      return [
        'Crie a credencial do Google pra integração Google Contatos do meu Brain, dirigindo o navegador você mesmo (Playwright ou outro navegador que você controle). O login é sempre MEU: quando aparecer tela de login do Google, me passe o controle (nunca peça senha no chat) e retome depois. Use a conta Google cujos contatos eu quero trazer. Valide cada passo antes de seguir pro próximo.',
        '',
        '1. Abra https://console.cloud.google.com/projectcreate e crie um projeto (nome livre, ex.: Meu Brain). Aguarde a criação terminar e confirme que ele ficou selecionado no topo da tela.',
        '2. Abra https://console.cloud.google.com/apis/library/people.googleapis.com e clique em Ativar.',
        '3. Abra https://console.cloud.google.com/auth/overview e clique em Primeiros passos: nome do app (ex.: Meu Brain), meu e-mail como suporte, público Externo, meu e-mail de contato; conclua.',
        '4. Abra https://console.cloud.google.com/auth/clients/create: tipo Aplicativo da Web, nome livre. Em "URIs de redirecionamento autorizados", adicione EXATAMENTE esta URI e clique em Criar:',
        '   ' + callbackUri,
        '5. Copie o ID do cliente e a Chave secreta exibidos (ou baixe o JSON e leia de lá). NUNCA cole esses valores no chat nem em arquivo — use-os só pra preencher campos no navegador.',
        '6. Abra https://console.cloud.google.com/auth/audience e clique em Publicar app (confirme). SÓ marque este passo como feito depois de VALIDAR que o status virou "Em produção" (a Visão geral não pode mais dizer "Status de teste") — em teste o Google corta a conexão a cada 7 dias e recusa qualquer conta que não seja usuário de teste.',
        '7. Abra ' + brainUrl + ' (se pedir login, me passe o controle). No card Google Contatos, preencha "ID do cliente" (campo com id gc-client-id) e "Chave secreta" (id gc-client-secret) e clique em "Salvar credenciais" (id gc-save-client). Aguarde a confirmação.',
        '8. Clique em "Conectar ao Google" (id gc-connect). Na tela do Google eu escolho a conta e autorizo — a conta dos CONTATOS pode ser diferente da conta dona do app (com o app publicado, qualquer conta conecta). No aviso de app não verificado, clique em Avançado e depois em Acessar. De volta ao painel, me pergunte quais etiquetas sincronizar, marque, clique em "Salvar etiquetas" e depois em "Sincronizar agora".',
        '',
        'Se alguma tela do Google estiver diferente do descrito, adapte — o objetivo de cada passo está dito. Prova final: o card Google Contatos mostrando "Conectado" com contatos vinculados.',
      ].join('\\n');
    }

    var gcParam = new URLSearchParams(location.search).get('google');
    if (gcParam) {
      activateTab('integracoes', false);
      gcRoot.open = true;
      gcFlash.hidden = false;
      if (gcParam === 'connected') {
        gcFlash.textContent = 'Google conectado. Escolha abaixo as etiquetas que entram no vault e clique em Salvar etiquetas.';
      } else {
        gcFlash.textContent = 'A conexão com o Google falhou (' + gcParam.replace(/^error:?/, '') + '). Tente conectar de novo.';
        gcFlash.style.color = 'var(--danger)';
      }
      if (history.replaceState) history.replaceState(null, '', location.pathname + '#google-contatos');
    }

    function gcEscape(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function gcJson(url, opts) {
      opts = opts || {};
      opts.credentials = 'same-origin';
      opts.headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
      return fetch(url, opts).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          data._status = res.status;
          return data;
        });
      });
    }

    function gcRenderLabels(configured) {
      gcJson('/app/config/google/labels').then(function (data) {
        if (!data.ok) {
          gcLabels.innerHTML = '<p style="color:var(--danger)">Não deu pra listar as etiquetas (' + gcEscape(data.error || data._status) + ').</p>';
          return;
        }
        var chosen = {};
        (configured || []).forEach(function (g) { chosen[g] = true; });
        gcLabels.innerHTML = data.labels.map(function (l) {
          return '<label style="display:flex;align-items:center;gap:8px">' +
            '<input type="checkbox" class="gc-label" value="' + gcEscape(l.resourceName) + '"' + (chosen[l.resourceName] ? ' checked' : '') + '>' +
            '<span>' + gcEscape(l.name) + ' <span style="color:var(--text-dim)">(' + l.memberCount + ')</span></span>' +
            '</label>';
        }).join('') || '<p style="color:var(--text-dim)">Nenhuma etiqueta na conta.</p>';
      });
    }

    function gcRender(st) {
      if (!st.ok) {
        setDot('gc-dot', false, 'Indisponível', 'O servidor de contatos não respondeu — a integração volta sozinha quando ele estiver no ar');
        gcStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        // Estado inicial de toda instalação: sem chave de acesso ainda. O wizard
        // dentro do card guia a criação na conta Google da própria pessoa.
        setDot('gc-dot', 'warn', 'Configuração necessária', 'Abra o card e siga o passo a passo — uma vez só');
        gcSetup.hidden = false;
        gcCredsRow.hidden = true;
        gcConnect.hidden = true;
        gcSync.hidden = true;
        gcDisconnect.hidden = true;
        gcLabelsSection.hidden = true;
        if (st.callback_uri) {
          gcCallbackUri.textContent = st.callback_uri;
          gcAgentPrompt.textContent = gcBuildAgentPrompt(st.callback_uri);
        }
        if (st.callback_uri && st.callback_uri.indexOf('https://contacts/') === 0) {
          // Instalação sem a URL pública do serviço de contatos: a URI exibida
          // sairia errada e o Google recusaria a conexão. Erro de operador, não
          // do usuário final — a mensagem aponta o conserto pro assistente.
          gcStatusEl.textContent = 'Quase lá: o endereço público do serviço de contatos não está configurado. Peça ao seu assistente pra definir CONTACTS_PUBLIC_URL no Brain e recarregue esta página antes de seguir os passos.';
          return;
        }
        gcStatusEl.textContent = 'Falta criar a chave de acesso na sua conta Google — siga o passo a passo abaixo (leva uns 10 minutos, uma vez só).';
        return;
      }
      gcSetup.hidden = true;
      gcCredsRow.hidden = false;
      if (st.mode === 'panel') {
        gcCredsLabel.textContent = 'Chave de acesso salva por aqui' + (st.client_id ? ' (' + st.client_id + ')' : '') + '.';
        gcRemoveClient.hidden = false;
      } else {
        gcCredsLabel.textContent = 'Chave de acesso configurada direto no servidor.';
        gcRemoveClient.hidden = true;
      }
      gcChangeClient.hidden = false;
      setDot('gc-dot', st.connected ? true : 'warn', st.connected ? 'Configurado' : 'Não conectado', st.connected ? '' : 'Clique no card e conecte sua conta Google');
      gcConnect.hidden = !!st.connected;
      gcSync.hidden = !st.connected;
      gcDisconnect.hidden = !st.connected;
      gcLabelsSection.hidden = !st.connected;
      if (!st.connected) {
        gcStatusEl.textContent = 'Não conectado. Clique em "Conectar ao Google" — abre a tela de permissão da sua conta.';
        return;
      }
      var parts = ['Conectado', st.linked_count + ' contatos vinculados'];
      if (st.groups && st.groups.length) parts.push(st.groups.length + ' etiqueta(s) configurada(s)');
      else parts.push('nenhuma etiqueta configurada ainda (o sync fica parado até salvar)');
      if (st.last_run && st.last_run.at) parts.push('último sync: ' + new Date(st.last_run.at).toLocaleString());
      if (st.alert && st.alert.kind === 'gsync_reconnect_required') {
        parts.push('ATENÇÃO: a autorização expirou, reconecte');
      }
      gcStatusEl.textContent = parts.join(' · ') + '.';
      gcRenderLabels(st.groups || []);
    }

    // Adia o fetch de status pro 1º OPEN do <details> (evento toggle) — evita
    // round-trip no primeiro paint quando o painel está fechado. Se o deep-link
    // por hash já abriu esta seção (resolveHash rodou acima), dispara na hora.
    // Flag garante no máximo 1 chamada mesmo fechando/reabrindo depois.
    function gcRefresh() {
      gcJson('/app/config/google/status').then(gcRender);
    }
    var gcLoaded = false;
    function gcLoad() {
      if (gcLoaded) return;
      gcLoaded = true;
      gcRefresh();
    }
    integLoaders.push(gcLoad);
    if (gcRoot.open) gcLoad();
    gcRoot.addEventListener('toggle', function () { if (gcRoot.open) gcLoad(); });

    gcConnect.addEventListener('click', function () {
      gcConnect.disabled = true;
      gcJson('/app/config/google/connect', { method: 'POST' }).then(function (data) {
        if (data.ok && data.auth_url) { location.href = data.auth_url; return; }
        gcConnect.disabled = false;
        gcStatusEl.textContent = data.error === 'google_client_not_configured'
          ? 'Antes de conectar, falta salvar as credenciais: siga o passo a passo abaixo e clique em "Salvar credenciais".'
          : 'Não deu pra iniciar a conexão (' + (data.error || data._status) + ').';
      });
    });

    // Wizard: salvar a chave de acesso criada no console do Google. O campo da
    // chave secreta é limpo após o save — o valor não fica pendurado no DOM.
    gcSaveClient.addEventListener('click', function () {
      var id = gcClientId.value.trim();
      var secret = gcClientSecret.value.trim();
      if (!/\\.apps\\.googleusercontent\\.com$/.test(id)) {
        gcSetupStatus.textContent = 'O ID do cliente parece incompleto — ele termina com .apps.googleusercontent.com. Copie o valor inteiro.';
        return;
      }
      if (!secret) {
        gcSetupStatus.textContent = 'Falta colar a chave secreta.';
        return;
      }
      gcSaveClient.disabled = true;
      gcSetupStatus.textContent = 'Salvando…';
      gcJson('/app/config/google/client', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: id, client_secret: secret }),
      }).then(function (r) {
        gcSaveClient.disabled = false;
        if (!r.ok) {
          gcSetupStatus.textContent = 'Não deu pra salvar (' + (r.error || r._status) + '). Confira se copiou os dois valores inteiros.';
          return;
        }
        gcClientId.value = '';
        gcClientSecret.value = '';
        gcSetupStatus.textContent = '';
        gcFlash.hidden = false;
        gcFlash.style.color = '';
        gcFlash.textContent = r.disconnected
          ? 'Credenciais trocadas. A conexão anterior foi desfeita — clique em "Conectar ao Google" pra reconectar.'
          : 'Credenciais salvas! Agora clique em "Conectar ao Google".';
        gcRefresh();
      });
    });

    gcChangeClient.addEventListener('click', function () {
      gcSetup.hidden = false;
      gcChangeClient.hidden = true;
    });

    gcRemoveClient.addEventListener('click', function () {
      askConfirm({ title: 'Remover as credenciais do Google?', body: 'A conexão com a agenda é desfeita na hora; os contatos já sincronizados FICAM no vault. Pra usar de novo é só refazer o passo a passo.', verb: 'Remover' }).then(function (go) {
        if (!go) return;
        gcJson('/app/config/google/client', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clear: true }),
        }).then(function () {
          location.href = '/app/config#google-contatos';
          location.reload();
        });
      });
    });

    gcSync.addEventListener('click', function () {
      gcSync.disabled = true;
      gcStatusEl.textContent = 'Sincronizando…';
      gcJson('/app/config/google/sync', { method: 'POST' }).then(function (r) {
        gcSync.disabled = false;
        if (!r.ok && !r.skipped) {
          gcStatusEl.textContent = 'Sync falhou (' + (r.error || r._status) + ').';
          return;
        }
        if (r.skipped === 'no_groups_configured') {
          gcStatusEl.textContent = 'Nenhuma etiqueta configurada — salve as etiquetas primeiro.';
          return;
        }
        var s = 'Sync ok: ' + (r.created || 0) + ' novos, ' + (r.updated || 0) + ' atualizados, ' + (r.unchanged || 0) + ' sem mudança';
        if (r.unlinked) s += ', ' + r.unlinked + ' desvinculados';
        if (r.partial) s += ' (parcial — continua no próximo ciclo)';
        gcStatusEl.textContent = s + '.';
      });
    });

    gcDisconnect.addEventListener('click', function () {
      askConfirm({ title: 'Desconectar do Google?', body: 'Os contatos já sincronizados FICAM no vault; só a ponte com a agenda é desfeita.', verb: 'Desconectar' }).then(function (go) {
        if (!go) return;
        gcJson('/app/config/google/disconnect', { method: 'POST' }).then(function () {
          location.href = '/app/config#google-contatos';
          location.reload();
        });
      });
    });

    function gcSetAllLabels(checked) {
      Array.prototype.slice.call(document.querySelectorAll('.gc-label')).forEach(function (c) { c.checked = checked; });
    }
    document.getElementById('gc-labels-all').addEventListener('click', function () { gcSetAllLabels(true); });
    document.getElementById('gc-labels-none').addEventListener('click', function () { gcSetAllLabels(false); });

    var gcSaveLabels = document.getElementById('gc-save-labels');
    gcSaveLabels.addEventListener('click', function () {
      var groups = Array.prototype.slice.call(document.querySelectorAll('.gc-label:checked')).map(function (c) { return c.value; });
      gcLabelsStatus.textContent = 'Salvando…';
      gcJson('/app/config/google/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groups: groups }),
      }).then(function (r) {
        gcLabelsStatus.textContent = r.ok
          ? 'Salvo. O próximo sync aplica o recorte novo (ou clique em "Sincronizar agora").'
          : 'Erro ao salvar (' + (r.error || r._status) + ').';
      });
    });
  }

  // ── Grupos do WhatsApp (integração opcional — expert-contacts specs/whatsapp-
  // groups-sync.md). Hidrata o painel #whatsapp-grupos via /app/config/whatsapp/*
  // (proxy same-origin do Brain; nenhum token chega aqui). O catálogo de grupos é
  // empurrado por script na máquina do dono — o painel só ESCOLHE o que sincronizar.
  var waRoot = document.getElementById('whatsapp-grupos');
  if (waRoot) {
    var waStatusEl = document.getElementById('wa-status');
    var waGroupsSection = document.getElementById('wa-groups-section');
    var waGroups = document.getElementById('wa-groups');
    var waGroupsStatus = document.getElementById('wa-groups-status');

    function waEscape(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function waJson(url, opts) {
      opts = opts || {};
      opts.credentials = 'same-origin';
      opts.headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
      return fetch(url, opts).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          data._status = res.status;
          return data;
        });
      });
    }

    function waRender(st) {
      if (!st.ok) {
        setDot('wa-dot', false, 'Indisponível', 'O servidor de contatos não respondeu — a integração volta sozinha quando ele estiver no ar');
        waStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        setDot('wa-dot', 'warn', 'Não configurado', 'Falta configurar credenciais no servidor de contatos');
        waStatusEl.textContent = 'Integração desligada: falta configurar o WHATSAPP_SYNC_TOKEN no servidor de contatos. Sem ele, nada é sincronizado.';
        return;
      }
      setDot('wa-dot', true, 'Configurado');
      var parts = ['Integração ativa'];
      if (st.groups_linked) parts.push(st.groups_linked + ' grupo(s) no grafo');
      if (st.last_run && st.last_run.at) parts.push('última sincronização: ' + new Date(st.last_run.at).toLocaleString());
      if (st.last_run && st.last_run.unmatched) parts.push(st.last_run.unmatched + ' participante(s) sem contato correspondente (não viraram vínculo)');
      if (!st.catalog || !st.catalog.length) {
        parts.push('nenhum catálogo de grupos ainda — rode o script de push pra listar seus grupos aqui');
        waStatusEl.textContent = parts.join(' · ') + '.';
        return;
      }
      waStatusEl.textContent = parts.join(' · ') + '.';
      waGroupsSection.hidden = false;
      var waCreateSection = document.getElementById('wa-create-section');
      var waCreateBox = document.getElementById('wa-create-members');
      if (waCreateSection && waCreateBox) {
        waCreateSection.hidden = false;
        waCreateBox.checked = !!st.create_members;
      }
      var chosen = {};
      (st.allowlist || []).forEach(function (id) { chosen[id] = true; });
      // Nunca salvou (allowlist_set false) → todos vêm pré-marcados; o dono desmarca
      // o que não quer e salva. Depois do 1º save, vale exatamente o que foi salvo.
      var waPreAll = st.allowlist_set === false;
      waGroups.innerHTML = st.catalog.map(function (g) {
        var on = waPreAll || chosen[g.chat_id];
        return '<label style="display:flex;align-items:center;gap:8px">' +
          '<input type="checkbox" class="wa-group" value="' + waEscape(g.chat_id) + '"' + (on ? ' checked' : '') + '>' +
          '<span>' + waEscape(g.name) + (g.member_count != null ? ' <span style="color:var(--text-dim)">(' + g.member_count + ')</span>' : '') + '</span>' +
          '</label>';
      }).join('');
    }

    function waSetAll(on) {
      document.querySelectorAll('.wa-group').forEach(function (c) { c.checked = on; });
    }
    document.getElementById('wa-select-all').addEventListener('click', function () { waSetAll(true); });
    document.getElementById('wa-clear-all').addEventListener('click', function () { waSetAll(false); });

    // Mesmo gate do painel Google: adia o fetch de status pro 1º OPEN do <details>
    // (toggle) ou pro deep-link por hash que já abriu a seção antes deste ponto.
    var waLoaded = false;
    function waLoad() {
      if (waLoaded) return;
      waLoaded = true;
      waJson('/app/config/whatsapp/status').then(waRender);
    }
    integLoaders.push(waLoad);
    if (waRoot.open) waLoad();
    waRoot.addEventListener('toggle', function () { if (waRoot.open) waLoad(); });

    var waCreateToggle = document.getElementById('wa-create-members');
    if (waCreateToggle) {
      waCreateToggle.addEventListener('change', function () {
        var on = waCreateToggle.checked;
        var stEl = document.getElementById('wa-create-status');
        stEl.textContent = 'Salvando…';
        waJson('/app/config/whatsapp/create-members', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: on }),
        }).then(function (r) {
          if (!r.ok) {
            waCreateToggle.checked = !on;
            stEl.textContent = 'Erro ao salvar (' + (r.error || r._status) + ').';
            return;
          }
          stEl.textContent = on
            ? 'Ligado. A próxima rodada do script cria os contatos que faltam (em levas, se o grupo for grande).'
            : 'Desligado. Contatos já criados continuam no vault.';
        });
      });
    }

    var waSave = document.getElementById('wa-save-groups');
    waSave.addEventListener('click', function () {
      var ids = Array.prototype.slice.call(document.querySelectorAll('.wa-group:checked')).map(function (c) { return c.value; });
      waGroupsStatus.textContent = 'Salvando…';
      waJson('/app/config/whatsapp/allowlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_ids: ids }),
      }).then(function (r) {
        waGroupsStatus.textContent = r.ok
          ? 'Salvo. A próxima rodada do script sincroniza só os grupos marcados.'
          : 'Erro ao salvar (' + (r.error || r._status) + ').';
      });
    });
  }

  // ── Conversas do Instagram (integração opcional — expert-contacts specs/
  // instagram-contacts-sync.md). Hidrata o painel #instagram-contatos via
  // /app/config/instagram/* (proxy same-origin do Brain; nenhum token chega aqui).
  // Diferença pro WhatsApp: marcar a conversa CRIA o contato se ele não existe.
  var igRoot = document.getElementById('instagram-contatos');
  if (igRoot) {
    var igStatusEl = document.getElementById('ig-status');
    var igContactsSection = document.getElementById('ig-contacts-section');
    var igContacts = document.getElementById('ig-contacts');
    var igContactsStatus = document.getElementById('ig-contacts-status');

    function igEscape(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function igJson(url, opts) {
      opts = opts || {};
      opts.credentials = 'same-origin';
      opts.headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
      return fetch(url, opts).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          data._status = res.status;
          return data;
        });
      });
    }

    function igRender(st) {
      if (!st.ok) {
        setDot('ig-dot', false, 'Indisponível', 'O servidor de contatos não respondeu — a integração volta sozinha quando ele estiver no ar');
        igStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        setDot('ig-dot', 'warn', 'Não configurado', 'Falta configurar credenciais no servidor de contatos');
        igStatusEl.textContent = 'Integração desligada: falta configurar o INSTAGRAM_SYNC_TOKEN no servidor de contatos. Sem ele, nada é sincronizado.';
        return;
      }
      setDot('ig-dot', true, 'Configurado');
      var parts = ['Integração ativa'];
      if (st.contacts_linked) parts.push(st.contacts_linked + ' conversa(s) vinculada(s) a contatos');
      if (st.last_run && st.last_run.at) parts.push('última sincronização: ' + new Date(st.last_run.at).toLocaleString());
      if (!st.catalog || !st.catalog.length) {
        parts.push('nenhum catálogo de conversas ainda — rode o script de push pra listar suas conversas aqui');
        igStatusEl.textContent = parts.join(' · ') + '.';
        return;
      }
      igStatusEl.textContent = parts.join(' · ') + '.';
      igContactsSection.hidden = false;
      var chosen = {};
      (st.allowlist || []).forEach(function (id) { chosen[id] = true; });
      // Mesmo padrão do WhatsApp: nunca salvou → todas pré-marcadas.
      var igPreAll = st.allowlist_set === false;
      igContacts.innerHTML = st.catalog.map(function (c) {
        var label = c.name ? igEscape(c.name) : '';
        if (c.username) label += (label ? ' ' : '') + '<span style="color:var(--text-dim)">@' + igEscape(c.username) + '</span>';
        var on = igPreAll || chosen[c.igsid];
        return '<label style="display:flex;align-items:center;gap:8px">' +
          '<input type="checkbox" class="ig-contact" value="' + igEscape(c.igsid) + '"' + (on ? ' checked' : '') + '>' +
          '<span>' + label + '</span>' +
          '</label>';
      }).join('');
    }

    function igSetAll(on) {
      document.querySelectorAll('.ig-contact').forEach(function (c) { c.checked = on; });
    }
    document.getElementById('ig-select-all').addEventListener('click', function () { igSetAll(true); });
    document.getElementById('ig-clear-all').addEventListener('click', function () { igSetAll(false); });

    // Mesmo gate dos painéis Google/WhatsApp: adia o fetch de status pro 1º OPEN
    // do <details> (toggle) ou pro deep-link por hash que já abriu a seção antes.
    var igLoaded = false;
    function igLoad() {
      if (igLoaded) return;
      igLoaded = true;
      igJson('/app/config/instagram/status').then(igRender);
    }
    integLoaders.push(igLoad);
    if (igRoot.open) igLoad();
    igRoot.addEventListener('toggle', function () { if (igRoot.open) igLoad(); });

    var igSave = document.getElementById('ig-save-contacts');
    igSave.addEventListener('click', function () {
      var ids = Array.prototype.slice.call(document.querySelectorAll('.ig-contact:checked')).map(function (c) { return c.value; });
      igContactsStatus.textContent = 'Salvando…';
      igJson('/app/config/instagram/allowlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ igsids: ids }),
      }).then(function (r) {
        igContactsStatus.textContent = r.ok
          ? 'Salvo. A próxima rodada do script sincroniza só as conversas marcadas.'
          : 'Erro ao salvar (' + (r.error || r._status) + ').';
      });
    });
  }

  // ── Pipedrive (integração opcional do CRM no expert-contacts) ──
  // Hidrata o painel #pipedrive-crm via /app/config/pipedrive/* (proxy same-origin;
  // a chave de API do Pipedrive vive só no worker de contatos).
  var pdRoot = document.getElementById('pipedrive-crm');
  if (pdRoot) {
    var pdStatusEl = document.getElementById('pd-status');
    var pdSyncBtn = document.getElementById('pd-sync');
    var pdSyncStatus = document.getElementById('pd-sync-status');

    function pdJson(url, opts) {
      opts = opts || {};
      opts.credentials = 'same-origin';
      opts.headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
      return fetch(url, opts).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          data._status = res.status;
          return data;
        });
      });
    }

    function pdRender(st) {
      if (!st.ok) {
        setDot('pd-dot', false, 'Indisponível', 'O servidor de contatos não respondeu — a integração volta sozinha quando ele estiver no ar');
        pdStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        setDot('pd-dot', 'warn', 'Não configurado', 'Falta configurar credenciais no servidor de contatos');
        pdStatusEl.textContent = 'Integração desligada: nenhuma chave do Pipedrive conectada no servidor de contatos. Nada é sincronizado.';
        return;
      }
      setDot('pd-dot', true, 'Configurado');
      var parts = ['Integração ativa (sync diário automático)'];
      if (st.last_run) parts.push('última janela concluída: ' + st.last_run);
      if (st.cursor_pending) parts.push('há uma janela em andamento (retoma no próximo run)');
      if (st.consecutive_failures) parts.push(st.consecutive_failures + ' falha(s) consecutiva(s)');
      pdStatusEl.textContent = parts.join(' · ') + '.';
      pdSyncBtn.hidden = false;
    }

    // Mesmo gate dos demais painéis de integração: adia o fetch de status pro 1º
    // OPEN do <details> (toggle) ou pro deep-link por hash que já abriu antes.
    var pdLoaded = false;
    function pdLoad() {
      if (pdLoaded) return;
      pdLoaded = true;
      pdJson('/app/config/pipedrive/status').then(pdRender);
    }
    integLoaders.push(pdLoad);
    if (pdRoot.open) pdLoad();
    pdRoot.addEventListener('toggle', function () { if (pdRoot.open) pdLoad(); });

    pdSyncBtn.addEventListener('click', function () {
      pdSyncBtn.disabled = true;
      pdSyncStatus.textContent = 'Sincronizando…';
      pdJson('/app/config/pipedrive/sync', { method: 'POST' }).then(function (r) {
        pdSyncBtn.disabled = false;
        if (r.ok) {
          pdSyncStatus.textContent = r.partial
            ? 'Janela parcial processada (' + (r.processed || 0) + ' pessoas); rode de novo pra continuar.'
            : 'Sincronizado: ' + (r.escaneados || 0) + ' pessoa(s) verificada(s), ' + (r.enriquecidos || 0) + ' enriquecida(s).';
          pdJson('/app/config/pipedrive/status').then(pdRender);
        } else {
          pdSyncStatus.textContent = 'Erro: ' + (r.error || r._status) + '.';
        }
      });
    });
  }

  // Botão "Criar chave" do card de agente: abre o accordion #api-keys (mesma
  // aba), marca o dono no passo 1 do wizard e cai direto no passo 2 (papel).
  // Zero rota nova — só conduz o dono pro fluxo já respondido pela metade.
  document.querySelectorAll('[data-create-key-for]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var uid = btn.getAttribute('data-create-key-for');
      var keysBox = document.getElementById('api-keys');
      if (!keysBox) return;
      keysBox.open = true;
      var radio = keysBox.querySelector('#key-wizard input[name="user_id"][value="' + uid + '"]');
      if (radio) radio.checked = true;
      if (window.__ebKeyWizardShow && radio) window.__ebKeyWizardShow(2);
      keysBox.scrollIntoView();
    });
  });

  // Os loaders são registrados DEPOIS do resolveHash inicial — se o primeiro
  // paint já caiu na aba Integrações (server via ?saved=/callback ou deep-link
  // por hash), dispara os dots agora (as flags de 1-fetch evitam repetição).
  var activePanel = document.querySelector('.config-panel.active');
  if (activePanel && activePanel.getAttribute('data-panel') === 'integracoes') runIntegLoaders();

  // ── Contador de caracteres (spec 70: "Instruções pros agentes (MCP)") ──
  // Genérico: qualquer textarea com data-charcount="<id do span>" ganha um
  // contador "usados/max" (usa o maxlength do próprio campo como teto).
  document.querySelectorAll('textarea[data-charcount]').forEach(function (ta) {
    var out = document.getElementById(ta.getAttribute('data-charcount'));
    if (!out) return;
    var max = ta.getAttribute('maxlength');
    var render = function () {
      out.textContent = ta.value.length + (max ? '/' + max : '');
    };
    ta.addEventListener('input', render);
    render();
  });

  // ── Seção Tags (pedido 10/07): confirmação no apagar + filtro client-side ──
  document.querySelectorAll('form.tag-delete-form').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      // Confirmação assíncrona: cancela o submit, pergunta no modal e re-submete
      // com a flag marcada — o segundo submit passa direto por este guard.
      if (f.getAttribute('data-confirmed') === '1') return;
      e.preventDefault();
      var tag = f.getAttribute('data-tag') || 'esta tag';
      askConfirm({ title: 'Apagar a tag "' + tag + '"?', body: 'Sai de todas as notas e tasks. As notas ficam, só o rótulo some.', verb: 'Apagar tag' }).then(function (go) {
        if (!go) return;
        f.setAttribute('data-confirmed', '1');
        if (f.requestSubmit) f.requestSubmit(); else f.submit();
      });
    });
  });
  var tagsFilter = document.getElementById('tags-filter');
  if (tagsFilter) {
    tagsFilter.addEventListener('input', function () {
      var q = tagsFilter.value.trim().toLowerCase();
      document.querySelectorAll('#tags-tbody tr[data-tag-row]').forEach(function (tr) {
        tr.style.display = !q || (tr.getAttribute('data-tag-row') || '').indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }
})();
`;
}
