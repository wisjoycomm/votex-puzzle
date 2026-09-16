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
};

/** Vungle and Mintegral have no URL to hand over - the container already knows the destination. */
function post(message: string): boolean {
    if (typeof window === "undefined" || !window.parent || window.parent === window) return false;
    window.parent.postMessage(message, "*");
    return true;
}

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
        case "unity":
            // Unity Ads is MRAID on the wire; it differs only in resize handling, which is the
            // renderer's business, not this one's.
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
        case "vungle":
            // Liftoff's spec: 'download' and 'complete' must never both fire. `complete` already
            // triggers the store itself once enough of the ad has played, so after gameEnded()
            // has posted it, a CTA tap must stay quiet rather than double-count the click.
            if (ended) return;
            if (post("download")) return;
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
 * Tell the network the run is over. Vungle and Mintegral require this *in addition to* the store
 * click; everyone else ignores it. Call on win and on loss — "ended", not "won".
 *
 * Fires once: networks count completions and reject repeats.
 */
export function gameEnded(): void {
    if (ended) return;
    ended = true;

    const hooks = globalThis as unknown as Hooks;
    switch (detectNetwork()) {
        case "mintegral":
            hooks.gameEnd?.();
            break;
        case "vungle":
            post("complete");
            break;
    }
}

/** Test seam: the once-only latch is module state, and each case needs a fresh one. */
export function resetGameEnded(): void {
    ended = false;
}
