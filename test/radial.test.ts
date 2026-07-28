import { describe, expect, it } from "vitest";
import { decomposeRadial, tessellateRadialFace } from "../src/index.js";
import { signedArea } from "../src/geometry.js";
import type { Point, Polygon, RadialDecompositionResult } from "../src/types.js";

const TWO_PI = 2 * Math.PI;

function pts(coords: Array<[number, number]>): Point[] {
  return coords.map(([x, y]) => ({ x, y }));
}

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return pts([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
}

/** Largest distance from `center` to any vertex — the scale arcs live at. */
function maxRadius(polygon: Polygon, center: Point): number {
  let r = 0;
  for (const ring of [polygon.outer, ...(polygon.holes ?? [])]) {
    for (const p of ring) r = Math.max(r, Math.hypot(p.x - center.x, p.y - center.y));
  }
  return r;
}

/**
 * Shoelace about a nearby origin. For inputs far from `(0, 0)` the raw sum
 * cancels catastrophically — the terms are the square of the coordinates, so a
 * polygon of size 10 sitting at 10⁶ loses ten digits — and this measures the
 * test harness rather than the library. Shifting first fixes it.
 */
function areaAbout(ring: Point[], origin: Point): number {
  return signedArea(ring.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y })));
}

/**
 * Total area of the decomposition, flattening arcs finely enough that the
 * polyline error is far below the tolerance the assertions use.
 */
function totalArea(result: RadialDecompositionResult, tolerance: number): number {
  let sum = 0;
  for (let i = 0; i < result.faces.length; i++) {
    for (const loop of tessellateRadialFace(result, i, tolerance)) {
      sum += areaAbout(loop, result.center);
    }
  }
  return sum;
}

function expectedArea(polygon: Polygon, origin: Point = { x: 0, y: 0 }): number {
  let area = Math.abs(areaAbout(polygon.outer, origin));
  for (const hole of polygon.holes ?? []) area -= Math.abs(areaAbout(hole, origin));
  return area;
}

function connected(result: RadialDecompositionResult): boolean {
  if (result.faces.length === 0) return true;
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const cur = stack.pop() as number;
    for (const nb of result.graph.adjacency[cur]) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return seen.size === result.faces.length;
}

function assertGraphConsistent(result: RadialDecompositionResult): void {
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
  }
}

/**
 * Arcs must reference real loop positions, span disjoint runs of loop edges,
 * and be consistent with the vertices they claim to join.
 */
function assertArcsWellFormed(result: RadialDecompositionResult): void {
  const { center, vertices, faces } = result;
  const claimed = new Map<string, Set<number>>();
  for (const arc of result.arcs) {
    expect(arc.face).toBeGreaterThanOrEqual(0);
    expect(arc.face).toBeLessThan(faces.length);
    const face = faces[arc.face];
    const loop = arc.hole < 0 ? face.ring : (face.holes as number[][])[arc.hole];
    expect(loop).toBeDefined();
    expect(arc.index).toBeGreaterThanOrEqual(0);
    expect(arc.index).toBeLessThan(loop.length);
    expect(arc.count).toBeGreaterThanOrEqual(1);
    expect(arc.count).toBeLessThanOrEqual(loop.length);
    expect(Math.abs(arc.sweep)).toBeGreaterThan(0);
    expect(Math.abs(arc.sweep)).toBeLessThanOrEqual(TWO_PI + 1e-9);

    // No two arcs may claim the same loop edge.
    const key = `${arc.face}:${arc.hole}`;
    const used = claimed.get(key) ?? new Set<number>();
    for (let k = 0; k < arc.count; k++) {
      const at = (arc.index + k) % loop.length;
      expect(used.has(at)).toBe(false);
      used.add(at);
    }
    claimed.set(key, used);

    // Endpoints sit on the arc's circle, at the angles it reports.
    const start = vertices[loop[arc.index]];
    const end = vertices[loop[(arc.index + arc.count) % loop.length]];
    for (const p of [start, end]) {
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeCloseTo(arc.radius, 6);
    }
    expect(Math.cos(arc.startAngle)).toBeCloseTo((start.x - center.x) / arc.radius, 6);
    expect(Math.sin(arc.startAngle)).toBeCloseTo((start.y - center.y) / arc.radius, 6);
    const endAngle = arc.startAngle + arc.sweep;
    expect(Math.cos(endAngle)).toBeCloseTo((end.x - center.x) / arc.radius, 6);
    expect(Math.sin(endAngle)).toBeCloseTo((end.y - center.y) / arc.radius, 6);
  }
}

