import { Component, Node, UIOpacity, Vec3, _decorator, tween } from "cc";

import { playSfx } from "./audio-manager";
import { openStore } from "./cta";

const { ccclass, property } = _decorator;

// Entrance timing. Longer reads calmer but delays the CTA, which is the whole point of the screen.
const POP_DURATION = 0.28;
// Scale the panel starts at. Lower is a bigger pop; above 1 it shrinks into place instead.
const POP_FROM = 0.7;
const FULL_SCALE = new Vec3(1, 1, 1);

@ccclass("EndView")
export class EndView extends Component {
    /** The call-to-action. Needs a sized UITransform, or the tap lands on nothing. */
    @property(Node)
    cta: Node = null!;

    bind(): void {
        this.cta?.on(Node.EventType.TOUCH_END, () => {
            playSfx("click");
            openStore();
        });
    }

    /** Called every frame by HudView.refresh, so the entrance runs on the edge, not on each call. */
    setShown(shown: boolean): void {
        if (shown === this.node.active) return;
        this.node.active = shown;
        if (shown) this.pop();
    }

    // UIOpacity rather than tinting each child: it multiplies down the hierarchy, so one tween
    // fades the dim, both labels and the button together.
    private pop(): void {
        const fade = this.getComponent(UIOpacity) ?? this.addComponent(UIOpacity);
        fade.opacity = 0;
        tween(fade).to(POP_DURATION, { opacity: 255 }).start();

        this.node.setScale(POP_FROM, POP_FROM, 1);
        tween(this.node)
            .to(POP_DURATION, { scale: FULL_SCALE }, { easing: "backOut" })
            .start();
    }
}
