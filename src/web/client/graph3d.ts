import ForceGraph3D from '3d-force-graph';
import { domainColor } from '../domain-colors.js';

// ──────────────────────────────────────────────────────────────────────────────
// Grafo 3D — o "globo que gira". Mesma FONTE de dados do 2D (/app/graph/data),
// mas renderizado com WebGL/three via 3d-force-graph. Só arestas explícitas
// entram (as semânticas ficam de fora por clareza e performance — em 3D o
// emaranhado semântico polui demais). CSP do app é script-src 'self': o bundle
// (three incluso) é self-hosted, ZERO CDN. Ver src/web/render.ts (CSP).
// ──────────────────────────────────────────────────────────────────────────────

// Formato do payload — espelha src/web/graph-data.ts (server-side).
interface GraphNode {
  id: string;
  label: string;
  domain: string;
  size: number;
  x: number;
  y: number;
}
interface ExplicitEdge {
  id: string;
  source: string;
  target: string;
  type: 'explicit';
  why: string;
  relation_type: string;
}
interface SimilarEdge {
  id: string;
  source: string;
  target: string;
  type: 'similar';
  score: number;
}
type Edge = ExplicitEdge | SimilarEdge;
interface Payload { nodes: GraphNode[]; edges: Edge[]; }

// Nó no formato do 3d-force-graph (id + props livres que os accessors leem).
interface Node3D {
  id: string;
  label: string;
  domain: string;
  val: number;   // tamanho relativo do nó (nodeVal)
}
interface Link3D {
  source: string;
  target: string;
}

// Fundo escuro igual ao tema do canvas 2D (.graph-wrap em src/web/graph.ts).
const BG_COLOR = '#0c0c10';

function setStatus(msg: string) {
  const el = document.getElementById('graph3d-status');
  if (el) el.textContent = msg;
}

async function main() {
  const container = document.getElementById('graph3d-canvas') as HTMLElement | null;
  if (!container) return;

  // Mesmo payload do 2D. Sessão via cookie same-origin. Se a sessão expirou, o
  // requireSession devolve 401 JSON (accept: application/json) em vez de seguir o
  // 302 — aqui a gente detecta e manda pro login preservando o destino.
  let res: Response;
  try {
    res = await fetch('/app/graph/data', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    console.error('graph3d: fetch falhou', err);
    setStatus('Falha ao carregar grafo');
    return;
  }
  if (res.status === 401) {
    // Sessão expirada: volta pro login com next pra retornar aqui depois.
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/app/login?next=${next}`;
    return;
  }
  if (!res.ok) {
    setStatus('Falha ao carregar grafo');
    return;
  }

  const payload = (await res.json()) as Payload;

  // Nós: cor por domínio (MESMA paleta do 2D via domainColor). O `val` controla
  // o raio da esfera — n.size do payload é a escala do Obsidian (6..30); dividido
  // por ~3 pra ficar proporcional ao mundo 3D do three (nodeRelSize default 4).
  const nodes: Node3D[] = payload.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    domain: n.domain,
    val: n.size / 3,
  }));

  // SÓ arestas explícitas (type 'explicit'). As semânticas ficam fora: em 3D o
  // volume de linhas de similaridade vira ruído e pesa no render. Clareza + perf.
  const validIds = new Set(nodes.map((n) => n.id));
  const links: Link3D[] = [];
  for (const e of payload.edges) {
    if (e.type !== 'explicit') continue;
    if (!validIds.has(e.source) || !validIds.has(e.target)) continue;
    links.push({ source: e.source, target: e.target });
  }

  setStatus(`${nodes.length} notas · ${links.length} ligações explícitas`);
  const loading = document.getElementById('graph3d-loading');
  if (loading) loading.classList.add('hidden');

  const { clientWidth, clientHeight } = container;

  const graph = new ForceGraph3D(container)
    .graphData({ nodes, links })
    .backgroundColor(BG_COLOR)
    .width(clientWidth || window.innerWidth)
    .height(clientHeight || window.innerHeight)
    .showNavInfo(false)
    // Cor do nó pela paleta compartilhada com o 2D (por domínio).
    .nodeColor((n: any) => domainColor(String(n.domain || 'misc')))
    .nodeVal((n: any) => (typeof n.val === 'number' ? n.val : 1))
    .nodeRelSize(4)
    // Hover: tooltip com o título da nota.
    .nodeLabel((n: any) => String(n.label ?? n.id))
    // Arestas explícitas discretas — cinza translúcido sobre o fundo escuro.
    .linkColor(() => 'rgba(120, 120, 140, 0.35)')
    .linkWidth(0.6)
    // Clique: abre a nota completa (mesmo destino do painel 2D → botão "Abrir nota").
    .onNodeClick((n: any) => {
      const id = String(n.id ?? '');
      if (id) location.href = '/app/notes/' + encodeURIComponent(id);
    });

  // ────────────────────────────────────────────────────────────────────────
  // Órbita "globo que gira": arrastar gira e scroll dá zoom (padrão da lib com
  // controlType 'orbit'). Auto-rotate suave e lento; PAUSA quando o usuário
  // interage e retoma depois de ~10s parado.
  // ────────────────────────────────────────────────────────────────────────
  const controls = graph.controls() as any;
  const AUTOROTATE_SPEED = 0.6;   // giro lento e suave
  const RESUME_AFTER_MS = 10_000; // retoma 10s após a última interação
  if (controls) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = AUTOROTATE_SPEED;

    let resumeTimer = 0;
    const pauseAutoRotate = () => {
      controls.autoRotate = false;
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        controls.autoRotate = true;
      }, RESUME_AFTER_MS);
    };
    // Qualquer interação de ponteiro/roda no canvas pausa o giro automático.
    // OrbitControls também emite 'start', mas cobrir pointer/wheel direto garante
    // que o toque inicial já pause sem esperar o controle disparar o evento.
    container.addEventListener('pointerdown', pauseAutoRotate, { passive: true });
    container.addEventListener('wheel', pauseAutoRotate, { passive: true });
    if (typeof controls.addEventListener === 'function') {
      controls.addEventListener('start', pauseAutoRotate);
    }
  }

  // Redimensiona o canvas com a janela (o container é full-height).
  window.addEventListener('resize', () => {
    graph.width(container.clientWidth || window.innerWidth);
    graph.height(container.clientHeight || window.innerHeight);
  });
}

void main();
