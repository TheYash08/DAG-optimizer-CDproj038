const DEMOS = {
  cse: `t1 = a + b\nt2 = a + b\nt3 = t1 * c\nt4 = t2 * c\nt5 = t3 + t4\nx = t5`,
  dead:`t1 = a + b\nt2 = c * d\nt3 = t1 + t2\nt4 = e - f\nx = t3`,
  chain:`t1 = a + b\nt2 = t1 * t1\nt3 = t2 + c\nt4 = t3 * t3\ny = t4`,
  mixed:`t1 = a + b\nt2 = a + b\nt3 = b + a\nt4 = t1 * t2\nt5 = c - d\nt6 = t5 + t5\nt7 = t4 + t6\nx = t7`,
  copy: `t1 = a\nt2 = t1\nt3 = t2 + b\nt4 = a + b\nx = t3\ny = t4`
};

function loadDemo(k){ document.getElementById('code-input').value = DEMOS[k] || ''; }

// ── PARSER ──
function parseInstructions(src) {
  return src.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'))
    .map((l, i) => {
      const assign = l.match(/^(\w+)\s*=\s*(.+)$/);
      if (!assign) return null;
      const lhs = assign[1].trim();
      const rhs = assign[2].trim();
      const binop = rhs.match(/^(\w+)\s*([\+\-\*\/])\s*(\w+)$/);
      const unop  = rhs.match(/^([\-!])(\w+)$/);
      if (binop) return { idx:i, lhs, op:binop[2], arg1:binop[1], arg2:binop[3], type:'binop', raw:l };
      if (unop)  return { idx:i, lhs, op:unop[1],  arg1:unop[2],  arg2:null,     type:'unop',  raw:l };
      // copy
      return { idx:i, lhs, op:'=', arg1:rhs, arg2:null, type:'copy', raw:l };
    })
    .filter(Boolean);
}

// ── DAG CONSTRUCTION ──
class DAGBuilder {
  constructor() {
    this.nodes = [];       // {id, kind:'leaf'|'op'|'root', label, op, children[], names[], vn, dead}
    this.vnMap = {};       // expr_key → node_id
    this.varNode = {};     // var_name → node_id  (current node for this var)
    this.steps = [];       // animation steps
    this.cseFired = 0;
    this.nodeIdCounter = 0;
  }

  newId() { return this.nodeIdCounter++; }

  getOrCreateLeaf(name) {
    if (this.varNode[name] !== undefined) return this.varNode[name];
    const id = this.newId();
    this.nodes.push({ id, kind:'leaf', label:name, op:null, children:[], names:[name], vn:name, dead:false });
    this.varNode[name] = id;
    return id;
  }

  exprKey(op, c1, c2) {
    const n1 = this.nodes[c1];
    const n2 = c2 !== null ? this.nodes[c2] : null;
    // commutative ops: sort for canonical form
    if (['+','*'].includes(op) && c2 !== null) {
      const k1 = `${op}:${n1.vn}:${n2.vn}`;
      const k2 = `${op}:${n2.vn}:${n1.vn}`;
      return k1 < k2 ? k1 : k2;
    }
    return c2 !== null ? `${op}:${n1.vn}:${n2.vn}` : `${op}:${n1.vn}`;
  }

