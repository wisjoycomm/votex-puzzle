import {
    CCFloat,
    CCInteger,
    Component,
    Layout,
    Node,
    Prefab,
    UITransform,
    Vec2,
    Tween,
    Vec3,
    _decorator,
    instantiate,
    tween,
} from "cc";
import type { GameState } from "core";

import { playSfx } from "./audio-manager";
import { SocketView } from "./socket-view";

const { ccclass, property } = _decorator;

@ccclass("LaneView")
export class LaneView extends Component {
    @property(Prefab)
    socketPrefab: Prefab = null!;

    @property(Node)
    socketContainer: Node = null!;

    /** How many queue entries to show. A display choice — a lane holds ~18 hives. */
    @property(CCInteger)
    previewDepth = 3;

    /** Gap between sockets. Ignored if socketContainer has its own Layout. */
    @property(CCFloat)
    socketSpacing = 16;

    /** Seconds for the queue to slide up after a hive leaves. */
    @property(CCFloat)
    shiftDuration = 0.18;

    private sockets: SocketView[] = [];
    /** Resting y of the socket container, so a shift can tween back to it. */
    private baseY = 0;
    /** Queues only shrink from the front, so a drop here means the stack moved up by one. */
    private lastQueueLen = -1;

    bind(hivePrefab: Prefab, onActivate: () => void): void {
        this.spawnSockets(hivePrefab);
        const front = this.sockets[0];
        if (!front) return;
        front.node.on(Node.EventType.TOUCH_END, () => {
            if (!front.filled) return;
            playSfx("click");
            front.pop();
            onActivate();
        });
    }

    private spawnSockets(hivePrefab: Prefab): void {
        if (this.sockets.length > 0) return;
        if (!this.socketPrefab || !this.socketContainer) {
            console.warn(
                `[lane-view] ${this.node.name}: assign socketPrefab and socketContainer`,
            );
            return;
        }
        this.socketContainer.removeAllChildren();
        for (let q = 0; q < this.previewDepth; q++) {
            const node = instantiate(this.socketPrefab);
            node.setPosition(0,0,0);
            this.socketContainer.addChild(node);
            const socket = node.getComponent(SocketView);
            if (!socket) {
                console.warn("[lane-view] socketPrefab has no SocketView");
                return;
            }
            socket.setHivePrefab(hivePrefab);
            this.sockets.push(socket);
        }
        const layout = this.socketContainer.getComponent(Layout);
        // Defer to a Layout if the scene has one; otherwise stack them here. Either way the
        // sockets end up centred on the container instead of overflowing it.
        if (layout) layout.updateLayout(true);
        else this.stackSockets();
        this.baseY = this.socketContainer.position.y;
    }

    /**
     * The sockets never move — render() repaints them in place, so a consumed hive would just pop.
     * Repainting already put every hive at its new socket, so sliding the whole container up from
     * one step below replays that jump as movement, and the new bottom preview slides in.
     */
    private playShift(): void {
        const a = this.sockets[0]?.node;
        const b = this.sockets[1]?.node;
        if (!a || !b) return;
        const step = Math.abs(a.position.y - b.position.y);
        if (step <= 0) return;

        const container = this.socketContainer;
        Tween.stopAllByTarget(container);
        container.setPosition(container.position.x, this.baseY - step, 0);
        tween(container)
            .to(
                this.shiftDuration,
                { position: new Vec3(container.position.x, this.baseY, 0) },
                { easing: "quadOut" },
            )
            .start();
    }

    /** Front socket on top, nearest the firing row, with the whole stack centred vertically. */
    private stackSockets(): void {
        const step =
            (this.sockets[0]?.getComponent(UITransform)?.height ?? 0) +
            this.socketSpacing;
        const top = ((this.sockets.length - 1) * step) / 2;
        this.sockets.forEach((socket, i) =>
            socket.node.setPosition(0, top - i * step, 0),
        );
    }

    /** Front socket node, for a hive flying out of it. Null while the lane is empty. */
    frontNode(): Node | null {
        const front = this.sockets[0];
        return front?.filled ? front.node : null;
    }

    render(queue: GameState["columns"][number], canActivate: boolean): void {
        this.sockets.forEach((socket, q) => {
            if (!socket) return;
            const hive = queue[q];
            socket.render(hive?.color, hive?.ammo);
            socket.node.active = !!hive;
            // Only the front socket is tappable, and only while a firing slot is free.
            socket.setDimmed(!(q === 0 && !!hive && canActivate));
        });

        if (queue.length < this.lastQueueLen) this.playShift();
        this.lastQueueLen = queue.length;
    }

    hits(point: Vec2): boolean {
        const front = this.sockets[0];
        if (!front?.node.active) return false;
        return front.node
            .getComponent(UITransform)!
            .getBoundingBoxToWorld()
            .contains(point);
    }
}
