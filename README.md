# bcd

[![CI](https://github.com/matthewjacobson/bcd/actions/workflows/ci.yml/badge.svg)](https://github.com/matthewjacobson/bcd/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@matthewjacobson/bcd)](https://www.npmjs.com/package/@matthewjacobson/bcd)

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

**[▶ Try it live](https://matthewjacobson.github.io/bcd/)** — no install needed.

The interactive demo (source in [`demo/`](./demo)) lets you pick a polygon from the
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

There is also a **[DCEL explorer](https://matthewjacobson.github.io/bcd/demo/dcel.html)**
(`demo/dcel.html`) for the [DCEL output](#dcel-output): hover a face to walk its
half-edge cycle via `next`, hover an edge to see the twin pair (each offset
toward its own face), and hover a vertex to orbit it via `twin→next`. Boundary
cycles of the unbounded face — the outer boundary plus one per hole — are drawn
dashed, and highlights are deep-linkable (e.g. `?hover=face:1`).

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

### `decompose(polygon, angle, options?): DecompositionResult`

| Parameter | Type               | Description                                                                                   |
| --------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `polygon` | `Polygon`          | `{ outer: Point[]; holes?: Point[][] }`. Rings may be given in any winding order.             |
| `angle`   | `number`           | Sweep direction in radians, CCW from the `+x` axis. Cells are sliced perpendicular to it.     |
| `options` | `DecomposeOptions` | Optional. `{ dcel: true }` also builds a [doubly connected edge list](#dcel-output).          |

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
do **not** need their first point repeated at the end. A repeated closing point
and consecutive duplicate points are stripped before decomposing. Output faces
are always counter-clockwise.

Two faces are adjacent when they share a vertical cut produced at a **critical
point** of the sweep — a *split* (one cell divides into two) or a *merge* (two
cells fuse into one). START/END events open and close cells without creating
adjacency, so a simple convex polygon yields a single face with an empty graph.

### DCEL output

Pass `{ dcel: true }` to also get a doubly connected edge list — a full
topological description of the planar subdivision, useful when you need to walk
seams, orbit vertices, or hand the decomposition to downstream geometry code:

```ts
const result = decompose(polygon, angle, { dcel: true });
const dcel = result.dcel!;

dcel.halfEdges; // { origin, twin, next, prev, face }[] — face -1 is the unbounded face
dcel.faceEdge; // one half-edge index per face (its CCW cycle)
dcel.vertexEdge; // one outgoing half-edge index per vertex
dcel.boundaryCycles; // one half-edge per boundary cycle: outer boundary + one per hole
```

Every undirected edge is represented by two directed twins, each with its face
on the left. Interior faces cycle counter-clockwise via `next`; edges on the
polygon's boundary have a twin with `face === -1`, and those twins form one
cycle around the outer boundary plus one around each hole (`boundaryCycles`).
The orbit `h -> halfEdges[halfEdges[h].twin].next` walks the edges leaving a
vertex.

Raw boustrophedon cells do not share their cut edges exactly (a cell closed at
a split carries the full cut as one edge, while its neighbours subdivide it at
the event vertex), so with `dcel: true` the face loops are first *normalised*:
T-junction vertices are inserted into the loops they are missing from. The
faces are geometrically identical but may contain collinear vertices along
shared cuts; `vertices` and `graph` are unchanged.

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
  critical points, see above) are dropped below an area threshold relative to
  the input's bounding box (`10⁻¹² · diagonal²`), but their adjacencies are
  preserved. Note that at an exactly degenerate angle the cell *count* reflects
  the simultaneous interpretation (e.g. two aligned holes give one shared band),
  whereas any other angle gives the generic-position count; both are valid,
  area-conserving decompositions.
- The polygon is centred on its bounding box internally and all tolerances
  scale with the box diagonal, so results are independent of the units used and
  stable for inputs far from the origin (e.g. projected geographic coordinates).
- Input rings are assumed simple (non-self-intersecting). Self-intersections and
  overlapping holes are not validated.
- Runs in `O(n log n)` for `n` vertices: events are sorted once, and the active
  edges are kept in a balanced AVL status tree, so each event does `O(log n)`
  work. ~25k vertices decomposes in well under 100 ms.

## Releasing

Releases are automated. Pushing a `vX.Y.Z` tag triggers the
[publish workflow](./.github/workflows/publish.yml), which runs the tests and
then publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC — **no token needed**) with build provenance attached.

To cut a release:

```sh
# 1. Bump the version (this edits package.json and updates the lockfile).
#    Use "patch", "minor", or "major" — or an explicit version like 0.2.0.
npm version patch --no-git-tag-version

# 2. Commit the bump and push to main (CI runs typecheck + tests).
git add package.json package-lock.json
git commit -m "Release v$(node -p "require('./package.json').version")"
git push origin main

# 3. Tag the release and push the tag — this kicks off the publish workflow.
git tag "v$(node -p "require('./package.json').version")"
git push origin --tags
```

Then watch it and confirm it landed:

```sh
gh run watch                          # follow the "Publish to npm" run
npm view @matthewjacobson/bcd version # should show the new version
```

Optionally add release notes: `gh release create vX.Y.Z --title vX.Y.Z --notes "..."`.

Notes:

- The tag **must** match the `version` in `package.json`, or the publish step
  fails on purpose (a guard against mismatched releases).
- The npm trusted publisher (repo `matthewjacobson/bcd`, workflow `publish.yml`)
  is already configured, so no `NPM_TOKEN` secret is involved.
- `npm version` without `--no-git-tag-version` would also create the tag for
  you, but it tags *before* the push to main; the steps above keep the commit
  and tag ordering explicit.

## License

MIT