  build(instructions) {
    const steps = [];

    for (const instr of instructions) {
      const step = { instr, nodesBefore: this.nodes.map(n=>({...n,children:[...n.children],names:[...n.names]})), merged:false, deadNodes:[] };

      if (instr.type === 'copy') {
        // copy propagation: point lhs to same node as rhs
        const srcId = this.getOrCreateLeaf(instr.arg1);
        const oldId = this.varNode[instr.lhs];

        // Check if lhs was pointing to something else — mark that as potentially dead
        if (oldId !== undefined && oldId !== srcId) {
          const oldNode = this.nodes[oldId];
          // remove lhs from old node's names
          oldNode.names = oldNode.names.filter(n => n !== instr.lhs);
        }

        this.varNode[instr.lhs] = srcId;
        const srcNode = this.nodes[srcId];
        if (!srcNode.names.includes(instr.lhs)) srcNode.names.push(instr.lhs);

        step.type = 'copy';
        step.assignedNode = srcId;
        step.merged = false;
        steps.push(step);
        continue;
      }

      // resolve operands
      const c1 = this.getOrCreateLeaf(instr.arg1);
      const c2 = instr.arg2 !== null ? this.getOrCreateLeaf(instr.arg2) : null;
      const key = this.exprKey(instr.op, c1, c2);

      let nodeId;
      let isMerge = false;

      if (this.vnMap[key] !== undefined) {
        // CSE: expression already computed — reuse node
        nodeId = this.vnMap[key];
        const existing = this.nodes[nodeId];

        // Remove lhs from old node if it was assigned elsewhere
        const oldId = this.varNode[instr.lhs];
        if (oldId !== undefined && oldId !== nodeId) {
          const oldNode = this.nodes[oldId];
          oldNode.names = oldNode.names.filter(n => n !== instr.lhs);
        }

        if (!existing.names.includes(instr.lhs)) existing.names.push(instr.lhs);
        this.varNode[instr.lhs] = nodeId;
        isMerge = true;
        this.cseFired++;
        step.merged = true;
        step.mergedInto = nodeId;
      } else {
        // New operator node
        nodeId = this.newId();
        const children = c2 !== null ? [c1, c2] : [c1];
        const vn = `vn${nodeId}`;
        this.nodes.push({
          id: nodeId,
          kind: 'op',
          label: instr.op,
          op: instr.op,
          children,
          names: [instr.lhs],
          vn,
          dead: false
        });
        this.vnMap[key] = nodeId;
        this.varNode[instr.lhs] = nodeId;
        step.merged = false;
        step.newNode = nodeId;
      }

      step.type = isMerge ? 'merge' : 'new';
      step.assignedNode = nodeId;
      steps.push(step);
    }

    // Mark dead nodes: operator nodes with no names and not referenced by any living node
    this._markDead();

    return steps;
  }

  _markDead() {
    // A node is dead if it has no names assigned to it AND
    // no other node references it as a child that is itself alive
    const referenced = new Set();
    for (const n of this.nodes) {
      n.children.forEach(c => referenced.add(c));
    }
    for (const n of this.nodes) {
      if (n.kind === 'op' && n.names.length === 0 && !referenced.has(n.id)) {
        n.dead = true;
      }
    }
  }

  generateOptimized(instructions) {
    // Regenerate minimal instruction set from DAG
    const result = [];
    const emitted = new Set();
    const varNode = {};
    const nodeVar = {}; // node id → first temp name generated

    // Topological order: leaves first, then ops in dependency order
    const order = this._topoSort();

    for (const nid of order) {
      const node = this.nodes[nid];
      if (node.dead) continue;
      if (node.kind === 'leaf') {
        // leaves are already defined
        nodeVar[nid] = node.names[0] || node.label;
        continue;
      }
      if (node.kind === 'op') {
        if (emitted.has(nid)) continue;
        const c1name = nodeVar[node.children[0]] || this.nodes[node.children[0]]?.names[0];
        const c2name = node.children[1] !== undefined ? (nodeVar[node.children[1]] || this.nodes[node.children[1]]?.names[0]) : null;
        const destName = node.names[0];
        if (!destName) continue;
        if (c2name !== null && c2name !== undefined) {
          result.push(`${destName} = ${c1name} ${node.op} ${c2name}`);
        } else {
          result.push(`${destName} = ${node.op}${c1name}`);
        }
        nodeVar[nid] = destName;
        emitted.add(nid);
        // additional aliases
        for (let i = 1; i < node.names.length; i++) {
          result.push(`${node.names[i]} = ${destName}`);
        }
      }
    }
    return result;
  }

  _topoSort() {
    const visited = new Set();
    const order = [];
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.nodes[id];
      if (node) node.children.forEach(c => visit(c));
      order.push(id);
    };
    this.nodes.forEach(n => visit(n.id));
    return order;
  }
}

// ═══════════════════════════════════════════
//  CANVAS RENDERER
// ═══════════════════════════════════════════

