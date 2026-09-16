import {
    Camera,
    Component,
    EffectAsset,
    JsonAsset,
    Mesh,
    Vec3,
    _decorator,
    view,
} from "cc";
import { GameCore, parseBoxyBlastLevel } from "core";
import type { BoxyBlastLevel, LevelDef } from "core";
import { isVisible, whenReady } from "playable-ads-core";

import { createCameraRig } from "./camera-rig";
import type { CameraRig } from "./camera-rig";
import { HudView } from "./hud-view";
import { buildSculpture, destroyCube } from "./sculpture";
import type { Sculpture } from "./sculpture";

const { ccclass, property } = _decorator;

// Framing knobs — tune these on device, they're the ones that decide how big teddy reads.
// Camera distance in bounding-sphere radii: apparent size goes as 1/distance, so smaller is bigger.
const DISTANCE_RADII = 3;
// Floor on the share of the height left for the model once the HUD has taken its cut.
const MIN_FREE_HEIGHT = 0.65;
// Level, straight-on camera: the tilt comes from the level's own DefaultRotation, applied to the
// sculpture by the camera rig. An angled camera here would double-count it — with both, teddy ends
// up on his back showing the camera the top of his head.

@ccclass("GameView")
export class GameView extends Component {
    // Explicit rather than Camera.main: the scene has two cameras (this one and the Canvas UI
    // camera), so Camera.main would be a coin toss.
    @property({ type: Camera, tooltip: "The 3D scene camera" })
    sceneCamera: Camera = null!;

    @property({ type: Mesh, tooltip: "Cube mesh, from bee-cube-2.fbx" })
    cubeMesh: Mesh = null!;

    @property({ type: EffectAsset, tooltip: "bee-master.effect" })
    toonEffect: EffectAsset = null!;

    // Drag a different level in to swap levels — `easy` is the 10x2x10 one to debug against
    // before trying the 4000-cube `teddy`. Inspector-referenced assets load as scene
    // dependencies, so this is already populated by the time start() runs; no resources.load,
    // no async, no `resources/` folder.
    @property({
        type: JsonAsset,
        tooltip: "levels/teddy.json or levels/easy.json",
    })
    levelData: JsonAsset = null!;

    @property({
        type: HudView,
        tooltip: "The HudView component on the Canvas",
    })
    hudView: HudView = null!;

    private core!: GameCore;
    private sculpture!: Sculpture;
    private rig!: CameraRig;
    /** Share of the viewport the HUD board covers. Zero until the HUD has laid out. */
    private boardFraction = 0;
    private distance = 0;
    private lastWidth = 0;
    private lastHeight = 0;

    start(): void {
        if (
            !this.sceneCamera ||
            !this.cubeMesh ||
            !this.toonEffect ||
            !this.levelData ||
            !this.hudView
        ) {
            console.error(
                "[game-view] assign sceneCamera, cubeMesh, toonEffect, levelData and hudView in the Inspector",
            );
            return;
        }
        // Fire-and-forget: Cocos does not await start(). update() no-ops until `core` exists.
        void this.init();
    }

    /** Nothing is built until the ad container says it is showing us. No-op without an MRAID SDK. */
    private async init(): Promise<void> {
        await whenReady();

        // `as unknown as`: JsonAsset.json is typed `any`-ish and the cube quads widen to number[].
        const level: LevelDef = parseBoxyBlastLevel(
            this.levelData.json as unknown as BoxyBlastLevel,
        );

        this.sculpture = buildSculpture(
            this.node,
            level,
            this.cubeMesh,
            this.toonEffect,
        );
        this.distance = this.sculpture.radius * DISTANCE_RADII;
        this.frameCamera();

        this.core = new GameCore(level, Date.now());
        this.hudView.bind((lane) => this.core.activateColumn(lane));
        this.rig = createCameraRig(
            this.sculpture.root,
            this.sceneCamera.node,
            (point) => this.hudView.hitsUi(point),
            level.initialRotation,
        );

        this.core.on("cubeShot", (e) => destroyCube(this.sculpture, e.cell));
        this.core.on("gameWon", () => console.log("[game-view] WON"));
        this.core.on("gameLost", () => console.log("[game-view] LOST"));

        console.log(
            `[game-view] ${this.sculpture.cubes.size} cubes, radius ${this.sculpture.radius.toFixed(2)}, ` +
                `${level.lanes.length} lanes — tap a hive to fire`,
        );
    }

    onDestroy(): void {
        this.rig?.destroy();
    }

    /**
     * No resize listener: an ad slot can resize without firing one, so this is polled from update()
     * instead. Distance depends on aspect, so a reshaped viewport has to reframe.
     */
    private frameCamera(): void {
        const size = view.getVisibleSize();
        const aspect = size.width / Math.max(size.height, 1);
        // fov is vertical, so only a slot narrower than it is tall needs distance to fit the width.
        const forWidth = aspect < 1 ? this.distance / aspect : this.distance;
        // The board is a fixed height, so the shorter the slot the more of the frame it claims.
        // Floor it so a very short viewport cannot push the camera towards infinity.
        const free = Math.max(MIN_FREE_HEIGHT, 1 - this.boardFraction);
        this.sceneCamera.node.setPosition(0, 0, forWidth / free);
        this.sceneCamera.node.lookAt(Vec3.ZERO);
    }

    update(dt: number): void {
        if (!this.core) return;

        // Poll for a resized ad slot; the camera reframes because distance depends on aspect.
        const size = view.getVisibleSize();
        if (size.width !== this.lastWidth || size.height !== this.lastHeight) {
            this.lastWidth = size.width;
            this.lastHeight = size.height;
            this.frameCamera();
        }

        // Off-screen or backgrounded: keep drawing, stop the clock.
        if (!isVisible()) return;

        // The speed control scales the simulation, but not the camera rig — rotation follows the
        // player's hand, and speeding that up just reads as a bug.
        this.rig.update(dt);
        this.core.setViewDirection(this.rig.getViewDir());
        const frame = this.core.update(dt * this.hudView.getSpeed());
        this.hudView.refresh(frame.state);
        // After refresh: fitBoard() runs in there. Reframing every frame rather than off the
        // resize poll — the camera depends on the board, so it cannot be a frame behind it.
        this.boardFraction = this.hudView.getBoardFraction();
        this.frameCamera();
    }
}
