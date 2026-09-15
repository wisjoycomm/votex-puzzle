import type { GameEvent, GridSize, V3 } from "./events.ts";
import { VotexGrid } from "./grid.ts";
import { LaneQueue, Shooter, type HiveDef } from "./lane.ts";

export interface LevelDef {
    size: GridSize;
    cells: (number | null)[];
    lanes: HiveDef[][];
    maxBends?: number;
}

export interface Frame {
    duration: number;
    state: GameState;
}

export interface SlotState {
    color: number;
    ammo: number;
}

export interface GameState {
    seed: number;
    grid: GridSize;
    columns: HiveDef[][];
    slots: (SlotState | null)[];
    viewDir: V3;
    status: "playing" | "won" | "lost";
}

type Handler<T extends GameEvent["t"]> = (
    event: Extract<GameEvent, { t: T }>,
) => void;

const SLOT_COUNT = 5;

export class GameCore {
    private readonly grid: VotexGrid;
    private readonly seed: number;
    private readonly columns: LaneQueue[];
    private readonly slots: (Shooter | null)[];
    private viewDir: V3 = { x: 0, y: 0, z: 1 };
    private status: GameState["status"] = "playing";
    private time = 0;
    private pending: GameEvent[] = [];
    private readonly listeners = new Map<
        GameEvent["t"],
        Set<(event: GameEvent) => void>
    >();

    constructor(level: LevelDef, seed: number) {
        this.grid = new VotexGrid(level.size, level.cells, level.maxBends);
        this.seed = seed;
        this.columns = level.lanes.map((queue) => new LaneQueue(queue));
        this.slots = new Array(SLOT_COUNT).fill(null);
    }
    //#region Observer
    on<T extends GameEvent["t"]>(type: T, handler: Handler<T>): void {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(handler as (event: GameEvent) => void);
    }

    off<T extends GameEvent["t"]>(type: T, handler: Handler<T>): void {
        this.listeners.get(type)?.delete(handler as (event: GameEvent) => void);
    }

    private emit(event: GameEvent): void {
        this.listeners.get(event.t)?.forEach((handler) => handler(event));
    }
    //#endregion
    update(dt: number): Frame {
        this.time += dt;
        if (this.status === "playing") {
            this.slots.forEach((shooter, i) => {
                if (!shooter) return;
                shooter.fire(i, dt, this.grid, this.viewDir, this.time, this.pending);
                if (shooter.isExhausted()) this.slots[i] = null;
            });
            this.checkWinLoss();
        }
        const events = this.pending;
        this.pending = [];
        for (const event of events) this.emit(event);
        return { duration: dt, state: this.getState() };
    }

    getState(): GameState {
        return {
            seed: this.seed,
            grid: this.grid.size,
            columns: this.columns.map((c) => c.snapshot()),
            slots: this.slots.map((s) => s?.snapshot() ?? null),
            viewDir: this.viewDir,
            status: this.status,
        };
    }

    private checkWinLoss(): void {
        if (this.grid.isCleared()) {
            this.status = "won";
            this.pending.push({ t: "gameWon", at: this.time });
            return;
        }

        // Only colors currently loaded into a firing slot can be "stuck" — a color
        // still waiting in a column hasn't been exposed yet and may become reachable
        // once other slots clear cubes in front of it.
        const activeColors = new Set<number>();
        for (const s of this.slots) {
            const color = s?.color();
            if (color !== null && color !== undefined) activeColors.add(color);
        }

        for (const color of activeColors) {
            const cells = this.grid.cellsOfColor(color);
            if (cells.length === 0) continue;
            const stuck = cells.every((p) => !this.grid.reachableEver(p));
            if (stuck) {
                this.status = "lost";
                this.pending.push({ t: "gameLost", at: this.time });
                return;
            }
        }
    }

    setViewDirection(dir: V3): void {
        this.viewDir = dir;
    }

    /**
     * Click a hive in a waiting column. Normally only itemIndex 0 (the
     * column's front) is allowed; opts.booster bypasses that to pull any
     * item, closing the gap behind it. Slots are a shared pool: a column may
     * hold several at once, and takes the lowest-numbered free one.
     * Returns the slot it landed in, or null if nothing activated, so a caller
     * (HUD fly animation, etc.) doesn't have to re-derive that from state.
     */
    activateColumn(
        columnIndex: number,
        itemIndex = 0,
        opts?: { booster?: boolean },
    ): number | null {
        if (this.status !== "playing") return null;
        if (itemIndex !== 0 && !opts?.booster) return null;

        const column = this.columns[columnIndex];
        if (!column) return null;

        const freeSlot = this.slots.findIndex((s) => s === null);
        if (freeSlot === -1) return null;

        const hive =
            itemIndex === 0 ? column.popFront() : column.popAt(itemIndex);
        if (!hive) return null;

        const shooter = new Shooter();
        this.slots[freeSlot] = shooter;
        shooter.activate(hive, this.time, freeSlot, this.pending);
        return freeSlot;
    }
}