const canvas = document.getElementById('dag-canvas');
const ctx = canvas.getContext('2d');
let dagNodes = [];
let dagEdges = [];
let showLabels = true;
let animFrame = null;
let panX = 0, panY = 0;
let isDragging = false, dragStartX = 0, dragStartY = 0;
let hoveredNode = null;
let visibleNodeCount = 0;
let builder = null;

const NODE_R = 26;
const COLORS = {
  leaf:   { fill:'#e6f7ff', stroke:'#0070f3', text:'#0070f3', glow:'rgba(0,112,243,.1)' },
  op:     { fill:'#f9f0ff', stroke:'#7b61ff', text:'#7b61ff', glow:'rgba(123,97,255,.1)' },
  root:   { fill:'#fff5f0', stroke:'#fa5d0b', text:'#fa5d0b', glow:'rgba(250,93,11,.1)' },
  dead:   { fill:'#fff1f0', stroke:'#ff4d4f', text:'#ff4d4f', glow:'rgba(255,77,79,.1)' },
  merge:  { fill:'#feffe6', stroke:'#d4b106', text:'#d4b106', glow:'rgba(250,219,20,.1)' },
  active: { fill:'#fff5f0', stroke:'#fa5d0b', text:'#fa5d0b', glow:'rgba(250,93,11,.2)' },
};

function resizeCanvas() {
  const parent = canvas.parentElement;
  if (!parent) return;
  const rect = parent.getBoundingClientRect();
  canvas.width = rect.width;
  // take remaining height above output panel
  const outputPanel = document.getElementById('output-panel');
  const headerEl = document.querySelector('.dag-header');
  const resizerH = document.getElementById('resizer-h');
  const hh = headerEl ? headerEl.getBoundingClientRect().height : 44;
  const oh = outputPanel ? outputPanel.getBoundingClientRect().height : 220;
  const rh = resizerH ? resizerH.getBoundingClientRect().height : 8;
  canvas.height = Math.max(0, rect.height - hh - oh - rh);
}

function layoutNodes(nodes) {
  if (!nodes.length) return;
  // BFS level layout
  const adj = {};
  nodes.forEach(n => { adj[n.id] = []; });
  nodes.forEach(n => n.children.forEach(c => { if(adj[c]) adj[c].push(n.id); }));

  // find roots (no parents)
  const hasParent = new Set();
  nodes.forEach(n => n.children.forEach(c => hasParent.add(c)));
  const roots = nodes.filter(n => !hasParent.has(n.id)).map(n => n.id);

  const levelOf = {};
  const queue = roots.map(r => ({ id: r, lv: 0 }));
  const visited = new Set();
  while (queue.length) {
    const { id, lv } = queue.shift();
    if (visited.has(id)) { levelOf[id] = Math.max(levelOf[id]||0, lv); continue; }
    visited.add(id);
    levelOf[id] = lv;
    const node = nodes.find(n => n.id === id);
    if (node) node.children.forEach(c => queue.push({ id: c, lv: lv + 1 }));
  }

  const maxLv = Math.max(...Object.values(levelOf), 0);
  const byLevel = {};
  nodes.forEach(n => {
    const lv = levelOf[n.id] || 0;
    (byLevel[lv] = byLevel[lv] || []).push(n);
  });

  const W = canvas.width || 600;
  const H = canvas.height || 400;
  const vGap = Math.min(100, (H - 80) / Math.max(maxLv + 1, 1));

  Object.entries(byLevel).forEach(([lv, peers]) => {
    const total = peers.length;
    peers.forEach((n, i) => {
      const spacing = Math.min(110, (W - 80) / Math.max(total, 1));
      const startX = W / 2 - (total - 1) * spacing / 2;
      n.x = startX + i * spacing;
      n.y = 50 + parseInt(lv) * vGap;
      if (!n.vx) n.vx = 0;
      if (!n.vy) n.vy = 0;
    });
  });
}

