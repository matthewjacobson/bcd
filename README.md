# bcd

Boustrophedon cellular decomposition of a 2D polygon (with or without holes)
along an arbitrary sweep angle.

The boustrophedon decomposition is the standard building block for **coverage
path planning** — it carves a region into cells that can each be covered with a
simple back-and-forth ("boustrophedon", _as the ox plows_) motion, plus a graph
describing how the cells connect so you can plan an order to visit them.

- Single function, no runtime dependencies.
- Handles concave polygons and holes.
- Works at any sweep angle.
- Ships ESM + CJS builds with TypeScript types.

## Demo

An interactive demo lives in [`demo/`](./demo): pick a polygon from the
[Interesting Polygon Archive](https://github.com/LingDong-/interesting-polygon-archive),
drag the sweep-angle slider, and toggle visualization of the cells, the
connectivity graph, the original outline and the sweep lines.

![bcd demo](https://raw.githubusercontent.com/matthewjacobson/bcd/main/demo/preview.png)

Run it from the repo root with any static file server, e.g.:

```sh
npm run demo            # builds, then serves on http://localhost:8123
# then open http://localhost:8123/demo/
```

The view is deep-linkable — the current polygon, angle and toggles are encoded
in the URL query string (e.g. `?polygon=held-1&angle=35&graph=1`).

The dropdown also has an **"Edge-case demos"** group of hand-built shapes that
put several critical points on the same sweep line (see
[below](#multiple-critical-points-on-one-sweep-line)). Pick one and watch the
"Faces" / "Graph edges" stats change as you nudge the slider off its target
angle — at the degenerate angle the aligned holes share a band, just off it you
get the generic-position decomposition, and the graph stays connected either
way:

![aligned holes at 0°](https://raw.githubusercontent.com/matthewjacobson/bcd/main/demo/edge-case.png)

The grid shape (`edge · hole grid 4×4`) at `0°` is the worst case — every column
of holes piles critical points onto one sweep line — and still decomposes into a
fully connected graph.

## Install

```sh
npm install @matthewjacobson/bcd
```

## Usage

```ts
import { decompose } from "@matthewjacobson/bcd";

const result = decompose(
  {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [
      [
        { x: 4, y: 4 },
        { x: 6, y: 4 },
        { x: 6, y: 6 },
        { x: 4, y: 6 },
      ],
    ],
  },
  Math.PI / 6, // sweep direction in radians
);

result.vertices; // Point[]            — unique vertices, original coordinate frame
result.faces; // number[][]           — each face is a CCW loop of vertex indices
result.graph.adjacency; // number[][] — adjacency[i] = faces adjacent to face i
result.graph.edges; // [number, number][] — undirected adjacency pairs, i < j
```

## API

### `decompose(polygon, angle): DecompositionResult`

| Parameter | Type        | Description                                                                                   |
| --------- | ----------- | --------------------------------------------------------------------------------------------- |
| `polygon` | `Polygon`   | `{ outer: Point[]; holes?: Point[][] }`. Rings may be given in any winding order.             |
| `angle`   | `number`    | Sweep direction in radians, CCW from the `+x` axis. Cells are sliced perpendicular to it.     |

```ts
interface Point {
  x: number;
  y: number;
}

interface Polygon {
  outer: Point[]; // outer ring, ≥ 3 points
  holes?: Point[][]; // optional inner rings, each ≥ 3 points
}

interface DecompositionResult {
  vertices: Point[];
  faces: number[][]; // CCW loops of indices into `vertices`
  graph: {
    adjacency: number[][]; // adjacency[i] = sorted neighbour face indices
    edges: Array<[number, number]>; // [i, j] with i < j, each pair once
  };
}
```

Rings are re-oriented internally (outer counter-clockwise, holes clockwise) and
do **not** need their first point repeated at the end. The first point being
repeated is tolerated. Output faces are always counter-clockwise.

Two faces are adjacent when they share a vertical cut produced at a **critical
point** of the sweep — a *split* (one cell divides into two) or a *merge* (two
cells fuse into one). START/END events open and close cells without creating
adjacency, so a simple convex polygon yields a single face with an empty graph.

## How it works

After rotating the polygon so that `angle` aligns with `+x`, a vertical line
sweeps left to right. Each vertex is classified by its two incident edges and
the interior turn direction:

| Event       | Incident edges        | Turn    | Effect                          |
| ----------- | --------------------- | ------- | ------------------------------- |
| **START**   | both to the right     | convex  | open one cell                   |
| **SPLIT**   | both to the right     | reflex  | close one cell, open two        |
| **END**     | both to the left      | convex  | close one cell                  |
| **MERGE**   | both to the left      | reflex  | close two cells, open one       |
| **REGULAR** | one left, one right   | —       | extend a cell's floor / ceiling |

Cells are the maximal regions between consecutive critical points, which is
exactly the boustrophedon decomposition. Events are processed in lexicographic
`(x, y)` order, which removes the ambiguity of perfectly vertical edges (e.g.
axis-aligned input at `angle = 0`) without perturbing coordinates.

### Multiple critical points on one sweep line

When several critical points share the same sweep position — for example two
holes whose left edges line up vertically, or any axis-aligned input at
`angle = 0` — a cell can be opened and closed at the same `x`, producing a
zero-width "pass-through" cell. These are filtered out of the face list (they
have no area), but the connections that ran *through* them are preserved by
contracting them in the graph: the cells on the left of a dropped cell are
linked directly to the cells on its right. The result stays a correct, fully
connected decomposition with exact coordinates (no perturbation). This is
covered by tests, including a fully axis-aligned grid of holes at `angle = 0`.

## Notes & limitations

- Coordinates are exact (no perturbation). Zero-area cells (from coincident
  critical points, see above) are dropped below an area threshold of `1e-9`, but
  their adjacencies are preserved. Note that at an exactly degenerate angle the
  cell *count* reflects the simultaneous interpretation (e.g. two aligned holes
  give one shared band), whereas any other angle gives the generic-position
  count; both are valid, area-conserving decompositions.
- Input rings are assumed simple (non-self-intersecting). Self-intersections and
  overlapping holes are not validated.
- Runs in `O(n log n)` for `n` vertices: events are sorted once, and the active
  edges are kept in a balanced AVL status tree, so each event does `O(log n)`
  work. ~25k vertices decomposes in well under 100 ms.

## License

MIT
