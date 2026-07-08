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

    gcJson('/app/config/google/status').then(gcRender);

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
