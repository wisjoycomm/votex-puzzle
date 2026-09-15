import { GameCore, parseBoxyBlastLevel } from 'core';
import type { BoxyBlastLevel } from 'core';
import { isVisible, whenReady } from 'playable-ads-core';
import {
    AppBase,
    AppOptions,
    BatchManager,
    ButtonComponentSystem,
    CameraComponentSystem,
    Color,
    ContainerHandler,
    ElementComponentSystem,
    ElementInput,
    Entity,
    FILLMODE_FILL_WINDOW,
    FontHandler,
    LightComponentSystem,
    Mouse,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    ScreenComponentSystem,
    TextureHandler,
    TouchDevice,
    Vec3,
    createGraphicsDevice
} from 'playcanvas';

import rawLevel from './assets/levels/teddy.json';
import { createBackdrop } from './backdrop.ts';
import { createBeeSwarm } from './bee.ts';
import { createCameraRig } from './camera-rig.ts';
import { createHud } from './hud.ts';
import { buildSculpture, destroyCube, gridToLocal } from './sculpture.ts';
import './style.css';

// Nothing is drawn until the ad container says it is showing us. No-op without an MRAID SDK.
await whenReady();

const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;

const device = await createGraphicsDevice(canvas);
device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

const createOptions = new AppOptions();
createOptions.graphicsDevice = device;
createOptions.mouse = new Mouse(canvas);
createOptions.touch = new TouchDevice(canvas);
createOptions.elementInput = new ElementInput(canvas);
createOptions.componentSystems = [
    RenderComponentSystem,
    CameraComponentSystem,
    LightComponentSystem,
    ScreenComponentSystem,
    ButtonComponentSystem,
    ElementComponentSystem
];
createOptions.resourceHandlers = [TextureHandler, ContainerHandler, FontHandler];
createOptions.batchManager = BatchManager;

const app = new AppBase(canvas);
app.init(createOptions);
app.start();

app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);

// No resize listener: an ad slot can resize without firing one. Polled in the update loop instead.

const camera = new Entity('camera');
camera.addComponent('camera', { clearColor: new Color(0.08, 0.08, 0.12) });
app.root.addChild(camera);

const light = new Entity('light');
light.addComponent('light', { type: 'directional', intensity: 1 });
light.setEulerAngles(90, 0, 0);
app.root.addChild(light);

// Minified copy of the BoxyBlast export. Regenerate with `npm run shrink-levels`.
// Imported, not fetched — a playable has no server. Cast through `unknown`: TS widens the
// cube quads to number[].
const level = parseBoxyBlastLevel(rawLevel as unknown as BoxyBlastLevel);

const sculpture = await buildSculpture(app, level);

// Pulled back further so the sculpture reads smaller in frame (~3/5 its previous apparent size).
const distance = sculpture.radius * 5;
// Level, straight-on camera: the tilt comes from the level's own DefaultRotation, applied to the
// sculpture by the camera rig. An angled camera here would double-count it — with both, teddy ends
// up on his back showing the camera the top of his head.
// Aim height. The camera looks horizontally, so raising this pushes the sculpture DOWN the frame:
// it drops into the gap between the hive hanging from the canopy and the HUD board at the bottom.
const framingY = -sculpture.radius * 0.28;

// fov is vertical, so a portrait slot clips the sculpture sideways. Back off by 1/aspect.
function frameCamera(): void {
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    camera.setPosition(0, framingY, aspect < 1 ? distance / aspect : distance);
    // Aimed below the sculpture's actual center so it sits higher in frame, leaving room for the
    // HUD queue stack at the bottom instead of the model reading vertically centered on screen.
    camera.lookAt(0, framingY, 0);
}
frameCamera();

const backdrop = await createBackdrop(app, camera);

const core = new GameCore(level, Date.now());
const hud = await createHud(app, (lane) => core.activateColumn(lane));

const rig = createCameraRig(canvas, sculpture.root, camera, hud.hitsButton, level.initialRotation);
const bees = createBeeSwarm(
    app,
    camera,
    sculpture.mesh,
    distance,
    sculpture.root,
    sculpture.radius,
    backdrop
);

core.on('cubeShot', (e) => {
    // Local, not world: the sculpture keeps rotating during the flight, so a world position
    // captured now would be stale by the time the bee arrives.
    const cubeLocal = gridToLocal(sculpture, e.cell);
    destroyCube(app, sculpture, e.cell);

    // core hands back the route it proved the cube was reachable by — same coordinates as the
    // grid, so it just needs centering like any other cell.
    const path = e.path
        ? {
            points: e.path.points.map((p) => gridToLocal(sculpture, p)),
            face: new Vec3(e.path.face.x, e.path.face.y, e.path.face.z)
        }
        : undefined;

    bees.spawn(cubeLocal, e.color, hud.getSlotScreenPos(e.slot), path);
});
// No gameWon/gameLost handlers: the HUD switches between its gameplay, win and lose groups off
// frame.state.status in refresh(), so there's no second copy of "is the round over" to drift.

let lastWidth = 0;
let lastHeight = 0;

app.on('update', (dt: number) => {
    // Poll for a resized ad slot; the camera reframes because distance depends on aspect.
    if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
        lastWidth = canvas.clientWidth;
        lastHeight = canvas.clientHeight;
        app.resizeCanvas();
        frameCamera();
    }

    // Off-screen or backgrounded: keep drawing, stop the clock.
    if (!isVisible()) return;

    // The speed control scales the simulation and the bees together, but not the camera rig —
    // rotation follows the player's hand, and speeding that up just reads as a bug.
    const scaled = dt * hud.getSpeed();
    rig.update(dt);
    bees.update(scaled);
    core.setViewDirection(rig.getViewDir());
    const frame = core.update(scaled);
    hud.refresh(frame.state);
});

app.on('destroy', () => rig.destroy());
