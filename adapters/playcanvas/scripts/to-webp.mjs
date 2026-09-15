// Re-encode source PNGs as the WebP the bundle ships. Chrome does the encoding, so no image dep.
//
//   node scripts/to-webp.mjs [quality] [file.png...]     default q=0.85
//
// Not for fonts/courier.png — MSDF glyph edges are distance values, lossy wrecks them.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find((p) => existsSync(p));

const DEFAULTS = [
    'src/assets/sprites/Top Leaf.png',
    'src/assets/sprites/Layer 02.png',
    'src/assets/sprites/Layer 03.png',
    'src/assets/sprites/Slot.png'
];

const args = process.argv.slice(2);
const quality = Number(args[0]) ? Number(args.shift()) : 0.85;
const files = args.length ? args : DEFAULTS;

if (!CHROME) {
    console.error('no Chrome or Edge found — add its path to CHROME in this script');
    process.exit(1);
}

const port = 9333;
const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--user-data-dir=' + process.cwd() + '/node_modules/.cache/to-webp-profile',
    '--no-first-run',
    'about:blank'
]);

// Poll rather than sleep a fixed amount: startup time varies a lot between machines.
let target;
for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
    } catch {
        /* not up yet */
    }
}
if (!target) {
    chrome.kill();
    throw new Error('Chrome never opened a debugging port');
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
    new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params }));
    });
ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result);
        pending.delete(m.id);
    }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');

for (const file of files) {
    const before = readFileSync(file);
    const r = await send('Runtime.evaluate', {
        expression: `(async () => {
            const img = new Image();
            img.src = 'data:image/png;base64,${before.toString('base64')}';
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            // The canvas starts fully transparent and nothing is drawn behind the image, so the
            // alpha channel carries through instead of being flattened onto a white matte.
            c.getContext('2d').drawImage(img, 0, 0);
            return c.toDataURL('image/webp', ${quality}).split(',')[1];
        })()`,
        awaitPromise: true,
        returnByValue: true
    });

    const b64 = r?.result?.value;
    if (typeof b64 !== 'string') {
        console.error(`FAILED ${file}: ${JSON.stringify(r)}`);
        continue;
    }
    const out = file.replace(/\.png$/, '.webp');
    const buf = Buffer.from(b64, 'base64');
    writeFileSync(out, buf);
    const pct = (100 - (buf.length / before.length) * 100).toFixed(0);
    const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
    console.log(`${kb(before.length).padStart(7)} -> ${kb(buf.length).padStart(7)}  (${pct}% off)  ${out}`);
}

ws.close();
chrome.kill();
process.exit(0);
