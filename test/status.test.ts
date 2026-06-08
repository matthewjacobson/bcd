import { describe, expect, it } from "vitest";
import { StatusTree, type StatusNode } from "../src/status.js";

interface TestNode extends StatusNode {
  id: number;
}

/**
 * Build a status tree of horizontal segments at given heights (each spanning
 * x in [0, 10]), evaluated at sweepX = 5. Returns the tree, the nodes, and the
 * backing coordinate arrays.
 */
function build(heights: number[]) {
  const vx: number[] = [];
  const vy: number[] = [];
  const tree = new StatusTree<TestNode>(vx, vy);
  tree.sweepX = 5;
  const nodes = heights.map((y, id) => {
    const ai = vx.length;
    vx.push(0);
    vy.push(y);
    const bi = vx.length;
    vx.push(10);
    vy.push(y);
    const node: TestNode = {
      id,
      ai,
      bi,
      left: null,
      right: null,
      parent: null,
      height: 1,
    };
    return node;
  });
  return { tree, nodes };
}

function inOrder(tree: StatusTree<TestNode>): TestNode[] {
  const out: TestNode[] = [];
  const visit = (n: TestNode | null) => {
    if (!n) return;
    visit(n.left);
    out.push(n);
    visit(n.right);
  };
  visit(tree.root);
  return out;
}

/** Assert the BST is ordered, parent pointers are consistent and AVL-balanced. */
function assertValid(tree: StatusTree<TestNode>): void {
  const heightOf = (n: TestNode | null): number => {
    if (!n) return 0;
    if (n.left) expect(n.left.parent).toBe(n);
    if (n.right) expect(n.right.parent).toBe(n);
    const lh = heightOf(n.left);
    const rh = heightOf(n.right);
    expect(Math.abs(lh - rh)).toBeLessThanOrEqual(1); // AVL invariant
    expect(n.height).toBe(1 + Math.max(lh, rh)); // stored height correct
    return n.height;
  };
  if (tree.root) expect(tree.root.parent).toBeNull();
  heightOf(tree.root);
  const ordered = inOrder(tree);
  for (let i = 1; i < ordered.length; i++) {
    expect(tree.yOf(ordered[i - 1])).toBeLessThanOrEqual(tree.yOf(ordered[i]));
  }
}

describe("StatusTree", () => {
  it("keeps elements ordered after many insertions", () => {
    const heights = Array.from({ length: 200 }, (_, i) => ((i * 73) % 200) + 0.5);
    const { tree, nodes } = build(heights);
    for (const n of nodes) tree.insert(n);
    assertValid(tree);
    const ys = inOrder(tree).map((n) => tree.yOf(n));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys.length).toBe(200);
  });

  it("stays balanced and ordered through interleaved removals", () => {
    const heights = Array.from({ length: 256 }, (_, i) => i + 0.5);
    const { tree, nodes } = build(heights);
    for (const n of nodes) tree.insert(n);
    // Remove every other node, then the rest in a scrambled order.
    for (let i = 0; i < nodes.length; i += 2) tree.remove(nodes[i]);
    assertValid(tree);
    expect(inOrder(tree).length).toBe(128);
    const rest = nodes.filter((_, i) => i % 2 === 1);
    for (const n of [...rest].reverse()) {
      tree.remove(n);
      assertValid(tree);
    }
    expect(tree.root).toBeNull();
  });

  it("floorBelow returns the greatest edge strictly below a height", () => {
    const { tree, nodes } = build([10, 20, 30, 40, 50]);
    for (const n of nodes) tree.insert(n);
    expect(tree.floorBelow(35)?.id).toBe(2); // height 30
    expect(tree.floorBelow(30)?.id).toBe(1); // strictly below -> height 20
    expect(tree.floorBelow(10)).toBeNull(); // nothing below the lowest
    expect(tree.floorBelow(1000)?.id).toBe(4); // height 50
  });

  it("height grows logarithmically (balanced)", () => {
    const heights = Array.from({ length: 1000 }, (_, i) => i + 0.5);
    const { tree, nodes } = build(heights);
    for (const n of nodes) tree.insert(n);
    // AVL height is bounded by ~1.4404 * log2(n + 2) - 0.328.
    const bound = 1.4404 * Math.log2(1000 + 2);
    expect(tree.root!.height).toBeLessThanOrEqual(bound);
  });
});
