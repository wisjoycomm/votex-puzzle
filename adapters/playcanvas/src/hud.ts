import { Easing, Group, Tween } from '@tweenjs/tween.js';
import type { GameState } from 'core';
import { Asset, Color, ELEMENTTYPE_GROUP, Entity, SCALEMODE_NONE } from 'playcanvas';
import type { AppBase, ButtonComponent } from 'playcanvas';

import fontData from './assets/fonts/courier.json';
import FONT_PNG_URL from './assets/fonts/courier.png?inline';
import SLOT_TEXTURE_URL from './assets/sprites/Slot.webp?inline';
import { hexFor } from './colors.ts';
import { createEndUi } from './end-ui.ts';
import { sfx } from './sfx.ts';
import { elementCenter, loadAsset, makeFill, makeFullScreenGroup, makeImage, makeText } from './ui-elements.ts';

const FLY_MS = 220;
// Fill size as a fraction of its socket — 1 so the colored hex exactly fits the Slot.png outline
// it's tinting, now that it's the same shape instead of a small circular dot inside it.
const FILL_RATIO = 1;

export type Hud = {
    /** Drives everything, including which of the three UI groups is showing. */
    refresh(state: GameState): void;
    /** Screen-space center of a firing slot, for effects that should originate from where a shot
     *  visually comes from. */
    getSlotScreenPos(slot: number): { x: number; y: number } | undefined;
    /** Whether a screen point (CSS px) lands on a currently-clickable button — lets the camera
     *  drag rig skip starting a drag when a click actually targets the UI, now that both render
     *  on the same canvas instead of a DOM overlay sitting above it. */
    hitsButton(x: number, y: number): boolean;
    /** Simulation speed multiplier the player has selected. */
    getSpeed(): number;
    /** Backdrop band split, in screen units from the bottom: the gap between the slot row and the
     *  lane stack below it. Follows fitBoard()'s shrink. */
    getBandSplit(): number;
    destroy(): void;
};


// x1 is the tuned look (flight timings in bee.ts are set for it); the rest are speed-ups for a
// player who doesn't want to watch every bee. Cycles 1 -> 2 -> 3 -> 5 -> 1.
const SPEEDS = [1, 2, 3, 5];
const SPEED_DEFAULT = 1;
const SPEED_SIZE = 52;
const SPEED_MARGIN = 64;

const QUEUE_PREVIEW = 3;
const ACTIVE_SIZE = 100;
const QUEUE_SIZE = 80;
const QUEUE_PREVIEW_SIZE = QUEUE_SIZE;
const QUEUE_OVERLAP = -16;
const SLOT_SPACING = ACTIVE_SIZE + 32;
const LANE_SPACING = QUEUE_SIZE + 16;
const BOARD_BOTTOM_MARGIN = 2;
// Gap between the top of the queue stack and the firing-slot row.
const SLOT_ROW_GAP = 10;
// Clearance kept either side of the board when it has to shrink to fit a narrow viewport.
const BOARD_SIDE_MARGIN = 12;
// Most of the screen height the board may occupy before it shrinks — keeps the sculpture visible
// on a short, wide window, which a playable ad can be resized into at any time.
const BOARD_MAX_HEIGHT_FRACTION = 0.4;

type Socket = { el: Entity; fill: Entity; text: Entity };

type LaneEls = {
    /** Front slot (index 0) is the clickable button; the rest are a preview peek of what's next. */
    queueSlots: (Socket & { button: ButtonComponent | null })[];
    /** Queues only ever shrink from the front, so a drop here means the stack shifted up by one. */
    lastQueueLen: number;
};

