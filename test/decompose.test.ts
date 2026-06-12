import { describe, expect, it } from "vitest";
import { decompose } from "../src/index.js";
import { signedArea } from "../src/geometry.js";
import type { DecompositionResult, Point, Polygon } from "../src/types.js";

function pts(coords: Array<[number, number]>): Point[] {
  return coords.map(([x, y]) => ({ x, y }));
}

function faceRing(result: DecompositionResult, faceIndex: number): Point[] {
  return result.faces[faceIndex].map((i) => result.vertices[i]);
}

function totalArea(result: DecompositionResult): number {
  return result.faces.reduce((sum, _f, i) => sum + Math.abs(signedArea(faceRing(result, i))), 0);
}

function expectedArea(polygon: Polygon): number {
  let area = Math.abs(signedArea(polygon.outer));
  for (const hole of polygon.holes ?? []) area -= Math.abs(signedArea(hole));
  return area;
}

/** Adjacency must be symmetric and reference only valid faces. */
function assertGraphConsistent(result: DecompositionResult): void {
  const { adjacency, edges } = result.graph;
  expect(adjacency.length).toBe(result.faces.length);
  for (let i = 0; i < adjacency.length; i++) {
    for (const j of adjacency[i]) {
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(result.faces.length);
      expect(adjacency[j]).toContain(i);
    }
  }
  for (const [a, b] of edges) {
    expect(a).toBeLessThan(b);
    expect(adjacency[a]).toContain(b);
    expect(adjacency[b]).toContain(a);
  }
}

/** Faces should be simple loops of at least 3 distinct vertices. */
function assertFacesWellFormed(result: DecompositionResult): void {
  for (const face of result.faces) {
    expect(face.length).toBeGreaterThanOrEqual(3);
    expect(new Set(face).size).toBe(face.length);
  }
}

const square: Polygon = {
  outer: pts([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]),
};

const squareWithHole: Polygon = {
  outer: pts([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]),
  holes: [
    pts([
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ]),
  ],
};

// Non-convex "plus"/cross shape with reflex vertices.
const plus: Polygon = {
  outer: pts([
    [3, 0],
    [6, 0],
    [6, 3],
    [9, 3],
    [9, 6],
    [6, 6],
    [6, 9],
    [3, 9],
    [3, 6],
    [0, 6],
    [0, 3],
    [3, 3],
  ]),
};

describe("decompose – basic invariants", () => {
  const cases: Array<{ name: string; polygon: Polygon; angle: number }> = [];
  for (const angle of [0, 0.3, Math.PI / 4, 1.1, -0.7]) {
    cases.push({ name: `square @ ${angle}`, polygon: square, angle });
    cases.push({ name: `square+hole @ ${angle}`, polygon: squareWithHole, angle });
    cases.push({ name: `plus @ ${angle}`, polygon: plus, angle });
  }

  for (const { name, polygon, angle } of cases) {
    it(`${name}: area is conserved, faces & graph well-formed`, () => {
      const result = decompose(polygon, angle);
      expect(result.faces.length).toBeGreaterThanOrEqual(1);
      expect(totalArea(result)).toBeCloseTo(expectedArea(polygon), 6);
      assertFacesWellFormed(result);
      assertGraphConsistent(result);
    });
  }
});

describe("decompose – cell structure", () => {
  it("a convex square is a single cell with no adjacency", () => {
    const result = decompose(square, 0.3);
    expect(result.faces.length).toBe(1);
    expect(result.graph.edges.length).toBe(0);
    expect(totalArea(result)).toBeCloseTo(100, 6);
  });

  it("a square with a square hole splits into 4 cells", () => {
    const result = decompose(squareWithHole, 0.3);
    expect(result.faces.length).toBe(4);
    // One split (2 adjacencies) + one merge (2 adjacencies) = 4 edges.
    expect(result.graph.edges.length).toBe(4);
    expect(totalArea(result)).toBeCloseTo(96, 6);
    assertGraphConsistent(result);

    // The graph is a 4-cycle/diamond: two faces of degree 1-ish at the ends.
    const degrees = result.graph.adjacency.map((a) => a.length).sort();
    expect(degrees).toEqual([2, 2, 2, 2]);
  });

  it("the plus shape decomposes into multiple connected cells", () => {
    const result = decompose(plus, 0);
    expect(result.faces.length).toBeGreaterThan(1);
    // The connectivity graph should be connected (single component).
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of result.graph.adjacency[cur]) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    expect(seen.size).toBe(result.faces.length);
  });
});

describe("decompose – robustness", () => {
  it("is rotation invariant in face count for the hole case", () => {
    const counts = [0.1, 0.5, 1.0, 2.0, 3.0].map((a) => decompose(squareWithHole, a).faces.length);
    for (const c of counts) expect(c).toBe(4);
  });

  it("accepts either winding order for the outer ring", () => {
    const cw: Polygon = { outer: [...square.outer].reverse() };
    const result = decompose(cw, 0.3);
    expect(result.faces.length).toBe(1);
    expect(totalArea(result)).toBeCloseTo(100, 6);
  });

  it("throws on a degenerate outer ring", () => {
    expect(() => decompose({ outer: pts([[0, 0], [1, 1]]) }, 0)).toThrow();
  });

  it("produces counter-clockwise faces", () => {
    const result = decompose(squareWithHole, 0.3);
    for (let i = 0; i < result.faces.length; i++) {
      expect(signedArea(faceRing(result, i))).toBeGreaterThan(0);
    }
  });
});

function connected(result: DecompositionResult): boolean {
  const adj = result.graph.adjacency;
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nb of adj[cur]) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return seen.size === result.faces.length;
}

