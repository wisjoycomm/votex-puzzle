import type { GameEvent, V3 } from "./events.ts";
import type { VotexGrid } from "./grid.ts";

export interface HiveDef {
    color: number;
    ammo: number;
}

const FIRE_INTERVAL = 0.35;
const RETRY_INTERVAL = 0.2;

/** One of the 5 waiting columns. Holds hives; never fires. */
export class LaneQueue {
    private readonly items: HiveDef[];

    constructor(items: HiveDef[]) {
        this.items = items.slice();
    }

    popFront(): HiveDef | undefined {
        return this.items.shift();
    }

    popAt(index: number): HiveDef | undefined {
        return this.items.splice(index, 1)[0];
    }

    snapshot(): HiveDef[] {
        return this.items.slice();
    }
}

/** One of the 5 fixed slots. Holds at most one hive; only slots fire. */
export class Shooter {
    private hive: HiveDef | null = null;
    private timer = 0;

    activate(hive: HiveDef, time: number, slot: number, events: GameEvent[]): void {
        this.hive = hive;
        this.timer = FIRE_INTERVAL;
        events.push({
            t: "hiveActivated",
            slot,
            color: hive.color,
            ammo: hive.ammo,
            at: time,
        });
    }

    fire(
        slot: number,
        dt: number,
        grid: VotexGrid,
        viewDir: V3,
        time: number,
        events: GameEvent[],
    ): void {
        if (!this.hive) return;
        this.timer -= dt;
        if (this.timer > 0) return;

        const target = grid.findTarget(this.hive.color, viewDir);
        if (!target) {
            this.timer = RETRY_INTERVAL;
            return;
        }

        // Captured before the removal: afterwards the cell is empty and has no route to it.
        const path = grid.pathTo(target, viewDir);

        grid.remove(target);
        this.hive.ammo--;
        events.push({
            t: "cubeShot",
            slot,
            cell: target,
            color: this.hive.color,
            ammoRemaining: this.hive.ammo,
            path,
            at: time,
        });

        if (this.hive.ammo <= 0) {
            events.push({ t: "laneDepleted", slot, at: time });
            this.hive = null;
            this.timer = 0;
        } else {
            this.timer = FIRE_INTERVAL;
        }
    }

    isExhausted(): boolean {
        return this.hive === null;
    }

    color(): number | null {
        return this.hive ? this.hive.color : null;
    }

    snapshot(): { color: number; ammo: number } | null {
        return this.hive ? { color: this.hive.color, ammo: this.hive.ammo } : null;
    }
}
