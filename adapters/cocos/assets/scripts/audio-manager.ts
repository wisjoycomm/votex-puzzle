import { AudioClip, AudioSource, Component, Node, _decorator } from "cc";
import { isVisible } from "playable-ads-core";

const { ccclass, property, requireComponent } = _decorator;

// Raise if a bee burst flams.
const MIN_GAP_MS = 40;

/** `shoot_2` -> `shoot`: a trailing `_<n>` marks a variant, not a sound of its own. */
function keyOf(clip: AudioClip): string {
    return clip.name.replace(/\.\w+$/, "").replace(/_\d+$/, "");
}

let active: AudioManager | null = null;
/** False until the first gesture-driven sfx(); web audio won't autoplay before one. */
let gestured = false;

const lastPlayed = new Map<string, number>();
const lastVariant = new Map<string, number>();
const warned = new Set<string>();

/** Names are strings: a typo can't fail to compile, so it has to say something here. */
function warnMissing(name: string): void {
    if (!active || warned.has(name)) return;
    warned.add(name);
    console.warn(`[audio] no clip named "${name}" on AudioManager`);
}

/** Every clip the game plays, keyed on its asset name. Drop this on the GameView node. */
@ccclass("AudioManager")
@requireComponent(AudioSource)
export class AudioManager extends Component {
    @property({
        type: [AudioClip],
        tooltip: "Every clip. sfx() keys on the asset name; name_1, name_2… are random variants of name",
    })
    clips: AudioClip[] = [];

    @property({ range: [0, 1], slide: true, tooltip: "Volume for all one-shots" })
    volume = 0.5;

    @property({ range: [0, 1], slide: true, tooltip: "Backing track volume" })
    musicVolume = 0.25;

    source: AudioSource = null!;

    private byName = new Map<string, AudioClip[]>();
    private music: AudioSource = null!;
    /** Our own latch: `music.playing` reads false for a frame after `clip` is set. */
    private musicOn = false;

    onLoad(): void {
        this.source = this.getComponent(AudioSource)!;
        this.source.volume = this.volume;

        for (const clip of this.clips) {
            if (!clip) continue;
            const key = keyOf(clip);
            const list = this.byName.get(key);
            if (list) list.push(clip);
            else this.byName.set(key, [clip]);
        }

        // Its own source on its own node: `volume` is per-source, and getComponent must stay
        // unambiguous.
        const node = new Node("Music");
        this.node.addChild(node);
        this.music = node.addComponent(AudioSource);
        this.music.loop = true;
        this.music.volume = this.musicVolume;

        active = this;
    }

    onDestroy(): void {
        if (active === this) active = null;
    }

    /** update() starts it: the clip can be set before web audio is unlocked. */
    setMusic(clip: AudioClip): void {
        if (this.music.clip === clip) return;
        this.music.stop();
        this.music.clip = clip;
        this.musicOn = false;
    }

    pick(name: string): AudioClip | undefined {
        const list = this.byName.get(name);
        if (!list) return undefined;
        let i = Math.floor(Math.random() * list.length);
        // Two variants and pure random still repeats half the time.
        if (list.length > 1 && i === lastVariant.get(name)) i = (i + 1) % list.length;
        lastVariant.set(name, i);
        return list[i];
    }

    /** Polled: `isVisible()` has nothing to subscribe to, and an ad scrolled out of its slot
     *  keeps playing where a hidden tab wouldn't. */
    update(): void {
        if (!this.music.clip) return;
        const want = gestured && isVisible();
        if (want === this.musicOn) return;
        this.musicOn = want;
        if (want) this.music.play();
        else this.music.pause();
    }
}

/** Fire-and-forget one-shot; `playOneShot` layers, so overlapping bees stack. */
export function playSfx(name: string): void {
    if (!isVisible()) return;
    // Every sfx() is downstream of the first lane tap, so this is inside that gesture.
    gestured = true;

    const now = performance.now();
    if (now - (lastPlayed.get(name) ?? -Infinity) < MIN_GAP_MS) return;

    const clip = active?.pick(name);
    if (!clip) return warnMissing(name);

    lastPlayed.set(name, now);
    active!.source.playOneShot(clip);
}

/** Loop a clip from the same list on the music source. Safe to call before the first gesture —
 *  it starts once audio is unlocked and the ad is on screen. */
export function playMusic(name: string): void {
    const clip = active?.pick(name);
    if (!clip) return warnMissing(name);
    active!.setMusic(clip);
}
