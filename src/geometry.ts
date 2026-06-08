import type { Point } from "./types.js";

/**
 * Signed area of a ring via the shoelace formula. Positive for a
 * counter-clockwise ring, negative for clockwise.
 */
export function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Rotate a point by the rotation defined by `cos`/`sin`. */
export function rotatePoint(p: Point, cos: number, sin: number): Point {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}