function drawArrow(x1, y1, x2, y2, color, dashed) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len < 1) return;
  const ux = dx/len, uy = dy/len;
  const sx = x1 + ux * NODE_R, sy = y1 + uy * NODE_R;
  const ex = x2 - ux * NODE_R, ey = y2 - uy * NODE_R;

  ctx.beginPath();
  if (dashed) ctx.setLineDash([4, 4]);
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // arrowhead
  const angle = Math.atan2(ey - sy, ex - sx);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - 9*Math.cos(angle-0.4), ey - 9*Math.sin(angle-0.4));
  ctx.lineTo(ex - 9*Math.cos(angle+0.4), ey - 9*Math.sin(angle+0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawNode(node, alpha) {
  if (!node.x) return;
  const x = node.x + panX, y = node.y + panY;

  let scheme;
  if (node.dead) scheme = COLORS.dead;
  else if (node._isActive) scheme = COLORS.active;
  else if (node._isMerge) scheme = COLORS.merge;
  else if (node.kind === 'leaf') scheme = COLORS.leaf;
  else if (node.names && node.names.length > 0) scheme = COLORS.root;
  else scheme = COLORS.op;

  ctx.save();
  ctx.globalAlpha = alpha;

  // glow
  ctx.beginPath();
  ctx.arc(x, y, NODE_R + 8, 0, Math.PI*2);
  ctx.fillStyle = scheme.glow;
  ctx.fill();

  // circle
  ctx.beginPath();
  ctx.arc(x, y, NODE_R, 0, Math.PI*2);
  ctx.fillStyle = scheme.fill;
  ctx.fill();
  ctx.strokeStyle = scheme.stroke;
  ctx.lineWidth = node === hoveredNode ? 3 : 1.5;
  ctx.stroke();

  // label
  ctx.fillStyle = scheme.text;
  ctx.font = `600 13px 'IBM Plex Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(node.label, x, y);

  // names label below node
  if (showLabels && node.names && node.names.length > 0) {
    const nameStr = node.names.join(', ');
    ctx.font = `400 10px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = scheme.stroke;
    ctx.fillText(nameStr, x, y + NODE_R + 13);
  }

  ctx.restore();
}

function renderDAG() {
  if (!canvas.width || !canvas.height) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // draw edges
  for (let i = 0; i < visibleNodeCount; i++) {
    const node = dagNodes[i];
    if (!node.x) continue;
    node.children.forEach((cid, ci) => {
      const child = dagNodes.find(n => n.id === cid);
      if (!child || !child.x) return;
      const nx = node.x + panX, ny = node.y + panY;
      const cx = child.x + panX, cy = child.y + panY;
      let color;
      if (node.dead || child.dead) color = 'rgba(255,92,106,.3)';
      else if (node._isMerge) color = 'rgba(255,185,56,.5)';
      else color = 'rgba(139,127,248,.5)';
      drawArrow(nx, ny, cx, cy, color, node.dead);
    });
  }

  // draw nodes
  for (let i = 0; i < visibleNodeCount; i++) {
    drawNode(dagNodes[i], dagNodes[i]._alpha || 1);
  }
}

function animate() {
  renderDAG();
  animFrame = requestAnimationFrame(animate);
}

// ═══════════════════════════════════════════
//  ANIMATION ORCHESTRATION
// ═══════════════════════════════════════════

let animRunning = false;
let currentStepIdx = 0;
let stepDivs = [];

const SPEEDS = [900, 600, 380, 200, 50];

async function startAnimation() {
  if (animRunning) return;
  const src = document.getElementById('code-input').value.trim();
  if (!src) return;

  // Reset
  dagNodes = [];
  dagEdges = [];
  visibleNodeCount = 0;
  panX = 0; panY = 0;
  hoveredNode = null;

  const instructions = parseInstructions(src);
  if (!instructions.length) { alert('No valid 3-address instructions found.'); return; }

  builder = new DAGBuilder();
  const steps = builder.build(instructions);

  // Show canvas
  document.getElementById('dag-empty').style.display = 'none';
  canvas.style.display = 'block';
  resizeCanvas();
  layoutNodes(builder.nodes);
  dagNodes = builder.nodes.map(n => ({ ...n, children:[...n.children], names:[...n.names], _alpha:0, _isActive:false, _isMerge:false }));
  visibleNodeCount = 0;

  // Build step list UI
  buildStepList(instructions, steps);

  // Update stats
  document.getElementById('st-orig').textContent = instructions.length;

  animRunning = true;
  const btn = document.getElementById('run-btn');
  btn.classList.add('running');
  btn.textContent = 'Building...';

  const speed = parseInt(document.getElementById('speed').value);
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    highlightStep(si, step);

    // find nodes in this step and reveal them
    if (step.type === 'new' && step.newNode !== undefined) {
      const node = dagNodes.find(n => n.id === step.newNode);
      if (node) {
        node._alpha = 0;
        node._isActive = true;
        visibleNodeCount = Math.max(visibleNodeCount, step.newNode + 1, ...builder.nodes.slice(0, step.newNode+1).map(n=>n.id+1));
        // also ensure leaves are visible
        const instrNode = builder.nodes.find(n=>n.id===step.newNode);
        if (instrNode) instrNode.children.forEach(cid => {
          const cn = dagNodes.find(n=>n.id===cid);
          if(cn) { if(!cn._alpha||cn._alpha<1) cn._alpha=1; visibleNodeCount = Math.max(visibleNodeCount, cid+1); }
        });
        // fade in
        const fadeSteps = 8;
        for (let f = 0; f <= fadeSteps; f++) {
          node._alpha = f / fadeSteps;
          await delay(SPEEDS[speed-1] / fadeSteps);
        }
        node._isActive = false;
      }
    } else if (step.type === 'merge') {
      // flash the merged node
      const node = dagNodes.find(n => n.id === step.mergedInto);
      if (node) {
        node._isMerge = true;
        for (let f = 0; f < 3; f++) {
          await delay(SPEEDS[speed-1] / 4);
        }
        node._isMerge = false;
      }
    } else {
      await delay(SPEEDS[speed-1]);
    }

    await delay(SPEEDS[speed-1] * 0.5);
  }

  // Mark visible count fully
  visibleNodeCount = dagNodes.length;
  layoutNodes(dagNodes);

  // Show dead nodes in red
  dagNodes.forEach(n => { if (n.dead) n._isActive = false; });

  // Finalize stats and output
  finalizeOutput(instructions, steps, builder);

  animRunning = false;
  btn.classList.remove('running');
  btn.innerHTML = `<svg class="run-icon" viewBox="0 0 14 14"><polygon points="1,0 13,7 1,14" fill="currentColor"/></svg> Build DAG &amp; Optimize`;
}

