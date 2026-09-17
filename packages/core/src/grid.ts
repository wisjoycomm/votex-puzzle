import type { CellPath, GridSize, V3 } from "./events.ts";

// Ordered in +/- pairs so `d ^ 1` flips a direction — the flood fill relies on that to turn an
// exit direction into the direction it must travel coming back in.
const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];

/** Every exterior face open — used by the rotation-independent "reachable ever" flood. */
const ALL_FACES = 0b111111;

function dot(a: V3, b: V3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: V3, b: V3): V3 {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function normalize(v: V3): V3 {
    const len = Math.hypot(v.x, v.y, v.z);
    return len < 1e-6
        ? { x: 0, y: 0, z: 0 }
        : { x: v.x / len, y: v.y / len, z: v.z / len };
}

function compareScore(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < a.length; i++) {
        const d = a[i]! - b[i]!;
        if (d !== 0) return d;
    }
    return 0;
}

/** Keep only the corners: a straight run of cells is one segment to fly, not N waypoints. */
function collapseCollinear(points: V3[]): V3[] {
    if (points.length <= 2) return points;
    const out: V3[] = [points[0]!];
    for (let i = 1; i < points.length - 1; i++) {
        const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
        const straight =
            b.x - a.x === c.x - b.x && b.y - a.y === c.y - b.y && b.z - a.z === c.z - b.z;
        if (!straight) out.push(b);
    }
    out.push(points[points.length - 1]!);
    return out;
}

function indexToPos(i: number, size: GridSize): V3 {
    const x = i % size.nx;
    const y = Math.floor(i / size.nx) % size.ny;
    const z = Math.floor(i / (size.nx * size.ny));
    return { x, y, z };
}

/**
 * Reachability is answered by flooding *inward* from outside the sculpture, not by searching
 * outward from each cube. One flood marks every reachable cube at once, for every color, so the
 * five firing slots and the deadlock check share a single pass instead of paying a BFS per cube.
 * On the 23x25x19 level that took findTarget from 23ms to under 3ms for the whole grid.
 *
 * A path may bend at most `maxBends` times, so a state is (cell, direction, bends) rather than
 * just a cell: the same cell entered heading a different way, or with fewer bends spent, is a
 * genuinely different position to be in. Bend counts are symmetric under path reversal, which is
 * what makes flooding inward equivalent to searching outward (see bench/reachability-variants.ts,
 * which checks the two agree on every cube of the real level).
 */
export class VotexGrid {
    readonly size: GridSize;
    private readonly cells: (number | null)[];
    private readonly maxBends: number;
    private readonly n: number;

    /** Flat-index offset per direction, so a neighbour is `i + step[d]` with no V3 allocation. */
    private readonly step: Int32Array;
    /** Bit d set when stepping direction d from that cell leaves the grid. Precomputed because
     *  the alternative is a div+mod per step in the hottest loop in the codebase. */
    private readonly edge: Uint8Array;

    private readonly byColor = new Map<number, Set<number>>();
    private remaining = 0;

    // Flood scratch, allocated once and reused.
    private readonly best: Uint8Array;
    private readonly queue: Int32Array;
    private readonly everReach: Uint8Array;
    private readonly nowReach: Uint8Array;

    // Path recording, maintained by the view-dependent flood only (the deadlock flood has no use
    // for routes, and letting it write here would clobber the route data shooting depends on).
    /** Predecessor state key per state, -1 at a seed. */
    private readonly from: Int32Array;
    /** State the flood was in when it bumped each cube, -1 for a cube on the boundary. */
    private readonly entryState: Int32Array;
    /** Direction the flood stepped to arrive at each cube. */
    private readonly entryDir: Int8Array;

    // Cache validity. `version` bumps on every removal; the view-dependent flood also has to
    // match the direction it was computed for.
    private version = 0;
    private everVersion = -1;
    private nowVersion = -1;
    private nowMask = -1;

