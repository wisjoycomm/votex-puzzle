import type { LevelDef, V3 } from 'core';
import { Asset, Entity, MeshInstance } from 'playcanvas';
import type { AppBase, Mesh } from 'playcanvas';

import { materialFor } from './colors.ts';

export type Sculpture = {
    root: Entity;
    cubes: Map<string, Entity>;
    /** Half-diagonal of the populated cells' bounding box, for framing a camera around it. */
    radius: number;
    /** Batch group each cube belongs to (one per color), so destroying a cube can mark it dirty. */
    batchGroupOf: Map<string, number>;
}

const CUBE_MODEL_URL = '/models/bee-cube-2.glb';
// inspect-glb: bee-cube-2.glb is a single mesh, 105x105x105, centered at its own origin — scale it
// down to fit the 1-unit grid spacing the rest of this file assumes. Slightly oversized (not an
// exact 1/105) so neighboring cubes overlap a hair instead of leaving a seam a cube behind it
// shows through — an exact edge-to-edge fit is fragile against any rounding in the source mesh.
const CUBE_MODEL_SIZE = 105;
const CUBE_OVERSCALE = 1.15;
const CUBE_SCALE = CUBE_OVERSCALE / CUBE_MODEL_SIZE;

function cellKey(p: V3): string {
    return `${p.x},${p.y},${p.z}`;
}

// `ContainerResource`'s public .d.ts omits `renders` (an Asset[] of Render resources) even though
// the GLB parser always sets it at runtime — the class-level JSDoc documents it, but it isn't a
// declared class member. Typed locally rather than casting through the incomplete public type.
type GlbContainer = {
    renders: { resource: { meshes: (Mesh | null)[] } }[];
}

async function loadCubeMesh(app: AppBase): Promise<Mesh> {
    const asset = new Asset('bee-cube', 'container', { url: CUBE_MODEL_URL });
    app.assets.add(asset);
    await new Promise<void>((resolve, reject) => {
        asset.once('load', () => resolve());
        asset.once('error', (err: string) => reject(new Error(err)));
        app.assets.load(asset);
    });

    const container = asset.resource as GlbContainer;
    const mesh = container.renders[0]?.resource?.meshes[0];
    if (!mesh) throw new Error(`${CUBE_MODEL_URL}: container has no mesh`);
    return mesh;
}

// Center on the bounding box of populated cells, not size/2 — otherwise rotating
// `root` orbits around a corner of the (mostly empty) grid instead of spinning in place.
export async function buildSculpture(app: AppBase, level: LevelDef): Promise<Sculpture> {
    const mesh = await loadCubeMesh(app);
    const { nx, ny } = level.size;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const populated: { pos: V3; color: number }[] = [];

    level.cells.forEach((color, i) => {
        if (color === null) return;
        const pos: V3 = {
            x: i % nx,
            y: Math.floor(i / nx) % ny,
            z: Math.floor(i / (nx * ny))
        };
        populated.push({ pos, color });
        minX = Math.min(minX, pos.x); maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y); maxY = Math.max(maxY, pos.y);
        minZ = Math.min(minZ, pos.z); maxZ = Math.max(maxZ, pos.z);
    });

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const root = new Entity('sculptureRoot');
    app.root.addChild(root);

    // One batch group per color (13 in the real level) instead of one draw call per cube (4000+).
    // Must be `dynamic: true`: cubes don't move relative to each other, but the whole sculpture
    // rotates as `root` spins under drag, and only dynamic batching re-reads each member's current
    // world transform every frame. `dynamic: false` bakes vertices into world space once at
    // generation time on a node outside this hierarchy — rotating `root` would silently stop moving
    // the (still-batched) cubes.
    const maxAabbSize = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) + 2;
    const groupByColor = new Map<number, number>();
    function groupFor(color: number): number {
        let id = groupByColor.get(color);
        if (id === undefined) {
            id = app.batcher.addGroup(`cubes-${color}`, true, maxAabbSize).id;
            groupByColor.set(color, id);
        }
        return id;
    }

    const cubes = new Map<string, Entity>();
    const batchGroupOf = new Map<string, number>();
    for (const { pos, color } of populated) {
        const cube = new Entity(`cube_${pos.x}_${pos.y}_${pos.z}`);
        cube.addComponent('render', {});
        cube.setLocalPosition(pos.x - cx, pos.y - cy, pos.z - cz);
        cube.setLocalScale(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);
        root.addChild(cube);
        cube.render!.meshInstances = [new MeshInstance(mesh, materialFor(color), cube)];
        // batchGroupId only takes while the entity is enabled *and* parented into the live tree,
        // so this has to happen after addChild, not before.
        const groupId = groupFor(color);
        cube.render!.batchGroupId = groupId;
        const key = cellKey(pos);
        cubes.set(key, cube);
        batchGroupOf.set(key, groupId);
    }

    const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    return { root, cubes, radius, batchGroupOf };
}

export function destroyCube(app: AppBase, sculpture: Sculpture, cell: V3): void {
    const key = cellKey(cell);
    const cube = sculpture.cubes.get(key);
    if (!cube) return;
    cube.destroy();
    sculpture.cubes.delete(key);

    const groupId = sculpture.batchGroupOf.get(key);
    sculpture.batchGroupOf.delete(key);
    if (groupId !== undefined) app.batcher.markGroupDirty(groupId);
}
