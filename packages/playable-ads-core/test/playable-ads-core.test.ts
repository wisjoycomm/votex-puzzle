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

const { buildNetwork, detectNetwork, gameEnded, isIos, isVisible, openStore, pickStoreUrl, resetGameEnded } =
    await import("../src/index.ts");

const URLS = { ios: "https://apps.apple.com/app/id1", android: "https://play.google.com/store/apps/details?id=a" };

/** Remove every SDK an earlier case installed, so each starts from a bare page. */
function clearSdks(): void {
    for (const k of ["FbPlayableAd", "ExitApi", "mraid", "install", "open", "gameEnd", "gameReady", "__AD_NETWORK__"]) {
        delete (globalThis as Record<string, unknown>)[k];
    }
}

test("buildNetwork reads the build stamp, and ignores a bogus one", () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__AD_NETWORK__;
    assert.equal(buildNetwork(), undefined);
    g.__AD_NETWORK__ = "google";
    assert.equal(buildNetwork(), "google");
    g.__AD_NETWORK__ = "tiktok";
    assert.equal(buildNetwork(), undefined);
    delete g.__AD_NETWORK__;
});

test("the build stamp wins over the probe", () => {
    clearSdks();
    const g = globalThis as Record<string, unknown>;
    // Built for mraid, but the MRAID SDK hasn't injected yet — the build still knows what it is.
    g.__AD_NETWORK__ = "mraid";
    assert.equal(detectNetwork(), "mraid");
    // And it outranks an SDK from a different network that happens to be present.
    g.FbPlayableAd = { onCTAClick() {} };
    assert.equal(detectNetwork(), "mraid");
    clearSdks();
});

test("a stamped build with no SDK still clicks through", () => {
    clearSdks();
    const g = globalThis as Record<string, unknown>;
    let opened = "";
    g.window = { open: (u: string) => (opened = u) };
    for (const network of ["meta", "google", "mraid"]) {
        opened = "";
        g.__AD_NETWORK__ = network;
        openStore(URLS);
        assert.equal(opened, URLS.android, `${network} build with no SDK must fall back`);
    }
    clearSdks();
});

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

test("gameEnded calls only the network that asked for it", () => {
    const g = globalThis as Record<string, unknown>;
    let ends = 0;
    g.gameEnd = () => ends++;

    g.__AD_NETWORK__ = "mintegral";
    resetGameEnded();
    gameEnded();
    assert.equal(ends, 1);

    // Fires once - networks count completions.
    gameEnded();
    assert.equal(ends, 1);

    // Everyone else ignores the concept entirely, even with gameEnd sitting on the page.
    for (const net of ["meta", "google", "mraid", "applovin", "unity"]) {
        g.__AD_NETWORK__ = net;
        resetGameEnded();
        gameEnded();
    }
    assert.equal(ends, 1);

    delete g.gameEnd;
    delete g.__AD_NETWORK__;
});

test("openStore dispatches per network: the MRAID family opens, mintegral installs", () => {
    const g = globalThis as Record<string, unknown>;

    // mraid, applovin and unity are the same call - only the stamp differs.
    const opened: string[] = [];
    clearSdks();
    g.mraid = { getState: () => "default", open: (u: string) => opened.push(u) };
    for (const net of ["mraid", "applovin", "unity"]) {
        g.__AD_NETWORK__ = net;
        openStore(URLS);
    }
    assert.deepEqual(opened, [URLS.android, URLS.android, URLS.android]);

    // Mintegral takes a bare install(), no url - the container knows the destination.
    let installs = 0;
    clearSdks();
    g.install = () => installs++;
    g.__AD_NETWORK__ = "mintegral";
    openStore(URLS);
    assert.equal(installs, 1);

    delete g.__AD_NETWORK__;
});
