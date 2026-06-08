/**
 * Balanced sweep-line status structure.
 *
 * An AVL tree of active boundary edges, ordered by the height at which each
 * edge crosses the sweep line at the current sweep position. Because the input
 * polygon is simple, two active edges never swap vertical order while they are
 * both active, so the tree's ordering invariant holds across the whole sweep as
 * long as comparisons are evaluated at the current `sweepX`.
 *
 * Supports `insert`, `remove` (by node reference — node identity is preserved,
 * never copied, so external references stay valid) and `floorBelow` (locate the
 * edge immediately beneath a y value), each in O(log n).
 */

/** Base node: any record carrying segment endpoints and AVL links. */
export interface StatusNode {
  /** Lexicographically smaller (left) endpoint vertex index. */
  ai: number;
  /** Lexicographically larger (right) endpoint vertex index. */
  bi: number;
  left: this | null;
  right: this | null;
  parent: this | null;
  height: number;
}

export class StatusTree<T extends StatusNode> {
  root: T | null = null;
  /** Current sweep-line position; comparisons evaluate edge heights here. */
  sweepX = 0;

  constructor(
    private readonly vx: number[],
    private readonly vy: number[],
  ) {}

  /** Height at which edge `e` crosses the vertical line at `sweepX`. */
  yOf(e: T): number {
    const ax = this.vx[e.ai];
    const bx = this.vx[e.bi];
    if (ax === bx) return (this.vy[e.ai] + this.vy[e.bi]) / 2;
    return this.vy[e.ai] + ((this.vy[e.bi] - this.vy[e.ai]) * (this.sweepX - ax)) / (bx - ax);
  }

  /**
   * Order two edges at `sweepX`: by crossing height, breaking ties (edges that
   * meet at the current point) by rightward slope so the lower edge sorts first.
   */
  private cmp(a: T, b: T): number {
    const ya = this.yOf(a);
    const yb = this.yOf(b);
    if (ya < yb) return -1;
    if (ya > yb) return 1;
    const adx = this.vx[a.bi] - this.vx[a.ai];
    const ady = this.vy[a.bi] - this.vy[a.ai];
    const bdx = this.vx[b.bi] - this.vx[b.ai];
    const bdy = this.vy[b.bi] - this.vy[b.ai];
    const cross = adx * bdy - ady * bdx; // > 0 => b turns above a => a is lower
    if (cross > 0) return -1;
    if (cross < 0) return 1;
    return 0;
  }

  private h(n: T | null): number {
    return n ? n.height : 0;
  }

  private balanceFactor(n: T): number {
    return this.h(n.left) - this.h(n.right);
  }

  /** Rotate left around `x`; returns the new subtree root (does not fix grandparent). */
  private rotateLeft(x: T): T {
    const y = x.right as T;
    x.right = y.left;
    if (y.left) y.left.parent = x;
    y.left = x;
    y.parent = x.parent;
    x.parent = y;
    x.height = 1 + Math.max(this.h(x.left), this.h(x.right));
    y.height = 1 + Math.max(this.h(y.left), this.h(y.right));
    return y;
  }

  /** Rotate right around `y`; returns the new subtree root (does not fix grandparent). */
  private rotateRight(y: T): T {
    const x = y.left as T;
    y.left = x.right;
    if (x.right) x.right.parent = y;
    x.right = y;
    x.parent = y.parent;
    y.parent = x;
    y.height = 1 + Math.max(this.h(y.left), this.h(y.right));
    x.height = 1 + Math.max(this.h(x.left), this.h(x.right));
    return x;
  }

  /** Walk from `node` to the root, updating heights and rebalancing. */
  private rebalanceUp(node: T | null): void {
    let n = node;
    while (n) {
      n.height = 1 + Math.max(this.h(n.left), this.h(n.right));
      const parent = n.parent;
      const bf = this.balanceFactor(n);
      let sub: T = n;
      if (bf > 1) {
        if (this.balanceFactor(n.left as T) < 0) {
          const r = this.rotateLeft(n.left as T);
          n.left = r;
          r.parent = n;
        }
        sub = this.rotateRight(n);
      } else if (bf < -1) {
        if (this.balanceFactor(n.right as T) > 0) {
          const r = this.rotateRight(n.right as T);
          n.right = r;
          r.parent = n;
        }
        sub = this.rotateLeft(n);
      }
      if (!parent) this.root = sub;
      else if (parent.left === n) parent.left = sub;
      else parent.right = sub;
      sub.parent = parent;
      n = parent;
    }
  }

  insert(e: T): void {
    e.left = null;
    e.right = null;
    e.height = 1;
    if (!this.root) {
      e.parent = null;
      this.root = e;
      return;
    }
    let cur: T = this.root;
    let goLeft = true;
    for (;;) {
      goLeft = this.cmp(e, cur) < 0;
      const nxt = (goLeft ? cur.left : cur.right) as T | null;
      if (!nxt) break;
      cur = nxt;
    }
    e.parent = cur;
    if (goLeft) cur.left = e;
    else cur.right = e;
    this.rebalanceUp(cur);
  }

  /** Replace the subtree rooted at `u` with the subtree rooted at `v`. */
  private transplant(u: T, v: T | null): void {
    const parent = u.parent;
    if (!parent) this.root = v;
    else if (parent.left === u) parent.left = v;
    else parent.right = v;
    if (v) v.parent = parent;
  }

  /** Remove a node by reference. Node identity is never copied. */
  remove(z: T): void {
    let rebalanceAt: T | null;
    if (z.left && z.right) {
      let s = z.right as T; // in-order successor (no left child)
      while (s.left) s = s.left as T;
      if (s.parent !== z) {
        rebalanceAt = s.parent;
        this.transplant(s, s.right as T | null);
        s.right = z.right;
        if (s.right) s.right.parent = s;
      } else {
        rebalanceAt = s;
      }
      this.transplant(z, s);
      s.left = z.left;
      if (s.left) s.left.parent = s;
      s.height = z.height;
    } else {
      const child = (z.left ?? z.right) as T | null;
      rebalanceAt = z.parent;
      this.transplant(z, child);
    }
    z.left = null;
    z.right = null;
    z.parent = null;
    this.rebalanceUp(rebalanceAt);
  }

  /** Greatest active edge whose crossing height is strictly below `yKey`. */
  floorBelow(yKey: number): T | null {
    let cur = this.root;
    let best: T | null = null;
    while (cur) {
      if (this.yOf(cur) < yKey) {
        best = cur;
        cur = cur.right;
      } else {
        cur = cur.left;
      }
    }
    return best;
  }
}
