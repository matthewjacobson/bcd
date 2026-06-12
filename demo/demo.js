import { decompose } from "../dist/index.js";

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");

const els = {
  polygon: document.getElementById("polygon"),
  angle: document.getElementById("angle"),
  angleVal: document.getElementById("angle-val"),
  faces: document.getElementById("show-faces"),
  graph: document.getElementById("show-graph"),
  outline: document.getElementById("show-outline"),
  sweep: document.getElementById("show-sweep"),
  nFaces: document.getElementById("n-faces"),
  nVerts: document.getElementById("n-verts"),
  nEdges: document.getElementById("n-edges"),
  nTime: document.getElementById("n-time"),
  err: document.getElementById("err"),
};

let polygons = {}; // name -> { outer, holes }
let current = null; // currently selected { outer, holes }

const toPts = (contour) => contour.map(([x, y]) => ({ x, y }));
const rect = (x0, y0, x1, y1) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/**
 * Hand-built shapes that exercise multiple critical points landing on the same
 * sweep line. Watch the "Faces"/"Graph edges" stats jump as you move the slider
 * off a degenerate angle: when critical points align on one sweep line the holes
 * share a band (fewer cells), just off it you get the generic-position
 * decomposition. Each shape's name flags its most obvious degenerate angle, but
 * a regular layout can be degenerate at several — e.g. the 4×4 grid coincides at
 * 0° *and* 45° (the rotated corners realign). Either way the graph stays
 * connected and reports only real adjacencies — that's the edge case handled.
 */
function buildDemoPolygons() {
  const demos = {};

  // Two holes with aligned left/right edges: at angle 0 both split events (and
  // both merge events) coincide on one sweep line.
  demos["edge · aligned holes (0°)"] = {
    outer: rect(0, 0, 300, 300),
    holes: [rect(100, 40, 200, 120), rect(100, 180, 200, 260)],
  };

  // Three stacked aligned holes — three coincident splits, three coincident merges.
  demos["edge · 3 stacked holes (0°)"] = {
    outer: rect(0, 0, 300, 360),
    holes: [rect(100, 40, 200, 100), rect(100, 150, 200, 210), rect(100, 260, 200, 320)],
  };

  // A fully axis-aligned grid: every column of holes piles critical points onto
  // the same sweep line at angle 0 (the worst case).
  const gridHoles = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x0 = 40 + 80 * i;
      const y0 = 40 + 80 * j;
      gridHoles.push(rect(x0, y0, x0 + 40, y0 + 40));
    }
  }
  demos["edge · hole grid 4×4 (0°)"] = { outer: rect(0, 0, 340, 340), holes: gridHoles };

  // Holes whose centres lie on a 45° sweep line (x + y = 300): the coincidence
  // appears at angle 45°, not 0° — showing it depends on the sweep direction.
  demos["edge · diagonal holes (45°)"] = {
    outer: rect(0, 0, 300, 300),
    holes: [rect(60, 200, 100, 240), rect(130, 130, 170, 170), rect(200, 60, 240, 100)],
  };

  return demos;
}

function addOption(group, name) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name;
  group.appendChild(opt);
}

async function init() {
  const demos = buildDemoPolygons();
  const archive = {};
  const raw = await (await fetch("./polygons.json")).json();
  for (const [name, contours] of Object.entries(raw)) {
    archive[name] = { outer: toPts(contours[0]), holes: contours.slice(1).map(toPts) };
  }
  polygons = { ...demos, ...archive };

  const demoGroup = document.createElement("optgroup");
  demoGroup.label = "Edge-case demos (coincident critical points)";
  for (const name of Object.keys(demos)) addOption(demoGroup, name);
  els.polygon.appendChild(demoGroup);

  const archiveGroup = document.createElement("optgroup");
  archiveGroup.label = "Interesting Polygon Archive";
  for (const name of Object.keys(archive)) addOption(archiveGroup, name);
  els.polygon.appendChild(archiveGroup);

  // Initialise from URL query (?polygon=&angle=&faces=&graph=&outline=&sweep=).
  const q = new URLSearchParams(location.search);
  els.polygon.value = polygons[q.get("polygon")] ? q.get("polygon") : "eberly-14";
  if (q.has("angle")) els.angle.value = q.get("angle");
  const bool = (key, def) => (q.has(key) ? q.get(key) === "1" || q.get(key) === "true" : def);
  els.faces.checked = bool("faces", true);
  els.graph.checked = bool("graph", false);
  els.outline.checked = bool("outline", true);
  els.sweep.checked = bool("sweep", false);
  current = polygons[els.polygon.value];

  const sync = () => {
    const params = new URLSearchParams({
      polygon: els.polygon.value,
      angle: els.angle.value,
      faces: els.faces.checked ? 1 : 0,
      graph: els.graph.checked ? 1 : 0,
      outline: els.outline.checked ? 1 : 0,
      sweep: els.sweep.checked ? 1 : 0,
    });
    history.replaceState(null, "", `?${params}`);
    render();
  };

  els.polygon.addEventListener("change", () => {
    current = polygons[els.polygon.value];
    sync();
  });
  els.angle.addEventListener("input", sync);
  for (const t of [els.faces, els.graph, els.outline, els.sweep]) {
    t.addEventListener("change", sync);
  }
  window.addEventListener("resize", render);
  render();
}

