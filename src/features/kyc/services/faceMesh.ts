/**
 * The face web's geometry — shared by the LIVE mesh and the STILL one.
 *
 * `FaceMesh` draws it over the camera; `VerdictMesh` draws it over the frozen
 * frame while the servers decide and once they have answered. Same web, same
 * cover-crop arithmetic — so the wireframe that was on somebody's face a second
 * ago is the wireframe that is on it now, rather than two implementations that
 * agree until one of them is tuned.
 *
 * ── ⚠️ IT IS NOT MEDIAPIPE'S TESSELLATION ANY MORE ──────────────────────────
 * It was, clustered down to a readable size, and that approach was abandoned
 * for one reason: it could not be made to look REGULAR. The triangulation is
 * derived from where a particular face's landmarks happen to be, so the
 * triangles come out in a hundred different sizes, and the pattern on the left
 * cheek is not the pattern on the right — the two halves are built from
 * different measurements of a face that is not symmetric to begin with.
 *
 * Three rounds of fixes went into the clustering (a grid centred on the midline
 * rather than on the bounding box, representatives elected by distance to the
 * cell's centre rather than by index, a rounding rule that does not favour one
 * side), each of which made it measurably better and none of which could make
 * it regular. The reason is structural: a pattern INFERRED from an irregular
 * point set inherits its irregularity.
 *
 * So the pattern is GENERATED instead — a spider's web, spun from the middle of
 * the face out to its own silhouette. Spokes at even angles, rings at even
 * radii. It is perfectly regular and perfectly symmetric because it is
 * constructed to be, not because the landmarks were persuaded to be; and it
 * still belongs to THIS face, because its extent is the face's own outline and
 * its centre is the face's own centre. Nothing is inferred; the landmarks are
 * used for the two things they are reliable for — where the face is and what
 * shape it is — and the geometry is ours.
 *
 * Pure functions only. Nothing here touches a canvas, a ref or React.
 */

/** The edge list's type, derived from a value — `Connection` is not exported. */
export type Edges =
    typeof import('@mediapipe/tasks-vision').FaceLandmarker.FACE_LANDMARKS_TESSELATION;

/** The web: its points, the lines between them, and where a gem may sit. */
export interface Web {
    /**
     * Vertex positions as flat x,y pairs, in the same space as the landmarks
     * they were built from.
     *
     * ⚠️ POSITIONS, NOT LANDMARK INDICES. The web's points are its own — the
     * centre, and one per spoke per ring — and almost none of them is a
     * landmark. The drawing code indexes THIS, never the landmark array.
     */
    verts: Float32Array;
    /**
     * Pairs of vertex indices, ORDERED FROM THE CENTRE OUTWARD.
     *
     * The order is load-bearing: colouring the first N edges fills the web from
     * the middle out, which is what both the live match gauge and the verdict
     * sweep are drawn from. It is also the order the web spins itself in.
     */
    edges: Int32Array;
    /**
     * Where the outermost ring starts in `edges` — its boundary.
     *
     * Everything from here to the end is the rim: the one closed line around
     * the whole web. The drawing code gives it its own treatment (see
     * `VerdictMesh`), which is the only reason it has to be findable. It is the
     * TAIL of the list because the edges run hub-outward and the last ring
     * carries no radials after it.
     */
    rim: number;
    /** Every vertex index — where the sparkles may sit. */
    vertices: Int32Array;
}