function buildStepList(instructions, steps) {
  const list = document.getElementById('steps-list');
  list.innerHTML = '';
  stepDivs = [];

  steps.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'step-item pending';

    let tag = '';
    const instr = step.instr;

    div.innerHTML = `
      <div class="step-num">${i+1}</div>
      <div style="flex:1">${escHtml(instr.raw)}</div>
    `;
    list.appendChild(div);
    stepDivs.push(div);
  });
}

function highlightStep(idx, step) {
  stepDivs.forEach((d, i) => {
    if (i < idx) {
      const type = steps_cache[i]?.type;
      d.className = 'step-item ' + (type === 'merge' ? 'merged' : 'done');
      // add tag
      if (!d.querySelector('.step-tag')) {
        const tag = document.createElement('span');
        tag.className = 'step-tag ' + (type === 'merge' ? 'tag-cse' : type === 'copy' ? 'tag-copy' : 'tag-new');
        tag.textContent = type === 'merge' ? 'CSE' : type === 'copy' ? 'COPY' : 'NEW';
        d.appendChild(tag);
      }
    }
    if (i === idx) {
      d.className = 'step-item active';
      d.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }
    if (i > idx) d.className = 'step-item pending';
  });
}

let steps_cache = [];

// Override to cache steps
const _origStart = startAnimation;
window.startAnimation = async function() {
  const src = document.getElementById('code-input').value.trim();
  if (!src) return;
  const instructions = parseInstructions(src);
  const tempBuilder = new DAGBuilder();
  steps_cache = tempBuilder.build(instructions);
  await _origStart();
};