    constructor(size: GridSize, cells: (number | null)[], maxBends = 2) {
        this.size = size;
        this.cells = cells.slice();
        this.maxBends = maxBends;
        this.n = size.nx * size.ny * size.nz;

        this.step = new Int32Array(6);
        for (let d = 0; d < 6; d++) {
            this.step[d] = DX[d]! + DY[d]! * size.nx + DZ[d]! * size.nx * size.ny;
        }

        this.edge = new Uint8Array(this.n);
        for (let i = 0; i < this.n; i++) {
            const p = indexToPos(i, size);
            let mask = 0;
            for (let d = 0; d < 6; d++) {
                const x = p.x + DX[d]!, y = p.y + DY[d]!, z = p.z + DZ[d]!;
                const inside =
                    x >= 0 && x < size.nx && y >= 0 && y < size.ny && z >= 0 && z < size.nz;
                if (!inside) mask |= 1 << d;
            }
            this.edge[i] = mask;
        }

        for (let i = 0; i < this.n; i++) {
            const color = this.cells[i];
            if (color === null || color === undefined) continue;
            let set = this.byColor.get(color);
            if (!set) {
                set = new Set();
                this.byColor.set(color, set);
            }
            set.add(i);
            this.remaining++;
        }

        this.best = new Uint8Array(this.n * 6);
        // A state is re-queued only when it improves, and bends run 0..maxBends, so it can be
        // enqueued at most maxBends+1 times. Sizing below that would silently drop writes —
        // out-of-range TypedArray stores are no-ops in JS, which would read as false negatives.
        this.queue = new Int32Array(this.n * 6 * (maxBends + 1));
        this.everReach = new Uint8Array(this.n);
        this.nowReach = new Uint8Array(this.n);
        this.from = new Int32Array(this.n * 6);
        this.entryState = new Int32Array(this.n);
        this.entryDir = new Int8Array(this.n);
    }

    private idx(p: V3): number {
        return p.x + p.y * this.size.nx + p.z * this.size.nx * this.size.ny;
    }

    remove(p: V3): void {
        const i = this.idx(p);
        const color = this.cells[i];
        if (color === null || color === undefined) return;
        this.cells[i] = null;
        this.byColor.get(color)?.delete(i);
        this.remaining--;
        this.version++;
    }

    isCleared(): boolean {
        return this.remaining === 0;
    }

    /** Are there any cubes of this color left at all? A shooter whose color is extinct can never
     *  fire again, however the sculpture is peeled or rotated. */
    hasColor(color: number): boolean {
        return (this.byColor.get(color)?.size ?? 0) > 0;
    }

    cellsOfColor(color: number): V3[] {
        const set = this.byColor.get(color);
        if (!set) return [];
        const out: V3[] = [];
        for (const i of set) out.push(indexToPos(i, this.size));
        return out;
    }

    /**
     * Flood inward from every exterior face into `out`, marking each cube the flood reaches.
     * `faceMask` selects which of the 6 exterior faces may be entered from. `record` also stores
     * how each cube was reached, which is what `pathTo` walks back to produce a route.
     */
    private flood(out: Uint8Array, faceMask: number, record: boolean): void {
        const { best, queue, cells, edge, step, maxBends, n } = this;
        best.fill(255);
        out.fill(0);
        let head = 0;
        let tail = 0;

        for (let i = 0; i < n; i++) {
            const e = edge[i]!;
            if (e === 0) continue; // interior cell: not on any exterior face
            for (let d = 0; d < 6; d++) {
                if ((e & (1 << d)) === 0) continue;
                if ((faceMask & (1 << d)) === 0) continue;
                // A cube sitting on the boundary is reachable with no travel at all.
                if (cells[i] !== null) {
                    if (record && out[i] !== 1) {
                        this.entryState[i] = -1;
                        this.entryDir[i] = d ^ 1;
                    }
                    out[i] = 1;
                    continue;
                }
                const k = i * 6 + (d ^ 1); // enters heading opposite the way it would exit
                if (best[k] === 0) continue;
                best[k] = 0;
                if (record) this.from[k] = -1;
                queue[tail++] = k;
            }
        }

        while (head < tail) {
            const k = queue[head++]!;
            const cur = (k / 6) | 0;
            const curDir = k % 6;
            const bends = best[k]!;
            const e = edge[cur]!;
            for (let d = 0; d < 6; d++) {
                const b = bends + (d === curDir ? 0 : 1);
                if (b > maxBends) continue;
                if (e & (1 << d)) continue; // would leave the grid: nothing out there to reach
                const next = cur + step[d]!;
                if (cells[next] !== null) {
                    if (record && out[next] !== 1) {
                        this.entryState[next] = k;
                        this.entryDir[next] = d;
                    }
                    out[next] = 1; // flood bumped a cube
                    continue;
                }
                const nk = next * 6 + d;
                // Best-known bends, not first-arrival: a cheaper path arriving later must be
                // allowed to re-expand, or it gets locked out by a wasteful one that got here first.
                if (best[nk]! <= b) continue;
                best[nk] = b;
                if (record) this.from[nk] = k;
                queue[tail++] = nk;
            }
        }
    }

