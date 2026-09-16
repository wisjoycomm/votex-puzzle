import { EffectAsset, Mesh, MeshRenderer, Node, tween, Vec3 } from "cc";
import type { LevelDef, V3 } from "core";

import { materialFor } from "./colors";

// Cubes fall in from this many grid steps above their cell. Raise for a bigger drop.
const SPAWN_DROP = 1;
// Seconds one cube takes to land.
const SPAWN_FALL = 0.3;
// Seconds between one row landing and the next. Raise for a slower cascade; 0 = all at once.
const SPAWN_ROW_DELAY = 0.05;
// Squash on impact, as a fraction of cube scale. 0 disables the pop.
const POP = 0.1;
// Seconds for the squash, and again for the recovery.
const POP_TIME = 0.04;

export type Sculpture = {
    root: Node;
    cubes: Map<string, Node>;
    /** Half-diagonal of the populated cells' bounding box, for framing a camera around it. */
    radius: number;
    /** Shared cube mesh, exposed so other effects (e.g. a bee carrying one off) can reuse it. */
    mesh: Mesh;
    /** Midpoint of the populated cells, subtracted from every grid coordinate to get a local one.
     *  Exposed so core's grid-space flight paths can be placed in this hierarchy. */
    center: V3;
    /** Uniform scale applied to each cube so it occupies exactly one grid step. */
    cubeScale: number;
    /** Total populated cells. `cubes` only holds the rows spawned so far, so it is not this. */
    cubeCount: number;
    /** Cells shot before their row spawned. The row builder skips these — without it the cube
     *  would appear after its own destruction and nothing could ever remove it. */
    killed: Set<string>;
};

export function cellKey(p: V3): string {
    return `${p.x},${p.y},${p.z}`;
}

/** Grid coordinate -> position inside `root`. Local, not world: `root` rotates under the drag
 *  rig, so anything following a path has to be re-transformed each frame rather than baked once. */
export function gridToLocal(
    sculpture: Sculpture,
    p: V3,
    out = new Vec3(),
): Vec3 {
    return out.set(
        p.x - sculpture.center.x,
        p.y - sculpture.center.y,
        p.z - sculpture.center.z,
    );
}

/**
 * Scale that makes one cube exactly one grid step.
 *
 * Measured off the mesh rather than hard-coded: the PlayCanvas adapter could assume 105 units
 * because it loaded a known GLB, but an FBX carries its own unit scale and Creator applies a
 * conversion on import, so the same model does not arrive at the same size. Reading the bounds
 * means re-exporting the asset at a different scale can't silently break the layout.
 */
function scaleToUnitCube(mesh: Mesh): number {
    const min = mesh.struct.minPosition;
    const max = mesh.struct.maxPosition;
    if (!min || !max) {
        // ponytail: older meshes may not carry bounds; 1 renders wrong but visibly so, which beats
        // guessing a factor. Set it by hand here if an asset ever lands without them.
        console.warn("[sculpture] mesh has no bounds; falling back to scale 1");
        return 1;
    }
    const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
    return size > 0 ? 1 / size : 1;
}

/**
 * Center on the bounding box of populated cells, not size/2 — otherwise rotating `root` orbits
 * around a corner of the (mostly empty) grid instead of spinning in place.
 */
export function buildSculpture(
    parent: Node,
    level: LevelDef,
    mesh: Mesh,
    effect: EffectAsset,
): Sculpture {
    const { nx, ny } = level.size;

    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    const populated: { pos: V3; color: number }[] = [];

    level.cells.forEach((color, i) => {
        if (color === null) return;
        const pos: V3 = {
            x: i % nx,
            y: Math.floor(i / nx) % ny,
            z: Math.floor(i / (nx * ny)),
        };
        populated.push({ pos, color });
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y);
        minZ = Math.min(minZ, pos.z);
        maxZ = Math.max(maxZ, pos.z);
    });

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const root = new Node("sculptureRoot");
    parent.addChild(root);

    const cubeScale = scaleToUnitCube(mesh);
    // Shared by every spawn tween: `to()` only reads these, it never writes back into them.
    const landed = new Vec3(cubeScale, cubeScale, cubeScale);
    const squash = new Vec3(
        cubeScale * (1 + POP),
        cubeScale * (1 - POP),
        cubeScale * (1 + POP),
    );
    const cubes = new Map<string, Node>();

    // Row by row, one grid layer per SPAWN_ROW_DELAY. The nodes are built when their row's turn
    // comes rather than all up front: 4000 nodes plus 4000 tweens in a single frame is a visible
    // hitch, and spread over the rows it is a slice of that per frame.
    const rows: { pos: V3; color: number }[][] = [];
    for (const cell of populated) {
        (rows[cell.pos.y - minY] ??= []).push(cell);
    }

    const sculpture: Sculpture = {
        root,
        cubes,
        radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
        mesh,
        center: { x: cx, y: cy, z: cz },
        cubeScale,
        cubeCount: populated.length,
        killed: new Set(),
    };

    function spawnRow(row: { pos: V3; color: number }[]): void {
        for (const { pos, color } of row) {
            const key = cellKey(pos);
            if (sculpture.killed.has(key)) continue;

            const cube = new Node(`cube_${pos.x}_${pos.y}_${pos.z}`);
            const base = new Vec3(pos.x - cx, pos.y - cy, pos.z - cz);
            cube.setPosition(base.x, base.y + SPAWN_DROP, base.z);
            cube.setScale(cubeScale, cubeScale, cubeScale);
            root.addChild(cube);

            // Fall in, squash on impact, recover.
            tween(cube)
                .to(SPAWN_FALL, { position: base }, { easing: "quadOut" })
                .to(POP_TIME, { scale: squash })
                .to(POP_TIME, { scale: landed }, { easing: "quadOut" })
                .start();

            const renderer = cube.addComponent(MeshRenderer);
            renderer.mesh = mesh;
            // setMaterial, NOT setMaterialInstance: the latter wraps the material in a per-renderer
            // MaterialInstance, which would give 4000 distinct materials and defeat instancing
            // completely. Instancing batches models that share one material, so they must share one.
            //
            // No dynamic-batching bookkeeping to keep in step either — unlike PlayCanvas' batch
            // groups, an instanced batch re-reads each member's transform every frame, so `root`
            // can spin, and destroying a cube node drops it from the batch on its own.
            renderer.setSharedMaterial(materialFor(color, effect), 0);
            // The toon ramp carries the shading; 4000 shadow casters buy nothing and would drag the
            // effect's shadow-caster pass in on top of the base pass.
            renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;

            cubes.set(key, cube);
        }
    }

    // One tween on `root` drives the whole schedule — 1 action rather than one per row. It only
    // calls back; the rig owns root's rotation and nothing here touches it.
    let schedule = tween(root);
    rows.forEach((row, i) => {
        if (i > 0) schedule = schedule.delay(SPAWN_ROW_DELAY);
        schedule = schedule.call(() => spawnRow(row));
    });
    schedule.start();

    return sculpture;
}

export function destroyCube(sculpture: Sculpture, cell: V3): void {
    const key = cellKey(cell);
    const cube = sculpture.cubes.get(key);
    if (!cube) {
        // Shot before its row spawned — remember, so the row builder never creates it.
        sculpture.killed.add(key);
        return;
    }
    cube.destroy();
    sculpture.cubes.delete(key);
}
