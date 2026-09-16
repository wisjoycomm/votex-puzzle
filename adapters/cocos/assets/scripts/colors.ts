import { Color, EffectAsset, Material } from "cc";

// BoxyBlast GameColor enum -> fallback tint hex (see .scratch/docs/BoxyBlast_Cube_Colors.pdf).
// Indices 14 and 17 are intentionally unused upstream.
const PALETTE: Record<number, string> = {
    0: "#7A1428",
    1: "#CC3333",
    2: "#D47F7F",
    3: "#8B2255",
    4: "#CC2288",
    5: "#FF55AA",
    6: "#FF88CC",
    7: "#441888",
    8: "#8844BB",
    9: "#6644FF",
    10: "#AA88EE",
    11: "#11205A",
    12: "#1212E6",
    13: "#2299EE",
    15: "#118866",
    16: "#19D4E6",
    18: "#147914",
    19: "#778833",
    20: "#0FBE0F",
    21: "#DD9900",
    22: "#FFDD00",
    23: "#EE7722",
    24: "#FFAA77",
    25: "#442211",
    26: "#85351B",
    27: "#BB8833",
    28: "#313131",
    29: "#EEEEEE",
    30: "#6C6C7B",
};

// Loud, obviously-wrong color for any index the palette above doesn't cover.
const FALLBACK_HEX = "#FF00FF";

// TCP2 ramp mode: 0 Default | 1 Crisp | 2 Bands | 3 Bands Crisp | 4 Texture. Bands is the look
// the PlayCanvas adapter approximated by hand in toon-shader.ts.
const RAMP_TYPE_BANDS = 2;
const RAMP_BANDS = 4;
// The darkest band. Not black on purpose: a player has to tell a dark red cube from a dark purple
// one when its face is turned away from the light, which a flat toon ramp has no reason to care
// about but this puzzle does. Tune here, on device — it is the one knob that decides readability.
const SHADOW_LEVEL = 0.3;

const materials = new Map<number, Material>();

/**
 * One material per color, shared by every cube of that color — 13 on the real level, not 4000.
 *
 * Instanced, and deliberately stripped back: the outline pass is an inverted hull, i.e. a second
 * full draw of every cube, and the sculpture is the one thing in the scene that cannot afford it.
 * Everything else the effect offers (specular, rim, matcap, normal map, emission, reflections,
 * occlusion, albedo map) is off, which also keeps the compiled shader variant small.
 */
export function materialFor(color: number, effect: EffectAsset): Material {
    let material = materials.get(color);
    if (material) return material;

    material = new Material();
    material.initialize({
        effectAsset: effect,
        technique: 0, // "opaque"
        defines: {
            RAMP_TYPE: RAMP_TYPE_BANDS,
            USE_INSTANCING: true,
        },
    });
    material.setProperty(
        "mainColor",
        hexToColor(PALETTE[color] ?? FALLBACK_HEX),
    );
    material.setProperty("rampBands", RAMP_BANDS);
    material.setProperty(
        "shadowColor",
        new Color(
            255 * SHADOW_LEVEL,
            255 * SHADOW_LEVEL,
            255 * SHADOW_LEVEL,
            255,
        ),
    );

    materials.set(color, material);
    return material;
}

export function hexFor(color: number): string {
    return PALETTE[color] ?? FALLBACK_HEX;
}

// Cocos Color channels are 0-255 ints, not the 0-1 floats PlayCanvas uses.
function hexToColor(hex: string): Color {
    return new Color().fromHEX(hex);
}
