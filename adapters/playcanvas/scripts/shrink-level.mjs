// Prepare a level export for shipping: strip whitespace, and rewrite the Cubes array from one
// object per cube to a flat [x, y, z, color] quad.
//
//   node scripts/shrink-level.mjs <in.json> <out.json>
//
// Everything else is passed through untouched, so the file stays a BoxyBlastLevel and
// parseBoxyBlastLevel reads it directly — it accepts a cube in either form.
//
// Health is dropped because it is 1 for every cube in both levels; a level that actually used
// multi-hit cubes would need it back (and the game would need to implement them).
import { readFileSync, writeFileSync, statSync } from 'node:fs';

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

level.Cubes = level.Cubes.map((c) => [c.GridPosition.x, c.GridPosition.y, c.GridPosition.z, c.Color]);
writeFileSync(output, JSON.stringify(level));

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const before = statSync(input).size;
const after = statSync(output).size;
console.log(`${input} -> ${output}`);
console.log(`  ${kb(before)} -> ${kb(after)}  (${((1 - after / before) * 100).toFixed(1)}% smaller)`);
