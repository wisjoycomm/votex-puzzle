import { GameCore, parseBoxyBlastLevel } from 'core';
import type { BoxyBlastLevel } from 'core';
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
    createGraphicsDevice
} from 'playcanvas';

import { createBeeSwarm } from './bee.ts';
import { createCameraRig } from './camera-rig.ts';
import { createHud } from './hud.ts';
import { buildSculpture, cellKey, destroyCube } from './sculpture.ts';
import './style.css';

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

const resize = () => app.resizeCanvas();
window.addEventListener('resize', resize);
app.on('destroy', () => window.removeEventListener('resize', resize));

const camera = new Entity('camera');
camera.addComponent('camera', { clearColor: new Color(0.08, 0.08, 0.12) });
app.root.addChild(camera);

const light = new Entity('light');
light.addComponent('light', { type: 'directional', intensity: 1 });
light.setEulerAngles(90, 0, 0);
app.root.addChild(light);

const rawLevel: BoxyBlastLevel = await fetch('/levels/easy.json').then((res) => res.json());
const level = parseBoxyBlastLevel(rawLevel);

const sculpture = await buildSculpture(app, level);

// Pulled back further so the sculpture reads smaller in frame (~3/5 its previous apparent size).
const distance = sculpture.radius * 5;
camera.setPosition(distance * 0.6, distance * 0.5, distance * 0.6);
// Look below the sculpture's actual center so it sits higher in frame, leaving room for the HUD
// queue stack at the bottom instead of the model reading vertically centered on screen.
camera.lookAt(0, -sculpture.radius * 0.5, 0);

const core = new GameCore(level, Date.now());
const hud = await createHud(app, (lane) => core.activateColumn(lane));

const rig = createCameraRig(canvas, sculpture.root, camera, hud.hitsButton);
const bees = createBeeSwarm(app, camera, sculpture.mesh, distance);

core.on('cubeShot', (e) => {
    const cubePos = sculpture.cubes.get(cellKey(e.cell))?.getPosition().clone();
    destroyCube(app, sculpture, e.cell);
    if (!cubePos) return;

    bees.spawn(cubePos, e.color, hud.getSlotScreenPos(e.slot));
});
core.on('gameWon', () => hud.setStatus('Cleared!'));
core.on('gameLost', () => hud.setStatus('No moves left'));

app.on('update', (dt: number) => {
    rig.update(dt);
    bees.update(dt);
    core.setViewDirection(rig.getViewDir());
    const frame = core.update(dt);
    hud.refresh(frame.state);
});

app.on('destroy', () => rig.destroy());
