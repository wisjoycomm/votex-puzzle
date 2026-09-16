import { Color, Component, Label, MeshRenderer, _decorator } from "cc";

import { hexFor } from "./colors";

const { ccclass, property } = _decorator;

const TINT_PROPERTY = "mainColor";

@ccclass("HiveView")
export class HiveView extends Component {
    @property(MeshRenderer)
    model: MeshRenderer = null!;

    @property(Label)
    ammoTxt: Label = null!;

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
}
