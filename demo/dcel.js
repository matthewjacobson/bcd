import { decompose } from "../dist/index.js";

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");

const els = {
  polygon: document.getElementById("polygon"),
  angle: document.getElementById("angle"),
  angleVal: document.getElementById("angle-val"),
  faces: document.getElementById("show-faces"),
  cycles: document.getElementById("show-cycles"),
  verts: document.getElementById("show-verts"),
  info: document.getElementById("hover-info"),
  nHe: document.getElementById("n-he"),
  nFaces: document.getElementById("n-faces"),
  nCycles: document.getElementById("n-cycles"),
  nEuler: document.getElementById("n-euler"),
  err: document.getElementById("err"),
};

const rect = (x0, y0, x1, y1) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const pts = (coords) => coords.map(([x, y]) => ({ x, y }));

const polygons = {
  "plus (T-junctions @ 0°)": {
    outer: pts([[90, 0], [180, 0], [180, 90], [270, 90], [270, 180], [180, 180], [180, 270], [90, 270], [90, 180], [0, 180], [0, 90], [90, 90]]),
    holes: [],
  },
  "square + hole": {
    outer: rect(0, 0, 300, 300),
    holes: [rect(120, 120, 180, 180)],
  },
  "aligned holes (0°)": {
    outer: rect(0, 0, 300, 300),
    holes: [rect(100, 40, 200, 120), rect(100, 180, 200, 260)],
  },
  "diagonal holes (45°)": {
    outer: rect(0, 0, 300, 300),
    holes: [rect(60, 200, 100, 240), rect(130, 130, 170, 170), rect(200, 60, 240, 100)],
  },
  "comb": {
    outer: pts([[0, 0], [320, 0], [320, 200], [260, 200], [260, 60], [200, 60], [200, 200], [140, 200], [140, 60], [80, 60], [80, 200], [0, 200]]),
    holes: [],
  },
};

let current = null;
let result = null; // cached decomposition (recomputed on control change)
let view = null; // cached fit transform
let hover = null; // { kind: "vertex"|"edge"|"face", ... }
let urlHover = null; // hover requested via ?hover=…, until the pointer takes over
let mouse = null; // screen coords

function faceColor(i, alpha) {
  const hue = (i * 137.508) % 360;
  return `hsla(${hue}, 62%, 58%, ${alpha})`;
}
const cycleColor = (i, alpha = 1) =>
  i === 0 ? `rgba(230,232,238,${alpha})` : `hsla(${(45 + i * 67) % 360}, 80%, 66%, ${alpha})`;

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

function recompute() {
  const angle = (Number(els.angle.value) * Math.PI) / 180;
  els.angleVal.textContent = `${els.angle.value}°`;
  try {
    result = decompose(current, angle, { dcel: true });
    els.err.textContent = "";
  } catch (e) {
    els.err.textContent = String(e.message || e);
    result = null;
    return;
  }
  const { halfEdges, boundaryCycles } = result.dcel;
  const used = new Set();
  for (const face of result.faces) for (const v of face) used.add(v);
  const V = used.size;
  const E = halfEdges.length / 2;
  const F = result.faces.length + boundaryCycles.length;
  els.nHe.textContent = halfEdges.length;
  els.nFaces.textContent = result.faces.length;
  els.nCycles.textContent = boundaryCycles.length;
  els.nEuler.textContent = `${V - E + F}${V - E + F === 2 ? " ✓" : " ✗"}`;
  hover = null;
  // Re-apply a deep-linked highlight (?hover=face:1 | edge:12 | vertex:3)
  // until the pointer takes over.
  if (urlHover) {
    const [kind, idx] = urlHover.split(":");
    const n = Number(idx);
    if (kind === "face" && n >= 0 && n < result.faces.length) hover = { kind, f: n };
    else if (kind === "edge" && n >= 0 && n < result.dcel.halfEdges.length) hover = { kind, h: n };
    else if (kind === "vertex" && n >= 0 && n < result.vertices.length) hover = { kind, v: n };
  }
}

function fit() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (ring) => {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  };
  scan(current.outer);
  for (const h of current.holes) scan(h);
  const pad = 44;
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const scale = Math.min((cssW - 2 * pad) / bw, (cssH - 2 * pad) / bh);
  const offX = (cssW - bw * scale) / 2;
  const offY = (cssH - bh * scale) / 2;
  view = {
    cssW,
    cssH,
    toScreen: (p) => ({ x: offX + (p.x - minX) * scale, y: cssH - (offY + (p.y - minY) * scale) }),
    toWorld: (s) => ({ x: minX + (s.x - offX) / scale, y: minY + (cssH - s.y - offY) / scale }),
  };
}

// --- DCEL helpers -----------------------------------------------------------

const he = (h) => result.dcel.halfEdges[h];
const origin = (h) => result.vertices[he(h).origin];
const dest = (h) => result.vertices[he(he(h).twin).origin];
const faceName = (f) => (f === -1 ? "−1 (boundary)" : String(f));

/** All half-edge indices of the cycle starting at h (following next). */
function cycle(h) {
  const out = [];
  let cur = h;
  do {
    out.push(cur);
    cur = he(cur).next;
  } while (cur !== h && out.length <= result.dcel.halfEdges.length);
  return out;
}

