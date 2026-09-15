import { Asset, ELEMENTTYPE_IMAGE, Entity, Layer, SCALEMODE_NONE } from 'playcanvas';
import type { AppBase, CameraComponent } from 'playcanvas';

// `?inline` = base64 data URI, so the playable stays one file. WebP via `npm run to-webp`.
import BACKGROUND_URL from './assets/sprites/Dark BG 01.png?inline';
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

export type Backdrop = {
    /** CSS px point below the hive where a bee lines up. */
    approachScreenPos(): { x: number; y: number };
    /** CSS px point inside the hive, where bees disappear. */
    entranceScreenPos(): { x: number; y: number };
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

    // The only thing that stretches: a 50x50 gradient anchored to all four corners.
    const backgroundEl = new Entity('background');
    backgroundEl.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor: [0, 0, 1, 1],
        pivot: [0.5, 0.5],
        textureAsset: background.id,
        layers: [backdropLayer.id]
    });
    behind.addChild(backgroundEl);

    // Sibling order is draw order within a layer: canopy, then the hive's back shell over it.
    addTopCentre(behind, 'canopy', canopy, CANOPY_WIDTH, CANOPY_HEIGHT, 0, backdropLayer);
    const back = addTopCentre(
        behind,
        'hive-back',
        hiveBack,
        HIVE_WIDTH,
        HIVE_HEIGHT,
        -HIVE_TOP_OFFSET,
        backdropLayer
    );

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

    return { approachScreenPos, entranceScreenPos };
}
