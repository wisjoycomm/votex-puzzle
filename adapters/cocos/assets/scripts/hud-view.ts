import {
    CCFloat,
    Component,
    Label,
    Layout,
    Node,
    Prefab,
    UITransform,
    Vec2,
    _decorator,
    instantiate,
    tween,
    view,
} from "cc";
import type { GameState } from "core";

import { openStore } from "./cta";
import { HiveView } from "./hive-view";
import { LaneView } from "./lane-view";
import { SocketView } from "./socket-view";

const { ccclass, property } = _decorator;

// x1 is the tuned look; the rest are speed-ups for a player who has already understood the game.
const SPEEDS = [1, 2, 3, 5];

/**
 * Binds the editor-authored HUD to GameCore state. Layout is the scene's; this writes data.
 *
 * Both containers are owned by this component: their children are cleared and respawned, because
 * lane and slot counts come from the level and the core, not from the scene.
 */
@ccclass("HudView")
export class HudView extends Component {
    @property(Node)
    board: Node = null!;

    @property(Prefab)
    lanePrefab: Prefab = null!;

    @property(Node)
    laneContainer: Node = null!;

    @property(Prefab)
    slotPrefab: Prefab = null!;

    @property(Node)
    activeSlotContainer: Node = null!;

    @property(Prefab)
    hivePrefab: Prefab = null!;

    /** Flying hives parent here. Must sit outside any Layout, or it yanks them mid-flight. */
    @property(Node)
    flightLayer: Node = null!;

    @property(CCFloat)
    flyDuration = 0.22;

    @property(Node)
    winPanel: Node = null!;

    @property(Node)
    losePanel: Node = null!;

    @property([Node])
    ctaButtons: Node[] = [];

    /** Tap target that cycles x1 -> x2 -> x3 -> x5. Optional: leave unassigned to pin at x1. */
    @property(Node)
    speedButton: Node = null!;

    @property(Label)
    speedLabel: Label = null!;

    private lanes: LaneView[] = [];
    private slots: SocketView[] = [];
    private onActivate: ((lane: number) => number | null) | null = null;
    private boardFraction = 0;
    private lastState: GameState | null = null;
    /** Slots whose hive is mid-flight, held empty so the flight reads as movement. */
    private flying = new Set<number>();
    private speedIndex = 0;

    bind(onActivate: (lane: number) => number | null): void {
        this.onActivate = onActivate;
        for (const cta of this.ctaButtons) {
            cta.on(Node.EventType.TOUCH_END, () => openStore());
        }
        this.speedButton?.on(Node.EventType.TOUCH_END, () => {
            this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
            this.showSpeed();
        });
        this.showSpeed();
    }

    /** Simulation multiplier. GameView scales its dt by this; the camera rig deliberately ignores it. */
    getSpeed(): number {
        return SPEEDS[this.speedIndex]!;
    }

    private showSpeed(): void {
        if (this.speedLabel) this.speedLabel.string = `x${this.getSpeed()}`;
    }

    private spawn<T extends Component>(
        prefab: Prefab,
        container: Node,
        count: number,
        type: { new (): T },
        label: string,
    ): T[] {
        container.removeAllChildren();
        const out: T[] = [];
        for (let i = 0; i < count; i++) {
            const node = instantiate(prefab);
            node.setPosition(0, 0, 0);
            container.addChild(node);
            const view = node.getComponent(type);
            if (!view) {
                console.warn(`[hud-view] ${label} prefab has no ${type.name}`);
                return out;
            }
            out.push(view);
        }
        // Layout only recomputes on its own cycle, so children added here sit at (0,0,0) until
        // something forces it. Nothing does, for nodes spawned during update().
        container.getComponent(Layout)?.updateLayout(true);
        return out;
    }

    /** Lane count comes from the level, slot count from the core, so neither is a scene decision. */
    private ensureBoard(laneCount: number, slotCount: number): void {
        if (this.lanes.length !== laneCount) {
            if (!this.lanePrefab || !this.laneContainer) {
                console.warn("[hud-view] assign lanePrefab and laneContainer");
            } else {
                this.lanes = this.spawn(
                    this.lanePrefab,
                    this.laneContainer,
                    laneCount,
                    LaneView,
                    "lane",
                );
                this.lanes.forEach((lane, i) =>
                    lane.bind(this.hivePrefab, () => this.activate(i)),
                );
            }
        }
        if (this.slots.length !== slotCount) {
            if (!this.slotPrefab || !this.activeSlotContainer) {
                console.warn(
                    "[hud-view] assign slotPrefab and activeSlotContainer",
                );
            } else {
                this.slots = this.spawn(
                    this.slotPrefab,
                    this.activeSlotContainer,
                    slotCount,
                    SocketView,
                    "slot",
                );
                this.slots.forEach((slot) =>
                    slot.setHivePrefab(this.hivePrefab),
                );
            }
        }
    }

