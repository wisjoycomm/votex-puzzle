import { renameSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

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
const buildStamp = () => new Date().toLocaleString('sv-SE').replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);

const NETWORKS = ['meta', 'google', 'mraid', 'applovin', 'unity', 'mintegral'];

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
            name: 'playable-file-name',
            // Renamed on disk, not in the bundle: Vite 8 builds with Rolldown, whose bundle is a
            // native proxy that rejects re-keying an emitted asset.
            closeBundle() {
                if (!NETWORKS.includes(mode)) return;
                const name = `${pkg.name}-${mode}-${buildStamp()}.html`;
                const dist = join(import.meta.dirname, 'dist');
                renameSync(join(dist, 'index.html'), join(dist, name));
                console.log(`dist/${name}`);
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
