import { isVisible } from 'playable-ads-core';

// `?inline` = base64 data URI, so the playable stays one file. Re-encode the masters with
// `node scripts/shrink-audio.mjs`.
//
// Not PlayCanvas' sound system: that would mean registering SoundComponentSystem, a SoundManager
// and AudioHandler in main.ts just to play six one-shots — and AudioHandler resolves clips through
// the asset registry, which trips over data URIs the same way the HUD font PNG does (see hud.ts).
import MUSIC_URL from './assets/audios/backtrack.mp3?inline';
import CLICK_URL from './assets/audios/button-click.mp3?inline';
import HIVE_URL from './assets/audios/got-in-hive.mp3?inline';
import LOSE_URL from './assets/audios/lose.mp3?inline';
import SHOOT_URL from './assets/audios/shoot.mp3?inline';
import SPAWN_URL from './assets/audios/spawn.mp3?inline';
import WIN_URL from './assets/audios/win.mp3?inline';

const CLIPS = {
    click: CLICK_URL,
    hive: HIVE_URL,
    lose: LOSE_URL,
    shoot: SHOOT_URL,
    spawn: SPAWN_URL,
    win: WIN_URL
};

export type SfxName = keyof typeof CLIPS;

/** The masters aren't levelled against each other — the win sting is far hotter than the click.
 *  Tune here, on device, rather than at the call sites. */
const VOLUME: Record<SfxName, number> = {
    click: 0.5,
    hive: 0.6,
    lose: 0.8,
    shoot: 0.5,
    spawn: 0.7,
    win: 0.8
};

/** Backing track, well under the one-shots so a sting still cuts through it. Matches the Cocos
 *  adapter's shipped `musicVolume`. */
const MUSIC_VOLUME = 0.25;

const lastPlayed: Partial<Record<SfxName, number>> = {};

let music: HTMLAudioElement | null = null;
let musicOn = false;
/** Web audio won't start before a user gesture, and every sfx() is downstream of the first tap. */
let gestured = false;

// ponytail: flat retrigger gap for every clip; make it per-clip if a bee burst still flams.
const MIN_GAP_MS = 40;

/**
 * Fire-and-forget one-shot. A fresh element per call so overlapping bees layer instead of cutting
 * each other off — the src is a data URI, so there's no fetch behind the extra element.
 */
export function sfx(name: SfxName): void {
    // Off-screen or backgrounded: the ad is not allowed to be the thing making noise.
    if (!isVisible()) return;

    // Inside the gesture that produced this sound, which is what unlocks the backing track.
    gestured = true;

    const now = performance.now();
    if (now - (lastPlayed[name] ?? -Infinity) < MIN_GAP_MS) return;
    lastPlayed[name] = now;

    const audio = new Audio(CLIPS[name]);
    audio.volume = VOLUME[name];
    // Rejects until a user gesture unlocks audio on iOS. Nothing to do about it, and an unhandled
    // rejection is exactly the kind of console noise network QA rejects a creative for.
    void audio.play().catch(() => {
        // Not recoverable and not worth reporting: the next gesture-driven play will work.
    });
}

/** Arm the backing track. Safe before the first gesture — it starts once audio is unlocked and
 *  the ad is on screen, which is what `updateMusic()` watches for. */
export function startMusic(): void {
    if (music) return;
    music = new Audio(MUSIC_URL);
    music.loop = true;
    music.volume = MUSIC_VOLUME;
}

/**
 * Polled from the frame loop. Must be called BEFORE the loop's own `isVisible()` early-return:
 * going quiet is exactly what a backgrounded ad has to do, so it can't sit behind that guard.
 * Polled rather than event-driven for the same reason `isVisible()` is — an ad scrolled out of its
 * slot fires nothing, where a hidden tab would.
 */
export function updateMusic(): void {
    if (!music) return;
    const want = gestured && isVisible();
    if (want === musicOn) return;
    musicOn = want;
    if (want) {
        void music.play().catch(() => {
            // Still locked; the next gesture-driven poll picks it up.
        });
    } else {
        music.pause();
    }
}