/**
 * Geometric ground truth for adjacency: two faces are adjacent iff they share a
 * boundary segment of positive length (in BCD every internal seam is such a
 * shared segment). Independent of how the algorithm tracks connectivity, so it
 * catches both phantom edges and missing ones.
 */
function geometricallyAdjacent(f1: Point[], f2: Point[]): boolean {
  const cross = (o: Point, p: Point, q: Point): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const overlaps = (a: Point, b: Point, c: Point, d: Point): boolean => {
    const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1);
    if (Math.abs(cross(a, b, c)) > 1e-4 * len || Math.abs(cross(a, b, d)) > 1e-4 * len) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = (p: Point): number => (Math.abs(dx) > Math.abs(dy) ? (p.x - a.x) / dx : (p.y - a.y) / dy);
    const lo = Math.min(t(c), t(d));
    const hi = Math.max(t(c), t(d));
    return Math.min(1, hi) - Math.max(0, lo) > 1e-4;
  };
  for (let i = 0; i < f1.length; i++) {
    const a = f1[i];
    const b = f1[(i + 1) % f1.length];
    for (let j = 0; j < f2.length; j++) {
      const c = f2[j];
      const d = f2[(j + 1) % f2.length];
      if (overlaps(a, b, c, d)) return true;
    }
  }
  return false;
}

/** The reported graph must match geometric adjacency exactly — no phantom or missing edges. */
function assertGraphMatchesGeometry(result: DecompositionResult): void {
  const rings = result.faces.map((_f, i) => faceRing(result, i));
  const reported = new Set(result.graph.edges.map(([a, b]) => `${a}_${b}`));
  for (const [a, b] of result.graph.edges) {
    expect(geometricallyAdjacent(rings[a], rings[b])).toBe(true); // no phantom edges
  }
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (geometricallyAdjacent(rings[i], rings[j])) {
        expect(reported.has(`${i}_${j}`)).toBe(true); // no missing edges
      }
    }
  }
}

describe("decompose – coincident critical points on one sweep line", () => {
  // Two holes whose left (and right) edges share an x-coordinate: at angle 0
  // both split events — and both merge events — land on the same sweep line.
  // A zero-width pass-through cell is produced and dropped; its connections must
  // survive via contraction so the graph stays correct and connected.
  const stackedHoles: Polygon = {
    outer: pts([[0, 0], [10, 0], [10, 10], [0, 10]]),
    holes: [
      pts([[4, 1], [6, 1], [6, 3], [4, 3]]),
      pts([[4, 5], [6, 5], [6, 7], [4, 7]]),
    ],
  };

  it("keeps the graph connected and area conserved at the degenerate angle", () => {
    const result = decompose(stackedHoles, 0);
    expect(totalArea(result)).toBeCloseTo(100 - 4 - 4, 6);
    expect(connected(result)).toBe(true);
    assertGraphConsistent(result);
    // left cell + 3 bands (below A / between / above B) + right cell.
    expect(result.faces.length).toBe(5);
    // each band joins the left and right cell -> 3 + 3 adjacencies.
    expect(result.graph.edges.length).toBe(6);
  });

  it("matches the perturbed (generic-position) result everywhere else", () => {
    for (const angle of [0.0001, 0.3, Math.PI / 2]) {
      const result = decompose(stackedHoles, angle);
      expect(totalArea(result)).toBeCloseTo(92, 6);
      expect(connected(result)).toBe(true);
      assertGraphConsistent(result);
    }
  });

  it("handles a fully axis-aligned grid of holes at angle 0", () => {
    const k = 6;
    const span = 3 * k + 1;
    const outer = pts([[0, 0], [span, 0], [span, span], [0, span]]);
    const holes: Point[][] = [];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const x0 = 3 * i + 1;
        const y0 = 3 * j + 1;
        holes.push(pts([[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 1], [x0, y0 + 1]]));
      }
    }
    const result = decompose({ outer, holes }, 0);
    expect(totalArea(result)).toBeCloseTo(span * span - k * k, 4);
    expect(connected(result)).toBe(true);
    assertGraphConsistent(result);
    assertGraphMatchesGeometry(result);
  });

  // Regression: a regular axis-aligned grid swept at 45° rotates every hole into
  // a diamond, and the regular spacing makes those diamond corners coincide on
  // shared sweep lines — so merge and split events pile onto the same x, creating
  // zero-area pass-through cells. Contracting them used to cross-connect every
  // upstream cell to every downstream cell, producing phantom graph edges between
  // faces that don't actually touch. The seam-interval intersection fixes it.
  it("does not produce phantom adjacencies on a grid swept at 45°", () => {
    const rect = (x0: number, y0: number, x1: number, y1: number): Point[] =>
      pts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    const holes: Point[][] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const x0 = 40 + 80 * i;
        const y0 = 40 + 80 * j;
        holes.push(rect(x0, y0, x0 + 40, y0 + 40));
      }
    }
    const result = decompose({ outer: rect(0, 0, 340, 340), holes }, Math.PI / 4);
    expect(totalArea(result)).toBeCloseTo(340 * 340 - 16 * 40 * 40, 3);
    expect(connected(result)).toBe(true);
    assertGraphConsistent(result);
    assertGraphMatchesGeometry(result);
  });

  it("matches geometric adjacency across a sweep of angles", () => {
    for (const angle of [0, 0.0001, 0.3, Math.PI / 4, Math.PI / 3, Math.PI / 2]) {
      assertGraphMatchesGeometry(decompose(stackedHoles, angle));
    }
  });
});
