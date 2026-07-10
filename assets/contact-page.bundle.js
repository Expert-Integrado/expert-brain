"use strict";(()=>{function o(e){return e.replace(/[&<>"']/g,n=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[n])}var k={management:"#f59e0b",sales:"#22c55e",marketing:"#ec4899",education:"#8b5cf6","ai-applied":"#06b6d4",leadership:"#f97316",product:"#3b82f6",operations:"#94a3b8","personal-development":"#14b8a6",entrepreneurship:"#ef4444","cognitive-science":"#a78bfa",music:"#fbbf24"},C={person:"#22c55e",company:"#3b82f6",group:"#a855f7",place:"#f59e0b",event:"#ec4899",other:"#64748b"},x="#64748b";function $(e){return k[e]??C[e]??x}var L={met:"Encontro",talked:"Conversa",meeting:"Reuni\xE3o",email:"E-mail",message:"Mensagem",note:"Nota",saw_post:"Vi post",recommended:"Indica\xE7\xE3o",birthday_reminder:"Anivers\xE1rio",mentioned_in_brain:"Citado no Brain"};var M={person:"Pessoa",company:"Empresa",group:"Grupo",place:"Lugar",event:"Evento",other:"Outro"},N={colleague:"Colega",friend:"Amigo(a)",family:"Fam\xEDlia",client:"Cliente",mentor:"Mentor(a)",alum_g4:"Alumni G4",peer_tech:"Par (tech)",introduced_by:"Apresentado por",works_at:"Trabalha em",founded:"Fundou",advisor_of:"Conselheiro de",studied_at:"Estudou em",member_of:"Membro de",partner_of:"Parceiro de",supplier_of:"Fornecedor de",competitor_of:"Concorrente de",parent_of:"Controladora de",subsidiary_of:"Subsidi\xE1ria de",invested_in:"Investiu em",client_of:"Cliente de",other:"Outro"};function E(e){return N[e]??e}var S=[{value:"met",label:"Encontro"},{value:"talked",label:"Conversa"},{value:"meeting",label:"Reuni\xE3o"},{value:"email",label:"E-mail"},{value:"message",label:"Mensagem"},{value:"note",label:"Nota"}],H=20;function I(e,n){if(!e)return"";let t=e.includes("T")?e:`${e.replace(" ","T")}Z`,l=new Date(t);if(Number.isNaN(l.getTime()))return e.slice(0,16);try{let a={timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit"};return n==="whatsapp"&&l.toLocaleTimeString("pt-BR",{timeZone:"America/Sao_Paulo",hour12:!1})==="12:00:00"||(a.hour="2-digit",a.minute="2-digit"),l.toLocaleString("pt-BR",a)}catch{return e.slice(0,16)}}function _(e){return e.toISOString().slice(0,19).replace("T"," ")}function A(e){return`/app/contacts/${encodeURIComponent(e)}`}function R(e){e.innerHTML=`
    <h1>Contato n\xE3o encontrado</h1>
    <p><a href="/app/contacts">\u2190 Voltar pros contatos</a></p>
  `}function w(e,n,t){let l=t.title||"Contato",a=t.kind||"other",r=t.editable?.category?.trim(),g=t.editable?.last_contacted?.trim(),s=typeof t.img=="string"&&t.img.startsWith("/media/")?`<img class="contact-page-avatar" src="/app/contacts${o(t.img)}" alt="" loading="lazy">`:'<div class="contact-page-avatar-fallback" aria-hidden="true"></div>',m=`<span class="panel-chip" style="--chip:${$(a)}">${o(M[a]??a)}</span>`,u=r?`<span class="panel-chip">${o(r)}</span>`:"",p=g?`<span class="panel-degree">\xDAltimo contato: ${o(g)}</span>`:"",f={"Grupo em comum":"Grupos em comum"},h=t.fields??[],c=new Map;for(let i of h)c.set(i.label,(c.get(i.label)??0)+1);let d=new Set,v=h.map(i=>{if((c.get(i.label)??1)>1){if(d.has(i.label))return"";d.add(i.label);let y=h.filter(b=>b.label===i.label).map(b=>b.href?`<a class="contact-page-chip" href="${o(b.href)}" target="_blank" rel="noopener">${o(b.value)}</a>`:`<span class="contact-page-chip">${o(b.value)}</span>`).join("");return`
    <div class="contact-page-field">
      <dt>${o(f[i.label]??i.label)}</dt>
      <dd><div class="contact-page-chips">${y}</div></dd>
    </div>`}return`
    <div class="contact-page-field">
      <dt>${o(i.label)}${i.primary?" \u2605":""}</dt>
      <dd>${i.href?`<a href="${o(i.href)}" target="_blank" rel="noopener">${o(i.value)}</a>`:o(i.value)}</dd>
    </div>`}).join("");e.innerHTML=`
    <div class="contact-page-header">
      ${s}
      <div>
        <h1 class="contact-page-name">${o(l)}</h1>
        <div class="contact-page-meta">${m}${u}${p}</div>
      </div>
    </div>
    <div class="contact-page-actions">
      <a class="panel-open" href="/app/contacts?focus=${encodeURIComponent(n)}">Abrir no grafo \u2192</a>
    </div>
    <div class="contact-page-section">
      <h2>Cartela</h2>
      <dl class="contact-page-fields">${v||'<p class="contact-page-empty">Sem campos cadastrados.</p>'}</dl>
    </div>
    <div class="contact-page-section" data-section="neighbors">
      <h2>V\xEDnculos</h2>
      <p class="contact-page-empty">Carregando v\xEDnculos...</p>
    </div>
    <div class="contact-page-section" data-section="mention-notes">
      <h2>Notas sobre esta pessoa</h2>
      <p class="contact-page-empty">Carregando...</p>
    </div>
    <div class="contact-page-section" data-section="mention-tasks">
      <h2>Tarefas com esta pessoa</h2>
      <p class="contact-page-empty">Carregando...</p>
    </div>
    <div class="contact-page-section" data-section="timeline">
      <h2>Intera\xE7\xF5es</h2>
    </div>
  `}function O(e,n){if(n.length===0){e.hidden=!0,e.innerHTML="";return}e.hidden=!1,e.innerHTML=`
    <details class="contact-page-acc">
      <summary>Notas sobre esta pessoa (${n.length})</summary>
      <div class="contact-page-acc-body">
        <div class="contact-page-vinculos">${n.map(t=>`
        <a class="panel-conn" href="${o(t.url)}">
          <span class="panel-conn-label">${o(t.title)}${t.private?" \u{1F512}":""}</span>
          <span class="panel-conn-rel">${o(t.kind||"nota")}</span>
        </a>`).join("")}</div>
      </div>
    </details>`}function q(e,n,t){if(n.length===0&&t===0){e.hidden=!0,e.innerHTML="";return}e.hidden=!1;let l=n.length?`<div class="contact-page-vinculos">${n.map(r=>`
        <a class="panel-conn" href="${o(r.url)}">
          <span class="panel-conn-label">${o(r.title)}${r.private?" \u{1F512}":""}</span>
          <span class="panel-conn-rel">${o(r.status||"open")}</span>
        </a>`).join("")}</div>`:'<p class="contact-page-empty">Nenhuma tarefa aberta com esta pessoa.</p>',a=t>0?`<p class="contact-page-warn">+ ${t} tarefa${t===1?"":"s"} conclu\xEDda${t===1?"":"s"}.</p>`:"";e.innerHTML=`
    <details class="contact-page-acc">
      <summary>Tarefas com esta pessoa (${n.length})</summary>
      <div class="contact-page-acc-body">${l}${a}</div>
    </details>`}function T(e){let n=e.edge==="explicit"?`<span class="panel-conn-rel">${o(E(e.rel??""))}</span>${e.why?`<span class="panel-conn-why">${o(e.why)}</span>`:""}`:`<span class="panel-conn-rel">similar \xB7 ${Math.round((e.score??0)*100)}%</span>`;return`<a class="panel-conn" href="${o(A(e.id))}">
    <span class="panel-conn-label">${o(e.label)}</span>${n}
  </a>`}function j(e,n){let t=n.level1??[],l=n.level2??[],a=t.filter(p=>p.edge==="explicit"),r=t.filter(p=>p.edge==="similar"),g=a.length?`<div class="contact-page-vinculos">${a.map(T).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo expl\xEDcito ainda.</p>',s=n.similar_available===!1?'<p class="contact-page-warn">Similaridade pendente de pr\xE9-computo.</p>':r.length?`<div class="contact-page-vinculos">${r.map(T).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo semelhante encontrado.</p>',m=new Map;for(let p of l){let f=p.via_label||p.via_id;m.has(f)||m.set(f,[]),m.get(f).push(p)}let u=m.size?[...m.entries()].map(([p,f])=>`
        <div class="contact-page-via-group">
          <div class="contact-page-via-label">via ${o(p)}</div>
          <div class="contact-page-vinculos">${f.map(T).join("")}</div>
        </div>
      `).join(""):'<p class="contact-page-empty">Sem rede de 2\xBA n\xEDvel ainda.</p>';e.innerHTML=`
    <h2>V\xEDnculos</h2>
    <details class="contact-page-acc"${a.length>0&&a.length<=6?" open":""}>
      <summary>Expl\xEDcitos (${a.length})</summary>
      <div class="contact-page-acc-body">${g}</div>
    </details>
    <details class="contact-page-acc">
      <summary>Similares (${r.length})</summary>
      <div class="contact-page-acc-body">${s}</div>
    </details>
    <details class="contact-page-acc">
      <summary>Rede de 2\xBA n\xEDvel (${l.length})</summary>
      <div class="contact-page-acc-body">${u}</div>
    </details>
  `}function D(e,n){let t={offset:0,total:0,loading:!1};n.innerHTML=`
    <ul class="panel-events" data-timeline-list></ul>
    <button type="button" class="panel-timeline-more" data-timeline-more style="display:none">Carregar mais</button>
    <details class="panel-addconn">
      <summary class="panel-addconn-summary">Registrar intera\xE7\xE3o</summary>
      <form class="panel-form" data-timeline-form>
        <div class="panel-form-field">
          <label class="panel-form-label">Tipo</label>
          <select class="panel-form-input" data-timeline-kind>
            ${S.map(c=>`<option value="${c.value}">${o(c.label)}</option>`).join("")}
          </select>
        </div>
        <div class="panel-form-field">
          <label class="panel-form-label">Contexto (opcional)</label>
          <textarea class="panel-form-textarea" rows="3" maxlength="2000" data-timeline-context placeholder="Sobre o que foi..."></textarea>
        </div>
        <div class="panel-form-field">
          <label class="panel-form-label">Quando (opcional, padr\xE3o agora)</label>
          <input type="datetime-local" class="panel-form-input" data-timeline-when />
        </div>
        <div class="panel-form-feedback" role="status" data-timeline-feedback></div>
        <button type="submit" class="panel-form-submit" data-timeline-submit>Registrar</button>
      </form>
    </details>
  `;let l=n.querySelector("[data-timeline-list]"),a=n.querySelector("[data-timeline-more]"),r=n.querySelector("[data-timeline-form]"),g=n.querySelector("[data-timeline-kind]"),s=n.querySelector("[data-timeline-context]"),m=n.querySelector("[data-timeline-when]"),u=n.querySelector("[data-timeline-feedback]"),p=n.querySelector("[data-timeline-submit]");function f(c){return`<li>
      <span class="panel-event-kind">${o(L[c.kind]??c.kind)}</span>
      <span class="panel-event-ts">${o(I(c.ts))}</span>
      ${c.context?`<div class="panel-event-ctx">${o(c.context)}</div>`:""}
    </li>`}async function h(){if(!t.loading){t.loading=!0,a.disabled=!0,a.textContent="Carregando...";try{let c=await fetch(`/app/contacts/entity/events?id=${encodeURIComponent(e)}&offset=${t.offset}&limit=${H}`,{credentials:"same-origin"}),d=c.ok?await c.json():null;if(!d||d.ok===!1){a.style.display="none",t.offset===0&&(l.innerHTML='<li class="panel-empty">Erro ao carregar intera\xE7\xF5es.</li>');return}t.total=d.total??0;let v=Array.isArray(d.events)?d.events:[];t.offset===0&&v.length===0?l.innerHTML='<li class="panel-empty">Nenhuma intera\xE7\xE3o registrada ainda.</li>':l.insertAdjacentHTML("beforeend",v.map(f).join("")),t.offset+=v.length,a.style.display=t.offset<t.total?"":"none",a.textContent="Carregar mais"}catch{a.style.display="none"}finally{a.disabled=!1,t.loading=!1}}}if(a.addEventListener("click",()=>{h()}),h(),r.addEventListener("submit",c=>{c.preventDefault(),u.textContent="",u.classList.remove("error","ok");let d=s.value.trim(),v={entity_id:e,kind:g.value};if(d&&(v.context=d),m.value){let i=new Date(m.value);Number.isNaN(i.getTime())||(v.ts=_(i))}p.disabled=!0,p.textContent="Registrando...",fetch("/app/contacts/entity/event",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(v)}).then(async i=>{let y=await i.json().catch(()=>({}));if(!i.ok||!y.ok)throw new Error(y.error||`falha ${i.status}`);let b=l.querySelector(".panel-empty");b&&b.remove(),l.insertAdjacentHTML("afterbegin",f({kind:g.value,ts:v.ts||_(new Date),context:d||null})),t.total+=1,t.offset+=1,s.value="",m.value="",u.classList.add("ok"),u.textContent="Registrado."}).catch(i=>{u.classList.add("error"),u.textContent=`Erro: ${String(i?.message||i)}`}).finally(()=>{p.disabled=!1,p.textContent="Registrar"})}),location.hash==="#registrar-interacao"){let c=n.querySelector(".panel-addconn");c&&(c.open=!0,c.scrollIntoView({block:"center"}),s.focus())}}async function B(){let e=document.querySelector(".contact-page");if(!e)return;let n=e.dataset.contactId;if(!n)return;let t;try{let s=await fetch(`/app/contacts/entity?id=${encodeURIComponent(n)}`,{credentials:"same-origin"});t=s.ok?await s.json():{ok:!1}}catch{t={ok:!1}}if(!t||t.ok===!1){R(e);return}w(e,n,t);let l=e.querySelector('[data-section="neighbors"]');l&&fetch(`/app/contacts/entity/neighbors?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(s=>s.ok?s.json():null).then(s=>{if(!s||s.ok===!1){l.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>';return}j(l,s)}).catch(()=>{l.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>'});let a=e.querySelector('[data-section="mention-notes"]'),r=e.querySelector('[data-section="mention-tasks"]');(a||r)&&fetch(`/app/contacts/entity/mentions?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(s=>s.ok?s.json():null).then(s=>{a&&(!s||s.ok===!1?a.innerHTML='<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>':O(a,s.notes??[])),r&&(!s||s.ok===!1?r.innerHTML='<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>':q(r,s.tasks_open??[],s.tasks_closed_count??0))}).catch(()=>{a&&(a.innerHTML='<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>'),r&&(r.innerHTML='<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>')});let g=e.querySelector('[data-section="timeline"]');g&&D(n,g)}B().catch(e=>console.error("contact-page: fatal",e));})();