    // Read the hive BEFORE asking core to activate it: the call pops it off the column, so
    // afterwards there is nothing left to describe what should be flying.
    private activate(laneIndex: number): void {
        const hive = this.lastState?.columns[laneIndex]?.[0];
        const from = this.lanes[laneIndex]?.frontNode();
        const slot = this.onActivate?.(laneIndex);
        if (slot === null || slot === undefined || !hive || !from) return;
        this.flyHive(from, slot, hive.color, hive.ammo);
    }

    /**
     * Sockets never move — render() repaints them in place. To sell "the hive moves", fly a
     * throwaway instance over the top and let the real sockets update underneath it.
     */
    private flyHive(
        from: Node,
        slot: number,
        color: number,
        ammo: number,
    ): void {
        const target = this.slots[slot]?.node;
        const layer = this.flightLayer ?? this.board;
        if (!this.hivePrefab || !target || !layer) return;

        const node = instantiate(this.hivePrefab);
        layer.addChild(node);
        node.getComponent(HiveView)?.show(color, ammo);
        node.worldPosition = from.worldPosition.clone();

        this.flying.add(slot);
        tween(node)
            .to(
                this.flyDuration,
                { worldPosition: target.worldPosition.clone() },
                { easing: "quadOut" },
            )
            .call(() => {
                this.flying.delete(slot);
                node.destroy();
            })
            .start();
    }

    refresh(state: GameState): void {
        this.lastState = state;

        setActive(this.board, state.status === "playing");
        setActive(this.winPanel, state.status === "won");
        setActive(this.losePanel, state.status === "lost");

        this.ensureBoard(state.columns.length, state.slots.length);

        // Firing slots stay visible when empty; only queue sockets hide.
        // A lane can only be fired into a free slot, so with the pool full nothing is choosable.
        const hasFreeSlot = state.slots.some((slot) => slot === null);

        this.slots.forEach((socket, i) => {
            const hive = this.flying.has(i) ? undefined : state.slots[i];
            socket.render(hive?.color, hive?.ammo);
            socket.setDimmed(!hive);
        });
        this.lanes.forEach((lane, i) =>
            lane.render(state.columns[i] ?? [], hasFreeSlot),
        );

        this.boardFraction = this.measureBoardFraction();
    }

    /**
     * How much of the screen the HUD actually covers, measured from the containers rather than
     * from `board` — `board` is a full-screen node, so its own height says nothing about how far
     * up the content reaches. Taken from the highest top edge of the two rows, in screen space.
     */
    private measureBoardFraction(): number {
        if (!this.board?.active) return 0;
        const height = view.getVisibleSize().height;
        let top = 0;
        for (const container of [
            this.activeSlotContainer,
            this.laneContainer,
        ]) {
            if (!container?.activeInHierarchy) continue;
            const ui = container.getComponent(UITransform);
            if (!ui) continue;
            top = Math.max(top, ui.getBoundingBoxToWorld().yMax);
        }
        return Math.min(1, Math.max(0, top) / Math.max(height, 1));
    }

    getBoardFraction(): number {
        return this.boardFraction;
    }

    /** Global `input` fires even for touches on UI nodes, so the drag rig asks before dragging. */
    hitsUi(point: Vec2): boolean {
        for (const cta of this.ctaButtons) {
            if (covers(cta, point)) return true;
        }
        if (!this.board?.active) return false;
        if (covers(this.speedButton, point)) return true;
        return this.lanes.some((lane) => lane.hits(point));
    }
}

function covers(node: Node | null, point: Vec2): boolean {
    if (!node?.activeInHierarchy) return false;
    return !!node
        .getComponent(UITransform)
        ?.getBoundingBoxToWorld()
        .contains(point);
}

function setActive(node: Node | null, active: boolean): void {
    if (node) node.active = active;
}
