import { Easing, Group, Tween } from '@tweenjs/tween.js';
import {
    Asset,
    Color,
    ELEMENTTYPE_GROUP,
    ELEMENTTYPE_IMAGE,
    ELEMENTTYPE_TEXT,
    Entity,
    SCALEMODE_NONE
} from 'playcanvas';
import type { AppBase, ButtonComponent } from 'playcanvas';
import type { GameState } from 'core';

import { hexFor } from './colors.ts';

const FLY_MS = 220;
// Fill size as a fraction of its socket — 1 so the colored hex exactly fits the Slot.png outline
// it's tinting, now that it's the same shape instead of a small circular dot inside it.
const FILL_RATIO = 1;

export type Hud = {
    refresh(state: GameState): void;
    setStatus(text: string): void;
    /** Screen-space center of a firing slot, for effects that should originate from where a shot
     *  visually comes from. */
    getSlotScreenPos(slot: number): { x: number; y: number } | undefined;
    /** Whether a screen point (CSS px) lands on a currently-clickable queue-front button — lets
     *  the camera drag rig skip starting a drag when a click actually targets the UI, now that
     *  both render on the same canvas instead of a DOM overlay sitting above it. */
    hitsButton(x: number, y: number): boolean;
    destroy(): void;
}

const SLOT_TEXTURE_URL = '/sprites/Slot.png';
const FONT_URL = '/fonts/courier.json';

const QUEUE_PREVIEW = 3;
const ACTIVE_SIZE = 80;
const QUEUE_SIZE = 60;
const QUEUE_PREVIEW_SIZE = QUEUE_SIZE * 0.82;
const QUEUE_OVERLAP = 15;
const SLOT_SPACING = ACTIVE_SIZE + 16;
const LANE_SPACING = QUEUE_SIZE + 16;
const BOARD_BOTTOM_MARGIN = 24;
const BOARD_HEIGHT = ACTIVE_SIZE + QUEUE_SIZE * 3 + 40;

type Socket = { el: Entity; fill: Entity; text: Entity };

type LaneEls = {
    /** Front slot (index 0) is the clickable button; the rest are a preview peek of what's next. */
    queueSlots: (Socket & { button: ButtonComponent | null })[];
    /** Queues only ever shrink from the front, so a drop here means the stack shifted up by one. */
    lastQueueLen: number;
}

function loadAsset(app: AppBase, asset: Asset): Promise<Asset> {
    return new Promise((resolve, reject) => {
        app.assets.add(asset);
        asset.once('load', () => resolve(asset));
        asset.once('error', (err: string) => reject(new Error(err)));
        app.assets.load(asset);
    });
}

// Average of an element's 4 canvas-space corners (CSS px, same space DOM getBoundingClientRect
// used to report) — the Element-system equivalent, used to place effects.
function elementCenter(entity: Entity): { x: number; y: number } {
    const c = entity.element!.canvasCorners;
    return {
        x: (c[0]!.x + c[1]!.x + c[2]!.x + c[3]!.x) / 4,
        y: (c[0]!.y + c[1]!.y + c[2]!.y + c[3]!.y) / 4
    };
}

