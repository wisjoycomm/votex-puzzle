import { SHADERLANGUAGE_GLSL } from 'playcanvas';
import type { StandardMaterial } from 'playcanvas';

// Adapted from the official engine recipe (examples/src/examples/shaders/shader-toon.example.mjs,
// v2.22.2): quantize N·L into discrete bands instead of a smooth Lambert falloff. Ported as a
// `lightDiffuseLambertPS` chunk override (not that example's standalone ShaderMaterial) so the
// rest of StandardMaterial's pipeline — batching, fog, tonemapping — stays intact; see the
// `override-shader-chunks` skill. A floor keeps the shadow band non-black so cube colors stay
// readable from any rotation, which a flat toon ramp doesn't need to care about but this puzzle does.
const TOON_BANDS = 4;
const SHADOW_FLOOR = 0.3;

const lightDiffuseLambertPS = `
float getLightDiffuse(vec3 worldNormal, vec3 viewDir, vec3 lightDirNorm) {
    float ndl = max(dot(worldNormal, -lightDirNorm), 0.0);
    float banded = floor(ndl * ${TOON_BANDS}.0 + 0.0001) / ${(TOON_BANDS - 1).toFixed(1)};
    return clamp(banded, ${SHADOW_FLOOR}, 1.0);
}
`;

export function applyToonRamp(material: StandardMaterial): void {
    material.shaderChunksVersion = '2.22';
    material.getShaderChunks(SHADERLANGUAGE_GLSL).set('lightDiffuseLambertPS', lightDiffuseLambertPS);
    material.update();
}
