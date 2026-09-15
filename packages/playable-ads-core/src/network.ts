// Which ad network we're in, and when it lets the game run.
// No engine import here by design — window/document/navigator only.

/** `mraid` covers AppLovin, ironSource, Unity, Vungle, Mintegral and Moloco — identical from here. */
export type AdNetwork = "meta" | "google" | "mraid" | "none";

type NetworkHooks = {
    FbPlayableAd?: { onCTAClick?: () => void };
    ExitApi?: { exit?: () => void };
    mraid?: Mraid;
    install?: () => void;
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

/** Probed per call, not cached: several SDKs inject after the creative's script runs. */
export function detectNetwork(): AdNetwork {
    const h = hooks();
    if (typeof h.FbPlayableAd?.onCTAClick === "function") return "meta";
    if (typeof h.ExitApi?.exit === "function") return "google";
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
