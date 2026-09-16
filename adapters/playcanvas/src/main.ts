import { GameCore, parseBoxyBlastLevel } from 'core';
import type { BoxyBlastLevel } from 'core';
import { gameEnded, gameReady, isVisible, onAdClose, onAdStart, whenReady } from 'playable-ads-core';
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
import { allowMusic, sfx, startMusic, stopMusic, updateMusic } from './sfx.ts';
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
//
// Poll the VIEWPORT, not the canvas: FILLMODE_FILL_WINDOW sizes the canvas from window.inner* and
// writes the result back as inline styles, so canvas.client* is this poll's own output and never
// changes again — an orientation flip would leave the frame stuck at the old shape forever.

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

// Framing knobs — tune these on device, they're the ones that decide how big teddy reads.
// Camera distance in bounding-sphere radii, and the master zoom: apparent size goes as 1/distance,
// so smaller means bigger. Was 5; 3.33 is that same framing 1.5x closer.
const DISTANCE_RADII = 3.33;
const distance = sculpture.radius * DISTANCE_RADII;
// Share of the portrait width back-off to actually apply. `radius` is a bounding SPHERE, wider
// than teddy is, so fitting it strictly across a narrow slot wastes the height that slot has.
// 1 = strict fit (old behaviour), 0 = ignore width entirely.
const PORTRAIT_BACKOFF = 0.45;
// Floor on the share of the height left for the model once the HUD has taken its cut, so a very
// short slot can't push the camera towards infinity.
const MIN_FREE_HEIGHT = 0.45;
// Aim height as a share of radius. The camera looks horizontally, so RAISING this pushes the
// sculpture DOWN the frame. Was -0.28, which sat it high; 0 drops it into the room the board freed.
const FRAMING_Y = 0;
// Level, straight-on camera: the tilt comes from the level's own DefaultRotation, applied to the
// sculpture by the camera rig. An angled camera here would double-count it — with both, teddy ends
// up on his back showing the camera the top of his head.
const framingY = sculpture.radius * FRAMING_Y;

/** Share of the viewport height the HUD board covers. Zero until the HUD has laid out. */
let boardFraction = 0;

function frameCamera(): void {
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    // fov is vertical, so only a slot narrower than it is tall needs distance to fit the width.
    const forWidth = aspect < 1 ? distance / aspect : distance;
    // The board is a fixed pixel height, so the shorter the slot the more of the frame it claims —
    // which is what makes a portrait slot able to show a bigger model than a landscape one.
    const free = Math.max(MIN_FREE_HEIGHT, 1 - boardFraction);
    camera.setPosition(0, framingY, (distance + (forWidth - distance) * PORTRAIT_BACKOFF) / free);
    camera.lookAt(0, framingY, 0);
}
frameCamera();

const backdrop = await createBackdrop(app, camera);

const core = new GameCore(level, Date.now());
const hud = await createHud(app, (lane) => core.activateColumn(lane));

const rig = createCameraRig(canvas, sculpture.root, camera, hud.hitsButton, level.initialRotation);
const bees = createBeeSwarm(app, camera, sculpture.mesh, distance, sculpture.root, sculpture.radius, backdrop);

core.on('hiveActivated', () => sfx('spawn'));

core.on('cubeShot', (e) => {
    sfx('shoot');

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
// The HUD still switches between its gameplay, win and lose groups off frame.state.status in
// refresh() — these handlers own no state, they just need the one edge the polled status can't
// give them: the single frame the round ended on.
// gameEnded() tells Mintegral the run is over - required alongside the store click, ignored
// everywhere else. On both outcomes: the network wants "ended", not "won".
core.on('gameWon', () => {
    sfx('win');
    gameEnded();
});
core.on('gameLost', () => {
    sfx('lose');
    gameEnded();
});

let lastWidth = 0;
let lastHeight = 0;

// Armed now, audible from the first tap — browsers won't start audio before a gesture.
startMusic();

// Mintegral's container drives the ad's start and end, and expects the creative to hand it the
// backing-track controls (§5/§7). Every other network ignores these; the track still runs off the
// first tap. gameReady() is the opposite direction — ours to call, once everything is loaded.
onAdStart(allowMusic);
onAdClose(stopMusic);
gameReady();

app.on('update', (dt: number) => {
    // Poll for a resized ad slot; the camera reframes because distance depends on aspect.
    if (window.innerWidth !== lastWidth || window.innerHeight !== lastHeight) {
        lastWidth = window.innerWidth;
        lastHeight = window.innerHeight;
        app.resizeCanvas();
    }

    // Above the isVisible() gate on purpose: pausing the track is what a hidden ad has to do.
    updateMusic();

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
    // After refresh: fitBoard() runs in there. Reframing every frame rather than off the resize
    // poll — the camera depends on the board, so it can't be a frame behind it.
    backdrop.setGroundHeight(hud.getBandSplit());
    boardFraction = hud.getBoardFraction();
    frameCamera();
});

app.on('destroy', () => rig.destroy());