/** How the web is spun. See `CAPTURE_LIVE_MESH` for the tuned values. */
export interface WebShape {
    /** Radial lines out of the centre. EVEN — see `buildWeb`. */
    spokes: number;
    /** Concentric rings between the centre and the outline. */
    rings: number;
    /**
     * How far the centre sits above the outline's own middle, as a fraction of
     * the face's height.
     */
    centreLift: number;
    /**
     * Where the innermost ring sits, as a fraction of the way out.
     *
     * The web is OPEN inside it — there is no centre point and no spoke reaches
     * one. See `buildWeb`.
     */
    hub: number;
    /**
     * How much further the web reaches upward than downward, 0..1.
     *
     * 0 is the face's own outline in every direction. Above that the upward
     * spokes stretch past it and the downward ones pull inside it, so the web
     * is wider at the top than at the bottom — where a mask sits.
     */
    taper: number;
    /**
     * How far each strand dips toward the hub between two spokes, 0..1.
     *
     * ⚠️ THE ONE SETTING THAT MAKES IT A WEB RATHER THAN A DARTBOARD. At 0 the
     * rings are flat polygons, which at this many sides is a circle. See
     * `buildWeb`.
     */
    sag: number;
    /**
     * How far alternate spokes push their rings out, 0..1.
     *
     * Every ring meets every other spoke a little further out than the one
     * before, so the strand BREAKS and changes slant at each crossing instead
     * of running smoothly through it. See `buildWeb`.
     */
    zig: number;
    /**
     * How much narrower the web is at the chin than at the centre, 0..1.
     *
     * A horizontal squeeze that grows with depth. It does NOT shorten the
     * downward reach — the web still ends on the jaw. See `buildWeb`.
     */
    narrow: number;
    /**
     * How far each ring sits to one side of its spoke, as a fraction of the
     * radius — so the SPOKES break and change slant at every crossing too.
     *
     * Alternates ring by ring, and takes its direction from which side of the
     * face the spoke is on, which is what keeps it mirror-symmetric. See
     * `buildWeb`.
     */
    kink: number;
}

/**
 * A `#rrggbb` token plus an alpha, as an `rgba()` string.
 *
 * Canvas wants a colour string per draw and a hex token has no alpha channel to
 * vary, so every colour in the web goes through here.
 */
