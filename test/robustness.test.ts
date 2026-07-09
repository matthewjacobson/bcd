import { describe, expect, it } from "vitest";
import { decompose } from "../src/index.js";
import type { DecompositionResult, Point, Polygon } from "../src/types.js";

function pts(coords: Array<[number, number]>): Point[] {
  return coords.map(([x, y]) => ({ x, y }));
}

/**
 * Shoelace area computed relative to the ring's first vertex, so it stays
 * accurate for rings far from the origin (the plain formula catastrophically
 * cancels there and would make the assertions below meaningless).
 */
function robustArea(ring: Point[]): number {
  const r = ring[0];
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  }
  return a / 2;
}

function totalArea(result: DecompositionResult): number {
  return result.faces.reduce(
    (sum, face) => sum + Math.abs(robustArea(face.map((i) => result.vertices[i]))),
    0,
  );
}

function connected(result: DecompositionResult): boolean {
  if (result.faces.length === 0) return false;
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
  return seen.size === result.faces.length;
}

describe("decompose – duplicate input points", () => {
  it("tolerates a repeated closing point on the outer ring", () => {
    const closed: Polygon = { outer: pts([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) };
    for (const angle of [0, 0.3, Math.PI / 2]) {
      const result = decompose(closed, angle);
      expect(result.faces.length).toBe(1);
      expect(totalArea(result)).toBeCloseTo(100, 6);
    }
  });

  it("tolerates repeated closing points on hole rings", () => {
    const p: Polygon = {
      outer: pts([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
      holes: [pts([[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]])],
    };
    for (const angle of [0, 0.3]) {
      const result = decompose(p, angle);
      expect(result.faces.length).toBe(4);
      expect(totalArea(result)).toBeCloseTo(96, 6);
      expect(connected(result)).toBe(true);
    }
  });

  it("tolerates consecutive duplicate points mid-ring", () => {
    const p: Polygon = { outer: pts([[0, 0], [5, 0], [5, 0], [10, 0], [10, 10], [0, 10]]) };
    for (const angle of [0, 0.3]) {
      const result = decompose(p, angle);
      expect(result.faces.length).toBe(1);
      expect(totalArea(result)).toBeCloseTo(100, 6);
    }
  });

  it("throws when the outer ring has fewer than 3 distinct points", () => {
    expect(() => decompose({ outer: pts([[0, 0], [0, 0], [0, 0], [0, 0]]) }, 0)).toThrow();
    expect(() => decompose({ outer: pts([[0, 0], [5, 5], [5, 5], [0, 0]]) }, 0)).toThrow();
  });

  it("skips holes that collapse below 3 distinct points", () => {
    const p: Polygon = {
      outer: pts([[0, 0], [10, 0], [10, 10], [0, 10]]),
      holes: [pts([[4, 4], [4, 4], [6, 6]])],
    };
    const result = decompose(p, 0.3);
    expect(result.faces.length).toBe(1);
    expect(totalArea(result)).toBeCloseTo(100, 6);
  });
});

describe("decompose – scale and translation invariance", () => {
  const base: Polygon = {
    outer: pts([[0, 0], [10, 0], [10, 10], [0, 10]]),
    holes: [pts([[4, 1], [6, 1], [6, 3], [4, 3]]), pts([[4, 5], [6, 5], [6, 7], [4, 7]])],
  };
  const baseFaces = decompose(base, 0.3).faces.length;

  for (const s of [1e-6, 1e-3, 1, 1e3, 1e6]) {
    it(`same structure and relative area at scale ${s}`, () => {
      const p: Polygon = {
        outer: base.outer.map((q) => ({ x: q.x * s, y: q.y * s })),
        holes: base.holes!.map((h) => h.map((q) => ({ x: q.x * s, y: q.y * s }))),
      };
      const result = decompose(p, 0.3);
      expect(result.faces.length).toBe(baseFaces);
      expect(connected(result)).toBe(true);
      const want = 92 * s * s;
      expect(Math.abs(totalArea(result) - want) / want).toBeLessThan(1e-9);
    });
  }

  for (const t of [5e5, 1e8]) {
    it(`same structure and relative area translated by ${t}`, () => {
      const p: Polygon = {
        outer: base.outer.map((q) => ({ x: q.x + t, y: q.y + t })),
        holes: base.holes!.map((h) => h.map((q) => ({ x: q.x + t, y: q.y + t }))),
      };
      const result = decompose(p, 0.3);
      expect(result.faces.length).toBe(baseFaces);
      expect(connected(result)).toBe(true);
      // Vertex coordinates carry ~ulp(t) noise, so allow a proportional slack.
      expect(Math.abs(totalArea(result) - 92) / 92).toBeLessThan(1e-6);
    });
  }

  it("keeps the degenerate-angle contraction working at extreme scales", () => {
    for (const s of [1e-5, 1e5]) {
      const p: Polygon = {
        outer: base.outer.map((q) => ({ x: q.x * s, y: q.y * s })),
        holes: base.holes!.map((h) => h.map((q) => ({ x: q.x * s, y: q.y * s }))),
      };
      const result = decompose(p, 0); // aligned holes: coincident critical points
      expect(result.faces.length).toBe(5);
      expect(connected(result)).toBe(true);
      const want = 92 * s * s;
      expect(Math.abs(totalArea(result) - want) / want).toBeLessThan(1e-9);
    }
  });
});
