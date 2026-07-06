"use strict";(()=>{function s(e){return e.replace(/[&<>"']/g,n=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[n])}var k={management:"#f59e0b",sales:"#22c55e",marketing:"#ec4899",education:"#8b5cf6","ai-applied":"#06b6d4",leadership:"#f97316",product:"#3b82f6",operations:"#94a3b8","personal-development":"#14b8a6",entrepreneurship:"#ef4444","cognitive-science":"#a78bfa",music:"#fbbf24"},L={person:"#22c55e",company:"#3b82f6",place:"#f59e0b",event:"#ec4899",other:"#64748b"},x="#64748b";function $(e){return k[e]??L[e]??x}var E={person:"Pessoa",company:"Empresa",place:"Lugar",event:"Evento",other:"Outro"},C={met:"Encontro",talked:"Conversa",meeting:"Reuni\xE3o",email:"E-mail",message:"Mensagem",note:"Nota",saw_post:"Vi post",recommended:"Indica\xE7\xE3o",birthday_reminder:"Anivers\xE1rio",mentioned_in_brain:"Citado no Brain"},N=[{value:"met",label:"Encontro"},{value:"talked",label:"Conversa"},{value:"meeting",label:"Reuni\xE3o"},{value:"email",label:"E-mail"},{value:"message",label:"Mensagem"},{value:"note",label:"Nota"}],S=20;function _(e){if(!e)return"";let n=e.includes("T")?e:`${e.replace(" ","T")}Z`,t=new Date(n);if(Number.isNaN(t.getTime()))return e.slice(0,16);try{return t.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}catch{return e.slice(0,16)}}function M(e){return e.toISOString().slice(0,19).replace("T"," ")}function H(e){return`/app/contacts/${encodeURIComponent(e)}`}function I(e){e.innerHTML=`
    <h1>Contato n\xE3o encontrado</h1>
    <p><a href="/app/contacts">\u2190 Voltar pros contatos</a></p>
  `}function R(e,n,t){let i=t.title||"Contato",o=t.kind||"other",l=t.editable?.category?.trim(),d=t.editable?.last_contacted?.trim(),a=typeof t.img=="string"&&t.img.startsWith("/media/")?`<img class="contact-page-avatar" src="/app/contacts${s(t.img)}" alt="" loading="lazy">`:'<div class="contact-page-avatar-fallback" aria-hidden="true"></div>',p=`<span class="panel-chip" style="--chip:${$(o)}">${s(E[o]??o)}</span>`,m=l?`<span class="panel-chip">${s(l)}</span>`:"",c=d?`<span class="panel-degree">\xDAltimo contato: ${s(d)}</span>`:"",g=(t.fields??[]).map(u=>`
    <div class="contact-page-field">
      <dt>${s(u.label)}${u.primary?" \u2605":""}</dt>
      <dd>${u.href?`<a href="${s(u.href)}" target="_blank" rel="noopener">${s(u.value)}</a>`:s(u.value)}</dd>
    </div>
  `).join("");e.innerHTML=`
    <div class="contact-page-header">
      ${a}
      <div>
        <h1 class="contact-page-name">${s(i)}</h1>
        <div class="contact-page-meta">${p}${m}${c}</div>
      </div>
    </div>
    <div class="contact-page-actions">
      <a class="panel-open" href="/app/contacts?focus=${encodeURIComponent(n)}">Abrir no grafo \u2192</a>
    </div>
    <div class="contact-page-section">
      <h2>Cartela</h2>
      <dl class="contact-page-fields">${g||'<p class="contact-page-empty">Sem campos cadastrados.</p>'}</dl>
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
  `}function A(e,n){let t=n.length?`<div class="contact-page-vinculos">${n.map(i=>`
        <a class="panel-conn" href="${s(i.url)}">
          <span class="panel-conn-label">${s(i.title)}${i.private?" \u{1F512}":""}</span>
          <span class="panel-conn-rel">${s(i.kind||"nota")}</span>
        </a>`).join("")}</div>`:'<p class="contact-page-empty">Nenhuma nota menciona esta pessoa ainda.</p>';e.innerHTML=`<h2>Notas sobre esta pessoa</h2>${t}`}function w(e,n,t){let i=n.length?`<div class="contact-page-vinculos">${n.map(l=>`
        <a class="panel-conn" href="${s(l.url)}">
          <span class="panel-conn-label">${s(l.title)}${l.private?" \u{1F512}":""}</span>
          <span class="panel-conn-rel">${s(l.status||"open")}</span>
        </a>`).join("")}</div>`:'<p class="contact-page-empty">Nenhuma tarefa aberta com esta pessoa.</p>',o=t>0?`<p class="contact-page-warn">+ ${t} tarefa${t===1?"":"s"} conclu\xEDda${t===1?"":"s"}.</p>`:"";e.innerHTML=`<h2>Tarefas com esta pessoa</h2>${i}${o}`}function h(e){let n=e.edge==="explicit"?`<span class="panel-conn-rel">${s(e.rel??"")}</span>${e.why?`<span class="panel-conn-why">${s(e.why)}</span>`:""}`:`<span class="panel-conn-rel">similar \xB7 ${Math.round((e.score??0)*100)}%</span>`;return`<a class="panel-conn" href="${s(H(e.id))}">
    <span class="panel-conn-label">${s(e.label)}</span>${n}
  </a>`}function q(e,n){let t=n.level1??[],i=n.level2??[],o=t.filter(c=>c.edge==="explicit"),l=t.filter(c=>c.edge==="similar"),d=o.length?`<div class="contact-page-vinculos">${o.map(h).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo expl\xEDcito ainda.</p>',a=n.similar_available===!1?'<p class="contact-page-warn">Similaridade pendente de pr\xE9-computo.</p>':l.length?`<div class="contact-page-vinculos">${l.map(h).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo semelhante encontrado.</p>',p=new Map;for(let c of i){let g=c.via_label||c.via_id;p.has(g)||p.set(g,[]),p.get(g).push(c)}let m=p.size?[...p.entries()].map(([c,g])=>`
        <div class="contact-page-via-group">
          <div class="contact-page-via-label">via ${s(c)}</div>
          <div class="contact-page-vinculos">${g.map(h).join("")}</div>
        </div>
      `).join(""):'<p class="contact-page-empty">Sem rede de 2\xBA n\xEDvel ainda.</p>';e.innerHTML=`
    <h2>V\xEDnculos</h2>
    <h3 class="contact-page-via-label">Expl\xEDcitos</h3>
    ${d}
    <h3 class="contact-page-via-label">Similares</h3>
    ${a}
    <div class="contact-page-section">
      <h2>Rede (2\xBA n\xEDvel)</h2>
      ${m}
    </div>
  `}function O(e,n){let t={offset:0,total:0,loading:!1};n.innerHTML=`
    <ul class="panel-events" data-timeline-list></ul>
    <button type="button" class="panel-timeline-more" data-timeline-more style="display:none">Carregar mais</button>
    <details class="panel-addconn">
      <summary class="panel-addconn-summary">Registrar intera\xE7\xE3o</summary>
      <form class="panel-form" data-timeline-form>
        <div class="panel-form-field">
          <label class="panel-form-label">Tipo</label>
          <select class="panel-form-input" data-timeline-kind>
            ${N.map(r=>`<option value="${r.value}">${s(r.label)}</option>`).join("")}
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
  `;let i=n.querySelector("[data-timeline-list]"),o=n.querySelector("[data-timeline-more]"),l=n.querySelector("[data-timeline-form]"),d=n.querySelector("[data-timeline-kind]"),a=n.querySelector("[data-timeline-context]"),p=n.querySelector("[data-timeline-when]"),m=n.querySelector("[data-timeline-feedback]"),c=n.querySelector("[data-timeline-submit]");function g(r){return`<li>
      <span class="panel-event-kind">${s(C[r.kind]??r.kind)}</span>
      <span class="panel-event-ts">${s(_(r.ts))}</span>
      ${r.context?`<div class="panel-event-ctx">${s(r.context)}</div>`:""}
    </li>`}async function u(){if(!t.loading){t.loading=!0,o.disabled=!0,o.textContent="Carregando...";try{let r=await fetch(`/app/contacts/entity/events?id=${encodeURIComponent(e)}&offset=${t.offset}&limit=${S}`,{credentials:"same-origin"}),f=r.ok?await r.json():null;if(!f||f.ok===!1){o.style.display="none",t.offset===0&&(i.innerHTML='<li class="panel-empty">Erro ao carregar intera\xE7\xF5es.</li>');return}t.total=f.total??0;let b=Array.isArray(f.events)?f.events:[];t.offset===0&&b.length===0?i.innerHTML='<li class="panel-empty">Nenhuma intera\xE7\xE3o registrada ainda.</li>':i.insertAdjacentHTML("beforeend",b.map(g).join("")),t.offset+=b.length,o.style.display=t.offset<t.total?"":"none",o.textContent="Carregar mais"}catch{o.style.display="none"}finally{o.disabled=!1,t.loading=!1}}}o.addEventListener("click",()=>{u()}),u(),l.addEventListener("submit",r=>{r.preventDefault(),m.textContent="",m.classList.remove("error","ok");let f=a.value.trim(),b={entity_id:e,kind:d.value};if(f&&(b.context=f),p.value){let v=new Date(p.value);Number.isNaN(v.getTime())||(b.ts=M(v))}c.disabled=!0,c.textContent="Registrando...",fetch("/app/contacts/entity/event",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(async v=>{let y=await v.json().catch(()=>({}));if(!v.ok||!y.ok)throw new Error(y.error||`falha ${v.status}`);let T=i.querySelector(".panel-empty");T&&T.remove(),i.insertAdjacentHTML("afterbegin",g({kind:d.value,ts:b.ts||M(new Date),context:f||null})),t.total+=1,t.offset+=1,a.value="",p.value="",m.classList.add("ok"),m.textContent="Registrado."}).catch(v=>{m.classList.add("error"),m.textContent=`Erro: ${String(v?.message||v)}`}).finally(()=>{c.disabled=!1,c.textContent="Registrar"})})}async function j(){let e=document.querySelector(".contact-page");if(!e)return;let n=e.dataset.contactId;if(!n)return;let t;try{let a=await fetch(`/app/contacts/entity?id=${encodeURIComponent(n)}`,{credentials:"same-origin"});t=a.ok?await a.json():{ok:!1}}catch{t={ok:!1}}if(!t||t.ok===!1){I(e);return}R(e,n,t);let i=e.querySelector('[data-section="neighbors"]');i&&fetch(`/app/contacts/entity/neighbors?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(a=>a.ok?a.json():null).then(a=>{if(!a||a.ok===!1){i.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>';return}q(i,a)}).catch(()=>{i.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>'});let o=e.querySelector('[data-section="mention-notes"]'),l=e.querySelector('[data-section="mention-tasks"]');(o||l)&&fetch(`/app/contacts/entity/mentions?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(a=>a.ok?a.json():null).then(a=>{o&&(!a||a.ok===!1?o.innerHTML='<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>':A(o,a.notes??[])),l&&(!a||a.ok===!1?l.innerHTML='<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>':w(l,a.tasks_open??[],a.tasks_closed_count??0))}).catch(()=>{o&&(o.innerHTML='<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>'),l&&(l.innerHTML='<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>')});let d=e.querySelector('[data-section="timeline"]');d&&O(n,d)}j().catch(e=>console.error("contact-page: fatal",e));})();