// A pure view of GameCore's state: every element is re-derived from `state` on each call, never
// stored as its own source of truth.
export async function createHud(app: AppBase, onActivate: (lane: number) => number | null): Promise<Hud> {
    // Font loads by PNG + inline data, not by .json url: FontHandler does url.replace('.json',
    // '.png'), which a data URI can't satisfy.
    const [slotTexture, font] = await Promise.all([
        loadAsset(app, new Asset('slot', 'texture', { url: SLOT_TEXTURE_URL })),
        loadAsset(app, new Asset('hud-font', 'font', { url: FONT_PNG_URL }, fontData))
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

    // Three sibling groups, exactly one live at a time, switched off GameState.status in refresh().
    // Nothing here listens for gameWon/gameLost: the HUD stays a pure view of state, so there is
    // no second source of truth to fall out of step after a reset or replay.
    const gameplayUi = makeFullScreenGroup('hud-gameplay');
    screen.addChild(gameplayUi);

    const endUi = createEndUi(font);
    screen.addChild(endUi.win.root);
    screen.addChild(endUi.lose.root);

    // Speed control, top-right. Cycles x1 -> x2 -> x3 -> x5 -> x1; main.ts scales the simulation dt
    // by whatever this reports, so bee flight and firing rate speed up together.
    let speedIndex = SPEEDS.indexOf(SPEED_DEFAULT);
    const speedButton = makeImage(SPEED_SIZE, slotTexture, 0.7, true, [1, 1, 1, 1], [1, 1]);
    speedButton.setLocalPosition(-SPEED_MARGIN, -SPEED_MARGIN, 0);
    gameplayUi.addChild(speedButton);

    const speedLabel = makeText(font, 18, SPEED_SIZE);
    speedButton.addChild(speedLabel);
    speedLabel.element!.text = `x${SPEEDS[speedIndex]}`;

    speedButton.addComponent('button');
    speedButton.button!.on('click', () => {
        sfx('click');
        speedIndex = (speedIndex + 1) % SPEEDS.length;
        speedLabel.element!.text = `x${SPEEDS[speedIndex]}`;
    });

    // Firing slots and lanes are independent in the core — a fixed pool of slots fed by however
    // many lanes the level defines — so they're laid out as two separate rows. Both live in one
    // board group so a hive flying from a lane into a slot is a plain local-position tween.
    // Pivot is centred because child local positions are measured from the board's centre either
    // way — claiming a bottom pivot just made every constant in ensureLayout read half a board too
    // low. Size and vertical placement are both set there, once the real content height is known.
    const board = new Entity('hud-board');
    board.addComponent('element', {
        type: ELEMENTTYPE_GROUP,
        anchor: [0.5, 0, 0.5, 0],
        pivot: [0.5, 0.5],
        width: 0,
        height: 0
    });
    gameplayUi.addChild(board);

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

    // What the board needs at scale 1, measured once the lanes are laid out and then compared
    // against the live viewport by fitBoard().
    let boardWidth = 0;
    let boardHeight = 0;
    /** Band split, board-local; set by ensureLayout(). */
    let splitLocalY = 0;
    /** The same line in screen units, after fitBoard(). */
    let bandSplit = 0;

    /**
     * SCALEMODE_NONE means the px constants above are literal device pixels and nothing scales with
     * the window, so a viewport narrower (or shorter) than the board pushes the outer slots off
     * screen. A playable ad can be resized at any moment, so this shrinks the board to whatever
     * actually fits and keeps its bottom edge pinned.
     *
     * Run from refresh(), i.e. every frame, rather than off a resize event: no listener to fall out
     * of sync, and it also covers DPR changes and the canvas settling after a fill-mode resize.
     */
    function fitBoard(): void {
        if (boardWidth <= 0) return;

        // NOTE: `resolution` here is DEVICE pixels, so on a DPR-2 phone these px constants render
        // at half the physical size they were tuned at (a third at DPR-3). Overriding the screen's
        // `scale` or its `resolution` does not fix it — PlayCanvas recomputes both for a
        // screen-space screen — so the UI is DPR-dependent until that's solved properly.
        const res = screen.screen!.resolution;
        const availableWidth = res.x;
        const availableHeight = res.y;
        const fit = Math.min(
            1,
            (availableWidth - BOARD_SIDE_MARGIN * 2) / boardWidth,
            (availableHeight * BOARD_MAX_HEIGHT_FRACTION) / boardHeight
        );
        board.setLocalScale(fit, fit, fit);
        // Scaling happens about the centred pivot, so half the shrink would otherwise lift the
        // board off the bottom edge. Re-place it so the margin holds at any scale.
        board.setLocalPosition(0, BOARD_BOTTOM_MARGIN + (boardHeight * fit) / 2, 0);
        bandSplit = BOARD_BOTTOM_MARGIN + splitLocalY * fit;
    }

    function ensureLayout(laneCount: number, slotCount: number): void {
        if (laneEls.length > 0) return;
        boardWidth = Math.max(laneCount * LANE_SPACING, slotCount * SLOT_SPACING);

        // Queue sockets stack bottom-up (front slot on top, nearest the slot row); the slot row
        // sits just above whatever height that stack ends up being.
        const queueY: number[] = [];
        let top = QUEUE_PREVIEW_SIZE / 2;
        for (let q = QUEUE_PREVIEW - 1; q >= 0; q--) {
            queueY[q] = top;
            top += (q === 0 ? QUEUE_SIZE : QUEUE_PREVIEW_SIZE) - QUEUE_OVERLAP;
        }
        const slotY = top + ACTIVE_SIZE / 2 - QUEUE_PREVIEW_SIZE / 2 + SLOT_ROW_GAP;

        // Halfway between the slot row and the queue stack, measured from the board's bottom edge —
        // the edge fitBoard() pins.
        splitLocalY = (slotY - ACTIVE_SIZE / 2 + queueY[0]! + QUEUE_SIZE / 2) / 2;

        // Derived, not declared: the board is exactly as tall as what it holds, so BOARD_BOTTOM_
        // MARGIN means what it says and nothing has to be re-tuned when a row size changes.
        boardHeight = slotY + ACTIVE_SIZE / 2;
        board.element!.width = boardWidth;
        board.element!.height = boardHeight;

        // Everything above was measured from the bottom edge; children sit relative to the centre.
        const originY = boardHeight / 2;
        for (let q = 0; q < queueY.length; q++) queueY[q] = queueY[q]! - originY;
        const slotRowY = slotY - originY;

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
                        // Before the early-return below: the player pressed it either way, and this
                        // is also the gesture that unlocks audio on iOS.
                        sfx('click');
                        const ammoText = socket.text.element!.text;
                        const filled = socket.fill.enabled;
                        const slot = onActivate(l);
                        if (slot === null || !filled) return; // no free slot / lane already firing
                        flying.add(slot);
                        flyToken(socket.el, slotEls[slot]!.el, socket.fill.element!.color.clone(), ammoText, () =>
                            flying.delete(slot)
                        );
                    });
                }
                queueSlots[q] = { ...socket, button };
            }
            laneEls.push({ queueSlots, lastQueueLen: -1 });
        }

        for (let i = 0; i < slotCount; i++) {
            slotEls.push(addSocket(ACTIVE_SIZE, 0.5, (i - (slotCount - 1) / 2) * SLOT_SPACING, slotRowY));
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
        fitBoard();

        gameplayUi.enabled = state.status === 'playing';
        endUi.win.root.enabled = state.status === 'won';
        endUi.lose.root.enabled = state.status === 'lost';

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

    function getSlotScreenPos(slot: number): { x: number; y: number } | undefined {
        const els = slotEls[slot];
        return els ? elementCenter(els.el) : undefined;
    }

    function covers(el: Entity, x: number, y: number): boolean {
        const c = el.element!.canvasCorners;
        const minX = Math.min(c[0]!.x, c[1]!.x, c[2]!.x, c[3]!.x);
        const maxX = Math.max(c[0]!.x, c[1]!.x, c[2]!.x, c[3]!.x);
        const minY = Math.min(c[0]!.y, c[1]!.y, c[2]!.y, c[3]!.y);
        const maxY = Math.max(c[0]!.y, c[1]!.y, c[2]!.y, c[3]!.y);
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    function hitsButton(x: number, y: number): boolean {
        // The CTA is the one thing on an end screen that must never lose a click to the drag rig.
        for (const panel of [endUi.win, endUi.lose]) {
            if (panel.root.enabled && covers(panel.cta, x, y)) return true;
        }
        // Otherwise, once an overlay is up the gameplay UI is gone, so nothing here can be hit and
        // a drag anywhere should still rotate the sculpture.
        if (!gameplayUi.enabled) return false;
        if (covers(speedButton, x, y)) return true;
        return laneEls.some(({ queueSlots }) => {
            const front = queueSlots[0];
            if (!front?.button?.active) return false;
            return covers(front.el, x, y);
        });
    }

    function destroy(): void {
        screen.destroy();
    }

    return {
        refresh,
        getSlotScreenPos,
        hitsButton,
        getSpeed: () => SPEEDS[speedIndex]!,
        getBandSplit: () => bandSplit,
        destroy
    };
}
