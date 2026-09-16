import { Animation, Component, Node, _decorator } from "cc";

const { ccclass, property } = _decorator;

/**
 * The hive at the top of the board — where bees deliver the cubes they pull out of the sculpture.
 *
 * Holds no game state: the core never models this hive, so there is nothing here to keep in sync.
 */
@ccclass("TopHiveView")
export class TopHiveView extends Component {
    /** The hole bees fly into. Leave empty to aim at the hive's centre. */
    @property(Node)
    hole: Node = null!;

    /** Where a bee delivers, in world space. */
    get mouth(): Node {
        return this.hole ?? this.node;
    }

    /** A cube just went through the hole. play() restarts, so a volley reads as repeated gulps. */
    deliver(): void {
        this.getComponent(Animation)?.play();
    }
}
