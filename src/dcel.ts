import type { Dcel, HalfEdge } from "./types.js";

/**
 * Build a doubly connected edge list from the decomposition's face loops.
 *
 * The raw face loops are not a shared-edge mesh: a cell closed at a split or
 * merge carries the full vertical cut as a single edge, while its neighbours
 * subdivide that cut at the event vertex (and dropped zero-width cells add
 * further breakpoints). Step 1 therefore *normalises* the loops — every
 * (near-)vertical edge is split at each vertex lying in its interior. In the
 * sweep frame every internal seam is exactly vertical, so this is the only
 * place T-junctions can occur; afterwards each undirected internal edge
 * appears in exactly two loops and each boundary edge in exactly one.
 *
 * Step 2 creates twin half-edges for every loop edge, adds a boundary
 * half-edge (face `-1`) for each unmatched edge, and links the boundary
 * half-edges by angular order around their shared vertices, which yields one
 * cycle for the outer boundary and one per hole.
 *
 * @param loops Face vertex loops (CCW, indices into the vertex arrays).
 * @param px/py Vertex coordinates in the rotated sweep frame (seams vertical).
 * @param quantum Coordinate quantum used when vertices were merged.
 * @returns The normalised loops and the DCEL over them.
 */
export function buildDcel(
  loops: number[][],
  px: number[],
  py: number[],
  quantum: number,
): { loops: number[][]; dcel: Dcel } {
  const nV = px.length;
  const bucket = (v: number): number => Math.round(v / quantum);

  // Vertices grouped by quantised x, sorted by y, for locating the vertices
  // that lie on a given vertical edge.
  const byX = new Map<number, number[]>();
  for (let i = 0; i < nV; i++) {
    const k = bucket(px[i]);
    const list = byX.get(k);
    if (list) list.push(i);
    else byX.set(k, [i]);
  }
  for (const list of byX.values()) list.sort((a, b) => py[a] - py[b]);

  /** Vertices with x within ~quantum of `x` and y strictly inside (yLo, yHi). */
  const verticesOn = (x: number, yLo: number, yHi: number): number[] => {
    const out: number[] = [];
    const k = bucket(x);
    for (let kk = k - 1; kk <= k + 1; kk++) {
      const list = byX.get(kk);
      if (!list) continue;
      // Binary search for the first vertex above yLo.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (py[list[mid]] <= yLo) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < list.length && py[list[i]] < yHi; i++) {
        if (Math.abs(px[list[i]] - x) <= 2 * quantum) out.push(list[i]);
      }
    }
    return out;
  };

  // Cyclically remove consecutive duplicate vertices and zero-width spikes
  // (`u,v,u` backtracks). At degenerate sweep angles a cell born at a split
  // whose outgoing edge is vertical traces that edge even though it belongs to
  // the neighbouring region, leaving a spike in the ring; once normalisation
  // has inserted the T-junction vertices, such spikes become exact backtracks
  // and can be collapsed away.
  const collapseLoop = (loop: number[]): number[] => {
    const l = [...loop];
    let changed = true;
    while (changed && l.length > 2) {
      changed = false;
      for (let i = 0; i < l.length && l.length > 2; ) {
        const n = l.length;
        const before = l[(i - 1 + n) % n];
        if (before === l[i] || before === l[(i + 1) % n]) {
          // Duplicate neighbour, or a spike tip whose removal leaves one.
          l.splice(i, 1);
          changed = true;
          if (i > 0) i--; // re-check the joint we just created
        } else {
          i++;
        }
      }
    }
    return l;
  };

  // --- Step 1: normalise the loops.
  const norm: number[][] = loops.map((loop) => {
    const out: number[] = [];
    const m = loop.length;
    for (let i = 0; i < m; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % m];
      out.push(a);
      if (Math.abs(px[a] - px[b]) > 2 * quantum) continue; // not a vertical edge
      const yLo = Math.min(py[a], py[b]) + quantum;
      const yHi = Math.max(py[a], py[b]) - quantum;
      if (yHi <= yLo) continue;
      const inside = verticesOn((px[a] + px[b]) / 2, yLo, yHi);
      if (py[b] < py[a]) inside.reverse(); // emit along the edge's direction
      for (const v of inside) if (v !== a && v !== b) out.push(v);
    }
    return collapseLoop(out);
  });

  return {
    loops: norm,
    dcel: linkHalfEdges(
      norm,
      norm.map((_l, i) => i),
      norm.length,
      nV,
      px,
      py,
    ),
  };
}

