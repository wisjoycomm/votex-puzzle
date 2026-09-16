import { Camera, Component, EffectAsset, EventKeyboard, Input, JsonAsset, KeyCode, Mesh, Vec3, _decorator, input, view } from 'cc';
import { GameCore, parseBoxyBlastLevel } from 'core';
import type { BoxyBlastLevel, LevelDef } from 'core';
import { isVisible, whenReady } from 'playable-ads-core';

import { createCameraRig } from './camera-rig';
import type { CameraRig } from './camera-rig';
import { buildSculpture, destroyCube } from './sculpture';
import type { Sculpture } from './sculpture';

const { ccclass, property } = _decorator;

// Framing knobs — tune these on device, they're the ones that decide how big teddy reads.
// Camera distance in bounding-sphere radii: apparent size goes as 1/distance, so smaller is bigger.
const DISTANCE_RADII = 3.33;
// Level, straight-on camera: the tilt comes from the level's own DefaultRotation, applied to the
// sculpture by the camera rig. An angled camera here would double-count it — with both, teddy ends
// up on his back showing the camera the top of his head.

@ccclass('GameView')
export class GameView extends Component {
    // Explicit rather than Camera.main: explicit is testable, and a second camera gets added for
    // the UI in Phase F.
    @property({ type: Camera, tooltip: 'The 3D scene camera' })
    sceneCamera: Camera = null!;

    @property({ type: Mesh, tooltip: 'Cube mesh, from bee-cube-2.fbx' })
    cubeMesh: Mesh = null!;

    @property({ type: EffectAsset, tooltip: 'bee-master.effect' })
    toonEffect: EffectAsset = null!;

    // Drag a different level in to swap levels — `easy` is the 10x2x10 one to debug against
    // before trying the 4000-cube `teddy`. Inspector-referenced assets load as scene
    // dependencies, so this is already populated by the time start() runs; no resources.load,
    // no async, no `resources/` folder.
    @property({ type: JsonAsset, tooltip: 'levels/teddy.json or levels/easy.json' })
    levelData: JsonAsset = null!;

    private core!: GameCore;
    private sculpture!: Sculpture;
    private rig!: CameraRig;
    private distance = 0;
    private lastWidth = 0;
    private lastHeight = 0;

    start(): void {
        if (!this.sceneCamera || !this.cubeMesh || !this.toonEffect || !this.levelData) {
            console.error('[game-view] assign sceneCamera, cubeMesh, toonEffect and levelData in the Inspector');
            return;
        }
        // Fire-and-forget: Cocos does not await start(). update() no-ops until `core` exists.
        void this.init();
    }

    /** Nothing is built until the ad container says it is showing us. No-op without an MRAID SDK. */
    private async init(): Promise<void> {
        await whenReady();

        // `as unknown as`: JsonAsset.json is typed `any`-ish and the cube quads widen to number[].
        const level: LevelDef = parseBoxyBlastLevel(this.levelData.json as unknown as BoxyBlastLevel);

        this.sculpture = buildSculpture(this.node, level, this.cubeMesh, this.toonEffect);
        this.distance = this.sculpture.radius * DISTANCE_RADII;
        this.frameCamera();

        this.core = new GameCore(level, Date.now());
        this.rig = createCameraRig(
            this.sculpture.root,
            this.sceneCamera.node,
            level.initialRotation
        );

        this.core.on('cubeShot', (e) => destroyCube(this.sculpture, e.cell));
        this.core.on('gameWon', () => console.log('[game-view] WON'));
        this.core.on('gameLost', () => console.log('[game-view] LOST'));

        // ponytail: keyboard stand-in so cubes can be made to disappear before the hive UI exists.
        // Phase F replaces it with tap-to-activate; delete this handler then.
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);

        console.log(
            `[game-view] ${this.sculpture.cubes.size} cubes, radius ${this.sculpture.radius.toFixed(2)}, ` +
            `${level.lanes.length} lanes — press 1-5 to fire a lane`
        );
    }

    onDestroy(): void {
        this.rig?.destroy();
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    }

    private onKeyDown(event: EventKeyboard): void {
        const lane = [
            KeyCode.DIGIT_1, KeyCode.DIGIT_2, KeyCode.DIGIT_3, KeyCode.DIGIT_4, KeyCode.DIGIT_5
        ].indexOf(event.keyCode);
        if (lane === -1) return;
        const slot = this.core.activateColumn(lane);
        console.log(`[game-view] lane ${lane} -> slot ${slot}`);
    }

    /**
     * No resize listener: an ad slot can resize without firing one, so this is polled from update()
     * instead. Distance depends on aspect, so a reshaped viewport has to reframe.
     */
    private frameCamera(): void {
        const size = view.getVisibleSize();
        const aspect = size.width / Math.max(size.height, 1);
        // fov is vertical, so only a slot narrower than it is tall needs distance to fit the width.
        const distance = aspect < 1 ? this.distance / aspect : this.distance;
        this.sceneCamera.node.setPosition(0, 0, distance);
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

        this.rig.update(dt);
        this.core.setViewDirection(this.rig.getViewDir());
        this.core.update(dt);
    }
}