/** Every cell must come out counter-clockwise, holes clockwise. */
function assertOrientations(result: RadialDecompositionResult, tolerance: number): void {
  for (let i = 0; i < result.faces.length; i++) {
    const loops = tessellateRadialFace(result, i, tolerance);
    expect(signedArea(loops[0])).toBeGreaterThan(0);
    for (let h = 1; h < loops.length; h++) expect(signedArea(loops[h])).toBeLessThan(0);
  }
}

const square: Polygon = { outer: rect(0, 0, 10, 10) };
const squareWithHole: Polygon = { outer: rect(0, 0, 10, 10), holes: [rect(4, 4, 6, 6)] };
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

describe("decomposeRadial – basic invariants", () => {
  const cases: Array<{ name: string; polygon: Polygon; center: Point }> = [
    { name: "square, centre far outside", polygon: square, center: { x: -20, y: 5 } },
    { name: "square, centre just outside", polygon: square, center: { x: -1, y: -1 } },
    { name: "square, centre inside", polygon: square, center: { x: 4, y: 4.3 } },
    { name: "square, centre exactly middle", polygon: square, center: { x: 5, y: 5 } },
    { name: "square+hole, centre in hole", polygon: squareWithHole, center: { x: 5, y: 5 } },
    { name: "square+hole, centre in hole off", polygon: squareWithHole, center: { x: 4.8, y: 5.2 } },
    { name: "square+hole, centre in material", polygon: squareWithHole, center: { x: 2, y: 2 } },
    { name: "square+hole, centre outside", polygon: squareWithHole, center: { x: -5, y: -5 } },
    { name: "plus, centre inside", polygon: plus, center: { x: 4.2, y: 4.7 } },
    { name: "plus, centre at the middle", polygon: plus, center: { x: 4.5, y: 4.5 } },
    { name: "plus, centre outside", polygon: plus, center: { x: -3, y: -3 } },
  ];

  for (const { name, polygon, center } of cases) {
    it(`${name}: area is conserved, cells & graph well-formed`, () => {
      const result = decomposeRadial(polygon, center);
      const tol = maxRadius(polygon, center) * 1e-7;
      expect(result.faces.length).toBeGreaterThanOrEqual(1);
      expect(totalArea(result, tol)).toBeCloseTo(expectedArea(polygon), 5);
      expect(connected(result)).toBe(true);
      assertGraphConsistent(result);
      assertArcsWellFormed(result);
      assertOrientations(result, tol);
    });
  }
});

