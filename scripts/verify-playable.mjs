// Check a built playable before it goes to a network's validator. Engine-agnostic: it only reads
// the emitted HTML, so it works on adapters/playcanvas/dist/* and adapters/cocos/dist/* alike.
//
//   node scripts/verify-playable.mjs adapters/cocos/dist/*.html
//   node scripts/verify-playable.mjs adapters/playcanvas/dist/google/index.html --net google
//
// The network is read off the file name, else the parent directory, unless --net says otherwise.
// What it does NOT do: boot the page. Rendering is a browser's job - open the file and look.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Size budgets, in MB, for ONE self-contained html - a zip is usually allowed more, which this
// repo doesn't ship. Source: https://docs.lunalabs.io/docs/playable/ad-networks/overview
//
// Over budget is reported as a WARNING, never a failure: every network publishes its own number,
// they move, and the same `mraid` file gets handed to networks with different limits (AdColony
// 2 MB, TikTok/Tencent 3 MB). Worth seeing before you send; not worth throwing away a build over.
const CAP_MB = { meta: 5, google: 5, mraid: 5, applovin: 5, unity: 5, mintegral: 5 };

// The only outbound request any target is allowed to make.
const GOOGLE_EXITAPI = 'https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js';

// The tag each network's container expects in <head>. Mintegral needs none: its container injects
// its own globals, and that build ships as a zip rather than one inlined file.
const SDK_TAG = {
    meta: null,
    google: GOOGLE_EXITAPI,
    mraid: 'mraid.js',
    applovin: 'mraid.js',
    unity: 'mraid.js',
    mintegral: null
};

/**
 * Expand one `dir/*.html` pattern. Hand-rolled rather than `fs.globSync`, which needs Node 22:
 * Cocos Creator runs this script on its OWN bundled Node (20.x), and an import it can't resolve
 * kills the build hook with a bare SyntaxError. Only `*` in the file name is supported, which is
 * all any caller uses.
 */
function expand(pattern) {
    if (existsSync(pattern)) return [pattern];
    const dir = dirname(pattern) || '.';
    const name = basename(pattern);
    const star = name.indexOf('*');
    if (star === -1 || !existsSync(dir)) return [];
    const head = name.slice(0, star);
    const tail = name.slice(star + 1);
    return readdirSync(dir)
        .filter((f) => f.length >= head.length + tail.length && f.startsWith(head) && f.endsWith(tail))
        .map((f) => join(dir, f));
}

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
    const warns = [];
    const ok = (cond, msg) => (cond ? null : fails.push(msg));

    if (!(net in SDK_TAG)) {
        return { net, mb: 0, fails: [`unknown network "${net}" - expected one of ${Object.keys(SDK_TAG).join(', ')}`], warns };
    }

    const html = readFileSync(file, 'utf8');
    const mb = statSync(file).size / 1024 / 1024;

    if (mb > CAP_MB[net]) warns.push(`${mb.toFixed(2)} MB is over ${net}'s ${CAP_MB[net]} MB budget`);

    // The build stamp, and the code that reads it. Two hits: a lone stamp means the adapter is
    // linked against a stale playable-ads-core/dist that predates buildNetwork().
    ok(html.includes(`window.__AD_NETWORK__="${net}"`), `no build stamp for "${net}"`);
    // A build whose bundle ships deflated is exempt: the read is inside the compressed blob, so
    // there is no bundle text to grep. Cocos does this for every script via playable-adapter-core's
    // `window.__adapter_zip__`; the PlayCanvas loose-html builds deflate their one chunk behind
    // `window.__gz__`. Either marker means "can't see it from here", not "it isn't there".
    const hits = html.split('__AD_NETWORK__').length - 1;
    const deflated = html.includes('__adapter_zip__') || html.includes('__gz__');
    ok(deflated || hits >= 2, `stamp present but nothing reads it (${hits} hit) - rebuild playable-ads-core`);

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

    return { net, mb, fails, warns };
}

/**
 * Prints one line per file, plus reasons. Returns true when nothing FAILED - warnings don't
 * change the answer, so a caller that gates on this won't block over a size budget.
 */
export function reportPlayables(files, net = null) {
    let allOk = true;
    for (const file of files) {
        const r = verifyPlayable(file, net ?? networkOf(file));
        const head = r.fails.length ? 'FAIL' : r.warns.length ? 'warn' : 'ok  ';
        if (r.fails.length) allOk = false;
        console.log(`${head}  ${file}  [${r.net}]  ${r.mb.toFixed(2)} MB`);
        for (const f of r.fails) console.log(`        - ${f}`);
        for (const w of r.warns) console.log(`        ! ${w}`);
    }
    return allOk;
}

// --- CLI ---------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const netFlag = args.indexOf('--net');
    const forced = netFlag === -1 ? null : args[netFlag + 1];
    const patterns = args.filter((a, i) => !a.startsWith('--') && !(netFlag !== -1 && i === netFlag + 1));
    // Expanded here: npm scripts run through cmd.exe on Windows, which doesn't glob.
    const files = patterns.flatMap(expand);

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
