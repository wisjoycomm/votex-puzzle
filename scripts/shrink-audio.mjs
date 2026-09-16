// Encode SFX masters to mono MP3 for the bundle.
//
//   node scripts/shrink-audio.mjs <src-dir> <out-dir> [--kbps 96]
//   node scripts/shrink-audio.mjs audios-src adapters/cocos/assets/audios
//
// Every *.wav in <src-dir> lands as *.mp3 in <out-dir>, so both adapters use the same command
// with their own paths.
//
// The masters are 24-bit stereo 44.1 kHz, which is ~20x the bytes for sound a phone speaker plays
// once. MP3 rather than Ogg: Safari/WKWebView is where a large share of playable impressions run,
// and Ogg is not reliably decodable there.
//
// Sample rate is left at the source - at 44.1 kHz the bitrate does the work, and downsampling to
// 22 kHz measurably dulled shoot.wav (-22% RMS) for a few kB.
import lamejs from '@breezystack/lamejs';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const kFlag = args.indexOf('--kbps');
const KBPS = kFlag === -1 ? 96 : Number(args[kFlag + 1]);
const [SRC, OUT] = args.filter((a, i) => !a.startsWith('--') && (kFlag === -1 || i !== kFlag + 1));

if (!SRC || !OUT) {
    console.error('usage: node scripts/shrink-audio.mjs <src-dir> <out-dir> [--kbps 96]');
    process.exit(2);
}

/** Walk RIFF chunks rather than assuming a 44-byte header — exporters insert LIST/fact chunks. */
function parseWav(buf) {
    let off = 12;
    let fmt = null;
    let data = null;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            fmt = {
                channels: buf.readUInt16LE(off + 10),
                rate: buf.readUInt32LE(off + 12),
                bits: buf.readUInt16LE(off + 22)
            };
        }
        if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
        off += 8 + size + (size % 2);
    }
    if (!fmt || !data) throw new Error('not a PCM wav');
    return { fmt, data };
}

/** Interleaved PCM of any supported depth -> mono Int16, which is what the encoder takes. */
function toMonoInt16({ fmt, data }) {
    const bytes = fmt.bits / 8;
    const frames = Math.floor(data.length / (bytes * fmt.channels));
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
            const o = (i * fmt.channels + c) * bytes;
            if (bytes === 3) {
                const v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
                sum += (v & 0x800000 ? v - 0x1000000 : v) / 0x800000;
            } else if (bytes === 2) {
                sum += data.readInt16LE(o) / 0x8000;
            } else {
                throw new Error(`unsupported bit depth ${fmt.bits}`);
            }
        }
        const mono = sum / fmt.channels;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(mono * 32767)));
    }
    return out;
}

function encodeMp3(samples, rate, kbps) {
    const encoder = new lamejs.Mp3Encoder(1, rate, kbps);
    const chunks = [];
    // 1152 samples is one MPEG frame; the encoder expects whole frames.
    for (let i = 0; i < samples.length; i += 1152) {
        const block = encoder.encodeBuffer(samples.subarray(i, i + 1152));
        if (block.length) chunks.push(Buffer.from(block));
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(Buffer.from(tail));
    return Buffer.concat(chunks);
}

mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.wav'));
if (!files.length) {
    console.error(`no .wav in ${SRC}`);
    process.exit(1);
}
let before = 0;
let after = 0;

for (const file of files) {
    const src = readFileSync(join(SRC, file));
    const parsed = parseWav(src);
    const mp3 = encodeMp3(toMonoInt16(parsed), parsed.fmt.rate, KBPS);
    writeFileSync(join(OUT, file.replace(/\.wav$/i, '.mp3')), mp3);

    before += src.length;
    after += mp3.length;
    const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
    console.log(
        `${kb(src.length).padStart(9)} -> ${kb(mp3.length).padStart(8)}  (${(100 - (mp3.length / src.length) * 100).toFixed(0)}% off)  ${file.replace(/\.wav$/i, '.mp3')}`
    );
}

console.log(`total ${(before / 1024).toFixed(0)} kB -> ${(after / 1024).toFixed(0)} kB at ${KBPS} kbps mono`);
