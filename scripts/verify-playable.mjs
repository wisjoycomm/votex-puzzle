// Check a built playable before it goes to a network's validator. Engine-agnostic: it only reads
// the emitted HTML, so it works on adapters/playcanvas/dist/* and adapters/cocos/dist/* alike.
//
//   node scripts/verify-playable.mjs adapters/cocos/dist/*.html
//   node scripts/verify-playable.mjs adapters/playcanvas/dist/google/index.html --net google
//
// The network is read off the file name, else the parent directory, unless --net says otherwise.
// What it does NOT do: boot the page. Rendering is a browser's job - open the file and look.
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Caps for ONE self-contained html, which is all this repo ships - a zip is allowed more almost
// everywhere (Meta: 2 MB single file, 5 MB zipped). Measured raw, not gzip.
// Source: https://docs.lunalabs.io/docs/playable/ad-networks/overview
//
// `mraid` is the generic build, handed to whoever asks: AppLovin, ironSource and Moloco are all
// 5 MB, but that same file sent to AdColony (2 MB) or TikTok/Tencent (3 MB) needs `--net meta`
// as a stand-in for the stricter budget.
const CAP_MB = { meta: 2, google: 5, mraid: 5, unity: 5, vungle: 5, mintegral: 5 };

// The only outbound request any target is allowed to make.
const GOOGLE_EXITAPI = 'https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js';

// The tag each network's container expects in <head>. Vungle (postMessage to the parent frame)
// and Mintegral (globals its container injects) need none, same as Meta.
const SDK_TAG = {
    meta: null,
    google: GOOGLE_EXITAPI,
    mraid: 'mraid.js',
    unity: 'mraid.js',
    vungle: null,
    mintegral: null
};

/**
 * Which network a built file targets. The Cocos hook writes `<build>-<network>-<stamp>.html` flat
 * in dist/, the PlayCanvas build writes `dist/<network>/index.html` - so try the file name first,
 * then the parent directory, and hand back whatever was there so the error can say what it saw.
 */
export function networkOf(file) {
    // Whole tokens, not a substring: a build named "metaverse" must not read as `meta`.
    const tokens = basename(file).toLowerCase().split(/[^a-z0-9]+/);
    return Object.keys(SDK_TAG).find((n) => tokens.includes(n)) ?? basename(dirname(file));
}

/**
 * Check one built playable. Returns what it found; throws nothing, exits nothing - the caller
 * decides. `net` is read off the parent directory name when not given.
 */
export function verifyPlayable(file, net = networkOf(file)) {
    const fails = [];
    const ok = (cond, msg) => (cond ? null : fails.push(msg));

    if (!(net in SDK_TAG)) return { net, mb: 0, fails: [`unknown network "${net}" - expected one of ${Object.keys(SDK_TAG).join(', ')}`] };

    const html = readFileSync(file, 'utf8');
    const mb = statSync(file).size / 1024 / 1024;

    ok(mb <= CAP_MB[net], `${mb.toFixed(2)} MB is over the ${CAP_MB[net]} MB cap`);

    // The build stamp, and the code that reads it. Two hits: a lone stamp means the adapter is
    // linked against a stale playable-ads-core/dist that predates buildNetwork().
    ok(html.includes(`window.__AD_NETWORK__="${net}"`), `no build stamp for "${net}"`);
    // Cocos is exempt: playable-adapter-core deflates every script into a base64
    // `window.__adapter_zip__` blob, so no bundle text is greppable and the read can't be seen.
    const hits = html.split('__AD_NETWORK__').length - 1;
    const zipped = html.includes('__adapter_zip__');
    ok(zipped || hits >= 2, `stamp present but nothing reads it (${hits} hit) - rebuild playable-ads-core`);

    // The network's own SDK tag.
    const tag = SDK_TAG[net];
    if (tag) ok(html.includes(tag), `missing the ${net} SDK tag (${tag})`);

    // Every reference the page makes. One rule covers both things that used to be checked
    // separately: a remote URL is a request a playable can't make, and a relative path is a file
    // the inlining failed to swallow - either way the only legal refs are inline data:, an
    // in-page #anchor, and the network's own SDK tag. Commented-out tags don't count (the Cocos
    // template ships a dead <link href=".png">), so they go first.
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    const refs = [...live.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    const stray = refs.filter((u) => u !== tag && u !== '' && !u.startsWith('data:') && !u.startsWith('#'));
    ok(stray.length === 0, `not self-contained - stray ref(s): ${[...new Set(stray)].join(', ')}`);

    return { net, mb, fails };
}

/** Prints one line per file (plus reasons on failure). Returns true when every file passed. */
export function reportPlayables(files, net = null) {
    let allOk = true;
    for (const file of files) {
        const r = verifyPlayable(file, net ?? networkOf(file));
        if (r.fails.length) {
            allOk = false;
            console.log(`FAIL  ${file}  [${r.net}]`);
            for (const f of r.fails) console.log(`        - ${f}`);
        } else {
            console.log(`ok    ${file}  [${r.net}]  ${r.mb.toFixed(2)} MB`);
        }
    }
    return allOk;
}

// --- CLI ---------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const netFlag = args.indexOf('--net');
    const forced = netFlag === -1 ? null : args[netFlag + 1];
    const patterns = args.filter((a, i) => !a.startsWith('--') && !(netFlag !== -1 && i === netFlag + 1));
    // Expand globs here: npm scripts run through cmd.exe on Windows, which doesn't.
    const files = patterns.flatMap((a) => (existsSync(a) ? [a] : globSync(a)));

    if (patterns.length === 0) {
        console.error('usage: node scripts/verify-playable.mjs <built.html>... [--net <network>]');
        process.exit(2);
    }
    if (files.length === 0) {
        console.error(`nothing matched: ${patterns.join(', ')} - build first`);
        process.exit(1);
    }
    process.exit(reportPlayables(files, forced) ? 0 : 1);
}
