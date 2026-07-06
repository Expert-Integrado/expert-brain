"use strict";(()=>{function a(e){return e.replace(/[&<>"']/g,n=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[n])}var C={management:"#f59e0b",sales:"#22c55e",marketing:"#ec4899",education:"#8b5cf6","ai-applied":"#06b6d4",leadership:"#f97316",product:"#3b82f6",operations:"#94a3b8","personal-development":"#14b8a6",entrepreneurship:"#ef4444","cognitive-science":"#a78bfa",music:"#fbbf24"},E={person:"#22c55e",company:"#3b82f6",place:"#f59e0b",event:"#ec4899",other:"#64748b"},L="#64748b";function T(e){return C[e]??E[e]??L}var k={person:"Pessoa",company:"Empresa",place:"Lugar",event:"Evento",other:"Outro"},M={met:"Encontro",talked:"Conversa",meeting:"Reuni\xE3o",email:"E-mail",message:"Mensagem",note:"Nota",saw_post:"Vi post",recommended:"Indica\xE7\xE3o",birthday_reminder:"Anivers\xE1rio",mentioned_in_brain:"Citado no Brain"},N=[{value:"met",label:"Encontro"},{value:"talked",label:"Conversa"},{value:"meeting",label:"Reuni\xE3o"},{value:"email",label:"E-mail"},{value:"message",label:"Mensagem"},{value:"note",label:"Nota"}],S=20;function _(e){if(!e)return"";let n=e.includes("T")?e:`${e.replace(" ","T")}Z`,t=new Date(n);if(Number.isNaN(t.getTime()))return e.slice(0,16);try{return t.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}catch{return e.slice(0,16)}}function $(e){return e.toISOString().slice(0,19).replace("T"," ")}function I(e){return`/app/contacts/${encodeURIComponent(e)}`}function H(e){e.innerHTML=`
    <h1>Contato n\xE3o encontrado</h1>
    <p><a href="/app/contacts">\u2190 Voltar pros contatos</a></p>
  `}function A(e,n,t){let l=t.title||"Contato",o=t.kind||"other",i=t.editable?.category?.trim(),v=t.editable?.last_contacted?.trim(),b=typeof t.img=="string"&&t.img.startsWith("/media/")?`<img class="contact-page-avatar" src="/app/contacts${a(t.img)}" alt="" loading="lazy">`:'<div class="contact-page-avatar-fallback" aria-hidden="true"></div>',c=`<span class="panel-chip" style="--chip:${T(o)}">${a(k[o]??o)}</span>`,d=i?`<span class="panel-chip">${a(i)}</span>`:"",s=v?`<span class="panel-degree">\xDAltimo contato: ${a(v)}</span>`:"",p=(t.fields??[]).map(m=>`
    <div class="contact-page-field">
      <dt>${a(m.label)}${m.primary?" \u2605":""}</dt>
      <dd>${m.href?`<a href="${a(m.href)}" target="_blank" rel="noopener">${a(m.value)}</a>`:a(m.value)}</dd>
    </div>
  `).join("");e.innerHTML=`
    <div class="contact-page-header">
      ${b}
      <div>
        <h1 class="contact-page-name">${a(l)}</h1>
        <div class="contact-page-meta">${c}${d}${s}</div>
      </div>
    </div>
    <div class="contact-page-actions">
      <a class="panel-open" href="/app/contacts?focus=${encodeURIComponent(n)}">Abrir no grafo \u2192</a>
    </div>
    <div class="contact-page-section">
      <h2>Cartela</h2>
      <dl class="contact-page-fields">${p||'<p class="contact-page-empty">Sem campos cadastrados.</p>'}</dl>
    </div>
    <div class="contact-page-section" data-section="neighbors">
      <h2>V\xEDnculos</h2>
      <p class="contact-page-empty">Carregando v\xEDnculos...</p>
    </div>
    <div class="contact-page-section" data-section="timeline">
      <h2>Intera\xE7\xF5es</h2>
    </div>
  `}function h(e){let n=e.edge==="explicit"?`<span class="panel-conn-rel">${a(e.rel??"")}</span>${e.why?`<span class="panel-conn-why">${a(e.why)}</span>`:""}`:`<span class="panel-conn-rel">similar \xB7 ${Math.round((e.score??0)*100)}%</span>`;return`<a class="panel-conn" href="${a(I(e.id))}">
    <span class="panel-conn-label">${a(e.label)}</span>${n}
  </a>`}function R(e,n){let t=n.level1??[],l=n.level2??[],o=t.filter(s=>s.edge==="explicit"),i=t.filter(s=>s.edge==="similar"),v=o.length?`<div class="contact-page-vinculos">${o.map(h).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo expl\xEDcito ainda.</p>',b=n.similar_available===!1?'<p class="contact-page-warn">Similaridade pendente de pr\xE9-computo.</p>':i.length?`<div class="contact-page-vinculos">${i.map(h).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo semelhante encontrado.</p>',c=new Map;for(let s of l){let p=s.via_label||s.via_id;c.has(p)||c.set(p,[]),c.get(p).push(s)}let d=c.size?[...c.entries()].map(([s,p])=>`
        <div class="contact-page-via-group">
          <div class="contact-page-via-label">via ${a(s)}</div>
          <div class="contact-page-vinculos">${p.map(h).join("")}</div>
        </div>
      `).join(""):'<p class="contact-page-empty">Sem rede de 2\xBA n\xEDvel ainda.</p>';e.innerHTML=`
    <h2>V\xEDnculos</h2>
    <h3 class="contact-page-via-label">Expl\xEDcitos</h3>
    ${v}
    <h3 class="contact-page-via-label">Similares</h3>
    ${b}
    <div class="contact-page-section">
      <h2>Rede (2\xBA n\xEDvel)</h2>
      ${d}
    </div>
  `}function w(e,n){let t={offset:0,total:0,loading:!1};n.innerHTML=`
    <ul class="panel-events" data-timeline-list></ul>
    <button type="button" class="panel-timeline-more" data-timeline-more style="display:none">Carregar mais</button>
    <details class="panel-addconn">
      <summary class="panel-addconn-summary">Registrar intera\xE7\xE3o</summary>
      <form class="panel-form" data-timeline-form>
        <div class="panel-form-field">
          <label class="panel-form-label">Tipo</label>
          <select class="panel-form-input" data-timeline-kind>
            ${N.map(r=>`<option value="${r.value}">${a(r.label)}</option>`).join("")}
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
  `;let l=n.querySelector("[data-timeline-list]"),o=n.querySelector("[data-timeline-more]"),i=n.querySelector("[data-timeline-form]"),v=n.querySelector("[data-timeline-kind]"),b=n.querySelector("[data-timeline-context]"),c=n.querySelector("[data-timeline-when]"),d=n.querySelector("[data-timeline-feedback]"),s=n.querySelector("[data-timeline-submit]");function p(r){return`<li>
      <span class="panel-event-kind">${a(M[r.kind]??r.kind)}</span>
      <span class="panel-event-ts">${a(_(r.ts))}</span>
      ${r.context?`<div class="panel-event-ctx">${a(r.context)}</div>`:""}
    </li>`}async function m(){if(!t.loading){t.loading=!0,o.disabled=!0,o.textContent="Carregando...";try{let r=await fetch(`/app/contacts/entity/events?id=${encodeURIComponent(e)}&offset=${t.offset}&limit=${S}`,{credentials:"same-origin"}),g=r.ok?await r.json():null;if(!g||g.ok===!1){o.style.display="none",t.offset===0&&(l.innerHTML='<li class="panel-empty">Erro ao carregar intera\xE7\xF5es.</li>');return}t.total=g.total??0;let f=Array.isArray(g.events)?g.events:[];t.offset===0&&f.length===0?l.innerHTML='<li class="panel-empty">Nenhuma intera\xE7\xE3o registrada ainda.</li>':l.insertAdjacentHTML("beforeend",f.map(p).join("")),t.offset+=f.length,o.style.display=t.offset<t.total?"":"none",o.textContent="Carregar mais"}catch{o.style.display="none"}finally{o.disabled=!1,t.loading=!1}}}o.addEventListener("click",()=>{m()}),m(),i.addEventListener("submit",r=>{r.preventDefault(),d.textContent="",d.classList.remove("error","ok");let g=b.value.trim(),f={entity_id:e,kind:v.value};if(g&&(f.context=g),c.value){let u=new Date(c.value);Number.isNaN(u.getTime())||(f.ts=$(u))}s.disabled=!0,s.textContent="Registrando...",fetch("/app/contacts/entity/event",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(f)}).then(async u=>{let y=await u.json().catch(()=>({}));if(!u.ok||!y.ok)throw new Error(y.error||`falha ${u.status}`);let x=l.querySelector(".panel-empty");x&&x.remove(),l.insertAdjacentHTML("afterbegin",p({kind:v.value,ts:f.ts||$(new Date),context:g||null})),t.total+=1,t.offset+=1,b.value="",c.value="",d.classList.add("ok"),d.textContent="Registrado."}).catch(u=>{d.classList.add("error"),d.textContent=`Erro: ${String(u?.message||u)}`}).finally(()=>{s.disabled=!1,s.textContent="Registrar"})})}async function O(){let e=document.querySelector(".contact-page");if(!e)return;let n=e.dataset.contactId;if(!n)return;let t;try{let i=await fetch(`/app/contacts/entity?id=${encodeURIComponent(n)}`,{credentials:"same-origin"});t=i.ok?await i.json():{ok:!1}}catch{t={ok:!1}}if(!t||t.ok===!1){H(e);return}A(e,n,t);let l=e.querySelector('[data-section="neighbors"]');l&&fetch(`/app/contacts/entity/neighbors?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(i=>i.ok?i.json():null).then(i=>{if(!i||i.ok===!1){l.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>';return}R(l,i)}).catch(()=>{l.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>'});let o=e.querySelector('[data-section="timeline"]');o&&w(n,o)}O().catch(e=>console.error("contact-page: fatal",e));})();
