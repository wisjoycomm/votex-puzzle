// Check a built playable before it goes to a network's validator. Engine-agnostic: it only reads
// the emitted HTML, so it works on adapters/playcanvas/dist/* and adapters/cocos/dist/* alike.
//
//   node scripts/verify-playable.mjs adapters/cocos/dist/*/index.html
//   node scripts/verify-playable.mjs adapters/playcanvas/dist/google/index.html --net google
//
// The network is read off the parent directory name unless --net says otherwise.
// What it does NOT do: boot the page. Rendering is a browser's job - open the file and look.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Raise if a network's cap does. Most networks measure the raw file, not gzip.
const CAP_MB = { meta: 5, google: 5, mraid: 5 };

// The only outbound request any target is allowed to make.
const GOOGLE_EXITAPI = 'https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js';

const SDK_TAG = { meta: null, google: GOOGLE_EXITAPI, mraid: 'mraid.js' };

/**
 * Check one built playable. Returns what it found; throws nothing, exits nothing - the caller
 * decides. `net` is read off the parent directory name when not given.
 */
export function verifyPlayable(file, net = basename(dirname(file))) {
    const fails = [];
    const ok = (cond, msg) => (cond ? null : fails.push(msg));

    if (!(net in SDK_TAG)) return { net, mb: 0, fails: [`unknown network "${net}" - expected meta, google or mraid`] };

    const html = readFileSync(file, 'utf8');
    const mb = statSync(file).size / 1024 / 1024;

    // One file, or the inlining silently didn't take.
    const siblings = readdirSync(dirname(file)).filter((f) => f !== basename(file));
    ok(siblings.length === 0, `not self-contained: ${siblings.join(', ')}`);

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

    // Outbound requests. Meta allows none at all; Google allows exactly exitapi.js.
    const urls = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
    const stray = urls.filter((u) => u !== tag);
    ok(stray.length === 0, `outbound request(s) a playable can't make: ${stray.join(', ')}`);

    return { net, mb, fails };
}

/** Prints one line per file (plus reasons on failure). Returns true when every file passed. */
export function reportPlayables(files, net = null) {
    let allOk = true;
    for (const file of files) {
        const r = verifyPlayable(file, net ?? basename(dirname(file)));
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
    const files = args.filter((a, i) => !a.startsWith('--') && !(netFlag !== -1 && i === netFlag + 1));

    if (files.length === 0) {
        console.error('usage: node scripts/verify-playable.mjs <dist/<network>/index.html>... [--net <network>]');
        process.exit(2);
    }
    process.exit(reportPlayables(files, forced) ? 0 : 1);
}
