// Prepare a level export for shipping.
//
//   node scripts/shrink-level.mjs <in.json> <out.json>
//
// The editor writes an object per cube; at 4,003 cubes that is ~92% of the file. Each is
// rewritten as `[x, y, z, color]` — same data, about a fifth of the bytes, and still a plain
// BoxyBlastLevel, so parseBoxyBlastLevel reads it directly (it accepts either form).
//
// Output stays plain .json so each adapter loads it its own way: PlayCanvas `import`s it into
// the bundle, Cocos points a @property(JsonAsset) Inspector slot at it (dragging a different
// level into that slot swaps levels with no code change).
//
// Health is dropped because it is 1 for every cube in both levels; a level that actually used
// multi-hit cubes would need it back (and the game would need to implement them).
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
    console.error('usage: shrink-level.mjs <in.json> <out.json>');
    process.exit(1);
}

const level = JSON.parse(readFileSync(input, 'utf8'));

const withHealth = level.Cubes.filter((c) => c.Health !== undefined && c.Health !== 1);
if (withHealth.length > 0) {
    console.error(`refusing: ${withHealth.length} cubes have Health != 1, which this drops`);
    process.exit(1);
}

// Already-shrunk input passes through untouched, so this is safe to re-run on its own output.
level.Cubes = level.Cubes.map((c) =>
    Array.isArray(c) ? c : [c.GridPosition.x, c.GridPosition.y, c.GridPosition.z, c.Color]
);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(level));

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`${input} -> ${output}`);
console.log(
    `  ${kb(statSync(input).size)} -> ${kb(statSync(output).size)}` +
    `  (${((1 - statSync(output).size / statSync(input).size) * 100).toFixed(1)}% smaller)`
);