describe("decomposeRadial – cell structure", () => {
  it("a centre outside the polygon's angular span gives a single cell", () => {
    // From (-1,-1) every point of the square is farther than the last, so the
    // sweep circle never becomes tangent to an edge and nothing splits.
    const result = decomposeRadial(square, { x: -1, y: -1 });
    expect(result.faces.length).toBe(1);
    expect(result.arcs.length).toBe(0);
    expect(result.graph.edges.length).toBe(0);
    expect(totalArea(result, 1e-6)).toBeCloseTo(100, 6);
  });

  it("a centre inside a convex polygon starts with a full disc", () => {
    const result = decomposeRadial(square, { x: 4, y: 4.3 });
    const disc = result.faces[0];
    // A whole circle: one vertex, one arc closing on itself.
    expect(disc.ring.length).toBe(1);
    expect(disc.holes).toBeUndefined();
    const arc = result.arcs.find((a) => a.face === 0);
    expect(arc).toBeDefined();
    expect(Math.abs((arc as { sweep: number }).sweep)).toBeCloseTo(TWO_PI, 9);
    // The disc grows until it touches the nearest edge — 4 units to x = 0.
    expect((arc as { radius: number }).radius).toBeCloseTo(4, 9);
    expect(signedArea(tessellateRadialFace(result, 0, 1e-8)[0])).toBeCloseTo(Math.PI * 16, 4);
  });

  it("a centre in a hole produces exactly one annular cell", () => {
    const result = decomposeRadial(squareWithHole, { x: 5, y: 5 });
    const annuli = result.faces.filter((f) => f.holes && f.holes.length > 0);
    expect(annuli.length).toBe(1);
    const [annulus] = annuli;
    expect(annulus.ring.length).toBe(1);
    expect((annulus.holes as number[][])[0].length).toBe(1);

    // It runs from the hole's far corner out to the square's nearest edge.
    const index = result.faces.indexOf(annulus);
    const radii = result.arcs.filter((a) => a.face === index).map((a) => a.radius).sort();
    expect(radii[0]).toBeCloseTo(Math.hypot(1, 1), 9); // hole corner
    expect(radii[1]).toBeCloseTo(5, 9); // square edge
    const loops = tessellateRadialFace(result, index, 1e-8);
    expect(signedArea(loops[0]) + signedArea(loops[1])).toBeCloseTo(Math.PI * (25 - 2), 4);
  });

  it("a centre outside never produces an annulus", () => {
    for (const c of [
      { x: -5, y: -5 },
      { x: 20, y: 3 },
      { x: 5, y: -8 },
    ]) {
      const result = decomposeRadial(squareWithHole, c);
      expect(result.faces.every((f) => !f.holes)).toBe(true);
    }
  });
});

describe("decomposeRadial – the branch cut leaves no trace", () => {
  // The polar frame has to be cut open along some ray to be swept, but the
  // sweep is cylinder-aware, so where that ray points must not matter.
  const probes: Array<{ polygon: Polygon; center: Point }> = [
    { polygon: square, center: { x: 4, y: 4.3 } },
    { polygon: square, center: { x: 5, y: 5 } },
    { polygon: squareWithHole, center: { x: 4.8, y: 5.2 } },
    { polygon: squareWithHole, center: { x: 2, y: 2 } },
    { polygon: plus, center: { x: 4.2, y: 4.7 } },
  ];

  for (const [i, { polygon, center }] of probes.entries()) {
    it(`case ${i}: cell count and area are independent of branchAngle`, () => {
      const tol = maxRadius(polygon, center) * 1e-7;
      const base = decomposeRadial(polygon, center);
      for (const branchAngle of [0, 0.3, 1, 2, 3, 4, 5.5, -2.2]) {
        const result = decomposeRadial(polygon, center, { branchAngle });
        expect(result.faces.length).toBe(base.faces.length);
        expect(result.graph.edges.length).toBe(base.graph.edges.length);
        expect(totalArea(result, tol)).toBeCloseTo(expectedArea(polygon), 5);
        expect(connected(result)).toBe(true);
      }
    });
  }
});

