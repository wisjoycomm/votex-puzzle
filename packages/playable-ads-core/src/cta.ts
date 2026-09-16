// The click-through. Store is a device fact, API is a network fact — both resolved at click time.
//
// The game's own links live here, once, because both adapters ship the same game and had drifted
// into keeping their own copy of them. `openStore()` still takes urls, so a second game reusing
// this package overrides rather than edits.

import { detectNetwork } from "./network.ts";

export type StoreUrls = {
    ios: string;
    android: string;
};

/** Bee Cube's live store listings. The only place they are written down. */
export const STORE_URLS: StoreUrls = {
    ios: "https://apps.apple.com/us/app/bee-flow-pixel-puzzle/id6789171212",
    android: "https://play.google.com/store/apps/details?id=com.artoon.bee.buzz.pixel.puzzle",
};

type Hooks = {
    FbPlayableAd?: { onCTAClick?: () => void };
    ExitApi?: { exit?: () => void };
    mraid?: { open?: (url: string) => void };
    install?: () => void;
    gameEnd?: () => void;
    gameReady?: () => void;
    gameStart?: () => void;
    gameClose?: () => void;
};

/** iPadOS 13+ reports a desktop Mac UA; touch points are what give it away. */
export function isIos(): boolean {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

export function pickStoreUrl(urls: StoreUrls): string {
    return isIos() ? urls.ios : urls.android;
}

/**
 * Fire the network's click-through. Safe with no SDK present.
 * Meta and Google own the destination, so they ignore `urls`.
 * Call once per click — networks count clicks and some reject double-fires.
 */
export function openStore(urls: StoreUrls = STORE_URLS): void {
    const hooks = globalThis as unknown as Hooks;

    // Each case is guarded, not asserted: the network now comes from the build stamp, so a
    // mis-tagged build (or an SDK that never injected) has to fall through and still click.
    switch (detectNetwork()) {
        case "meta":
            if (typeof hooks.FbPlayableAd?.onCTAClick === "function") {
                hooks.FbPlayableAd.onCTAClick();
                return;
            }
            break;
        case "google":
            if (typeof hooks.ExitApi?.exit === "function") {
                hooks.ExitApi.exit();
                return;
            }
            break;
        case "mraid":
        case "applovin":
        case "unity":
            // AppLovin and Unity are MRAID on the wire. Unity differs only in resize handling,
            // which is the renderer's business, not this one's.
            if (typeof hooks.mraid?.open === "function") {
                hooks.mraid.open(pickStoreUrl(urls));
                return;
            }
            break;
        case "mintegral":
            if (typeof hooks.install === "function") {
                hooks.install();
                return;
            }
            break;
    }

    // Some networks inject a bare install().
    if (typeof hooks.install === "function") {
        hooks.install();
        return;
    }
    window.open(pickStoreUrl(urls), "_blank", "noopener");
}

// --- end of run -------------------------------------------------------------------------------

let ended = false;

/**
 * Tell the network the run is over. Mintegral requires this *in addition to* the store click;
 * everyone else ignores it. Call on win and on loss — "ended", not "won".
 *
 * Fires once: networks count completions and reject repeats.
 */
export function gameEnded(): void {
    if (ended) return;
    ended = true;

    if (detectNetwork() === "mintegral") (globalThis as unknown as Hooks).gameEnd?.();
}

/** Test seam: the once-only latch is module state, and each case needs a fresh one. */
export function resetGameEnded(): void {
    ended = false;
}

/**
 * Mintegral §4: call once every resource has finished loading. Ignored everywhere else.
 *
 * Direction matters and the name does not carry it — half of Mintegral's `game*` globals are ours
 * to CALL, half are ours to DEFINE for its container to call. Get it backwards and nothing throws:
 * the creative loads, the checklist can even go green, and the hook simply never runs.
 */
export function gameReady(): void {
    if (detectNetwork() === "mintegral") (globalThis as unknown as Hooks).gameReady?.();
}

/**
 * Mintegral §5: the container CALLS this, so we define it — "starting the countdown, starting the
 * background music". Deliberately not named `gameStart`: Luna ships a `startGame` that looks like
 * the same word transposed but gates boot instead, and confusing the two is the classic bug here.
 */
export function onAdStart(fn: () => void): void {
    (globalThis as unknown as Hooks).gameStart = fn;
}

/** Mintegral §7: the container CALLS this at the end of the ad — "turn off this background music". */
export function onAdClose(fn: () => void): void {
    (globalThis as unknown as Hooks).gameClose = fn;
}