export function withAlpha(hex: string, alpha: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(3)})`;
}

/**
 * A connection list walked into an ordered closed ring of landmark indices.
 *
 * `FaceLandmarker.FACE_LANDMARKS_FACE_OVAL` is the face's outline, and it comes
 * as an unordered bag of segments — fine for drawing, useless for asking "how
 * far is the edge of the face in THIS direction", which needs a polygon whose
 * points are in order around it.
 *
 * Returns an empty array if the connections do not form one closed loop, which
 * is the honest answer for input this cannot use — the caller draws no web, the
 * same as when the model has not loaded.
 */
export function ringOrder(connections: Edges): number[] {
    const neighbours = new Map<number, number[]>();
    for (const { start, end } of connections) {
        (neighbours.get(start) ?? neighbours.set(start, []).get(start)!).push(end);
        (neighbours.get(end) ?? neighbours.set(end, []).get(end)!).push(start);
    }
    if (!neighbours.size) return [];

    // The lowest index, so the walk starts from the same place every time and
    // the web does not rotate its own vertex numbering between builds.
    const first = Math.min(...neighbours.keys());
    const ring = [first];
    let prev = -1;
    let node = first;

    for (;;) {
        const next = (neighbours.get(node) ?? []).find((n) => n !== prev);
        if (next === undefined) return []; // A dead end: not a closed loop.
        if (next === first) return ring;
        if (ring.length > neighbours.size) return []; // A branch, walked twice.
        ring.push(next);
        prev = node;
        node = next;
    }
}

/**
 * The `object-fit: cover` crop, as a source-pixel rectangle.
 *
 * ⚠️ WITHOUT THIS THE WEB LANDS ON A FACE THAT IS NOT THERE. Landmarks are
 * normalised over the SOURCE (the video frame, or the still), and what the
 * frame shows is a centre crop of it — a 4:3 stream in a 350x400 box loses a
 * third of its width before anything is seen. Mapping straight from 0..1 to the
 * canvas puts the wireframe beside the face and stretches it by the same ratio.
 *
 * Returns the rectangle of the source that is actually visible; a normalised
 * landmark `p` maps to `(p * srcW - sx) / sw` across and the same down.
 */
export function coverCrop(
    srcW: number,
    srcH: number,
    boxW: number,
    boxH: number,
): { sx: number; sy: number; sw: number; sh: number } {
    const boxAspect = boxW / boxH;
    const srcAspect = srcW / srcH;
    const sw = srcAspect > boxAspect ? srcH * boxAspect : srcW;
    const sh = srcAspect > boxAspect ? srcH : srcW / boxAspect;
    return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/**
 * How far the face's outline is from `cx,cy` in the direction `dx,dy`.
 *
 * A ray cast at the polygon, taking the NEAREST crossing rather than the
 * farthest: a face outline is convex enough that there is normally one, and on
 * the jaw — where the polygon can doubles back — the nearest is the silhouette
 * and anything beyond it is the far side of the head.
 *
 * Returns 0 when the ray somehow escapes without crossing, which the caller
 * reads as "no web along this spoke" rather than as an error.
 */
function rayToRing(
    points: Float32Array,
    ring: number[],
    cx: number,
    cy: number,
    dx: number,
    dy: number,
): number {
    let nearest = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const ax = points[a * 2] - cx;
        const ay = points[a * 2 + 1] - cy;
        const bx = points[b * 2] - cx;
        const by = points[b * 2 + 1] - cy;

        /*
         * Where the segment a→b crosses the ray, solved in the ray's own
         * frame: `cross` is the segment's projection across the ray, so `s` is
         * how far along the segment the crossing sits and `t` how far along the
         * ray. Both have to be in range for it to be a real crossing.
         */
        const ex = bx - ax;
        const ey = by - ay;
        const denom = ex * dy - ey * dx;
        if (Math.abs(denom) < 1e-12) continue; // Parallel to the ray.
        const s = (ay * dx - ax * dy) / denom;
        if (s < 0 || s > 1) continue;
        /*
         * ⚠️ SOLVED ON THE RAY'S LARGER COMPONENT, always. Either equation
         * gives `t`; dividing by the smaller one is what breaks.
         *
         * A `!== 0` guard is NOT enough and was the bug: the vertical spokes
         * are at ±π/2, where `Math.cos` returns 6.1e-17 rather than zero. That
         * is not zero, so the guard passed, and `t` came back off by a third on
         * exactly two spokes of every web — measured as a reach of 0.34 on a
         * circle of radius 0.3, which is how it was found.
         */
        const t =
            Math.abs(dx) > Math.abs(dy) ? (ax + s * ex) / dx : (ay + s * ey) / dy;
        if (t > 0 && t < nearest) nearest = t;
    }
    return nearest === Infinity ? 0 : nearest;
}

/**
 * Spin the web.
 *
 * ── ⚠️ THE STRANDS SAG, AND THAT IS THE WHOLE DIFFERENCE ────────────────────
 * Without it this is not a web. Spokes plus rings at even radii is a
 * DARTBOARD: a sixteen-sided polygon at this size is a circle to the eye, five
 * of them nested is a target, and an open hub in the middle completes the
 * impression. That is exactly what the first version looked like, and no
 * amount of tuning the counts or the spacing fixes it, because the problem is
 * the shape of the strand rather than how many there are.
 *
 * A real orb web has no circles in it. Every strand hangs between two spokes
 * and SAGS toward the hub under its own weight, so each ring is a chain of
 * shallow Vs rather than a curve — and the eye reads that as a web instantly,
 * at any size, however few strands there are.
 *
 * It is built by giving every ring a point BETWEEN each pair of spokes, pulled
 * inward by `sag`. So the directions alternate: even ones are spokes and carry
 * the radial lines, odd ones are the dips and carry nothing but the ring. Two
 * segments per strand, still all straight lines, no curves to rasterise.
 *
 * ── ⚠️ WHY IT IS SYMMETRIC, WHICH IS THE WHOLE REASON IT EXISTS ─────────────
 * The directions are laid out from straight up in even steps, and there are
 * `2 * spokes` of them — an even count, so the set is closed under mirroring:
 * direction j mirrors onto direction `2 * spokes - j`, which has the SAME
 * PARITY and is therefore a spoke if j was a spoke and a dip if j was a dip.
 * Every vertex has a mirror vertex and every line a mirror line, exactly, on
 * any face at all.
 *
 * `taper` cannot break that either: it depends only on how far UP a direction
 * points, which is the one thing mirroring does not change.
 *
 * The only difference between the two halves is how far each spoke reaches,
 * because that is the face's own outline and a real face is not symmetric —
 * which is the one asymmetry that SHOULD survive, since the alternative is a
 * web that does not fit the head it is on.
 *
 * ── ⚠️ THE HUB IS OPEN, and that is not decoration ──────────────────────────
 * Spokes meeting at one point put a dozen lines through the width of a few
 * pixels: at the centre of the face the web stops being a pattern and becomes
 * a blot, and it is the densest mark on screen sitting on the bridge of
 * somebody's nose. So the innermost ring starts at `hub` of the way out and
 * nothing is drawn inside it. A real web is built the same way for the same
 * reason — and because the hub ring sags like every other, the opening is a
 * small star rather than the drawn circle it used to be.
 *
 * `into` lets the live mesh rebuild the web every frame without allocating:
 * the topology is fixed by `shape` alone, so only the positions are recomputed.
 */
export function buildWeb(
    points: Float32Array,
    ring: number[],
    shape: WebShape,
    into?: Web,
): Web | null {
    const { spokes, rings, centreLift, hub, taper, sag, zig, narrow, kink } = shape;
    if (ring.length < 3 || spokes < 4 || rings < 2) return null;

    /*
     * The centre of the outline, and the face's own extent.
     *
     * The mean of the ring's points, not of every landmark: the tessellation
     * crowds hundreds of points into the eyes, nose and lips, so their mean is
     * pulled toward the middle of the face's FEATURES rather than of its shape.
     * The outline is evenly sampled all the way round, so its mean is the shape
     * — and on a symmetric ring it sits exactly on the axis of symmetry.
     */
    let cx = 0;
    let cy = 0;
    let top = Infinity;
    let bottom = -Infinity;
    for (const i of ring) {
        cx += points[i * 2];
        cy += points[i * 2 + 1];
        top = Math.min(top, points[i * 2 + 1]);
        bottom = Math.max(bottom, points[i * 2 + 1]);
    }
    cx /= ring.length;
    cy /= ring.length;

    /*
     * Raised toward the brow. The outline's middle sits around the nose, and a
     * web spun from there puts its densest point on the one feature that should
     * stay legible. Lifting it to about the eyes is also where the mask this is
     * imitating carries its own centre.
     */
    cy -= (bottom - top) * centreLift;

    /**
     * How far the web reaches straight down — the depth the chin taper is
     * measured against. Cast once, before the spokes, because every vertex
     * needs it and it is the same ray every time.
     */
    const down = rayToRing(points, ring, cx, cy, 0, 1);

    /**
     * Spokes, and — only if the strands sag — a dip between each pair.
     *
     * ⚠️ At `sag: 0` the dips are not placed at zero depth, they are NOT PLACED
     * AT ALL. A dip at zero depth sits on the circumscribed circle rather than
     * on the chord between its two spokes, so keeping it would double the
     * ring's sides and round the polygon off — the opposite of the straight
     * runs that turning the sag off is asking for.
     */
    const dirs = sag > 0 ? spokes * 2 : spokes;
    /** How many directions apart two spokes are: 2 when sagging, 1 when not. */
    const step = dirs / spokes;
    const count = rings * dirs;
    const verts =
        into?.verts.length === count * 2 ? into.verts : new Float32Array(count * 2);

    for (let j = 0; j < dirs; j++) {
        const angle = -Math.PI / 2 + (2 * Math.PI * j) / dirs;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);

        /*
         * ── Wider at the top, and NEVER shorter at the bottom ───────────────
         *
         * A mask runs up over the brow, so the upward directions are stretched
         * past the outline. `dy` is -1 straight up and +1 straight down, and
         * `max(0, -dy)` is therefore 1 at the top, 0 at the horizontals, and 0
         * everywhere below them — a smooth lift over the upper half and
         * nothing at all over the lower one.
         *
         * ⚠️ IT USED TO SHRINK THE BOTTOM BY THE SAME AMOUNT, and that is the
         * "it only covers down to the mouth" bug. Symmetric taper looks
         * reasonable written down — stretch one end, pull in the other — but
         * the two ends are not equivalent: above the brow there is forehead and
         * hair to spare, and below the mouth there is only the chin, which is
         * the edge of the face and the place the web has to reach. Pulling in
         * there does not make the web top-heavy, it just takes the bottom
         * third off it.
         *
         * The downward directions now land exactly on the outline, which is to
         * say on the jaw, which is where the face ends.
         */
        const lift = 1 + taper * Math.max(0, -dy);
        const reach = rayToRing(points, ring, cx, cy, dx, dy) * lift;

        // Odd directions are the dips between spokes — the sag lives here, and
        // nowhere else.
        const pull = j % 2 === 0 ? 1 : 1 - sag;

        /*
         * ── The break at every crossing ─────────────────────────────────────
         *
         * Alternate spokes carry their rings a little further out, so a strand
         * arrives at a crossing, steps, and leaves at a different slant. That
         * step is the difference between a web and a set of nested polygons:
         * without it every ring is one smooth closed figure that the eye reads
         * straight through, and the spokes look like they were drawn on top
         * afterwards rather than being what the strands are strung between.
         *
         * A real orb web does this because its capture strand is a SPIRAL —
         * each turn passes a spoke further out than the last. A spiral is
         * chiral, though, and this web has to mirror exactly, so the step
         * alternates instead of accumulating: out, back, out, back. Same break
         * at every crossing, and the left half is still the right half.
         *
         * ⚠️ Symmetric only because `spokes` is even. Mirroring sends spoke k
         * to spoke `spokes - k`, which has the same parity when `spokes` is
         * even and the opposite parity when it is odd — and opposite parity
         * here means one cheek stepping out where the other steps in.
         *
         * ⚠️ IT ONLY EVER PULLS IN, never pushes out, and that is what keeps
         * the web on the face. Stepping alternately either side of the radius
         * is the obvious way to write it and it costs the chin: spoke 0 points
         * straight up and spoke `spokes / 2` straight down, both EVEN, so an
         * alternating step moves both of them — and the bottom one moving in is
         * the web stopping short of the jaw, which is the one edge it has to
         * reach. Pulling only the odd spokes in leaves every extreme exactly on
         * the outline and breaks the strand just as visibly.
         */
        const k = j / step;
        const zigged = Number.isInteger(k) ? 1 - zig * (k % 2) : 1;

        for (let r = 1; r <= rings; r++) {
            /*
             * From the hub out to the rim. Ring 1 is the hub itself, not the
             * centre — see the note above — and ring `rings` lands on `reach`.
             *
             * ⚠️ THE RIM ZIGS TOO, and it was excluded once — which was the
             * wrong way to make a boundary read. Held at a single radius it is
             * a clean twelve-sided polygon, and a clean polygon at twelve sides
             * is a curve: the corners are 150° and the eye runs straight round
             * them. The edge then had to be picked out by PAINT — a brighter
             * stroke — which is the same mistake in a different medium: the rim
             * does not look sharper, it looks louder.
             *
             * Zigged, alternate spokes pull their rim vertex in and every
             * corner becomes a real angle. The boundary is then defined by its
             * own shape, at the same colour and weight as everything inside it.
             */
            const at =
                reach * (hub + ((1 - hub) * (r - 1)) / (rings - 1)) * pull * zigged;
            const v = (r - 1) * dirs + j;

            /*
             * ── The kink in the spokes ──────────────────────────────────────
             *
             * The rings break at every crossing (`zig`), and until this the
             * spokes did not: each one ran dead straight from the hub to the
             * rim, so half the lines in the web were mechanical rays and the
             * other half were woven. Every ring a spoke passes now sits a
             * little to one side of it, alternating, so the spoke leaves each
             * junction on a different slant.
             *
             * The offset is TANGENTIAL — across the spoke, not along it — so it
             * changes where the line goes without changing how far it reaches.
             * The perpendicular of `(dx, dy)` is `(-dy, dx)`. Scaling by `at`
             * makes it a constant ANGLE rather than a constant distance, so the
             * kink looks the same near the hub as at the rim.
             *
             * ⚠️ THE SIGN COMES FROM WHICH SIDE OF THE FACE THE SPOKE IS ON,
             * and it has to. A plain alternation would rotate whole rings, and
             * a rotation is chiral: mirrored, a clockwise jog becomes an
             * anticlockwise one, and the two halves stop matching. Taking the
             * sign from `dx` makes the offset an odd function about the
             * midline — exactly what mirroring does to it — so it survives.
             *
             * ⚠️ AND `Math.sign(dx)` IS NOT SAFE HERE. The vertical spokes have
             * a `dx` of ±6.1e-17 rather than 0, so `sign` returns ±1 and jogs
             * the two spokes that lie ON the mirror axis — which are their own
             * twins, and cannot move at all without breaking the symmetry. Same
             * trap as the `Math.cos(-π/2)` one in `rayToRing`, one function
             * along.
             *
             * ⚠️ NOT ON THE RIM. The outermost ring is the boundary and stays
             * exactly where the outline put it — see the note above it. The
             * spoke's last segment still slants, because the ring below it
             * moved and the rim did not.
             */
            const side = Math.abs(dx) < 1e-9 ? 0 : Math.sign(dx);
            const jog = r === rings ? 0 : kink * side * (r % 2 === 0 ? 1 : -1) * at;

            const y = cy + dy * at + dx * jog;
            /*
             * ── Narrower toward the chin ────────────────────────────────────
             *
             * A horizontal squeeze that grows with depth below the centre, so
             * the web tapers to the jaw the way a face does — and the way the
             * mask it is imitating does, which is nearly to a point.
             *
             * ⚠️ IT SQUEEZES X ONLY. Narrowing by pulling the downward reach in
             * was the first attempt and it is the bug that stopped the web at
             * the mouth: shortening a direction moves the point UP as well as
             * IN, so the chin is lost to buy the width. Scaling the horizontal
             * offset leaves every vertex at exactly the height it had, so the
             * web still ends on the jaw — it is just tighter getting there.
             *
             * Symmetric by construction: the scale depends on the point's
             * height alone, and it is applied about the midline.
             */
            const depth = down > 0 ? Math.max(0, (y - cy) / down) : 0;
            const squeeze = 1 - narrow * Math.min(1, depth);

            verts[v * 2] = cx + (dx * at - dy * jog) * squeeze;
            verts[v * 2 + 1] = y;
        }
    }

    // The topology never changes for a given shape, so it is built once and
    // carried forward on every later frame.
    if (into?.verts === verts && into.edges.length) {
        return { verts, edges: into.edges, rim: into.rim, vertices: into.vertices };
    }

    /*
     * Ordered from the hub outward: each ring closed, then the spokes that
     * carry it to the next one, so any prefix of this list is a web that is
     * whole as far as it goes. That is what lets the reveal spin it and the
     * verdict fill it without either needing to know its shape.
     *
     * ⚠️ Every ring is closed, the outermost included — that last one is the
     * line around the whole web, and it is made of the same sagging strands as
     * every ring inside it rather than being a curve drawn round a pattern.
     *
     * ⚠️ RADIALS ONLY ON SPOKE DIRECTIONS — hence `step`, not a literal 2.
     * When the strands sag there are dips in between, and carrying a dip
     * outward would put a line down the middle of every cell; when they do not,
     * EVERY direction is a spoke and a step of 2 silently drops half the
     * radials. That was the bug this comment replaced: 84 edges where there
     * should have been 108, and every second spoke left with no rungs.
     */
    const edges: number[] = [];
    const at = (r: number, j: number) => (r - 1) * dirs + ((j + dirs) % dirs);
    for (let r = 1; r < rings; r++) {
        for (let j = 0; j < dirs; j++) edges.push(at(r, j), at(r, j + 1));
        for (let j = 0; j < dirs; j += step) edges.push(at(r, j), at(r + 1, j));
    }

    // The rim last, which is what `Web.rim` points at.
    for (let j = 0; j < dirs; j++) edges.push(at(rings, j), at(rings, j + 1));

    return {
        verts,
        edges: Int32Array.from(edges),
        // The rim's segments, which are the final `dirs` edges — two array
        // entries each. See `Web.rim`.
        rim: edges.length - dirs * 2,
        vertices: Int32Array.from({ length: count }, (_, i) => i),
    };
}