function finalizeOutput(instructions, steps, builder) {
  // Stats
  const optimized = builder.generateOptimized(instructions);
  const cseCount = builder.cseFired;
  const deadCount = builder.nodes.filter(n => n.dead).length;
  const reduction = instructions.length > 0 ? Math.round((1 - optimized.length / instructions.length) * 100) : 0;

  document.getElementById('st-opt').textContent = optimized.length;
  document.getElementById('st-cse').textContent = cseCount;
  document.getElementById('st-save').textContent = reduction + '%';

  // IR comparison
  const beforeEl = document.getElementById('out-before');
  const afterEl = document.getElementById('out-after');
  const beforeLines = instructions.map(i => i.raw);
  const afterSet = new Set(optimized);
  const beforeSet = new Set(beforeLines);

  beforeEl.innerHTML = beforeLines.map(l => {
    const removed = !optimized.some(ol => ol.split('=')[0].trim() === l.split('=')[0].trim()) && !optimized.includes(l);
    return `<span class="out-line ${removed ? 'removed' : ''}">${escHtml(l)}</span>`;
  }).join('');

  afterEl.innerHTML = optimized.map(l => {
    const isNew = !beforeSet.has(l);
    return `<span class="out-line ${isNew ? 'added' : ''}">${escHtml(l)}</span>`;
  }).join('');

  // Value number table
  const vnEl = document.getElementById('out-vntable');
  let vnHtml = `<table style="font-family:var(--mono);font-size:11px;border-collapse:collapse;width:100%">
    <tr style="color:var(--text3)">
      <th style="text-align:left;padding:3px 10px;border-bottom:1px solid var(--border)">Instruction</th>
      <th style="text-align:left;padding:3px 10px;border-bottom:1px solid var(--border)">LHS</th>
      <th style="text-align:left;padding:3px 10px;border-bottom:1px solid var(--border)">DAG Node</th>
      <th style="text-align:left;padding:3px 10px;border-bottom:1px solid var(--border)">Value #</th>
      <th style="text-align:left;padding:3px 10px;border-bottom:1px solid var(--border)">Status</th>
    </tr>`;

  steps_cache.forEach((step, i) => {
    const instr = step.instr;
    const nid = step.assignedNode;
    const node = builder.nodes.find(n => n.id === nid);
    const status = step.merged ? `<span style="color:var(--amber)">CSE — reused node ${nid}</span>` :
                   step.type === 'copy' ? `<span style="color:var(--purple)">Copy prop</span>` :
                   `<span style="color:var(--accent)">New node</span>`;
    vnHtml += `<tr style="border-bottom:1px solid rgba(37,44,66,.5)">
      <td style="padding:4px 10px;color:var(--text2)">${escHtml(instr.raw)}</td>
      <td style="padding:4px 10px;color:var(--accent)">${escHtml(instr.lhs)}</td>
      <td style="padding:4px 10px;color:var(--purple)">N${nid}</td>
      <td style="padding:4px 10px;color:var(--blue)">${node ? escHtml(node.vn) : '—'}</td>
      <td style="padding:4px 10px">${status}</td>
    </tr>`;
  });
  vnHtml += '</table>';
  vnEl.innerHTML = vnHtml;

  // Final step states
  stepDivs.forEach((d, i) => {
    const type = steps_cache[i]?.type;
    d.className = 'step-item ' + (type === 'merge' ? 'merged' : type === 'copy' ? 'done' : 'done');
    if (!d.querySelector('.step-tag')) {
      const tag = document.createElement('span');
      if (type === 'merge') { tag.className = 'step-tag tag-cse'; tag.textContent = 'CSE'; }
      else if (type === 'copy') { tag.className = 'step-tag tag-copy'; tag.textContent = 'COPY'; }
      else { tag.className = 'step-tag tag-new'; tag.textContent = 'NEW'; }
      d.appendChild(tag);
    }
  });

  // dead nodes in step list
  builder.nodes.forEach(n => {
    if (n.dead) {
      // find step that created this node
      const si = steps_cache.findIndex(s => s.newNode === n.id);
      if (si >= 0 && stepDivs[si]) {
        stepDivs[si].className = 'step-item dead';
        const existing = stepDivs[si].querySelector('.step-tag');
        if (existing) existing.remove();
        const tag = document.createElement('span');
        tag.className = 'step-tag tag-dead'; tag.textContent = 'DEAD';
        stepDivs[si].appendChild(tag);
      }
    }
  });
}

