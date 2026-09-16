'use strict';

// Turn a finished web-mobile build into one shippable file per ad network.
//
//   node extensions/playable-build/pack.js            (from adapters/cocos)
//
// Runnable two ways on purpose. Creator's build hook calls pack() — but Creator loads an
// extension's main process ONCE at editor startup and never reloads it, so every edit to this
// pipeline is invisible to an editor that is already open. Running it as a plain script sidesteps
// that entirely: `exec3xAdapter` has no dependency on the editor, only on build/web-mobile
// existing. `npm run pack -w cocos-adapter` after a Creator build always uses the code on disk.

const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('fs');
const { basename, join } = require('path');
const { zipDir } = require('../../../../scripts/zip-dir.cjs');

// Our network name -> the adapter-core channel that produces it. This way round, not the reverse,
// because two networks can share one channel: `mraid` and `applovin` are the same MRAID file and
// differ only in the stamp, which is what tells the CTA and any reporting which network it went
// to. Chosen for the <head> each channel injects: Google injects exitapi.js plus an ad.size meta,
// AppLovin and Unity inject mraid.js. IronSource deliberately isn't used for `mraid` - its channel
// injects no mraid.js.
//
// Facebook and Mintegral write a FOLDER (index.html + js/) rather than one inlined file, which is
// fine because both ship zipped - Meta allows 5 MB zipped against 2 MB for a single html. `meta`
// used to ride on the Moloco channel to get one self-contained file; now that it ships as a zip it
// comes from Meta's own channel instead. Both shapes are handled below.
const CHANNEL_OF = {
    meta: 'Facebook',
    google: 'Google',
    mraid: 'AppLovin',
    applovin: 'AppLovin',
    unity: 'Unity',
    mintegral: 'Mintegral'
};

// Networks that take a ZIP; everything else ships as one loose html. Meta's single-file limit is
// the strict one (2 MB against 5 MB zipped), Google asks for zipped html outright, and Mintegral's
// channel emits a folder so it has no other option. Listing Mintegral is belt and braces - the
// folder branch below would zip it anyway - but the whole rule should be readable in one place.
const ZIPPED = new Set(['meta', 'google', 'mintegral']);

// Only decides Google's ad.size meta tag. The game itself reframes off the real aspect ratio,
// so raising/lowering this changes nothing but what Google is told to expect.
const ORIENTATION = 'portrait';

// Output file name: <name>-<network>-<stamp>. The name is the build panel's Name field
// (`cocos-adapter`), not the output folder (`web-mobile`) - the file gets sent to a network, so it
// should say what the game is, not which platform target built it. The stamp keeps every send-off
// distinct. verify-playable.mjs reads the network back out of the file name.
const stamp = () => new Date().toLocaleString('sv-SE').replace(/[-:]/g, '').replace(' ', '_').slice(0, 13);

// Mintegral §13 allows only [A-Za-z0-9_] in the delivered file name. Applied to every network
// rather than just that one: underscores are legal everywhere, so one rule beats a special case.
const safeName = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * @param {object} [opts]
 * @param {string} [opts.buildDir]  the folder holding web-mobile/ (default: <adapter>/build)
 * @param {string} [opts.outDir]    where the shippable files land (default: <adapter>/dist)
 * @param {string} [opts.buildName] leading part of each file name (default: the package name)
 */