/** Outgoing half-edges around a vertex, via the twin→next orbit. */
function orbit(v) {
  const out = [];
  const start = result.dcel.vertexEdge[v];
  if (start === -1) return out;
  let h = start;
  do {
    out.push(h);
    h = he(he(h).twin).next;
  } while (h !== start && out.length <= result.dcel.halfEdges.length);
  return out;
}

// --- picking ----------------------------------------------------------------

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pick(screen) {
  if (!result) return null;
  const world = view.toWorld(screen);
  const { halfEdges, vertexEdge } = result.dcel;

  // 1. Vertex within 9 px.
  let bestV = -1, bestVd = 9;
  for (let v = 0; v < result.vertices.length; v++) {
    if (vertexEdge[v] === -1) continue;
    const s = view.toScreen(result.vertices[v]);
    const d = Math.hypot(s.x - screen.x, s.y - screen.y);
    if (d < bestVd) { bestVd = d; bestV = v; }
  }
  if (bestV !== -1) return { kind: "vertex", v: bestV };

  // 2. Half-edge within 7 px; of the twin pair, pick the one whose face side
  //    (its left, in world coords) the pointer is on.
  let bestH = -1, bestHd = 7;
  for (let h = 0; h < halfEdges.length; h++) {
    if (halfEdges[h].face === -1) continue; // consider interior of each pair; twin picked below
    const a = view.toScreen(origin(h));
    const b = view.toScreen(dest(h));
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((screen.x - a.x) * dx + (screen.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(a.x + t * dx - screen.x, a.y + t * dy - screen.y);
    if (d < bestHd) { bestHd = d; bestH = h; }
  }
  if (bestH !== -1) {
    const a = origin(bestH), b = dest(bestH);
    const side = (b.x - a.x) * (world.y - a.y) - (b.y - a.y) * (world.x - a.x);
    return { kind: "edge", h: side >= 0 ? bestH : he(bestH).twin };
  }

  // 3. Face containing the pointer.
  for (let f = 0; f < result.faces.length; f++) {
    if (pointInRing(world, result.faces[f].map((i) => result.vertices[i]))) {
      return { kind: "face", f };
    }
  }
  return null;
}

// --- drawing ----------------------------------------------------------------

/** Screen segment of half-edge h, offset a few px toward its own face side. */
function heSegment(h, offset = 3.5, shrink = 6) {
  const a = view.toScreen(origin(h));
  const b = view.toScreen(dest(h));
  let dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  // Offset toward the half-edge's own face: world-left of its direction, which
  // is (dy, -dx) in screen coords because the y-flip mirrors handedness.
  const ox = dy * offset, oy = -dx * offset;
  const s = Math.min(shrink, len * 0.25);
  return {
    a: { x: a.x + dx * s + ox, y: a.y + dy * s + oy },
    b: { x: b.x - dx * s + ox, y: b.y - dy * s + oy },
  };
}

function drawArrow(seg, color, width = 2, dash = null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(seg.a.x, seg.a.y);
  ctx.lineTo(seg.b.x, seg.b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const tipT = 0.62;
  const tip = { x: seg.a.x + dx * tipT, y: seg.a.y + dy * tipT };
  const ah = Math.min(7, len * 0.3);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - ux * ah - uy * ah * 0.6, tip.y - uy * ah + ux * ah * 0.6);
  ctx.lineTo(tip.x - ux * ah + uy * ah * 0.6, tip.y - uy * ah - ux * ah * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function label(text, x, y, color = "#e6e8ee") {
  ctx.save();
  ctx.font = "11px ui-monospace, Menlo, monospace";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(15,17,23,0.85)";
  ctx.fillRect(x - w / 2 - 3, y - 8, w + 6, 15);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
  ctx.restore();
}

function info(html) {
  els.info.innerHTML = html;
}

function render() {
  if (!result || !view) return;
  ctx.clearRect(0, 0, view.cssW, view.cssH);
  const { halfEdges, boundaryCycles } = result.dcel;
  const faceRing = (f) => result.faces[f].map((i) => result.vertices[i]);

  // Faces.
  if (els.faces.checked) {
    ctx.lineJoin = "round";
    for (let f = 0; f < result.faces.length; f++) {
      const ring = faceRing(f);
      ctx.beginPath();
      ring.forEach((p, k) => {
        const s = view.toScreen(p);
        k === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      const hovered = hover?.kind === "face" && hover.f === f;
      ctx.fillStyle = faceColor(f, hovered ? 0.42 : 0.18);
      ctx.fill();
      ctx.strokeStyle = faceColor(f, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
      const c = view.toScreen(centroid(ring));
      label(`f${f}`, c.x, c.y, faceColor(f, 1));
    }
  }

  // Boundary cycles of the unbounded face (outer + one per hole).
  if (els.cycles.checked) {
    for (let i = 0; i < boundaryCycles.length; i++) {
      const color = cycleColor(i, 0.8);
      for (const h of cycle(boundaryCycles[i])) {
        drawArrow(heSegment(h, 4.5), color, 1.4, [5, 4]);
      }
    }
  }

  // DCEL vertices.
  if (els.verts.checked) {
    ctx.fillStyle = "rgba(230,232,238,0.75)";
    for (let v = 0; v < result.vertices.length; v++) {
      if (result.dcel.vertexEdge[v] === -1) continue;
      const s = view.toScreen(result.vertices[v]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Hover highlights.
  if (hover?.kind === "face") {
    const cyc = cycle(result.dcel.faceEdge[hover.f]);
    cyc.forEach((h, k) => {
      const shade = `hsla(${(hover.f * 137.508) % 360}, 90%, ${72 - (28 * k) / cyc.length}%, 1)`;
      drawArrow(heSegment(h), shade, 2.4);
    });
    const start = view.toScreen(origin(cyc[0]));
    label("start", start.x, start.y - 12);
    const neighbours = [...new Set(cyc.map((h) => halfEdges[halfEdges[h].twin].face))];
    info(
      `<span class="k">face</span> <span class="a">${hover.f}</span>` +
        `\n<span class="k">cycle</span> ${cyc.length} half-edges (CCW via next)` +
        `\n<span class="k">faceEdge</span> he ${result.dcel.faceEdge[hover.f]}` +
        `\n<span class="k">twin faces</span> ${neighbours.map(faceName).join(", ")}`,
    );
  } else if (hover?.kind === "edge") {
    const h = hover.h;
    const t = halfEdges[h].twin;
    drawArrow(heSegment(h), "#5db1ff", 3);
    drawArrow(heSegment(t), "#ff9e64", 3);
    const mid = heSegment(h, 14);
    label(`he ${h}`, (mid.a.x + mid.b.x) / 2, (mid.a.y + mid.b.y) / 2, "#5db1ff");
    const midT = heSegment(t, 14);
    label(`he ${t}`, (midT.a.x + midT.b.x) / 2, (midT.a.y + midT.b.y) / 2, "#ff9e64");
    info(
      `<span class="a">half-edge ${h}</span>` +
        `\n<span class="k">origin→dest</span> v${halfEdges[h].origin} → v${halfEdges[t].origin}` +
        `\n<span class="k">face</span> ${faceName(halfEdges[h].face)}` +
        `\n<span class="k">next / prev</span> he ${halfEdges[h].next} / he ${halfEdges[h].prev}` +
        `\n<span class="t">twin ${t}</span> <span class="k">face</span> ${faceName(halfEdges[t].face)}`,
    );
  } else if (hover?.kind === "vertex") {
    const v = hover.v;
    const orb = orbit(v);
    const s = view.toScreen(result.vertices[v]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "#5db1ff";
    ctx.lineWidth = 2;
    ctx.stroke();
    orb.forEach((h, k) => {
      drawArrow(heSegment(h, 3.5, 8), `hsla(${(200 + (140 * k) / orb.length) % 360}, 85%, 65%, 1)`, 2.4);
      const seg = heSegment(h, 16, 8);
      const mx = seg.a.x + (seg.b.x - seg.a.x) * 0.45;
      const my = seg.a.y + (seg.b.y - seg.a.y) * 0.45;
      label(String(k + 1), mx, my);
    });
    const p = result.vertices[v];
    info(
      `<span class="a">vertex ${v}</span> <span class="k">(${p.x.toFixed(1)}, ${p.y.toFixed(1)})</span>` +
        `\n<span class="k">degree</span> ${orb.length}` +
        `\n<span class="k">orbit (twin→next)</span>\n${orb
          .map((h, k) => `  ${k + 1}. he ${h} → face ${faceName(halfEdges[h].face)}`)
          .join("\n")}`,
    );
  } else {
    info(
      `<span class="k">Move the pointer over the drawing.\n\nHover a face to walk its half-edge cycle\nvia next, an edge to see its twin pair,\na vertex to orbit it via twin→next.</span>`,
    );
  }
}

// --- wiring -----------------------------------------------------------------

function fullUpdate() {
  fit();
  recompute();
  render();
}

function init() {
  for (const name of Object.keys(polygons)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    els.polygon.appendChild(opt);
  }
  const q = new URLSearchParams(location.search);
  els.polygon.value = polygons[q.get("polygon")] ? q.get("polygon") : "plus (T-junctions @ 0°)";
  if (q.has("angle")) els.angle.value = q.get("angle");
  current = polygons[els.polygon.value];

  const sync = () => {
    const params = new URLSearchParams({ polygon: els.polygon.value, angle: els.angle.value });
    history.replaceState(null, "", `?${params}`);
    fullUpdate();
  };
  els.polygon.addEventListener("change", () => {
    current = polygons[els.polygon.value];
    sync();
  });
  els.angle.addEventListener("input", sync);
  for (const t of [els.faces, els.cycles, els.verts]) t.addEventListener("change", render);
  window.addEventListener("resize", fullUpdate);

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    urlHover = null;
    hover = pick(mouse);
    render();
  });
  canvas.addEventListener("mouseleave", () => {
    hover = null;
    render();
  });

  urlHover = q.get("hover");
  fullUpdate();
}

init();
