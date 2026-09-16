'use strict';

// The build hook. All of the work lives in ./pack.js so the same code can run without the editor —
// Creator loads an extension's main process once at startup and never reloads it, so an edit here
// is invisible to an already-open editor. When in doubt, run `npm run pack -w cocos-adapter`.

const { writeFileSync } = require('fs');
const { basename, dirname, join } = require('path');

exports.throwError = true;

exports.onAfterBuild = async (options, result) => {
    const platform = options.platform || 'web-mobile';
    const dest = result && result.dest;
    console.log(`[playable-build] build output: ${dest}`);

    // pack() wants the PARENT of the platform dir — exec3xAdapter joins buildPlatform back on.
    const buildDir = basename(dest) === platform ? dirname(dest) : dest;

    // Required fresh each build: `require` caches, and this is the file that actually changes.
    delete require.cache[require.resolve('./pack.js')];
    const { pack } = require('./pack.js');

    // A CLI build (`npm run build:all`) passes only platform/debug, so options.name is undefined
    // there - pack() falls back to the package name, the same string the panel puts in that field.
    await pack({ buildDir, buildName: options.name });

    // ponytail: breadcrumb for a hook that died mid-way - if this file is older than dist/, it did.
    // Delete once builds are reliably green.
    writeFileSync(join(__dirname, '..', '..', 'temp', 'playable-build.done'), new Date().toISOString());
};