// ── UI HELPERS ──
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleLabels() {
  showLabels = !showLabels;
  const btn = document.getElementById('btn-labels');
  btn.classList.toggle('on', showLabels);
}

function resetView() { panX = 0; panY = 0; if(dagNodes.length) layoutNodes(dagNodes); }

function switchOutTab(tab) {
  document.getElementById('out-ir').style.display = tab === 'ir' ? 'grid' : 'none';
  document.getElementById('out-vn').style.display = tab === 'vn' ? 'grid' : 'none';
  document.getElementById('otab-ir').classList.toggle('on', tab === 'ir');
  document.getElementById('otab-vn').classList.toggle('on', tab === 'vn');
}

// ── CANVAS INTERACTION ──
canvas.addEventListener('mousedown', e => {
  isDragging = true;
  dragStartX = e.clientX - panX;
  dragStartY = e.clientY - panY;
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('mousemove', e => {
  if (isDragging) {
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left - panX;
  const my = e.clientY - rect.top - panY;
  let found = null;
  for (let i = visibleNodeCount - 1; i >= 0; i--) {
    const n = dagNodes[i];
    if (!n.x) continue;
    const dx = mx - n.x, dy = my - n.y;
    if (dx*dx + dy*dy <= NODE_R*NODE_R) { found = n; break; }
  }
  hoveredNode = found;
  const tip = document.getElementById('tooltip');
  if (found) {
    canvas.style.cursor = 'pointer';
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top  = (e.clientY - 8)  + 'px';
    tip.innerHTML = `<b>Node N${found.id}</b><br>Kind: ${found.kind}<br>Label: ${found.label}<br>Names: ${found.names.join(', ')||'—'}<br>Value#: ${found.vn}<br>Dead: ${found.dead?'Yes':'No'}`;
  } else {
    canvas.style.cursor = isDragging ? 'grabbing' : 'grab';
    tip.style.display = 'none';
  }
});
canvas.addEventListener('mouseup',   () => { isDragging = false; canvas.style.cursor = 'grab'; });
canvas.addEventListener('mouseleave',() => { isDragging = false; document.getElementById('tooltip').style.display='none'; });

// ── RESIZER INTERACTION ──
const resizerH = document.getElementById('resizer-h');
const outputPanel = document.getElementById('output-panel');
const rightPanel = document.getElementById('right-panel');
let isResizingH = false;

resizerH.addEventListener('mousedown', function(e) {
  isResizingH = true;
  document.body.style.cursor = 'ns-resize';
  resizerH.classList.add('active');
  e.preventDefault();
});

document.addEventListener('mousemove', function(e) {
  if (!isResizingH) return;
  const containerRect = rightPanel.getBoundingClientRect();
  const resizerHeight = resizerH.getBoundingClientRect().height;
  const headerHeight = document.querySelector('.dag-header').getBoundingClientRect().height;
  
  let newHeight = containerRect.bottom - e.clientY - (resizerHeight / 2);
  
  if (newHeight < 60) newHeight = 60;
  if (newHeight > containerRect.height - headerHeight - 100) {
    newHeight = containerRect.height - headerHeight - 100;
  }
  
  outputPanel.style.height = newHeight + 'px';
  resizeCanvas();
  
  if (!animRunning) {
    if (dagNodes.length) layoutNodes(dagNodes);
    renderDAG();
  }
});

document.addEventListener('mouseup', function(e) {
  if (isResizingH) {
    isResizingH = false;
    document.body.style.cursor = '';
    resizerH.classList.remove('active');
    resizeCanvas();
    if (!animRunning) {
      if (dagNodes.length) layoutNodes(dagNodes);
      renderDAG();
    }
  }
});

// ── INIT ──
window.addEventListener('load', () => {
  resizeCanvas();
  animate();
});
window.addEventListener('resize', () => {
  resizeCanvas();
  if (dagNodes.length) layoutNodes(dagNodes);
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); window.startAnimation(); }
});