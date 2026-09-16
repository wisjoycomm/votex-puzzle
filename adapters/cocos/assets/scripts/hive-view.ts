import {
    Color,
    Component,
    Label,
    MeshRenderer,
    Node,
    Tween,
    Vec3,
    _decorator,
    tween,
} from "cc";

import { hexFor } from "./colors";

const { ccclass, property } = _decorator;

const TINT_PROPERTY = "mainColor";

// How far the body swells on a pop, and how long each half of the punch takes in seconds. Short
// on purpose: this fires on every tap and every shot, so anything slower reads as sluggish.
const POP_SCALE = 1.1;
const POP_SECONDS = 0.05;

@ccclass("HiveView")
export class HiveView extends Component {
    @property(MeshRenderer)
    model: MeshRenderer = null!;

    @property(Label)
    ammoTxt: Label = null!;

    /** The hole bees fly out of. Leave empty to launch from the hive's own centre. */
    @property(Node)
    hole: Node = null!;

    /** Where a bee enters and leaves this hive, in world space. */
    get mouth(): Node {
        return this.hole ?? this.node;
    }

    private baseScale: Vec3 | null = null;

    get shown(): boolean {
        return this.node.active;
    }

    // Required, not optional: an empty socket calls hide(). Optional params here would compile
    // and then throw on the first empty render.
    show(color: number, ammo: number): void {
        this.node.active = true;
        // Per-renderer instance: every hive is a different colour, so they cannot share a material.
        this.model
            ?.getMaterialInstance(0)
            ?.setProperty(TINT_PROPERTY, new Color().fromHEX(hexFor(color)));
        if (this.ammoTxt) this.ammoTxt.string = String(ammo);
    }

    hide(): void {
        this.node.active = false;
    }

    /** Punch the 3D body: a tap landed, or a bee just came out of the hole. */
    pop(): void {
        const node = this.model?.node;
        if (!node) return;
        // Captured once, not read live: a pop landing mid-tween would otherwise compound off the
        // swollen scale and the hive would creep bigger with every shot.
        if (!this.baseScale) this.baseScale = node.scale.clone();
        const base = this.baseScale;

        // Restart rather than queue, so a fast lane reads as repeated pops instead of drifting.
        Tween.stopAllByTarget(node);
        node.setScale(base);
        tween(node)
            .to(
                POP_SECONDS,
                { scale: Vec3.multiplyScalar(new Vec3(), base, POP_SCALE) },
                { easing: "quadOut" },
            )
            .to(POP_SECONDS, { scale: base.clone() }, { easing: "quadIn" })
            .start();
    }
}
