import { Color, ELEMENTTYPE_IMAGE, Entity } from 'playcanvas';
import type { Asset } from 'playcanvas';

import { openStore } from './cta.ts';
import { sfx } from './sfx.ts';
import { makeFullScreenGroup, makeText } from './ui-elements.ts';

// The win and lose screens. Deliberately a separate module from the gameplay HUD: these appear
// only once a round is over, share none of the board's layout, and carry the call to action —
// the only thing on screen an ad network actually cares about.

const WIN_TITLE = 'Cleared!';
const WIN_SUBTITLE = 'Every cube collected';
const LOSE_TITLE = 'No moves left';
const LOSE_SUBTITLE = 'Nothing reachable for the colours still loaded';

const DIM = new Color(0.04, 0.04, 0.06);
const DIM_OPACITY = 0.72;
const TITLE_SIZE = 44;
const SUBTITLE_SIZE = 18;
const TEXT_WIDTH = 600;

const CTA_LABEL = 'PLAY NOW';
const CTA_WIDTH = 260;
const CTA_HEIGHT = 64;
const CTA_TEXT_SIZE = 22;
// Honey amber against the dark backdrop — the one thing on the screen meant to pull the eye.
const CTA_COLOR = new Color(1, 0.76, 0.03);
const CTA_TEXT_COLOR = new Color(0.1, 0.08, 0.02);
const CTA_OFFSET_Y = -120;

export type EndPanel = {
    /** The whole overlay; enabling it shows the screen. */
    root: Entity;
    /** The call-to-action button, exposed so the drag rig can avoid stealing its clicks. */
    cta: Entity;
};

export type EndUi = {
    /** Shown when the grid is cleared. */
    win: EndPanel;
    /** Shown when a loaded colour has cubes left but none reachable from any rotation. */
    lose: EndPanel;
};

// A flat coloured rectangle — no texture, so the CTA needs no new art and can't be the thing that
// fails to load at the one moment the ad is trying to convert.
function makeCta(fontAsset: Asset): Entity {
    const button = new Entity('cta');
    button.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor: [0.5, 0.5, 0.5, 0.5],
        pivot: [0.5, 0.5],
        width: CTA_WIDTH,
        height: CTA_HEIGHT,
        color: CTA_COLOR,
        opacity: 1,
        // Without this the button component never receives a click — silently.
        useInput: true
    });
    button.setLocalPosition(0, CTA_OFFSET_Y, 0);

    const label = makeText(fontAsset, CTA_TEXT_SIZE, CTA_WIDTH);
    label.element!.text = CTA_LABEL;
    label.element!.color = CTA_TEXT_COLOR;
    button.addChild(label);

    button.addComponent('button');
    button.button!.on('click', () => {
        sfx('click');
        openStore();
    });
    return button;
}

// One end-of-round panel: dimmed backdrop, title, subtitle, CTA. Starts hidden. The backdrop is a
// plain tinted image with no texture, so this needs no new art.
function makeOverlay(fontAsset: Asset, title: string, subtitle: string): EndPanel {
    const root = makeFullScreenGroup(`hud-overlay-${title}`);

    const dim = new Entity('dim');
    dim.addComponent('element', {
        type: ELEMENTTYPE_IMAGE,
        anchor: [0, 0, 1, 1],
        pivot: [0.5, 0.5],
        color: DIM,
        opacity: DIM_OPACITY
    });
    root.addChild(dim);

    const titleEl = makeText(fontAsset, TITLE_SIZE, TEXT_WIDTH);
    titleEl.element!.text = title;
    titleEl.setLocalPosition(0, TITLE_SIZE / 2, 0);
    root.addChild(titleEl);

    const subtitleEl = makeText(fontAsset, SUBTITLE_SIZE, TEXT_WIDTH);
    subtitleEl.element!.text = subtitle;
    subtitleEl.setLocalPosition(0, -TITLE_SIZE / 2, 0);
    root.addChild(subtitleEl);

    const cta = makeCta(fontAsset);
    root.addChild(cta);

    root.enabled = false;
    return { root, cta };
}

export function createEndUi(fontAsset: Asset): EndUi {
    return {
        win: makeOverlay(fontAsset, WIN_TITLE, WIN_SUBTITLE),
        lose: makeOverlay(fontAsset, LOSE_TITLE, LOSE_SUBTITLE)
    };
}