describe("decomposeRadial – robustness", () => {
  it("accepts either winding order", () => {
    const cw: Polygon = { outer: [...square.outer].reverse() };
    const a = decomposeRadial(square, { x: 4, y: 4.3 });
    const b = decomposeRadial(cw, { x: 4, y: 4.3 });
    expect(b.faces.length).toBe(a.faces.length);
    expect(totalArea(b, 1e-6)).toBeCloseTo(100, 5);
  });

  it("is stable far from the origin and at extreme scales", () => {
    for (const [ox, oy, s] of [
      [1e6, 1e6, 1],
      [0, 0, 1e-6],
      [0, 0, 1e6],
      [-4e5, 7e5, 3],
    ]) {
      const move = (p: Point): Point => ({ x: ox + p.x * s, y: oy + p.y * s });
      const polygon: Polygon = {
        outer: squareWithHole.outer.map(move),
        holes: (squareWithHole.holes as Point[][]).map((h) => h.map(move)),
      };
      for (const f of [
        { x: 5, y: 5 },
        { x: 2, y: 2 },
        { x: -3, y: -3 },
      ]) {
        const center = move(f);
        const result = decomposeRadial(polygon, center);
        const want = expectedArea(polygon, center);
        const tol = maxRadius(polygon, center) * 1e-9;
        expect(totalArea(result, tol) / want).toBeCloseTo(1, 9);
        expect(connected(result)).toBe(true);
      }
    }
  });

  it("handles many coincident critical radii", () => {
    // A regular grid of square holes about its own centre: every hole edge and
    // corner shares its radius with three others, so critical points pile onto
    // the same sweep circle in fours.
    const span = 13;
    const holes: Point[][] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) holes.push(rect(3 * i + 1, 3 * j + 1, 3 * i + 2, 3 * j + 2));
    }
    const polygon: Polygon = { outer: rect(0, 0, span, span), holes };
    const result = decomposeRadial(polygon, { x: span / 2, y: span / 2 });
    expect(totalArea(result, 1e-7)).toBeCloseTo(span * span - 16, 4);
    expect(connected(result)).toBe(true);
    assertGraphConsistent(result);
  });

  it("handles thousands of vertices, sub-quadratically", () => {
    const grid = (k: number): Polygon => {
      const span = 3 * k + 1;
      const holes: Point[][] = [];
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) holes.push(rect(3 * i + 1, 3 * j + 1, 3 * i + 2, 3 * j + 2));
      }
      return { outer: rect(0, 0, span, span), holes };
    };
    const time = (k: number): number => {
      const polygon = grid(k);
      const span = 3 * k + 1;
      const center = { x: span / 2 + 0.37, y: span / 2 + 0.11 };
      decomposeRadial(polygon, center); // warm up
      const start = performance.now();
      for (let r = 0; r < 3; r++) decomposeRadial(polygon, center);
      return (performance.now() - start) / 3;
    };

    const k = 20; // 400 holes -> ~1604 vertices
    const polygon = grid(k);
    const span = 3 * k + 1;
    const center = { x: span / 2 + 0.37, y: span / 2 + 0.11 };
    const result = decomposeRadial(polygon, center);
    expect(totalArea(result, 1e-7)).toBeCloseTo(span * span - k * k, 3);
    expect(connected(result)).toBe(true);
    expect(result.faces.length).toBeGreaterThan(k * k);

    // O(n²) would be ~16x for 4x the vertices; O(n log n) is ~4.5x.
    const small = time(15);
    const large = time(30);
    expect(large).toBeLessThan(small * 9 + 50);
  });

  it("throws on a degenerate outer ring", () => {
    expect(() => decomposeRadial({ outer: pts([[0, 0], [1, 1]]) }, { x: 5, y: 5 })).toThrow();
  });

  it("throws when the centre lies on the boundary", () => {
    expect(() => decomposeRadial(square, { x: 0, y: 5 })).toThrow(/boundary/);
    expect(() => decomposeRadial(square, { x: 0, y: 0 })).toThrow(/boundary/);
    expect(() => decomposeRadial(squareWithHole, { x: 4, y: 5 })).toThrow(/boundary/);
  });

  it("throws on a non-finite centre", () => {
    expect(() => decomposeRadial(square, { x: NaN, y: 0 })).toThrow();
  });
});

