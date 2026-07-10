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
  function activateTab(slug, updateHash) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === slug;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-panel') === slug);
    });
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
      if (!confirm('Restaurar a taxonomia padrão? Cores e nomes customizados (e áreas pré-criadas sem notas) somem.')) return;
      fetch('/app/config/taxonomy/reset', { method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function () { location.href = '/app/config?saved=taxonomy#taxonomy'; })
        .catch(function () {
          var statusEl = document.getElementById('taxonomy-status');
          statusEl.textContent = 'Falha de rede ao restaurar.';
          statusEl.style.color = 'var(--danger)';
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

    var gcParam = new URLSearchParams(location.search).get('google');
    if (gcParam) {
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
        gcStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        gcStatusEl.innerHTML = 'Falta configurar as credenciais do Google no servidor de contatos (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).';
        return;
      }
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
    var gcLoaded = false;
    function gcLoad() {
      if (gcLoaded) return;
      gcLoaded = true;
      gcJson('/app/config/google/status').then(gcRender);
    }
    if (gcRoot.open) gcLoad();
    gcRoot.addEventListener('toggle', function () { if (gcRoot.open) gcLoad(); });

    gcConnect.addEventListener('click', function () {
      gcConnect.disabled = true;
      gcJson('/app/config/google/connect', { method: 'POST' }).then(function (data) {
        if (data.ok && data.auth_url) { location.href = data.auth_url; return; }
        gcConnect.disabled = false;
        gcStatusEl.textContent = 'Não deu pra iniciar a conexão (' + (data.error || data._status) + ').';
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
      if (!confirm('Desconectar do Google? Os contatos já sincronizados FICAM no vault; só a ponte com a agenda é desfeita.')) return;
      gcJson('/app/config/google/disconnect', { method: 'POST' }).then(function () {
        location.href = '/app/config#google-contatos';
        location.reload();
      });
    });

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
        waStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        waStatusEl.textContent = 'Integração desligada: falta configurar o WHATSAPP_SYNC_TOKEN no servidor de contatos. Sem ele, nada é sincronizado.';
        return;
      }
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
        igStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        igStatusEl.textContent = 'Integração desligada: falta configurar o INSTAGRAM_SYNC_TOKEN no servidor de contatos. Sem ele, nada é sincronizado.';
        return;
      }
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
        pdStatusEl.textContent = 'Integração indisponível (' + (st.error || st._status) + ').';
        return;
      }
      if (!st.configured) {
        pdStatusEl.textContent = 'Integração desligada: nenhuma chave do Pipedrive conectada no servidor de contatos. Nada é sincronizado.';
        return;
      }
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
})();
`;
}
