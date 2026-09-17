import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { zipDir } from '../../scripts/zip-dir.cjs';

import pkg from './package.json' with { type: 'json' };

// One build per network. Only the <head> differs; the click API is dispatched at runtime in
// playable-ads-core/cta.ts off the stamp this plugin writes.
//   build:meta | build:google | build:mraid | build:applovin | build:unity | build:mintegral
// `mraid` is the generic one: AppLovin, ironSource, Moloco and anything else speaking plain MRAID.
const MRAID_TAG = '<script src="mraid.js"></script>'; // served by the SDK, 404s locally

const NETWORK_HEAD: Record<string, string> = {
    mraid: MRAID_TAG,
    applovin: MRAID_TAG, // AppLovin and Unity are MRAID on the wire too
    unity: MRAID_TAG,
    google: '<script src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>',
    meta: '',
    // Mintegral's container injects its own globals; nothing to load.
    mintegral: '',
    production: ''
};

// Shippable builds land flat in dist/ as `<name>-<network>-<stamp>.html`, same shape the Cocos
// hook writes: the file is what gets sent to a network, so its name has to say which game, which
// network and which build without opening it. Other modes (production) keep dist/<mode>/index.html.
// ponytail: this one-liner is duplicated in the Cocos hook, which is CJS and can't import it.
const buildStamp = () => new Date().toLocaleString('sv-SE').replace(/[-:]/g, '').replace(' ', '_').slice(0, 13);

// Mintegral §13 allows only [A-Za-z0-9_] in the delivered file name. Applied to every network
// rather than just that one: underscores are legal everywhere, so one rule beats a special case.
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

const NETWORKS = ['meta', 'google', 'mraid', 'applovin', 'unity', 'mintegral'];

// Networks that take a ZIP; the rest ship as one loose html. Same rule the Cocos adapter applies,
// so a given network gets the same package shape whichever engine built it.
const ZIPPED = new Set(['meta', 'google', 'mintegral']);

export default defineConfig(({ mode }) => ({
    // .glb isn't a built-in Vite asset type, so `?inline` would hit the filesystem loader.
    assetsInclude: ['**/*.glb'],
    plugins: [
        viteSingleFile(),
        {
            name: 'network-head',
            transformIndexHtml(html: string) {
                const sdk = NETWORK_HEAD[mode] ?? '';
                // Stamp the target network so playable-ads-core's buildNetwork() can report
                // it. It never overrides the SDK probe - see network.ts.
                const stamp = NETWORKS.includes(mode) ? `<script>window.__AD_NETWORK__="${mode}";</script>` : '';
                const tag = sdk + stamp;
                return tag ? html.replace('</head>', `    ${tag}\n    </head>`) : html;
            }
        },
        {
            // Networks open the creative off file:// or out of a local container, and reject a
            // module script there: "Do not use crossorigin, type=module, import or export in local
            // files". After viteSingleFile there is one self-contained chunk with no import or
            // export statement left in it, so all `type="module"` still buys is top-level await -
            // an async IIFE gives that back, in a tag every network accepts.
            //
            // Runs in closeBundle, not transformIndexHtml: singlefile inlines at generateBundle,
            // so the script tag this rewrites only exists once the file is on disk. Must stay
            // ahead of playable-file-name, which renames that file out from under it.
            name: 'classic-script',
            closeBundle() {
                const html = join(import.meta.dirname, NETWORKS.includes(mode) ? 'dist' : `dist/${mode}`, 'index.html');
                const src = readFileSync(html, 'utf8');

                // PlayCanvas' WebGPU path carries import.meta, which is a SYNTAX error outside a
                // module - it would kill the whole bundle at parse time, reachable or not. It
                // isn't reachable: createGraphicsDevice's deviceTypes defaults to [] and only ever
                // adds webgl2 and null, so WebGPU is never attempted unless asked for by name.
                const out = src
                    .replace(
                        /<script type="module" crossorigin>([\s\S]*?)<\/script>/,
                        (_match, code: string) =>
                            // The readyState wait is not optional: a module script is deferred, a
                        // classic one is not, and vite puts the tag in <head>. Without it the
                        // bundle runs before <body> exists and getElementById('application-canvas')
                        // hands createGraphicsDevice a null canvas.
                        `<script>(async()=>{"use strict";` +
                        `if(document.readyState==="loading")` +
                        `await new Promise(r=>document.addEventListener("DOMContentLoaded",r,{once:true}));\n` +
                        `${code.replaceAll('import.meta', '({url:location.href})')}\n})();</script>`
                    )
                    // singlefile inlines the css as `<style rel="stylesheet" crossorigin>`. Nothing
                    // is fetched, but the checkers grep for the word, not for a real cross-origin
                    // load, so an inline tag carrying it fails the same way a real one would.
                    .replace(/<style rel="stylesheet" crossorigin>/g, '<style>');
                if (out === src) throw new Error('classic-script: no module script tag to rewrite');
                writeFileSync(html, out);
            }
        },
        {
            name: 'playable-file-name',
            // Renamed on disk, not in the bundle: Vite 8 builds with Rolldown, whose bundle is a
            // native proxy that rejects re-keying an emitted asset.
            closeBundle() {
                if (!NETWORKS.includes(mode)) return;
                const dist = join(import.meta.dirname, 'dist');
                const base = safeName(`${pkg.name}_${mode}_${buildStamp()}`);

                if (!ZIPPED.has(mode)) {
                    renameSync(join(dist, 'index.html'), join(dist, `${base}.html`));
                    console.log(`dist/${base}.html`);
                    return;
                }

                // Staged as index.html, which is the name every zip-taking network expects at the
                // archive root. vite already emitted it under that name, so this is a move. The
                // staging folder is named after the network because that is what
                // verify-playable.mjs reads the network from when the file is called index.html -
                // without this the zipped builds would drop out of checking entirely, since
                // `npm run verify` only globs dist/*.html.
                const stage = join(dist, '.pack', mode);
                rmSync(join(dist, '.pack'), { recursive: true, force: true });
                mkdirSync(stage, { recursive: true });
                const staged = join(stage, 'index.html');
                renameSync(join(dist, 'index.html'), staged);

                try {
                    const verifier = join(import.meta.dirname, '..', '..', 'scripts', 'verify-playable.mjs');
                    console.log(execFileSync(process.execPath, [verifier, staged], { encoding: 'utf8' }).trim());
                } catch (err) {
                    // Never fail a finished build over verification; the report is on stdout.
                    const e = err as { stdout?: string; message?: string };
                    console.warn(`verify: ${String(e.stdout || e.message).trim()}`);
                }

                zipDir(stage, join(dist, `${base}.zip`));
                rmSync(join(dist, '.pack'), { recursive: true, force: true });
                console.log(`dist/${base}.zip`);
            }
        }
    ],
    build: {
        outDir: NETWORKS.includes(mode) ? 'dist' : `dist/${mode}`,
        // Flat builds share dist/, so emptying it would delete the other two networks.
        emptyOutDir: !NETWORKS.includes(mode),
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        // No `target` override: main.ts uses top-level await, which needs ES2022.
        chunkSizeWarningLimit: 4096
    }
}));
