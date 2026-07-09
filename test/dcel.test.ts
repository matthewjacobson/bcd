import { describe, expect, it } from "vitest";
import { decompose } from "../src/index.js";
import { signedArea } from "../src/geometry.js";
import type { Dcel, DecompositionResult, Point, Polygon } from "../src/types.js";

function pts(coords: Array<[number, number]>): Point[] {
  return coords.map(([x, y]) => ({ x, y }));
}
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] =>
  pts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/** Structural DCEL invariants that must hold for any valid planar subdivision. */
function assertDcelValid(result: DecompositionResult): void {
  const dcel = result.dcel as Dcel;
  expect(dcel).toBeDefined();
  const H = dcel.halfEdges;

  for (let h = 0; h < H.length; h++) {
    // Twin involution, and twins run in opposite directions.
    expect(H[h].twin).not.toBe(h);
    expect(H[H[h].twin].twin).toBe(h);
    expect(H[H[h].twin].origin).not.toBe(H[h].origin);
    // next/prev are inverse.
    expect(H[H[h].next].prev).toBe(h);
    expect(H[H[h].prev].next).toBe(h);
    // Half-edges around a face are chained head-to-tail.
    expect(H[H[h].next].origin).toBe(H[H[h].twin].origin);
    // next stays on the same face.
    expect(H[H[h].next].face).toBe(H[h].face);
  }

  // Each face's cycle from faceEdge matches its vertex loop exactly.
  expect(dcel.faceEdge.length).toBe(result.faces.length);
  for (let f = 0; f < result.faces.length; f++) {
    const loop = result.faces[f];
    const start = dcel.faceEdge[f];
    let h = start;
    const cycle: number[] = [];
    do {
      expect(H[h].face).toBe(f);
      cycle.push(H[h].origin);
      h = H[h].next;
      expect(cycle.length).toBeLessThanOrEqual(loop.length);
    } while (h !== start);
    expect(cycle.length).toBe(loop.length);
    const off = loop.indexOf(cycle[0]);
    expect(off).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < loop.length; i++) {
      expect(cycle[i]).toBe(loop[(off + i) % loop.length]);
    }
  }

  // Boundary cycles: face -1 throughout, and every boundary half-edge is on
  // exactly one reported cycle.
  const onCycle = new Set<number>();
  for (const start of dcel.boundaryCycles) {
    let h = start;
    do {
      expect(H[h].face).toBe(-1);
      expect(onCycle.has(h)).toBe(false);
      onCycle.add(h);
      h = H[h].next;
      expect(onCycle.size).toBeLessThanOrEqual(H.length);
    } while (h !== start);
  }
  for (let h = 0; h < H.length; h++) {
    if (H[h].face === -1) expect(onCycle.has(h)).toBe(true);
  }

  // vertexEdge points at an outgoing half-edge for every used vertex.
  const used = new Set<number>();
  for (const face of result.faces) for (const v of face) used.add(v);
  for (const v of used) {
    const h = dcel.vertexEdge[v];
    expect(h).toBeGreaterThanOrEqual(0);
    expect(H[h].origin).toBe(v);
  }

  // Euler's formula for a connected planar subdivision: V - E + F = 2, where
  // the non-interior faces are the unbounded region and each hole region —
  // i.e. one face per boundary cycle.
  const V = used.size;
  const E = H.length / 2;
  const F = result.faces.length + dcel.boundaryCycles.length;
  expect(H.length % 2).toBe(0);
  expect(V - E + F).toBe(2);
}

/** Every boundary half-edge must lie on the input polygon's boundary. */
function assertBoundaryOnInput(result: DecompositionResult, polygon: Polygon): void {
  const dcel = result.dcel as Dcel;
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  const onSegment = (p: Point, a: Point, b: Point): boolean => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) > 1e-6 * Math.max(len, 1) * len) return false;
    const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
    return dot >= -1e-9 && dot <= len * len + 1e-9;
  };
  const onBoundary = (p: Point, q: Point): boolean => {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (onSegment(p, a, b) && onSegment(q, a, b)) return true;
      }
    }
    return false;
  };
  for (const h of dcel.halfEdges) {
    if (h.face !== -1) continue;
    const p = result.vertices[h.origin];
    const q = result.vertices[dcel.halfEdges[h.twin].origin];
    expect(onBoundary(p, q)).toBe(true);
  }
}

/** With the DCEL's normalised loops, twins mean interior edges pair up 2-2. */
function assertAreaConserved(result: DecompositionResult, polygon: Polygon): void {
  let want = Math.abs(signedArea(polygon.outer));
  for (const h of polygon.holes ?? []) want -= Math.abs(signedArea(h));
  const got = result.faces.reduce(
    (s, face) => s + Math.abs(signedArea(face.map((i) => result.vertices[i]))),
    0,
  );
  expect(got).toBeCloseTo(want, 6);
}

