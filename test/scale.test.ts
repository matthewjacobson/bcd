import { describe, expect, it } from "vitest";
import { decompose } from "../src/index.js";
import { signedArea } from "../src/geometry.js";
import type { DecompositionResult, Point, Polygon } from "../src/types.js";

/** A big square containing a `k × k` grid of unit-square holes (spacing 3). */
function gridOfHoles(k: number): Polygon {
  const span = 3 * k + 1;
  const outer: Point[] = [
    { x: 0, y: 0 },
    { x: span, y: 0 },
    { x: span, y: span },
    { x: 0, y: span },
  ];
  const holes: Point[][] = [];
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const x0 = 3 * i + 1;
      const y0 = 3 * j + 1;
      holes.push([
        { x: x0, y: y0 },
        { x: x0 + 1, y: y0 },
        { x: x0 + 1, y: y0 + 1 },
        { x: x0, y: y0 + 1 },
      ]);
    }
  }
  return { outer, holes };
}

function totalArea(result: DecompositionResult): number {
  return result.faces.reduce(
    (sum, face) => sum + Math.abs(signedArea(face.map((idx) => result.vertices[idx]))),
    0,
  );
}

function assertConnectedAndConsistent(result: DecompositionResult): void {
  const { adjacency } = result.graph;
  for (let i = 0; i < adjacency.length; i++) {
    for (const j of adjacency[i]) {
      expect(adjacency[j]).toContain(i); // symmetric
    }
  }
  // The decomposition of a connected region is connected.
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nb of adjacency[cur]) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  expect(seen.size).toBe(result.faces.length);
}

describe("decompose – scale & performance", () => {
  it("handles thousands of vertices with conserved area", () => {
    const k = 20; // 400 holes -> ~1604 vertices
    const polygon = gridOfHoles(k);
    const start = performance.now();
    const result = decompose(polygon, 0.3);
    const elapsed = performance.now() - start;

    const expectedArea = (3 * k + 1) ** 2 - k * k;
    expect(totalArea(result)).toBeCloseTo(expectedArea, 4);
    assertConnectedAndConsistent(result);
    // Each row of holes forces splits/merges -> many cells.
    expect(result.faces.length).toBeGreaterThan(k * k);
    // Comfortably fast; generous bound to avoid CI flakiness.
    expect(elapsed).toBeLessThan(2000);
  });

  it("scales sub-quadratically (roughly n log n)", () => {
    // Compare a 4x larger input: O(n^2) would be ~16x, O(n log n) ~4.5x.
    const time = (k: number): number => {
      const polygon = gridOfHoles(k);
      decompose(polygon, 0.3); // warm up
      const start = performance.now();
      for (let r = 0; r < 3; r++) decompose(polygon, 0.3);
      return (performance.now() - start) / 3;
    };
    const small = time(15); // 225 holes
    const large = time(30); // 900 holes (4x vertices)
    // Allow a loose ceiling; the point is it is nowhere near 16x.
    expect(large).toBeLessThan(small * 9 + 5);
  });
});
