"use strict";(()=>{function c(e){return e.replace(/[&<>"']/g,n=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[n])}var Y={management:"#f59e0b",sales:"#22c55e",marketing:"#ec4899",education:"#8b5cf6","ai-applied":"#06b6d4",leadership:"#f97316",product:"#3b82f6",operations:"#94a3b8","personal-development":"#14b8a6",entrepreneurship:"#ef4444","cognitive-science":"#a78bfa",music:"#fbbf24"},W={person:"#22c55e",company:"#3b82f6",group:"#a855f7",place:"#f59e0b",event:"#ec4899",other:"#64748b"},Z="#64748b";function O(e){return Y[e]??W[e]??Z}var B={met:"Encontro",talked:"Conversa",meeting:"Reuni\xE3o",email:"E-mail",message:"Mensagem",note:"Nota",saw_post:"Vi post",recommended:"Indica\xE7\xE3o",birthday_reminder:"Anivers\xE1rio",mentioned_in_brain:"Citado no Brain"};var D={person:"Pessoa",company:"Empresa",group:"Grupo",place:"Lugar",event:"Evento",other:"Outro"},X={colleague:"Colega",friend:"Amigo(a)",family:"Fam\xEDlia",client:"Cliente",mentor:"Mentor(a)",alum_g4:"Alumni G4",peer_tech:"Par (tech)",introduced_by:"Apresentado por",works_at:"Trabalha em",founded:"Fundou",advisor_of:"Conselheiro de",studied_at:"Estudou em",member_of:"Membro de",partner_of:"Parceiro de",supplier_of:"Fornecedor de",competitor_of:"Concorrente de",parent_of:"Controladora de",subsidiary_of:"Subsidi\xE1ria de",invested_in:"Investiu em",client_of:"Cliente de",other:"Outro"};function P(e){return X[e]??e}var z=[{value:"met",label:"Encontro"},{value:"talked",label:"Conversa"},{value:"meeting",label:"Reuni\xE3o"},{value:"email",label:"E-mail"},{value:"message",label:"Mensagem"},{value:"note",label:"Nota"}],J=20;function Q(e,n){if(!e)return"";let a=e.includes("T")?e:`${e.replace(" ","T")}Z`,p=new Date(a);if(Number.isNaN(p.getTime()))return e.slice(0,16);try{let o={timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit"};return n==="whatsapp"&&p.toLocaleTimeString("pt-BR",{timeZone:"America/Sao_Paulo",hour12:!1})==="12:00:00"||(o.hour="2-digit",o.minute="2-digit"),p.toLocaleString("pt-BR",o)}catch{return e.slice(0,16)}}function V(e){return e.toISOString().slice(0,19).replace("T"," ")}function q(e){return`/app/contacts/${encodeURIComponent(e)}`}function ee(e){e.innerHTML=`
    <h1>Contato n\xE3o encontrado</h1>
    <p><a href="/app/contacts">\u2190 Voltar pros contatos</a></p>
  `}function te(e,n,a){let p=a.title||"Contato",o=a.kind||"other",d=a.editable?.category?.trim(),g=a.editable?.last_contacted?.trim(),f=typeof a.img=="string"&&a.img.startsWith("/media/")?`<img class="contact-page-avatar" src="/app/contacts${c(a.img)}" alt="" loading="lazy">`:'<div class="contact-page-avatar-fallback" aria-hidden="true"></div>',s=`<span class="panel-chip" style="--chip:${O(o)}">${c(D[o]??o)}</span>`,r=d?`<span class="panel-chip">${c(d)}</span>`:"",h=g?`<span class="panel-degree">\xDAltimo contato: ${c(g)}</span>`:"",y={"Grupo em comum":"Grupos em comum"},x=a.fields??[],u=new Map;for(let m of x)u.set(m.label,(u.get(m.label)??0)+1);let v=new Set,T=x.map(m=>{if((u.get(m.label)??1)>1){if(v.has(m.label))return"";v.add(m.label);let E=x.filter($=>$.label===m.label).map($=>$.href?`<a class="contact-page-chip" href="${c($.href)}" target="_blank" rel="noopener">${c($.value)}</a>`:`<span class="contact-page-chip">${c($.value)}</span>`).join("");return`
    <div class="contact-page-field">
      <dt>${c(y[m.label]??m.label)}</dt>
      <dd><div class="contact-page-chips">${E}</div></dd>
    </div>`}return`
    <div class="contact-page-field">
      <dt>${c(m.label)}${m.primary?" \u2605":""}</dt>
      <dd>${m.href?`<a href="${c(m.href)}" target="_blank" rel="noopener">${c(m.value)}</a>`:c(m.value)}</dd>
    </div>`}).join("");e.innerHTML=`
    <div class="contact-page-header">
      ${f}
      <div>
        <h1 class="contact-page-name">${c(p)}</h1>
        <div class="contact-page-meta">${s}${r}${h}</div>
      </div>
    </div>
    <div class="contact-page-actions">
      <a class="panel-open" href="/app/contacts?focus=${encodeURIComponent(n)}">Abrir no grafo \u2192</a>
    </div>
    <div class="contact-page-section">
      <h2>Cartela</h2>
      <dl class="contact-page-fields">${T||'<p class="contact-page-empty">Sem campos cadastrados.</p>'}</dl>
    </div>
    <div class="contact-page-section" data-section="group-graph" hidden></div>
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
  `}function ne(e,n){if(n.length===0){e.hidden=!0,e.innerHTML="";return}e.hidden=!1,e.innerHTML=`
    <details class="contact-page-acc">
      <summary>Notas sobre esta pessoa (${n.length})</summary>
      <div class="contact-page-acc-body">
        <div class="contact-page-vinculos">${n.map(a=>`
        <a class="panel-conn" href="${c(a.url)}">
          <span class="panel-conn-label">${c(a.title)}${a.private?" \u{1F512}":""}</span>
          <span class="panel-conn-rel">${c(a.kind||"nota")}</span>
        </a>`).join("")}</div>
      </div>
    </details>`}function ae(e,n,a){if(n.length===0&&a===0){e.hidden=!0,e.innerHTML="";return}e.hidden=!1;let p=n.length?`<div class="contact-page-vinculos">${n.map(d=>`
        <a class="panel-conn" href="${c(d.url)}">
          <span class="panel-conn-label">${c(d.title)}${d.private?" \u{1F512}":""}</span>
          <span class="panel-conn-rel">${c(d.status||"open")}</span>
        </a>`).join("")}</div>`:'<p class="contact-page-empty">Nenhuma tarefa aberta com esta pessoa.</p>',o=a>0?`<p class="contact-page-warn">+ ${a} tarefa${a===1?"":"s"} conclu\xEDda${a===1?"":"s"}.</p>`:"";e.innerHTML=`
    <details class="contact-page-acc">
      <summary>Tarefas com esta pessoa (${n.length})</summary>
      <div class="contact-page-acc-body">${p}${o}</div>
    </details>`}function I(e){let n=e.edge==="explicit"?`<span class="panel-conn-rel">${c(P(e.rel??""))}</span>${e.why?`<span class="panel-conn-why">${c(e.why)}</span>`:""}`:`<span class="panel-conn-rel">similar \xB7 ${Math.round((e.score??0)*100)}%</span>`;return`<a class="panel-conn" href="${c(q(e.id))}">
    <span class="panel-conn-label">${c(e.label)}</span>${n}
  </a>`}function oe(e,n){let a=n.level1??[],p=n.level2??[],o=a.filter(h=>h.edge==="explicit"),d=a.filter(h=>h.edge==="similar"),g=o.length?`<div class="contact-page-vinculos">${o.map(I).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo expl\xEDcito ainda.</p>',f=n.similar_available===!1?'<p class="contact-page-warn">Similaridade pendente de pr\xE9-computo.</p>':d.length?`<div class="contact-page-vinculos">${d.map(I).join("")}</div>`:'<p class="contact-page-empty">Nenhum v\xEDnculo semelhante encontrado.</p>',s=new Map;for(let h of p){let y=h.via_label||h.via_id;s.has(y)||s.set(y,[]),s.get(y).push(h)}let r=s.size?[...s.entries()].map(([h,y])=>`
        <div class="contact-page-via-group">
          <div class="contact-page-via-label">via ${c(h)}</div>
          <div class="contact-page-vinculos">${y.map(I).join("")}</div>
        </div>
      `).join(""):'<p class="contact-page-empty">Sem rede de 2\xBA n\xEDvel ainda.</p>';e.innerHTML=`
    <h2>V\xEDnculos</h2>
    <details class="contact-page-acc"${o.length>0&&o.length<=6?" open":""}>
      <summary>Expl\xEDcitos (${o.length})</summary>
      <div class="contact-page-acc-body">${g}</div>
    </details>
    <details class="contact-page-acc">
      <summary>Similares (${d.length})</summary>
      <div class="contact-page-acc-body">${f}</div>
    </details>
    <details class="contact-page-acc">
      <summary>Rede de 2\xBA n\xEDvel (${p.length})</summary>
      <div class="contact-page-acc-body">${r}</div>
    </details>
  `}function se(e,n){let a={offset:0,total:0,loading:!1};n.innerHTML=`
    <ul class="panel-events" data-timeline-list></ul>
    <button type="button" class="panel-timeline-more" data-timeline-more style="display:none">Carregar mais</button>
    <details class="panel-addconn">
      <summary class="panel-addconn-summary">Registrar intera\xE7\xE3o</summary>
      <form class="panel-form" data-timeline-form>
        <div class="panel-form-field">
          <label class="panel-form-label">Tipo</label>
          <select class="panel-form-input" data-timeline-kind>
            ${z.map(u=>`<option value="${u.value}">${c(u.label)}</option>`).join("")}
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
  `;let p=n.querySelector("[data-timeline-list]"),o=n.querySelector("[data-timeline-more]"),d=n.querySelector("[data-timeline-form]"),g=n.querySelector("[data-timeline-kind]"),f=n.querySelector("[data-timeline-context]"),s=n.querySelector("[data-timeline-when]"),r=n.querySelector("[data-timeline-feedback]"),h=n.querySelector("[data-timeline-submit]");function y(u){return`<li>
      <span class="panel-event-kind">${c(B[u.kind]??u.kind)}</span>
      <span class="panel-event-ts">${c(Q(u.ts))}</span>
      ${u.context?`<div class="panel-event-ctx">${c(u.context)}</div>`:""}
    </li>`}async function x(){if(!a.loading){a.loading=!0,o.disabled=!0,o.textContent="Carregando...";try{let u=await fetch(`/app/contacts/entity/events?id=${encodeURIComponent(e)}&offset=${a.offset}&limit=${J}`,{credentials:"same-origin"}),v=u.ok?await u.json():null;if(!v||v.ok===!1){o.style.display="none",a.offset===0&&(p.innerHTML='<li class="panel-empty">Erro ao carregar intera\xE7\xF5es.</li>');return}a.total=v.total??0;let T=Array.isArray(v.events)?v.events:[];a.offset===0&&T.length===0?p.innerHTML='<li class="panel-empty">Nenhuma intera\xE7\xE3o registrada ainda.</li>':p.insertAdjacentHTML("beforeend",T.map(y).join("")),a.offset+=T.length,o.style.display=a.offset<a.total?"":"none",o.textContent="Carregar mais"}catch{o.style.display="none"}finally{o.disabled=!1,a.loading=!1}}}if(o.addEventListener("click",()=>{x()}),x(),d.addEventListener("submit",u=>{u.preventDefault(),r.textContent="",r.classList.remove("error","ok");let v=f.value.trim(),T={entity_id:e,kind:g.value};if(v&&(T.context=v),s.value){let m=new Date(s.value);Number.isNaN(m.getTime())||(T.ts=V(m))}h.disabled=!0,h.textContent="Registrando...",fetch("/app/contacts/entity/event",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(T)}).then(async m=>{let E=await m.json().catch(()=>({}));if(!m.ok||!E.ok)throw new Error(E.error||`falha ${m.status}`);let $=p.querySelector(".panel-empty");$&&$.remove(),p.insertAdjacentHTML("afterbegin",y({kind:g.value,ts:T.ts||V(new Date),context:v||null})),a.total+=1,a.offset+=1,f.value="",s.value="",r.classList.add("ok"),r.textContent="Registrado."}).catch(m=>{r.classList.add("error"),r.textContent=`Erro: ${String(m?.message||m)}`}).finally(()=>{h.disabled=!1,h.textContent="Registrar"})}),location.hash==="#registrar-interacao"){let u=n.querySelector(".panel-addconn");u&&(u.open=!0,u.scrollIntoView({block:"center"}),f.focus())}}function ie(e){let n=e.trim().split(/\s+/).filter(Boolean);return n.length?((n[0][0]??"")+(n.length>1?n[1][0]??"":"")).toUpperCase():"?"}function re(e,n){let a=n.members??[],p=n.edges??[];if(n.is_group===!1||a.length===0){e.hidden=!0,e.innerHTML="";return}e.hidden=!1;let o=n.truncated?`<p class="contact-page-warn">Mostrando ${a.length} de ${n.total_members} membros (grupo grande).</p>`:"",d=p.length>0,g=d?'<div class="group-graph-canvas-wrap"><canvas class="group-graph-canvas" width="600" height="360" role="img" aria-label="Grafo de conex\xF5es entre os membros do grupo"></canvas></div>':'<p class="contact-page-warn">Ainda n\xE3o h\xE1 conex\xF5es mapeadas entre os membros (o grafo aparece quando houver intera\xE7\xF5es entre eles).</p>',f=a.map(s=>`
    <a class="group-member" href="${c(q(s.id))}" data-member-id="${c(s.id)}">
      <span class="group-member-avatar" aria-hidden="true">${c(ie(s.label))}</span>
      <span class="group-member-name">${c(s.label)}</span>
      ${s.degree>0?`<span class="group-member-degree" title="Conex\xF5es dentro do grupo">${s.degree}</span>`:""}
    </a>`).join("");if(e.innerHTML=`
    <h2>Membros <span class="group-count">${n.total_members??a.length}</span></h2>
    ${o}
    ${g}
    <div class="group-member-grid">${f}</div>
  `,d){let s=e.querySelector(".group-graph-canvas");s&&le(s,a,p)}}function le(e,n,a){let p=e.getContext("2d");if(!p)return;let o=p,d=Math.min(window.devicePixelRatio||1,2),g=e.clientWidth||600,f=360;e.width=g*d,e.height=f*d,o.setTransform(d,0,0,d,0,0);let s=Math.max(1,...n.map(t=>t.degree)),r=n.map((t,l)=>{let i=l/n.length*Math.PI*2;return{id:t.id,label:t.label,degree:t.degree,x:g/2+Math.cos(i)*(g*.28),y:f/2+Math.sin(i)*(f*.32),vx:0,vy:0,r:5+t.degree/s*9}}),h=new Map(r.map((t,l)=>[t.id,l])),y=a.map(t=>({a:h.get(t.source),b:h.get(t.target),strength:t.strength})).filter(t=>t.a!==void 0&&t.b!==void 0),x=r.map((t,l)=>l),u=t=>{for(;x[t]!==t;)x[t]=x[x[t]],t=x[t];return t};for(let t of y){let l=u(t.a),i=u(t.b);l!==i&&(x[l]=i)}let v=new Map;r.forEach((t,l)=>{let i=u(l);v.has(i)||v.set(i,[]),v.get(i).push(l)});let T=[...v.values()].sort((t,l)=>l.length-t.length),m=new Set(T[0]??[]),E=T.slice(1).flat(),$=new Set;E.forEach((t,l)=>{r[t].x=g-46,r[t].y=40+l*40,$.add(t)});let A=E.length?92:8,H=[...m],U=(g-A)/2,F=f/2,K=(g-A)*f,w=Math.sqrt(K/Math.max(1,H.length))*.95;for(let t=0;t<320;t++){for(let i of H){let b=0,k=0;for(let L of H){if(i===L)continue;let S=r[i].x-r[L].x,N=r[i].y-r[L].y,C=Math.hypot(S,N)||.01,j=w*w/C;b+=S/C*j,k+=N/C*j}b+=(U-r[i].x)*.045,k+=(F-r[i].y)*.045,r[i].vx=b,r[i].vy=k}for(let i of y){if($.has(i.a)||$.has(i.b))continue;let b=r[i.a].x-r[i.b].x,k=r[i.a].y-r[i.b].y,L=Math.hypot(b,k)||.01,S=L*L/w,N=b/L*S,C=k/L*S;r[i.a].vx-=N,r[i.a].vy-=C,r[i.b].vx+=N,r[i.b].vy+=C}let l=.09*(1-t/320);for(let i of H){let b=r[i];b.x+=Math.max(-16,Math.min(16,b.vx*l)),b.y+=Math.max(-16,Math.min(16,b.vy*l)),b.x=Math.max(b.r+8,Math.min(g-A-b.r,b.x)),b.y=Math.max(b.r+8,Math.min(f-b.r-8,b.y))}}let _=new Map;y.forEach(t=>{_.has(t.a)||_.set(t.a,new Set),_.has(t.b)||_.set(t.b,new Set),_.get(t.a).add(t.b),_.get(t.b).add(t.a)});let M=-1;function R(){o.clearRect(0,0,g,f);for(let t of y){let l=M===-1||M===t.a||M===t.b;o.strokeStyle=l?"rgba(167,139,250,0.42)":"rgba(167,139,250,0.08)",o.lineWidth=l&&M!==-1?1.6:1,o.beginPath(),o.moveTo(r[t.a].x,r[t.a].y),o.lineTo(r[t.b].x,r[t.b].y),o.stroke()}for(let t=0;t<r.length;t++){let l=r[t],i=M===-1||M===t||_.get(M)?.has(t);o.globalAlpha=i?1:.3,o.fillStyle=M===t?"#c4b5fd":"rgba(167,139,250,0.9)",o.beginPath(),o.arc(l.x,l.y,l.r,0,Math.PI*2),o.fill(),(M===t||M===-1&&l.r>9)&&(o.globalAlpha=i?.95:.3,o.fillStyle="#e9e4fb",o.font="11px system-ui, sans-serif",o.textAlign="center",o.fillText(l.label.length>18?l.label.slice(0,17)+"\u2026":l.label,l.x,l.y-l.r-5))}o.globalAlpha=1}R();function G(t,l){for(let i=r.length-1;i>=0;i--)if(Math.hypot(r[i].x-t,r[i].y-l)<=r[i].r+4)return i;return-1}e.addEventListener("mousemove",t=>{let l=e.getBoundingClientRect(),i=G(t.clientX-l.left,t.clientY-l.top);i!==M&&(M=i,e.style.cursor=i>=0?"pointer":"default",R())}),e.addEventListener("mouseleave",()=>{M!==-1&&(M=-1,R())}),e.addEventListener("click",t=>{let l=e.getBoundingClientRect(),i=G(t.clientX-l.left,t.clientY-l.top);i>=0&&(window.location.href=q(r[i].id))})}async function ce(){let e=document.querySelector(".contact-page");if(!e)return;let n=e.dataset.contactId;if(!n)return;let a;try{let s=await fetch(`/app/contacts/entity?id=${encodeURIComponent(n)}`,{credentials:"same-origin"});a=s.ok?await s.json():{ok:!1}}catch{a={ok:!1}}if(!a||a.ok===!1){ee(e);return}te(e,n,a);let p=e.querySelector('[data-section="group-graph"]');p&&fetch(`/app/contacts/entity/group-graph?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(s=>s.ok?s.json():null).then(s=>{if(!s||s.ok===!1){p.hidden=!0;return}re(p,s)}).catch(()=>{p.hidden=!0});let o=e.querySelector('[data-section="neighbors"]');o&&fetch(`/app/contacts/entity/neighbors?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(s=>s.ok?s.json():null).then(s=>{if(!s||s.ok===!1){o.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>';return}oe(o,s)}).catch(()=>{o.innerHTML='<h2>V\xEDnculos</h2><p class="contact-page-empty">V\xEDnculos indispon\xEDveis no momento.</p>'});let d=e.querySelector('[data-section="mention-notes"]'),g=e.querySelector('[data-section="mention-tasks"]');(d||g)&&fetch(`/app/contacts/entity/mentions?id=${encodeURIComponent(n)}`,{credentials:"same-origin"}).then(s=>s.ok?s.json():null).then(s=>{d&&(!s||s.ok===!1?d.innerHTML='<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>':ne(d,s.notes??[])),g&&(!s||s.ok===!1?g.innerHTML='<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>':ae(g,s.tasks_open??[],s.tasks_closed_count??0))}).catch(()=>{d&&(d.innerHTML='<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>'),g&&(g.innerHTML='<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indispon\xEDvel no momento.</p>')});let f=e.querySelector('[data-section="timeline"]');f&&se(n,f)}ce().catch(e=>console.error("contact-page: fatal",e));})();
