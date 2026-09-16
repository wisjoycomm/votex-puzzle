import {
    CCInteger,
    Component,
    Prefab,
    UIOpacity,
    _decorator,
    instantiate,
} from "cc";

import { HiveView } from "./hive-view";

const { ccclass, property } = _decorator;

@ccclass("SocketView")
export class SocketView extends Component {
    /** Opacity (0-255) while this socket cannot be chosen. */
    @property(CCInteger)
    dimOpacity = 128;

    // Not a @property: the prefab is handed down from HudView so the whole board is wired once.
    private hivePrefab: Prefab | null = null;
    private hive: HiveView | null = null;

    get filled(): boolean {
        return !!this.hive?.shown;
    }

    setHivePrefab(prefab: Prefab): void {
        this.hivePrefab = prefab;
    }

    render(color?: number, ammo?: number): void {
        this.ensureHive();
        if (color === undefined || ammo === undefined) this.hive?.hide();
        else this.hive?.show(color, ammo);
    }

    setDimmed(dimmed: boolean): void {
        const ui =
            this.getComponent(UIOpacity) ?? this.addComponent(UIOpacity);
        ui.opacity = dimmed ? this.dimOpacity : 255;
    }

    private ensureHive(): void {
        if (this.hive || !this.hivePrefab) return;
        const node = instantiate(this.hivePrefab);
        node.setPosition(0, 0, 0);
        this.node.addChild(node);
        this.hive = node.getComponent(HiveView);
        if (!this.hive)
            console.warn("[socket-view] hivePrefab has no HiveView");
    }
}
