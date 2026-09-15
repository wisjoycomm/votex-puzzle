// The click-through. Store is a device fact, API is a network fact — both resolved at click time.
// URLs are passed in: they're the app's, this package is shared.

import { detectNetwork } from "./network.ts";

export type StoreUrls = {
    ios: string;
    android: string;
};

type Hooks = {
    FbPlayableAd?: { onCTAClick?: () => void };
    ExitApi?: { exit?: () => void };
    mraid?: { open?: (url: string) => void };
    install?: () => void;
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
export function openStore(urls: StoreUrls): void {
    const hooks = globalThis as unknown as Hooks;

    switch (detectNetwork()) {
        case "meta":
            hooks.FbPlayableAd!.onCTAClick!();
            return;
        case "google":
            hooks.ExitApi!.exit!();
            return;
        case "mraid":
            hooks.mraid!.open!(pickStoreUrl(urls));
            return;
        default:
            // Some networks inject a bare install().
            if (typeof hooks.install === "function") {
                hooks.install();
                return;
            }
            window.open(pickStoreUrl(urls), "_blank", "noopener");
    }
}
