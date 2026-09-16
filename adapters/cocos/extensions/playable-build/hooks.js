'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { basename, dirname, join } = require('path');

// Adapter-core channel -> our network name. Chosen for the <head> each channel injects:
// Moloco injects nothing (Meta allows zero outbound requests), Google injects exitapi.js plus an
// ad.size meta, AppLovin and Unity inject mraid.js. `Liftoff` is Vungle's channel - same company.
// Every channel writes ONE self-contained html; the Facebook channel deliberately splits scripts
// back out to js/*.js, which is why `meta` rides on Moloco.
const CHANNELS = {
    Moloco: 'meta',
    Google: 'google',
    AppLovin: 'mraid',
    Unity: 'unity',
    Liftoff: 'vungle',
    Mintegral: 'mintegral'
};

// Output file name: <name>-<network>-<stamp>.html, all three flat in dist/. The name is the build
// panel's Name field (`cocos-adapter`), not the output folder (`web-mobile`) - the file gets sent
// to a network, so it should say what the game is, not which platform target built it. The stamp
// keeps every send-off distinct. verify-playable.mjs reads the network back out of the file name.
const stamp = () => new Date().toLocaleString('sv-SE').replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);

// Only decides Google's ad.size meta tag. The game itself reframes off the real aspect ratio,
// so raising/lowering this changes nothing but what Google is told to expect.
const ORIENTATION = 'portrait';

exports.throwError = true;

exports.onAfterBuild = async (options, result) => {
    const platform = options.platform || 'web-mobile';
    const dest = result && result.dest;
    console.log(`[playable-build] build output: ${dest}`);

    // exec3xAdapter wants the PARENT of the platform dir — it joins buildPlatform back on itself.
    const buildDir = basename(dest) === platform ? dirname(dest) : dest;

    const { exec3xAdapter } = require('playable-adapter-core');
    await exec3xAdapter({
        buildFolderPath: buildDir,
        adapterBuildConfig: {
            buildPlatform: platform,
            orientation: ORIENTATION,
            enableSplash: false,
            exportChannels: Object.keys(CHANNELS)
        }
    });

    // A CLI build (`npm run build:all`) passes only platform/debug, so options.name is undefined
    // there - fall back to the package name, which is the same string the panel puts in that field.
    const buildName = options.name || require('../../package.json').name;
    const when = stamp();
    const out = join(__dirname, '..', '..', 'dist');
    mkdirSync(out, { recursive: true });

    for (const [channel, network] of Object.entries(CHANNELS)) {
        const src = join(buildDir, `${channel}.html`);
        if (!existsSync(src)) throw new Error(`[playable-build] ${channel} produced no ${src}`);
        const name = `${buildName}-${network}-${when}.html`;
        // Stamp the target network so playable-ads-core's buildNetwork() can report it. Done
        // here, not via the adapter's injectOptions, which can't reach the Moloco channel.
        const html = readFileSync(src, 'utf8').replace(
            '</head>',
            `<script>window.__AD_NETWORK__="${network}";</script></head>`
        );
        writeFileSync(join(out, name), html);
        console.log(`[playable-build] dist/${name}`);
    }

    // Verification is NOT done here. Creator's builder is an Electron worker that dies without
    // a stack the moment this hook runs the verifier - by import() or by execFileSync alike.
    // `npm run verify -w cocos-adapter` does it instead, after the build.
    //
    // ponytail: breadcrumb for that crash - if this file is older than dist/, the hook died.
    // Delete once builds are reliably green.
    writeFileSync(join(__dirname, '..', '..', 'temp', 'playable-build.done'), new Date().toISOString());
};