/**
 * Build the half-edge structure over a set of face loops that already share
 * their edges exactly (no T-junctions left to resolve).
 *
 * Twin half-edges are created for every directed loop edge; unmatched edges get
 * a boundary twin on face `-1`, and those are linked by angular order around
 * their shared vertices, which yields one cycle for the outer boundary and one
 * per hole.
 *
 * @param loops Vertex loops, counter-clockwise for a face's outer boundary and
 *   clockwise for an inner one.
 * @param loopFace Face index each loop belongs to. A face's first loop is its
 *   outer boundary; any further loops are inner cycles, which is how an annular
 *   radial cell is described.
 * @param faceCount Number of faces.
 * @param nV Number of vertices.
 * @param px/py Vertex coordinates used only to order edges around a vertex, so
 *   any frame with the same orientation will do.
 */
export function linkHalfEdges(
  loops: number[][],
  loopFace: number[],
  faceCount: number,
  nV: number,
  px: number[],
  py: number[],
): Dcel {
  const halfEdges: HalfEdge[] = [];
  const faceEdge: number[] = new Array(faceCount).fill(-1);
  const faceInnerEdges: number[][] = Array.from({ length: faceCount }, () => []);
  const dir = new Map<string, number>();
  for (let l = 0; l < loops.length; l++) {
    const loop = loops[l];
    const f = loopFace[l];
    const m = loop.length;
    const base = halfEdges.length;
    if (faceEdge[f] === -1) faceEdge[f] = base;
    else faceInnerEdges[f].push(base);
    for (let i = 0; i < m; i++) {
      dir.set(`${loop[i]},${loop[(i + 1) % m]}`, base + i);
      halfEdges.push({
        origin: loop[i],
        twin: -1,
        next: base + ((i + 1) % m),
        prev: base + ((i - 1 + m) % m),
        face: f,
      });
    }
  }
  const interiorCount = halfEdges.length;
  for (let h = 0; h < interiorCount; h++) {
    if (halfEdges[h].twin !== -1) continue;
    const a = halfEdges[h].origin;
    const b = halfEdges[halfEdges[h].next].origin;
    const t = dir.get(`${b},${a}`);
    if (t !== undefined) {
      halfEdges[h].twin = t;
      halfEdges[t].twin = h;
    }
  }
  // Unmatched edges bound the unbounded face: create their boundary twins.
  for (let h = 0; h < interiorCount; h++) {
    if (halfEdges[h].twin !== -1) continue;
    const b = halfEdges[halfEdges[h].next].origin;
    halfEdges[h].twin = halfEdges.length;
    halfEdges.push({ origin: b, twin: h, next: -1, prev: -1, face: -1 });
  }

  // Link boundary half-edges: entering a vertex along g, leave along the
  // outgoing half-edge immediately clockwise of g's twin. Interior loops
  // already satisfy this rule, so applying it to the boundary stitches the
  // unbounded face's cycles consistently with them.
  const outAt = new Map<number, number[]>();
  for (let h = 0; h < halfEdges.length; h++) {
    const list = outAt.get(halfEdges[h].origin);
    if (list) list.push(h);
    else outAt.set(halfEdges[h].origin, [h]);
  }
  const angleOf = (h: number): number => {
    const o = halfEdges[h].origin;
    const d = halfEdges[halfEdges[h].twin].origin;
    return Math.atan2(py[d] - py[o], px[d] - px[o]);
  };
  const sorted = new Set<number>();
  for (let g = interiorCount; g < halfEdges.length; g++) {
    const t = halfEdges[g].twin;
    const v = halfEdges[t].origin; // destination of g
    const outs = outAt.get(v) as number[];
    if (!sorted.has(v)) {
      outs.sort((h1, h2) => angleOf(h1) - angleOf(h2));
      sorted.add(v);
    }
    const i = outs.indexOf(t);
    const nxt = outs[(i - 1 + outs.length) % outs.length];
    halfEdges[g].next = nxt;
    halfEdges[nxt].prev = g;
  }

  const boundaryCycles: number[] = [];
  const seen = new Set<number>();
  for (let g = interiorCount; g < halfEdges.length; g++) {
    if (seen.has(g)) continue;
    boundaryCycles.push(g);
    let cur = g;
    while (cur !== -1 && !seen.has(cur)) {
      seen.add(cur);
      cur = halfEdges[cur].next;
    }
  }

  const vertexEdge: number[] = Array.from({ length: nV }, () => -1);
  for (let h = 0; h < halfEdges.length; h++) {
    if (vertexEdge[halfEdges[h].origin] === -1) vertexEdge[halfEdges[h].origin] = h;
  }

  const dcel: Dcel = { halfEdges, faceEdge, vertexEdge, boundaryCycles };
  if (faceInnerEdges.some((l) => l.length > 0)) dcel.faceInnerEdges = faceInnerEdges;
  return dcel;
}