function makeImage(size: number, textureAsset: Asset | null, opacity: number, useInput = false): Entity {
    const el = new Entity();
    el.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor: [0.5, 0.5, 0.5, 0.5],
        pivot: [0.5, 0.5],
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

// Colored dot showing a hive's color, layered on top of its socket — reuses the same Slot.png
// texture (tinted via `color`) so the dot takes the socket's hex silhouette instead of rendering
// as a plain square.
function makeFill(size: number, textureAsset: Asset): Entity {
    const el = makeImage(size, textureAsset, 1);
    el.element!.color = new Color(1, 1, 1);
    el.enabled = false;
    return el;
}

function makeText(
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

// A pure view of GameCore's state: every element is re-derived from `state` on each call, never
// stored as its own source of truth.
export async function createHud(
    app: AppBase,
    onActivate: (lane: number) => number | null
): Promise<Hud> {
    const [slotTexture, font] = await Promise.all([
        loadAsset(app, new Asset('slot', 'texture', { url: SLOT_TEXTURE_URL })),
        loadAsset(app, new Asset('hud-font', 'font', { url: FONT_URL }))
    ]);

    // SCALEMODE_NONE (not BLEND): a screen-space screen's `resolution` is the graphics device's
    // DEVICE-pixel size, not CSS px — BLEND's log-interpolated scale against a CSS-pixel-shaped
    // referenceResolution produced an unpredictable, DPR-dependent multiplier (the actual cause
    // of the layout "not seeming right"). NONE locks scale to 1: our px constants below become
    // literal device px — 1:1 with CSS px on a DPR-1 display, exactly half size on DPR-2.
    const screen = new Entity('hud-screen');
    screen.addComponent('screen', {
        scaleMode: SCALEMODE_NONE,
        screenSpace: true
    });
    app.root.addChild(screen);

    const status = makeText(font, 28, 600, [0.5, 1, 0.5, 1], [0.5, 1]);
    status.setLocalPosition(0, -40, 0);
    screen.addChild(status);

    // Firing slots and lanes are independent in the core — a fixed pool of slots fed by however
    // many lanes the level defines — so they're laid out as two separate rows. Both live in one
    // board group so a hive flying from a lane into a slot is a plain local-position tween.
    const board = new Entity('hud-board');
    board.addComponent('element', {
        type: ELEMENTTYPE_GROUP,
        anchor: [0.5, 0, 0.5, 0],
        pivot: [0.5, 0],
        width: 0,
        height: BOARD_HEIGHT
    });
    board.setLocalPosition(0, BOARD_BOTTOM_MARGIN, 0);
    screen.addChild(board);

    const slotEls: Socket[] = [];
    const laneEls: LaneEls[] = [];
    const tweens = new Group();
    /** Slots whose hive is mid-flight — held empty so the flight reads as movement instead of the
     *  hive simply appearing at the destination the frame it's clicked. */
    const flying = new Set<number>();
    /** Lanes whose queue stack is mid-shift — their queue sockets are hidden while clones slide. */
    const shifting = new Set<number>();

    function addSocket(size: number, opacity: number, x: number, y: number, useInput = false): Socket {
        const el = makeImage(size, slotTexture, opacity, useInput);
        el.setLocalPosition(x, y, 0);
        board.addChild(el);

        const fill = makeFill(size * FILL_RATIO, slotTexture);
        el.addChild(fill);
        const text = makeText(font, size > QUEUE_SIZE ? 18 : 14, size);
        el.addChild(text);
        return { el, fill, text };
    }

    // Sockets never move — refresh() only repaints ammo text in place. To sell "the hive moves",
    // animate a throwaway clone over the real elements instead of the (stationary) elements
    // themselves. Everything shares the `board` parent, so this is a pure local-position tween.
    function flyToken(from: Entity, to: Entity, color: Color, ammoText: string, onDone: () => void): void {
        const fromPos = from.getLocalPosition();
        const toPos = to.getLocalPosition();
        const fromSize = from.element!.width;

        const clone = makeImage(fromSize, slotTexture, 1);
        clone.setLocalPosition(fromPos.x, fromPos.y, 0);
        board.addChild(clone);
        const cloneFill = makeFill(fromSize * FILL_RATIO, slotTexture);
        cloneFill.element!.color = color;
        cloneFill.enabled = true; // makeFill starts hidden for empty sockets; a flying one is always filled
        clone.addChild(cloneFill);
        const cloneText = makeText(font, 14, fromSize);
        cloneText.element!.text = ammoText;
        clone.addChild(cloneText);

        // Entity scale carries the whole token (socket, fill, text), so the clone grows into a
        // larger destination socket over the flight instead of popping to fit on arrival.
        const t = { x: fromPos.x, y: fromPos.y, s: 1 };
        new Tween(t, tweens)
            .to({ x: toPos.x, y: toPos.y, s: to.element!.width / fromSize }, FLY_MS)
            .easing(Easing.Quadratic.Out)
            .onUpdate(() => {
                clone.setLocalPosition(t.x, t.y, 0);
                clone.setLocalScale(t.s, t.s, t.s);
            })
            .onComplete(() => {
                clone.destroy();
                onDone();
            })
            .start();
    }

    // The queue stack shifted up by one: slide a clone of each arriving hive from the socket it
    // came from into the one it now occupies, with the real sockets hidden until they all land.
    function shiftQueue(laneIndex: number, queue: GameState['columns'][number]): void {
        const { queueSlots } = laneEls[laneIndex]!;

        let pending = 0;
        const done = () => {
            if (--pending === 0) shifting.delete(laneIndex);
        };
        for (let q = 0; q < queueSlots.length - 1; q++) {
            const hive = queue[q];
            if (!hive) break;
            pending++;
            flyToken(
                queueSlots[q + 1]!.el,
                queueSlots[q]!.el,
                new Color().fromString(hexFor(hive.color)),
                String(hive.ammo),
                done
            );
        }
        if (pending > 0) shifting.add(laneIndex);
    }

    function ensureLayout(laneCount: number, slotCount: number): void {
        if (laneEls.length > 0) return;
        board.element!.width = Math.max(laneCount * LANE_SPACING, slotCount * SLOT_SPACING);

        // Queue sockets stack bottom-up (front slot on top, nearest the slot row); the slot row
        // sits just above whatever height that stack ends up being.
        const queueY: number[] = [];
        let top = QUEUE_PREVIEW_SIZE / 2;
        for (let q = QUEUE_PREVIEW - 1; q >= 0; q--) {
            queueY[q] = top;
            top += (q === 0 ? QUEUE_SIZE : QUEUE_PREVIEW_SIZE) - QUEUE_OVERLAP;
        }
        const slotY = top + ACTIVE_SIZE / 2 - QUEUE_PREVIEW_SIZE / 2 + 10;

        for (let l = 0; l < laneCount; l++) {
            const x = (l - (laneCount - 1) / 2) * LANE_SPACING;
            const queueSlots: LaneEls['queueSlots'] = [];
            for (let q = QUEUE_PREVIEW - 1; q >= 0; q--) {
                const size = q === 0 ? QUEUE_SIZE : QUEUE_PREVIEW_SIZE;
                const socket = addSocket(size, q === 0 ? 1 : 0.75, x, queueY[q]!, q === 0);

                let button: ButtonComponent | null = null;
                if (q === 0) {
                    socket.el.addComponent('button');
                    button = socket.el.button!;
                    button.on('click', () => {
                        const ammoText = socket.text.element!.text;
                        const filled = socket.fill.enabled;
                        const slot = onActivate(l);
                        if (slot === null || !filled) return; // no free slot / lane already firing
                        flying.add(slot);
                        flyToken(
                            socket.el,
                            slotEls[slot]!.el,
                            socket.fill.element!.color.clone(),
                            ammoText,
                            () => flying.delete(slot)
                        );
                    });
                }
                queueSlots[q] = { ...socket, button };
            }
            laneEls.push({ queueSlots, lastQueueLen: -1 });
        }

        for (let i = 0; i < slotCount; i++) {
            slotEls.push(addSocket(ACTIVE_SIZE, 0.5, (i - (slotCount - 1) / 2) * SLOT_SPACING, slotY));
        }
    }

    function renderHive(fill: Entity, text: Entity, color: number | undefined, ammo: number | undefined): void {
        // Slot sockets stay visible even when empty (per the caller), but their fill still needs
        // hiding on its own then, or it'd keep showing the last hive's color.
        fill.enabled = color !== undefined;
        if (color !== undefined) fill.element!.color = new Color().fromString(hexFor(color));
        text.element!.text = ammo === undefined ? '' : String(ammo);
    }

    function refresh(state: GameState): void {
        tweens.update();
        ensureLayout(state.columns.length, state.slots.length);

        state.slots.forEach((hive, i) => {
            // Slot sockets always show, empty or not — only the queue stacks hide when empty.
            const shown = flying.has(i) ? null : hive;
            const { fill, text } = slotEls[i]!;
            renderHive(fill, text, shown?.color, shown?.ammo);
        });

        state.columns.forEach((queue, laneIndex) => {
            const els = laneEls[laneIndex]!;
            if (queue.length < els.lastQueueLen) shiftQueue(laneIndex, queue);
            els.lastQueueLen = queue.length;

            const stacked = !shifting.has(laneIndex);
            els.queueSlots.forEach((s, q) => {
                const hive = queue[q];
                renderHive(s.fill, s.text, hive?.color, hive?.ammo);
                s.el.enabled = !!hive && stacked;
                if (s.button) s.button.active = !!hive && stacked;
            });
        });
    }

    function setStatus(text: string): void {
        status.element!.text = text;
    }

    function getSlotScreenPos(slot: number): { x: number; y: number } | undefined {
        const els = slotEls[slot];
        return els ? elementCenter(els.el) : undefined;
    }

    function hitsButton(x: number, y: number): boolean {
        return laneEls.some(({ queueSlots }) => {
            const front = queueSlots[0];
            if (!front?.button?.active) return false;
            const c = front.el.element!.canvasCorners;
            const minX = Math.min(c[0]!.x, c[1]!.x, c[2]!.x, c[3]!.x);
            const maxX = Math.max(c[0]!.x, c[1]!.x, c[2]!.x, c[3]!.x);
            const minY = Math.min(c[0]!.y, c[1]!.y, c[2]!.y, c[3]!.y);
            const maxY = Math.max(c[0]!.y, c[1]!.y, c[2]!.y, c[3]!.y);
            return x >= minX && x <= maxX && y >= minY && y <= maxY;
        });
    }

    function destroy(): void {
        screen.destroy();
    }

    return { refresh, setStatus, getSlotScreenPos, hitsButton, destroy };
}