    private ensureEver(): void {
        if (this.everVersion === this.version) return;
        this.flood(this.everReach, ALL_FACES, false);
        this.everVersion = this.version;
    }

    /**
     * Which exterior faces currently point at the camera. The filter is only ever the *sign* of
     * viewDir's three components, so continuous rotation produces at most 8 distinct masks — the
     * flood only has to be redone when the camera crosses an axis plane, not every frame.
     */
    private faceMaskFor(viewDir: V3): number {
        let mask = 0;
        for (let d = 0; d < 6; d++) {
            if (DX[d]! * viewDir.x + DY[d]! * viewDir.y + DZ[d]! * viewDir.z > 0) {
                mask |= 1 << d;
            }
        }
        return mask;
    }

    private ensureNow(viewDir: V3): void {
        const mask = this.faceMaskFor(viewDir);
        if (this.nowVersion === this.version && this.nowMask === mask) return;
        this.flood(this.nowReach, mask, true);
        this.nowVersion = this.version;
        this.nowMask = mask;
    }

    /** Reachable right now: the escape path must exit on a face currently facing the camera. */
    reachableNow(origin: V3, viewDir: V3): boolean {
        this.ensureNow(viewDir);
        return this.nowReach[this.idx(origin)] === 1;
    }

    /** Reachable from *some* rotation — the player can always spin to face any exit face. */
    reachableEver(origin: V3): boolean {
        this.ensureEver();
        return this.everReach[this.idx(origin)] === 1;
    }

    /** Has this color a cube some rotation could reach? The deadlock check asks this every frame,
     *  so it reads the flood directly rather than allocating a V3 per cube via cellsOfColor. */
    anyReachableEver(color: number): boolean {
        const set = this.byColor.get(color);
        if (!set || set.size === 0) return false;
        this.ensureEver();
        for (const i of set) if (this.everReach[i] === 1) return true;
        return false;
    }

    /**
     * The route a bee would fly to reach `origin`, or null if it isn't currently reachable.
     *
     * Free to produce: the flood already travelled these cells in this order, so this only walks
     * the predecessor chain back out and drops the cells in the middle of a straight run. Must be
     * called before the cube is removed — afterwards it is no longer a cube and has no entry.
     */
    pathTo(origin: V3, viewDir: V3): CellPath | null {
        this.ensureNow(viewDir);
        const cube = this.idx(origin);
        if (this.nowReach[cube] !== 1) return null;

        // Chain of states from the cell adjacent to the cube back out to a seed on the boundary.
        const states: number[] = [];
        let k = this.entryState[cube]!;
        while (k !== -1) {
            states.push(k);
            k = this.from[k]!;
        }
        states.reverse();

        const face = this.entryDir[cube]! ^ 1; // stepped in along entryDir, so the face faces back
        const cells: V3[] = states.map((s) => indexToPos((s / 6) | 0, this.size));

        // One step further out from the outermost cell leaves the grid: that's where the bee
        // enters. With no cells at all the cube is on the boundary, so step out from the cube.
        const first = cells.length > 0 ? cells[0]! : origin;
        const outDir = cells.length > 0 ? (states[0]! % 6) ^ 1 : face;
        const entry: V3 = {
            x: first.x + DX[outDir]!,
            y: first.y + DY[outDir]!,
            z: first.z + DZ[outDir]!,
        };

        return {
            points: collapseCollinear([entry, ...cells]),
            face: { x: DX[face]!, y: DY[face]!, z: DZ[face]! },
        };
    }

    /** Best target for a shooter of `color`: nearest the camera, then highest, then rightmost.
     *  Nearest leads so a bee goes for what's in front of it rather than climbing to the top of
     *  the sculpture on every shot; the other two only break ties within the same depth, keeping
     *  the peel visually ordered instead of a random scatter. */
    findTarget(color: number, viewDir: V3): V3 | null {
        const set = this.byColor.get(color);
        if (!set || set.size === 0) return null;
        this.ensureNow(viewDir);

        let right = normalize(cross({ x: 0, y: 1, z: 0 }, viewDir));
        if (right.x === 0 && right.y === 0 && right.z === 0)
            right = { x: 1, y: 0, z: 0 };

        let best: V3 | null = null;
        let bestScore: readonly number[] | null = null;
        for (const i of set) {
            if (this.nowReach[i] !== 1) continue;
            const p = indexToPos(i, this.size);
            const score = [dot(p, viewDir), p.y, dot(p, right)];
            if (!bestScore || compareScore(score, bestScore) > 0) {
                best = p;
                bestScore = score;
            }
        }
        return best;
    }
}