describe("tessellateRadialFace", () => {
  it("converges to the exact area as the tolerance tightens", () => {
    const result = decomposeRadial(square, { x: 4, y: 4.3 });
    let previous = Infinity;
    for (const tol of [1, 0.1, 0.01, 1e-4]) {
      const error = Math.abs(totalArea(result, tol) - 100);
      expect(error).toBeLessThan(previous);
      previous = error;
    }
    expect(Math.abs(totalArea(result, 1e-6) - 100)).toBeLessThan(1e-6);
  });

  it("keeps a shared cut identical in both cells that bound it", () => {
    // Sample angles come from a grid fixed by the radius, so the two cells
    // either side of a cut flatten it to exactly the same points.
    const result = decomposeRadial(square, { x: 4, y: 4.3 });
    const seen = new Map<string, number>();
    for (let i = 0; i < result.faces.length; i++) {
      for (const loop of tessellateRadialFace(result, i, 0.02)) {
        for (const p of loop) {
          const key = `${p.x.toFixed(9)}|${p.y.toFixed(9)}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
    }
    // Interior sample points must be shared, not duplicated at ε distance.
    expect([...seen.values()].some((n) => n >= 2)).toBe(true);
  });

  it("rejects an out-of-range face index", () => {
    const result = decomposeRadial(square, { x: 4, y: 4.3 });
    expect(() => tessellateRadialFace(result, result.faces.length)).toThrow(RangeError);
  });
});

describe("decomposeRadial – dcel", () => {
  const cases: Array<{ name: string; polygon: Polygon; center: Point }> = [
    { name: "square, centre outside", polygon: square, center: { x: -20, y: 5 } },
    { name: "square, centre inside", polygon: square, center: { x: 4, y: 4.3 } },
    { name: "square, centre middle", polygon: square, center: { x: 5, y: 5 } },
    { name: "square+hole, annulus", polygon: squareWithHole, center: { x: 5, y: 5 } },
    { name: "square+hole, in material", polygon: squareWithHole, center: { x: 2, y: 2 } },
    { name: "plus, centre inside", polygon: plus, center: { x: 4.2, y: 4.7 } },
  ];

  for (const { name, polygon, center } of cases) {
    it(`${name}: is a consistent half-edge structure`, () => {
      const result = decomposeRadial(polygon, center, { dcel: true, arcTolerance: 0.05 });
      const dcel = result.dcel;
      expect(dcel).toBeDefined();
      const h = (dcel as NonNullable<typeof dcel>).halfEdges;

      for (let i = 0; i < h.length; i++) {
        expect(h[h[i].twin].twin).toBe(i);
        expect(h[i].twin).not.toBe(i);
        expect(h[h[i].next].prev).toBe(i);
        expect(h[h[i].prev].next).toBe(i);
        // The twin leaves the vertex that `next` leaves: they share an endpoint.
        expect(h[h[i].twin].origin).toBe(h[h[i].next].origin);
      }

      // Every cycle stays on one face.
      const seen = new Set<number>();
      for (let i = 0; i < h.length; i++) {
        if (seen.has(i)) continue;
        let cur = i;
        let guard = 0;
        do {
          seen.add(cur);
          expect(h[cur].face).toBe(h[i].face);
          cur = h[cur].next;
          expect(guard++).toBeLessThan(h.length);
        } while (cur !== i);
      }
      expect(seen.size).toBe(h.length);
    });
  }

  it("gives an annular cell an inner cycle", () => {
    const result = decomposeRadial(squareWithHole, { x: 5, y: 5 }, { dcel: true });
    const dcel = result.dcel as NonNullable<typeof result.dcel>;
    const annulus = result.faces.findIndex((f) => f.holes && f.holes.length > 0);
    expect(annulus).toBeGreaterThanOrEqual(0);
    expect(dcel.faceInnerEdges).toBeDefined();
    expect((dcel.faceInnerEdges as number[][])[annulus].length).toBe(1);

    // Outer cycle counter-clockwise, inner cycle clockwise.
    const ring = (start: number): Point[] => {
      const out: Point[] = [];
      let cur = start;
      do {
        out.push(result.vertices[dcel.halfEdges[cur].origin]);
        cur = dcel.halfEdges[cur].next;
      } while (cur !== start);
      return out;
    };
    expect(signedArea(ring(dcel.faceEdge[annulus]))).toBeGreaterThan(0);
    expect(signedArea(ring((dcel.faceInnerEdges as number[][])[annulus][0]))).toBeLessThan(0);
  });

  it("leaves the linear decomposition's dcel without inner cycles", () => {
    const result = decomposeRadial(square, { x: -20, y: 5 }, { dcel: true });
    expect((result.dcel as NonNullable<typeof result.dcel>).faceInnerEdges).toBeUndefined();
  });
});
