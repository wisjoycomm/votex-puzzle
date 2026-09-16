'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { basename, dirname, join } = require('path');
const { pathToFileURL } = require('url');

// Adapter-core channel -> our network name. Chosen for the <head> each channel injects:
// Moloco injects nothing (Meta allows zero outbound requests), Google injects exitapi.js plus an
// ad.size meta, AppLovin injects mraid.js. All three write ONE self-contained html; the Facebook
// channel deliberately splits scripts back out to js/*.js, which is why `meta` rides on Moloco.
const CHANNELS = { Moloco: 'meta', Google: 'google', AppLovin: 'mraid' };

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

    const written = [];
    for (const [channel, network] of Object.entries(CHANNELS)) {
        const src = join(buildDir, `${channel}.html`);
        if (!existsSync(src)) throw new Error(`[playable-build] ${channel} produced no ${src}`);
        const out = join(__dirname, '..', '..', 'dist', network);
        mkdirSync(out, { recursive: true });
        // Stamp the target network so playable-ads-core's buildNetwork() can report it. Done
        // here, not via the adapter's injectOptions, which can't reach the Moloco channel.
        const html = readFileSync(src, 'utf8').replace(
            '</head>',
            `<script>window.__AD_NETWORK__="${network}";</script></head>`
        );
        writeFileSync(join(out, 'index.html'), html);
        written.push(join(out, 'index.html'));
        console.log(`[playable-build] dist/${network}/index.html`);
    }

    // Same check the PlayCanvas adapter runs by hand: one file, stamped, right SDK tag, no
    // outbound requests. `throwError` above turns a failure into a failed build.
    const verifier = join(__dirname, '..', '..', '..', '..', 'scripts', 'verify-playable.mjs');
    const { reportPlayables } = await import(pathToFileURL(verifier).href);
    if (!reportPlayables(written)) throw new Error('[playable-build] verification failed');
};
