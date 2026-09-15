import { test } from "node:test";
import assert from "node:assert/strict";

// Browser globals stubbed. Set before the dynamic import: network.ts wires its listener at
// module scope.
function setUserAgent(ua: string, maxTouchPoints = 0): void {
    Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: ua, maxTouchPoints },
        configurable: true,
        writable: true,
    });
}

const doc = { hidden: false };
Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });

setUserAgent("Mozilla/5.0 (Linux; Android 13)");

const { detectNetwork, isIos, isVisible, openStore, pickStoreUrl } = await import("../src/index.ts");

const URLS = { ios: "https://apps.apple.com/app/id1", android: "https://play.google.com/store/apps/details?id=a" };

/** Remove every SDK an earlier case installed, so each starts from a bare page. */
function clearSdks(): void {
    for (const k of ["FbPlayableAd", "ExitApi", "mraid", "install", "open"]) {
        delete (globalThis as Record<string, unknown>)[k];
    }
}

test("detectNetwork reports none on a bare page", () => {
    clearSdks();
    assert.equal(detectNetwork(), "none");
});

test("detectNetwork prefers the network-specific SDKs over mraid", () => {
    clearSdks();
    // A creative can carry both: MRAID is the generic fallback, so it must lose to Meta's own API.
    (globalThis as Record<string, unknown>).mraid = { getState: () => "default", isViewable: () => true, open() {}, addEventListener() {} };
    (globalThis as Record<string, unknown>).FbPlayableAd = { onCTAClick() {} };
    assert.equal(detectNetwork(), "meta");

    delete (globalThis as Record<string, unknown>).FbPlayableAd;
    (globalThis as Record<string, unknown>).ExitApi = { exit() {} };
    assert.equal(detectNetwork(), "google");

    delete (globalThis as Record<string, unknown>).ExitApi;
    assert.equal(detectNetwork(), "mraid");
});

test("a half-injected mraid is not treated as a network", () => {
    clearSdks();
    (globalThis as Record<string, unknown>).mraid = {};
    assert.equal(detectNetwork(), "none");
});

test("openStore uses each network's own API, and only mraid gets the url", () => {
    clearSdks();
    let called = "";
    let passedUrl = "";

    (globalThis as Record<string, unknown>).FbPlayableAd = { onCTAClick: () => (called = "meta") };
    openStore(URLS);
    assert.equal(called, "meta");

    clearSdks();
    (globalThis as Record<string, unknown>).ExitApi = { exit: () => (called = "google") };
    openStore(URLS);
    assert.equal(called, "google");

    clearSdks();
    (globalThis as Record<string, unknown>).mraid = {
        getState: () => "default",
        isViewable: () => true,
        addEventListener() {},
        open: (u: string) => {
            called = "mraid";
            passedUrl = u;
        },
    };
    openStore(URLS);
    assert.equal(called, "mraid");
    assert.equal(passedUrl, URLS.android);
});

test("openStore falls back to a bare install(), then to window.open", () => {
    clearSdks();
    let called = "";
    (globalThis as Record<string, unknown>).install = () => (called = "install");
    openStore(URLS);
    assert.equal(called, "install");

    clearSdks();
    let opened = "";
    (globalThis as Record<string, unknown>).window = { open: (u: string) => (opened = u) };
    openStore(URLS);
    assert.equal(opened, URLS.android);
});

test("pickStoreUrl follows the device, including an iPad reporting as a Mac", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    assert.equal(isIos(), true);
    assert.equal(pickStoreUrl(URLS), URLS.ios);

    // iPadOS 13+ ships a desktop Safari UA; touch points are what give it away.
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5);
    assert.equal(isIos(), true);

    // A real Mac reports no touch points, and must not be sent to the App Store.
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0);
    assert.equal(isIos(), false);

    setUserAgent("Mozilla/5.0 (Linux; Android 13)");
    assert.equal(pickStoreUrl(URLS), URLS.android);
});

test("isVisible follows document.hidden when there is no mraid", () => {
    doc.hidden = false;
    assert.equal(isVisible(), true);
    doc.hidden = true;
    assert.equal(isVisible(), false);
    doc.hidden = false;
});
