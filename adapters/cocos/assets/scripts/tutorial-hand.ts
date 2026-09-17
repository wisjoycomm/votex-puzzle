import { CCFloat, Component, Node, Tween, Vec3, _decorator, tween } from "cc";

const { ccclass, property } = _decorator;

@ccclass("TutorialHand")
export class TutorialHand extends Component {
    @property(Vec3)
    offset = new Vec3(60, -40, 0);

    /** How far the hand dips on each tap. Larger reads as a harder press. */
    @property(CCFloat)
    bob = 24;

    /** Seconds for one down-up. Lower is more insistent. */
    @property(CCFloat)
    bobDuration = 0.45;

    /** Once the player has acted the hint never comes back. */
    private done = false;

    protected onLoad(): void {
        this.node.active = false;
    }

    pointAt(target: Node | null): void {
        if (this.done || !target) return;
        // Active first: a node that has never been enabled has no usable world transform.
        this.node.active = true;
        this.node.worldPosition = target.worldPosition.clone().add(this.offset);

        const rest = this.node.position.clone();
        const down = rest.clone().subtract3f(0, this.bob, 0);
        Tween.stopAllByTarget(this.node);
        tween(this.node)
            .to(this.bobDuration / 2, { position: down }, { easing: "quadOut" })
            .to(this.bobDuration / 2, { position: rest }, { easing: "quadIn" })
            .union()
            .repeatForever()
            .start();
    }

    hide(): void {
        this.done = true;
        Tween.stopAllByTarget(this.node);
        this.node.active = false;
    }
}
