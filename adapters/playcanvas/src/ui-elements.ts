import { Color, ELEMENTTYPE_GROUP, ELEMENTTYPE_IMAGE, ELEMENTTYPE_TEXT, Entity } from 'playcanvas';
import type { AppBase, Asset } from 'playcanvas';

// Shared factory helpers for the canvas-drawn UI. No layout and no game state — just the
// boilerplate every Element needs, so hud.ts and end-ui.ts don't each re-derive it.

export function loadAsset(app: AppBase, asset: Asset): Promise<Asset> {
    return new Promise((resolve, reject) => {
        app.assets.add(asset);
        asset.once('load', () => resolve(asset));
        asset.once('error', (err: string) => reject(new Error(err)));
        app.assets.load(asset);
    });
}

// Average of an element's 4 canvas-space corners (CSS px, same space DOM getBoundingClientRect
// used to report) — the Element-system equivalent, used to place effects.
export function elementCenter(entity: Entity): { x: number; y: number } {
    const c = entity.element!.canvasCorners;
    return {
        x: (c[0]!.x + c[1]!.x + c[2]!.x + c[3]!.x) / 4,
        y: (c[0]!.y + c[1]!.y + c[2]!.y + c[3]!.y) / 4
    };
}

export function makeImage(
    size: number,
    textureAsset: Asset | null,
    opacity: number,
    useInput = false,
    anchor: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5],
    pivot: [number, number] = [0.5, 0.5]
): Entity {
    const el = new Entity();
    el.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor,
        pivot,
        width: size,
        height: size,
        textureAsset: textureAsset?.id,
        opacity,
        // ElementInput only hit-tests elements with this set — without it a 'button' component
        // silently never receives clicks at all, no error, nothing (found the hard way).
        useInput
    });
    return el;
}

// Tintable copy of a texture, layered on top of another element so it takes that silhouette
// instead of rendering as a plain square. Starts hidden; the caller decides when it shows.
export function makeFill(size: number, textureAsset: Asset): Entity {
    const el = makeImage(size, textureAsset, 1);
    el.element!.color = new Color(1, 1, 1);
    el.enabled = false;
    return el;
}

export function makeText(
    fontAsset: Asset,
    fontSize: number,
    size: number,
    anchor: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5],
    pivot: [number, number] = [0.5, 0.5]
): Entity {
    const el = new Entity();
    el.addComponent('element', {
        type: ELEMENTTYPE_TEXT,
        anchor,
        pivot,
        width: size,
        height: size,
        autoWidth: false,
        autoHeight: false,
        fontAsset: fontAsset.id,
        fontSize,
        color: new Color(1, 1, 1),
        text: ''
    });
    return el;
}

// A group filling the whole screen. Anchoring to all four corners makes the element stretch, so
// children position themselves against the viewport rather than against a fixed-size box.
export function makeFullScreenGroup(name: string): Entity {
    const el = new Entity(name);
    el.addComponent('element', {
        type: ELEMENTTYPE_GROUP,
        anchor: [0, 0, 1, 1],
        pivot: [0.5, 0.5]
    });
    return el;
}
