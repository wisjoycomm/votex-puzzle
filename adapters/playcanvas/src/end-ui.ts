import { Color, ELEMENTTYPE_IMAGE, Entity } from 'playcanvas';
import type { Asset } from 'playcanvas';

import { makeFullScreenGroup, makeText } from './ui-elements.ts';

// The win and lose screens. Deliberately a separate module from the gameplay HUD: these appear
// only once a round is over, share none of the board's layout, and are where restart / score /
// call-to-action will land. hud.ts decides WHEN they show (off GameState.status) — this file
// only decides what they look like.

const WIN_TITLE = 'Cleared!';
const WIN_SUBTITLE = 'Every cube collected';
const LOSE_TITLE = 'No moves left';
const LOSE_SUBTITLE = 'Nothing reachable for the colours still loaded';

const DIM = new Color(0.04, 0.04, 0.06);
const DIM_OPACITY = 0.72;
const TITLE_SIZE = 44;
const SUBTITLE_SIZE = 18;
const TEXT_WIDTH = 600;

export type EndUi = {
    /** Shown when the grid is cleared. */
    win: Entity;
    /** Shown when a loaded colour has cubes left but none reachable from any rotation. */
    lose: Entity;
}

// One end-of-round panel: dimmed backdrop, title, subtitle. Starts hidden. The backdrop is a
// plain tinted image with no texture, so this needs no new art.
function makeOverlay(fontAsset: Asset, title: string, subtitle: string): Entity {
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

    root.enabled = false;
    return root;
}

export function createEndUi(fontAsset: Asset): EndUi {
    return {
        win: makeOverlay(fontAsset, WIN_TITLE, WIN_SUBTITLE),
        lose: makeOverlay(fontAsset, LOSE_TITLE, LOSE_SUBTITLE)
    };
}