async function pack(opts) {
    const o = opts || {};
    const root = join(__dirname, '..', '..');
    const buildDir = o.buildDir || join(root, 'build');
    const out = o.outDir || join(root, 'dist');
    const buildName = o.buildName || require('../../package.json').name;

    if (!existsSync(join(buildDir, 'web-mobile'))) {
        throw new Error(`[playable-build] no build at ${join(buildDir, 'web-mobile')} - build in Creator first`);
    }

    const { exec3xAdapter } = require('playable-adapter-core');
    await exec3xAdapter({
        buildFolderPath: buildDir,
        adapterBuildConfig: {
            buildPlatform: 'web-mobile',
            orientation: ORIENTATION,
            enableSplash: false,
            exportChannels: [...new Set(Object.values(CHANNEL_OF))]
        }
    });

    const when = stamp();
    mkdirSync(out, { recursive: true });
    // Staging for the networks that ship zipped: one folder per network holding the index.html
    // that goes into the archive. The folder is named after the network on purpose - it is what
    // verify-playable.mjs reads the network from when the file itself is called index.html.
    const stage = join(buildDir, '.pack');
    rmSync(stage, { recursive: true, force: true });
    const written = [];
    const toVerify = [];

    for (const [network, channel] of Object.entries(CHANNEL_OF)) {
        const asFile = join(buildDir, `${channel}.html`);
        const asDir = join(buildDir, channel);
        const base = safeName(`${buildName}_${network}_${when}`);
        // Stamp the target network so playable-ads-core's buildNetwork() can report it. Done
        // here rather than via the adapter's injectOptions, which doesn't reach every channel.
        const withStamp = (html) =>
            html.replace('</head>', `<script>window.__AD_NETWORK__="${network}";</script></head>`);

        let dest;
        if (existsSync(asFile) && ZIPPED.has(network)) {
            // One self-contained html, delivered as a zip. Staged as index.html because that is
            // the name every zip-taking network expects at the archive root.
            const dir = join(stage, network);
            mkdirSync(dir, { recursive: true });
            const staged = join(dir, 'index.html');
            writeFileSync(staged, withStamp(readFileSync(asFile, 'utf8')));
            toVerify.push(staged);
            dest = join(out, `${base}.zip`);
            zipDir(dir, dest);
        } else if (existsSync(asFile)) {
            dest = join(out, `${base}.html`);
            writeFileSync(dest, withStamp(readFileSync(asFile, 'utf8')));
            toVerify.push(dest);
        } else if (existsSync(join(asDir, 'index.html'))) {
            // A folder of files (Facebook, Mintegral). Stamp in place, then zip the CONTENTS so
            // index.html sits at the archive root. Not verified: it is multi-file by design, so the
            // self-contained check would fail it for doing exactly what its spec asks.
            writeFileSync(join(asDir, 'index.html'), withStamp(readFileSync(join(asDir, 'index.html'), 'utf8')));
            dest = join(out, `${base}.zip`);
            zipDir(asDir, dest);
        } else {
            throw new Error(`[playable-build] ${channel} produced neither ${asFile} nor ${asDir}/index.html`);
        }

        written.push(dest);
        console.log(`[playable-build] dist/${basename(dest)}  ${(statSync(dest).size / 1048576).toFixed(2)} MB`);
    }

    // Verify, and NEVER fail over it. A size budget or a stray ref is something to look at before
    // sending the file, not a reason to throw away a build that finished - so every outcome here
    // is a log line. Under Creator the builder is an Electron worker with no plain `node` on hand,
    // so the verifier runs on whatever binary is hosting us; ELECTRON_RUN_AS_NODE makes Creator
    // behave like node and is ignored by node itself.
    try {
        const script = join(root, '..', '..', 'scripts', 'verify-playable.mjs');
        // The html that went out, whether it shipped loose or inside a zip.
        const report = execFileSync(process.execPath, [script, ...toVerify], {
            env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
            encoding: 'utf8'
        });
        console.log(report.trim());
    } catch (err) {
        // Non-zero exit means something genuinely failed; the report is still on stdout.
        console.warn(`[playable-build] verify: ${String(err.stdout || err.message).trim()}`);
    }

    rmSync(stage, { recursive: true, force: true });
    return written;
}

module.exports = { pack, CHANNEL_OF, ZIPPED };

if (require.main === module) {
    pack().catch((err) => {
        console.error(String(err.message || err));
        process.exit(1);
    });
}
