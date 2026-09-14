import { Color, StandardMaterial } from 'playcanvas';

import { applyToonRamp } from './toon-shader.ts';

// BoxyBlast GameColor enum -> fallback tint hex (see .scratch/docs/BoxyBlast_Cube_Colors.pdf).
// Indices 14 and 17 are intentionally unused upstream.
const PALETTE: Record<number, string> = {
    0: '#7A1428',
    1: '#CC3333',
    2: '#D47F7F',
    3: '#8B2255',
    4: '#CC2288',
    5: '#FF55AA',
    6: '#FF88CC',
    7: '#441888',
    8: '#8844BB',
    9: '#6644FF',
    10: '#AA88EE',
    11: '#11205A',
    12: '#1212E6',
    13: '#2299EE',
    15: '#118866',
    16: '#19D4E6',
    18: '#147914',
    19: '#778833',
    20: '#0FBE0F',
    21: '#DD9900',
    22: '#FFDD00',
    23: '#EE7722',
    24: '#FFAA77',
    25: '#442211',
    26: '#85351B',
    27: '#BB8833',
    28: '#313131',
    29: '#EEEEEE',
    30: '#6C6C7B'
};

// Loud, obviously-wrong color for any index the palette above doesn't cover.
const FALLBACK_HEX = '#FF00FF';

const materials = new Map<number, StandardMaterial>();

function materialFor(color: number): StandardMaterial {
    let mat = materials.get(color);
    if (mat) return mat;

    const hex = PALETTE[color] ?? FALLBACK_HEX;
    mat = new StandardMaterial();
    mat.diffuse = new Color().fromString(hex);
    applyToonRamp(mat);
    materials.set(color, mat);
    return mat;
}

function hexFor(color: number): string {
    return PALETTE[color] ?? FALLBACK_HEX;
}

export { materialFor, hexFor };
