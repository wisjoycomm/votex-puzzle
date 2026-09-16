import { Asset, ELEMENTTYPE_IMAGE, Entity, Layer, SCALEMODE_NONE, Vec4 } from 'playcanvas';
import type { AppBase, CameraComponent } from 'playcanvas';

// `?inline` = base64 data URI, so the playable stays one file. WebP via `npm run to-webp`.
import BACKGROUND_URL from './assets/sprites/Dark BG 01.webp?inline';
import HIVE_BACK_URL from './assets/sprites/Layer 02.webp?inline';
import HIVE_FRONT_URL from './assets/sprites/Layer 03.webp?inline';
import CANOPY_URL from './assets/sprites/Top Leaf.webp?inline';
import { loadAsset } from './ui-elements.ts';

// Gradient, canopy, and the hive the bees deliver into.
//
// Layer 02 and Layer 03 are the back and front shells of the same hive, so a bee flying to the
// entrance passes between them. Draw order:
//
//     gradient -> canopy -> hive BACK  |  world (sculpture, bees)  |  hive FRONT -> HUD
//     \_________ own layer, before the world _________/            \__ default UI layer __/

// Native pixel sizes — the art is never stretched.
const CANOPY_WIDTH = 936;
const CANOPY_HEIGHT = 302;
const HIVE_WIDTH = 262;
const HIVE_HEIGHT = 199;

/** How far below the top edge the hive hangs. */
const HIVE_TOP_OFFSET = 0;
/** Entrance position in the hive art, as a fraction of its height from the top. */
const ENTRANCE_Y_FRACTION = 1;
/** CSS px below the hive where a bee lines up, so the last stretch is straight up. */
const APPROACH_DROP = 50;

// Dark BG 01 is 50x50 flat bands, not a gradient: rows 0-2 #676C91, 3-5 #212335, 6-49 #31344C.
// Sample one row from the middle of a band, never its edge — a rect ending on a boundary blends
// into the next band along the seam. v runs from the bottom.
const SKY_RECT = new Vec4(0, 48 / 50, 1, 1 / 50); // row 1
const GROUND_RECT = new Vec4(0, 22 / 50, 1, 1 / 50); // row 27

export type Backdrop = {
    /** CSS px point below the hive where a bee lines up. */
    approachScreenPos(): { x: number; y: number };
    /** CSS px point inside the hive, where bees disappear. */
    entranceScreenPos(): { x: number; y: number };
    /** Where the two bands meet, in screen units from the bottom. Tracks the HUD, so not constant. */
    setGroundHeight(height: number): void;
};

export async function createBackdrop(app: AppBase, camera: Entity): Promise<Backdrop> {
    const [background, canopy, hiveBack, hiveFront] = await Promise.all([
        loadAsset(app, new Asset('bg', 'texture', { url: BACKGROUND_URL })),
        loadAsset(app, new Asset('canopy', 'texture', { url: CANOPY_URL })),
        loadAsset(app, new Asset('hive-back', 'texture', { url: HIVE_BACK_URL })),
        loadAsset(app, new Asset('hive-front', 'texture', { url: HIVE_FRONT_URL }))
    ]);

    // A layer before the world. The camera must be told to render it, or nothing shows.
    const backdropLayer = new Layer({ name: 'Backdrop' });
    app.scene.layers.insert(backdropLayer, 0);
    const cameraComponent = camera.camera as CameraComponent;
    cameraComponent.layers = [backdropLayer.id, ...cameraComponent.layers];

    const behind = new Entity('backdrop-behind');
    behind.addComponent('screen', { scaleMode: SCALEMODE_NONE, screenSpace: true });
    app.root.addChild(behind);

    const front = new Entity('backdrop-front');
    front.addComponent('screen', { scaleMode: SCALEMODE_NONE, screenSpace: true });
    app.root.addChild(front);

    // Top-centre anchor + top pivot: hangs from the top edge at its own size, centred at any width.
    function addTopCentre(
        parent: Entity,
        name: string,
        texture: Asset,
        w: number,
        h: number,
        y: number,
        layer?: Layer
    ): Entity {
        const el = new Entity(name);
        el.addComponent('element', {
            type: ELEMENTTYPE_IMAGE,
            anchor: [0.5, 1, 0.5, 1],
            pivot: [0.5, 1],
            width: w,
            height: h,
            textureAsset: texture.id,
            ...(layer ? { layers: [layer.id] } : {})
        });
        el.setLocalPosition(0, y, 0);
        parent.addChild(el);
        return el;
    }

    // Sky covers the whole screen; ground draws over its lower part, so only ground needs a height.
    const skyEl = new Entity('background-sky');
    skyEl.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor: [0, 0, 1, 1],
        pivot: [0.5, 0.5],
        textureAsset: background.id,
        rect: SKY_RECT,
        layers: [backdropLayer.id]
    });
    behind.addChild(skyEl);

    // Anchor drives width; height comes from the HUD each frame. Zero until it lays out.
    const groundEl = new Entity('background-ground');
    groundEl.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor: [0, 0, 1, 0],
        pivot: [0.5, 0],
        height: 0,
        textureAsset: background.id,
        rect: GROUND_RECT,
        layers: [backdropLayer.id]
    });
    behind.addChild(groundEl);

    // Not read back from element.height: a screen resize updates the element's calculated height
    // without touching that field, so it can report a value the engine isn't rendering from.
    let groundHeight = -1;

    function setGroundHeight(height: number): void {
        // Called every frame; the setter rebuilds the mesh, so only on a change.
        if (groundHeight === height) return;
        groundHeight = height;
        groundEl.element!.height = height;
    }

    // Sibling order is draw order within a layer: canopy, then the hive's back shell over it.
    addTopCentre(behind, 'canopy', canopy, CANOPY_WIDTH, CANOPY_HEIGHT, 0, backdropLayer);
    const back = addTopCentre(behind, 'hive-back', hiveBack, HIVE_WIDTH, HIVE_HEIGHT, -HIVE_TOP_OFFSET, backdropLayer);

    // Front shell on the default UI layer, so it draws over a bee at the entrance.
    addTopCentre(front, 'hive-front', hiveFront, HIVE_WIDTH, HIVE_HEIGHT, -HIVE_TOP_OFFSET);

    function entranceScreenPos(): { x: number; y: number } {
        // canvasCorners are CSS px. min/max rather than fixed indices, since order isn't promised.
        const c = back.element!.canvasCorners;
        const xs = [c[0]!.x, c[1]!.x, c[2]!.x, c[3]!.x];
        const ys = [c[0]!.y, c[1]!.y, c[2]!.y, c[3]!.y];
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        return {
            x: (Math.min(...xs) + Math.max(...xs)) / 2,
            y: top + (bottom - top) * ENTRANCE_Y_FRACTION
        };
    }

    // Canvas y grows downward, so "below the hive" is a positive offset.
    function approachScreenPos(): { x: number; y: number } {
        const entrance = entranceScreenPos();
        return { x: entrance.x, y: entrance.y + APPROACH_DROP };
    }

    return { approachScreenPos, entranceScreenPos, setGroundHeight };
}
