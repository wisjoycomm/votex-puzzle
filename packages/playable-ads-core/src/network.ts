// Which ad network we're in, and when it lets the game run.
// No engine import here by design — window/document/navigator only.

/**
 * The networks this game builds for. `mraid` is the generic one — ironSource, Moloco and anything
 * else that speaks plain MRAID. AppLovin and Unity are MRAID too and take the same calls; they get
 * their own build only so the stamp names the network the file was sent to. Mintegral is the one
 * that differs: its container injects its own globals, and it ships as a zip.
 */
export const AD_NETWORKS = ["meta", "google", "mraid", "applovin", "unity", "mintegral"] as const;

export type AdNetwork = (typeof AD_NETWORKS)[number] | "none";

type NetworkHooks = {
    FbPlayableAd?: { onCTAClick?: () => void };
    ExitApi?: { exit?: () => void };
    mraid?: Mraid;
    /** Mintegral's container injects these; `gameReady` is how its own SDK sniffs the protocol. */
    install?: () => void;
    gameReady?: () => void;
    gameEnd?: () => void;
};

type Mraid = {
    getState(): string;
    isViewable(): boolean;
    open(url: string): void;
    addEventListener(event: string, listener: (arg: unknown) => void): void;
};

function hooks(): NetworkHooks {
    return globalThis as unknown as NetworkHooks;
}

function mraid(): Mraid | undefined {
    const api = hooks().mraid;
    return typeof api?.getState === "function" ? api : undefined;
}

/**
 * The network this file was BUILT for, stamped into `<head>` as `window.__AD_NETWORK__` by the
 * build (vite `network-head` plugin / the Cocos `playable-build` extension). `undefined` in dev
 * and in any build that didn't stamp it.
 *
 * This is what `detectNetwork()` answers with when present: the build knows its target, and some
 * SDKs inject late enough that a probe at click time can still miss them. Whether the SDK is
 * actually *callable* is a separate question, guarded at the call site in `openStore`.
 */
export function buildNetwork(): AdNetwork | undefined {
    const stamp = (globalThis as { __AD_NETWORK__?: string }).__AD_NETWORK__;
    return AD_NETWORKS.find((n) => n === stamp);
}

/**
 * The build stamp when there is one, otherwise a probe. Probed per call, not cached: several SDKs
 * inject after the creative's script runs, which is also why the stamp is trusted over the probe.
 */
export function detectNetwork(): AdNetwork {
    const stamped = buildNetwork();
    if (stamped) return stamped;

    const h = hooks();
    if (typeof h.FbPlayableAd?.onCTAClick === "function") return "meta";
    if (typeof h.ExitApi?.exit === "function") return "google";
    // Before the mraid check: Mintegral's container speaks MRAID too, but wants its own globals.
    if (typeof h.gameReady === "function" || typeof h.gameEnd === "function") return "mintegral";
    // Unity is MRAID on the wire, so a probe can't tell the two apart - only the stamp can, and
    // it doesn't matter: they take the same call.
    if (mraid()) return "mraid";
    return "none";
}

/** Resolves when the container will show the game. Immediate without MRAID. */
export function whenReady(): Promise<void> {
    const api = mraid();
    if (!api || api.getState() !== "loading") return Promise.resolve();
    return new Promise((resolve) => api.addEventListener("ready", () => resolve()));
}

// document.hidden covers backgrounding; viewableChange covers the slot scrolling away.
let viewable = true;

const api = mraid();
if (api) {
    // Some SDKs send the string 'true'.
    const set = (v: unknown) => {
        viewable = v === true || v === "true";
    };
    api.addEventListener("viewableChange", set);
    // Fires only on change, so seed it once.
    void whenReady().then(() => set(api.isViewable()));
}

/** Whether the game should simulate this frame. */
export function isVisible(): boolean {
    return viewable && !document.hidden;
}
