import type { GridSize, V3 } from "./events.ts";

const DIRECTIONS: readonly V3[] = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
];

function add(a: V3, b: V3): V3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sameDir(a: V3, b: V3): boolean {
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

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

function indexToPos(i: number, size: GridSize): V3 {
    const x = i % size.nx;
    const y = Math.floor(i / size.nx) % size.ny;
    const z = Math.floor(i / (size.nx * size.ny));
    return { x, y, z };
}

export class VotexGrid {
    readonly size: GridSize;
    private readonly cells: VotexCell[];
    private readonly maxBends: number;

    constructor(size: GridSize, cells: (number | null)[], maxBends = 2) {
        this.size = size;
        this.cells = cells.map(
            (value, i) => new VotexCell(indexToPos(i, size), null, value),
        );
        this.maxBends = maxBends;
    }

    private idx(p: V3): number {
        return p.x + p.y * this.size.nx + p.z * this.size.nx * this.size.ny;
    }

    private inBounds(p: V3): boolean {
        return (
            p.x >= 0 &&
            p.x < this.size.nx &&
            p.y >= 0 &&
            p.y < this.size.ny &&
            p.z >= 0 &&
            p.z < this.size.nz
        );
    }

    remove(p: V3): void {
        this.cells[this.idx(p)]!.value = null;
    }

    isCleared(): boolean {
        return this.cells.every((c) => c.value === null);
    }

    cellsOfColor(color: number): V3[] {
        const out: V3[] = [];
        for (const cell of this.cells) {
            if (cell.value === color) out.push(cell.pos);
        }
        return out;
    }

    /** BFS from `origin`'s neighbors through empty cells to the grid exterior, bending direction up
     *  to maxBends times. `exitFilter` restricts which exterior faces count as a valid exit. */
    private canEscape(origin: V3, exitFilter?: (dir: V3) => boolean): boolean {
        type State = { p: V3; dir: V3; bends: number };
        const visited = new Set<string>();
        const queue: State[] = [];
        const key = (p: V3, dir: V3) =>
            `${p.x},${p.y},${p.z}|${dir.x},${dir.y},${dir.z}`;

        const step = (from: V3, dir: V3, bends: number): boolean => {
            const n = add(from, dir);
            if (!this.inBounds(n)) return !exitFilter || exitFilter(dir);
            if (this.cells[this.idx(n)]!.value !== null) return false;
            const k = key(n, dir);
            if (visited.has(k)) return false;
            visited.add(k);
            queue.push({ p: n, dir, bends });
            return false;
        };

        for (const d of DIRECTIONS) {
            if (step(origin, d, 0)) return true;
        }
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++]!;
            for (const d of DIRECTIONS) {
                const bends = cur.bends + (sameDir(d, cur.dir) ? 0 : 1);
                if (bends > this.maxBends) continue;
                if (step(cur.p, d, bends)) return true;
            }
        }
        return false;
    }

    /** Reachable right now: the escape path must exit on a face currently facing the camera. */
    reachableNow(origin: V3, viewDir: V3): boolean {
        return this.canEscape(origin, (dir) => dot(dir, viewDir) > 0);
    }

    /** Reachable from *some* rotation — the player can always spin to face any exit face. */
    reachableEver(origin: V3): boolean {
        return this.canEscape(origin);
    }

    /** Best target for a shooter of `color`: highest, then nearest camera, then rightmost — so the
     *  sculpture unwraps in a visually ordered way instead of a random scatter. */
    findTarget(color: number, viewDir: V3): V3 | null {
        let right = normalize(cross({ x: 0, y: 1, z: 0 }, viewDir));
        if (right.x === 0 && right.y === 0 && right.z === 0)
            right = { x: 1, y: 0, z: 0 };

        let best: V3 | null = null;
        let bestScore: readonly number[] | null = null;
        for (const p of this.cellsOfColor(color)) {
            if (!this.reachableNow(p, viewDir)) continue;
            const score = [p.y, dot(p, viewDir), dot(p, right)];
            if (!bestScore || compareScore(score, bestScore) > 0) {
                best = p;
                bestScore = score;
            }
        }
        return best;
    }
}

export class VotexCell {
    readonly pos: V3;
    readonly hexColor: string | null;
    value: number | null;

    constructor(pos: V3, hex: string | null, value: number | null) {
        this.pos = pos;
        this.hexColor = hex;
        this.value = value;
    }
}