const square: Polygon = { outer: rect(0, 0, 10, 10) };
const squareWithHole: Polygon = { outer: rect(0, 0, 10, 10), holes: [rect(4, 4, 6, 6)] };
const plus: Polygon = {
  outer: pts([[3, 0], [6, 0], [6, 3], [9, 3], [9, 6], [6, 6], [6, 9], [3, 9], [3, 6], [0, 6], [0, 3], [3, 3]]),
};
const stackedHoles: Polygon = {
  outer: rect(0, 0, 10, 10),
  holes: [rect(4, 1, 6, 3), rect(4, 5, 6, 7)],
};
const grid45: Polygon = (() => {
  const holes: Point[][] = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const x0 = 40 + 80 * i;
      const y0 = 40 + 80 * j;
      holes.push(rect(x0, y0, x0 + 40, y0 + 40));
    }
  return { outer: rect(0, 0, 340, 340), holes };
})();

describe("decompose – DCEL", () => {
  const cases: Array<{ name: string; polygon: Polygon; angle: number; cycles?: number }> = [
    { name: "square @ 0.3", polygon: square, angle: 0.3, cycles: 1 },
    { name: "square @ 0", polygon: square, angle: 0, cycles: 1 },
    { name: "square+hole @ 0.3", polygon: squareWithHole, angle: 0.3, cycles: 2 },
    { name: "square+hole @ 0", polygon: squareWithHole, angle: 0, cycles: 2 },
    { name: "plus @ 0", polygon: plus, angle: 0, cycles: 1 },
    { name: "plus @ 0.3", polygon: plus, angle: 0.3, cycles: 1 },
    { name: "plus @ pi/2", polygon: plus, angle: Math.PI / 2, cycles: 1 },
    { name: "stacked holes @ 0 (coincident criticals)", polygon: stackedHoles, angle: 0, cycles: 3 },
    { name: "stacked holes @ 0.3", polygon: stackedHoles, angle: 0.3, cycles: 3 },
    { name: "stacked holes @ pi/2", polygon: stackedHoles, angle: Math.PI / 2, cycles: 3 },
    { name: "4x4 grid @ 45deg (dropped pass-through cells)", polygon: grid45, angle: Math.PI / 4, cycles: 17 },
    { name: "4x4 grid @ 0", polygon: grid45, angle: 0, cycles: 17 },
  ];

  for (const { name, polygon, angle, cycles } of cases) {
    it(`${name}: valid DCEL, boundary on input, area conserved`, () => {
      const result = decompose(polygon, angle, { dcel: true });
      assertDcelValid(result);
      assertBoundaryOnInput(result, polygon);
      assertAreaConserved(result, polygon);
      if (cycles !== undefined) {
        expect((result.dcel as Dcel).boundaryCycles.length).toBe(cycles);
      }
    });
  }

  it("is absent unless requested, and requesting it does not change vertices or graph", () => {
    const plain = decompose(stackedHoles, 0.3);
    expect(plain.dcel).toBeUndefined();
    const withDcel = decompose(stackedHoles, 0.3, { dcel: true });
    expect(withDcel.vertices).toEqual(plain.vertices);
    expect(withDcel.graph).toEqual(plain.graph);
    expect(withDcel.faces.length).toBe(plain.faces.length);
    // Normalised faces are supersets of the plain loops (T-junction vertices added).
    for (let f = 0; f < plain.faces.length; f++) {
      for (const v of plain.faces[f]) expect(withDcel.faces[f]).toContain(v);
    }
  });

  it("resolves the T-junctions of the plus shape at angle 0", () => {
    const result = decompose(plus, 0, { dcel: true });
    // Before normalisation, no internal edge of this shape had a twin (every
    // seam was a T-junction); with the DCEL every internal edge pairs up.
    const counts = new Map<string, number>();
    for (const face of result.faces) {
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const twinned = [...counts.values()].filter((c) => c === 2).length;
    expect(twinned).toBeGreaterThanOrEqual(2); // the plus has 2 internal seams
    for (const c of counts.values()) expect(c).toBeLessThanOrEqual(2);
  });

  it("walks a face ring via next and around a vertex via twin/next", () => {
    const result = decompose(squareWithHole, 0.3, { dcel: true });
    const dcel = result.dcel as Dcel;
    // Around-vertex orbit: h -> twin(h).next cycles through edges leaving v.
    for (let v = 0; v < result.vertices.length; v++) {
      const start = dcel.vertexEdge[v];
      if (start === -1) continue;
      let h = start;
      let steps = 0;
      do {
        expect(dcel.halfEdges[h].origin).toBe(v);
        h = dcel.halfEdges[dcel.halfEdges[h].twin].next;
        steps++;
        expect(steps).toBeLessThanOrEqual(dcel.halfEdges.length);
      } while (h !== start);
    }
  });
});
