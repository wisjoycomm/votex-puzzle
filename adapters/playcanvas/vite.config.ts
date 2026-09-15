import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One build per network. Only the <head> differs; the CTA is probed at runtime in cta.ts.
//   build:meta | build:google | build:mraid (AppLovin, ironSource, Unity, Vungle, Mintegral, Moloco)
const NETWORK_HEAD: Record<string, string> = {
    mraid: '<script src="mraid.js"></script>', // served by the SDK, 404s locally
    google:
        '<script src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>',
    meta: '',
    production: ''
};

export default defineConfig(({ mode }) => ({
    // .glb isn't a built-in Vite asset type, so `?inline` would hit the filesystem loader.
    assetsInclude: ['**/*.glb'],
    plugins: [
        viteSingleFile(),
        {
            name: 'network-head',
            transformIndexHtml(html: string) {
                const tag = NETWORK_HEAD[mode] ?? '';
                return tag ? html.replace('</head>', `    ${tag}\n    </head>`) : html;
            }
        }
    ],
    build: {
        outDir: `dist/${mode}`,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        // No `target` override: main.ts uses top-level await, which needs ES2022.
        chunkSizeWarningLimit: 4096
    }
}));