/** Distinct, stable color per face via the golden-angle hue rotation. */
function faceColor(i, alpha) {
  const hue = (i * 137.508) % 360;
  return `hsla(${hue}, 62%, 58%, ${alpha})`;
}

/** Area-weighted centroid of a ring (array of {x,y}). Falls back to mean. */
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const m = ring.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
    return { x: m.x / ring.length, y: m.y / ring.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function boundsOf(polygon) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (ring) => {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  };
  scan(polygon.outer);
  for (const h of polygon.holes) scan(h);
  return { minX, minY, maxX, maxY };
}

function render() {
  if (!current) return;

  const angleDeg = Number(els.angle.value);
  els.angleVal.textContent = `${angleDeg}°`;
  const angle = (angleDeg * Math.PI) / 180;

  // High-DPI sizing.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Decompose (timed).
  let result;
  const t0 = performance.now();
  try {
    result = decompose(current, angle);
    els.err.textContent = "";
  } catch (e) {
    els.err.textContent = String(e.message || e);
    return;
  }
  const elapsed = performance.now() - t0;

  // Fit transform: preserve aspect ratio, flip Y (archive coords are y-down).
  const pad = 36;
  const b = boundsOf(current);
  const bw = Math.max(1e-6, b.maxX - b.minX);
  const bh = Math.max(1e-6, b.maxY - b.minY);
  const scale = Math.min((cssW - 2 * pad) / bw, (cssH - 2 * pad) / bh);
  const offX = (cssW - bw * scale) / 2;
  const offY = (cssH - bh * scale) / 2;
  const sx = (p) => offX + (p.x - b.minX) * scale;
  const sy = (p) => cssH - (offY + (p.y - b.minY) * scale); // flip Y
  const S = (p) => ({ x: sx(p), y: sy(p) });

  const faceRing = (f) => f.map((i) => result.vertices[i]);

  // --- sweep lines (cut direction is perpendicular to the sweep direction) ---
  if (els.sweep.checked) {
    const cx = cssW / 2, cy = cssH / 2;
    const diag = Math.hypot(cssW, cssH);
    // Cut lines are perpendicular to the sweep angle. In screen space Y is
    // flipped, so negate the angle to keep the on-screen direction intuitive.
    const a = -angle;
    const dir = { x: Math.cos(a), y: Math.sin(a) }; // sweep direction
    const perp = { x: -dir.y, y: dir.x }; // along the cut lines
    ctx.strokeStyle = "#3a4255";
    ctx.lineWidth = 1;
    for (let d = -diag; d <= diag; d += 26) {
      const ox = cx + dir.x * d, oy = cy + dir.y * d;
      ctx.beginPath();
      ctx.moveTo(ox - perp.x * diag, oy - perp.y * diag);
      ctx.lineTo(ox + perp.x * diag, oy + perp.y * diag);
      ctx.stroke();
    }
  }

  // --- faces ---
  if (els.faces.checked) {
    ctx.lineJoin = "round";
    for (let i = 0; i < result.faces.length; i++) {
      const ring = faceRing(result.faces[i]);
      ctx.beginPath();
      ring.forEach((p, k) => {
        const s = S(p);
        k === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = faceColor(i, 0.55);
      ctx.fill();
      ctx.strokeStyle = faceColor(i, 0.95);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // --- original outline ---
  if (els.outline.checked) {
    ctx.strokeStyle = els.faces.checked ? "rgba(230,232,238,0.85)" : "#e6e8ee";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    const drawRing = (ring) => {
      ctx.beginPath();
      ring.forEach((p, k) => {
        const s = S(p);
        k === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.stroke();
    };
    drawRing(current.outer);
    for (const h of current.holes) drawRing(h);
  }

  // --- connectivity graph ---
  if (els.graph.checked) {
    const centers = result.faces.map((f) => S(centroid(faceRing(f))));
    ctx.strokeStyle = "rgba(255,209,102,0.85)";
    ctx.lineWidth = 1.8;
    for (const [a, c] of result.graph.edges) {
      ctx.beginPath();
      ctx.moveTo(centers[a].x, centers[a].y);
      ctx.lineTo(centers[c].x, centers[c].y);
      ctx.stroke();
    }
    for (const c of centers) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
      ctx.strokeStyle = "#1a1d27";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // --- sweep direction indicator (bottom-right) ---
  drawSweepArrow(cssW - 54, cssH - 54, 22, -angle);

  // --- stats ---
  els.nFaces.textContent = result.faces.length;
  els.nVerts.textContent = result.vertices.length;
  els.nEdges.textContent = result.graph.edges.length;
  els.nTime.textContent = `${elapsed.toFixed(elapsed < 10 ? 2 : 1)} ms`;
}

function drawSweepArrow(cx, cy, r, a) {
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  ctx.save();
  ctx.strokeStyle = "rgba(93,177,255,0.9)";
  ctx.fillStyle = "rgba(93,177,255,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.stroke();
  const tip = { x: cx + dir.x * r, y: cy + dir.y * r };
  const tail = { x: cx - dir.x * r, y: cy - dir.y * r };
  ctx.strokeStyle = "rgba(93,177,255,0.95)";
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  const ah = 6;
  const left = { x: tip.x - dir.x * ah - dir.y * ah, y: tip.y - dir.y * ah + dir.x * ah };
  const right = { x: tip.x - dir.x * ah + dir.y * ah, y: tip.y - dir.y * ah - dir.x * ah };
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

init().catch((e) => {
  els.err.textContent = `Failed to load: ${e.message || e}`;
});
