import { Easing, Group, Tween } from '@tweenjs/tween.js';
import { Asset, Entity, MeshInstance, Vec3 } from 'playcanvas';
import type { AppBase, GraphNode, Mesh } from 'playcanvas';

import { materialFor } from './colors.ts';
import { CUBE_SCALE, CUBE_WORLD_SIZE } from './sculpture.ts';

const BEE_MODEL_URL = '/models/Bee_2.glb';
// inspect-glb reports Bee_2.glb at ~1 world unit, but that reads oversized next to the sculpture's
// 1-unit-grid cubes — scaled down by eye, tune further if needed.
const BEE_SCALE = 0.01;

const FLY_TO_CUBE_MS = 450;
const FLY_OUT_MS = 900;
// ponytail: constant fraction of viewport height, not tied to the (not-yet-wired) Top Leaf art —
// nudge this once that overlay's on-screen position is final.
const EXIT_SCREEN_Y_FRACTION = 0.08;
const WING_FLAP_HZ = 22;
const WING_FLAP_DEG = 35;
// How much a leg's midpoint bows up/sideways off the straight line, as a fraction of leg length.
const ARC_LIFT = 0.35;
const ARC_BOW = 0.2;
// Land the bee on the cube's near edge (facing where it flew in from), not buried in its center.
const GRAB_GAP = 0.05;
const GRAB_DISTANCE = CUBE_WORLD_SIZE / 2 + GRAB_GAP;
// Pre-warmed so the first few shots of a fast volley don't pay GLB-instantiation cost mid-flight.
const POOL_SIZE = 10;

export type BeeSwarm = {
    /** Spawn a bee at `originScreen` (falls back to `cubePos` if omitted), fly it to the shot
     *  cube's world position to "grab" a `color`-tinted stand-in, then fly it up off-screen. */
    spawn(cubePos: Vec3, color: number, originScreen?: { x: number; y: number }): void;
    update(dt: number): void;
}

// `ContainerResource`'s public .d.ts declares `instantiateRenderEntity` as `(options: any) => any`
// with no narrower overload — typed locally, matching the GlbContainer workaround in sculpture.ts.
type GlbContainer = {
    instantiateRenderEntity(): Entity;
}

type BeeInstance = {
    root: Entity;
    wingL: GraphNode | null;
    wingR: GraphNode | null;
    cube: Entity;
    cubeMeshInstance: MeshInstance;
    flapT: number;
    inUse: boolean;
}

function loadBeeContainer(app: AppBase): Promise<GlbContainer> {
    return new Promise((resolve, reject) => {
        const asset = new Asset('bee', 'container', { url: BEE_MODEL_URL });
        app.assets.add(asset);
        asset.once('load', () => resolve(asset.resource as GlbContainer));
        asset.once('error', (err: string) => reject(new Error(err)));
        app.assets.load(asset);
    });
}

// Midpoint of from->to, bowed up and sideways so a tweened path along it reads as a swoop
// instead of a ruler-straight line. Sideways axis picks an arbitrary side when the leg is
// (near-)vertical, since delta x UP degenerates to zero there.
function arcControlPoint(from: Vec3, to: Vec3): Vec3 {
    const delta = new Vec3().sub2(to, from);
    const dist = delta.length();
    const side = new Vec3().cross(delta, Vec3.UP);
    if (side.lengthSq() < 1e-6) side.copy(Vec3.RIGHT);
    side.normalize();
    return new Vec3()
        .add2(from, to)
        .mulScalar(0.5)
        .add(new Vec3(0, dist * ARC_LIFT, 0))
        .add(side.mulScalar(dist * ARC_BOW));
}

// ponytail: cube mesh is passed in (reused from Sculpture) rather than loaded again here.
// `depth` is the camera-to-sculpture distance (main.ts's `distance`) so the exit point and any
// fallback origin land in the same depth plane as the cubes, not an arbitrary far-clip fraction.
export function createBeeSwarm(app: AppBase, camera: Entity, cubeMesh: Mesh, depth: number): BeeSwarm {
    const tweens = new Group();
    const pool: BeeInstance[] = [];
    let container: GlbContainer | null = null;

    function makeInstance(): BeeInstance {
        const root = container!.instantiateRenderEntity();
        root.setLocalScale(BEE_SCALE, BEE_SCALE, BEE_SCALE);
        root.enabled = false;
        app.root.addChild(root);

        // Own entity, parented to app.root rather than `root` (the bee) — sitting at world scale
        // this way avoids compounding with the bee's BEE_SCALE, and lets it stay put at the cube's
        // position while the bee is still flying in, instead of only appearing once "grabbed".
        const cube = new Entity('grabbedCube');
        cube.addComponent('render', {});
        cube.setLocalScale(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);
        const cubeMeshInstance = new MeshInstance(cubeMesh, materialFor(0), cube);
        cube.render!.meshInstances = [cubeMeshInstance];
        cube.enabled = false;
        app.root.addChild(cube);

        return {
            root,
            wingL: root.findByName('Wing_L'),
            wingR: root.findByName('Wing_R'),
            cube,
            cubeMeshInstance,
            flapT: 0,
            inUse: false
        };
    }

    const ready = loadBeeContainer(app).then((c) => {
        container = c;
        for (let i = 0; i < POOL_SIZE; i++) pool.push(makeInstance());
    });

    function acquire(): BeeInstance {
        let inst = pool.find((b) => !b.inUse);
        if (!inst) {
            // All 10 mid-flight at once (fast volley across all lanes) — grow rather than drop
            // the effect. Should be rare; POOL_SIZE covers the common case.
            inst = makeInstance();
            pool.push(inst);
        }
        inst.inUse = true;
        inst.flapT = 0;
        inst.root.enabled = true;
        return inst;
    }

    function release(inst: BeeInstance): void {
        inst.root.enabled = false;
        inst.cube.enabled = false;
        inst.inUse = false;
    }

    // Tweens a single progress scalar and evaluates a quadratic bezier from it each frame,
    // rather than lerping x/y/z independently (which is what produces a straight line).
    // Each rider gets the computed position plus its own fixed `offset` (e.g. the bee holding
    // the cube's edge instead of its center) so they fly the same path without being parented.
    function flyArc(riders: { entity: Entity; offset: Vec3 }[], from: Vec3, to: Vec3, ms: number, easing: typeof Easing.Quadratic.Out, onComplete: () => void): void {
        const control = arcControlPoint(from, to);
        const progress = { t: 0 };
        const pos = new Vec3();
        const riderPos = new Vec3();
        new Tween(progress, tweens)
            .to({ t: 1 }, ms)
            .easing(easing)
            .onUpdate(() => {
                const u = 1 - progress.t;
                pos.x = u * u * from.x + 2 * u * progress.t * control.x + progress.t * progress.t * to.x;
                pos.y = u * u * from.y + 2 * u * progress.t * control.y + progress.t * progress.t * to.y;
                pos.z = u * u * from.z + 2 * u * progress.t * control.z + progress.t * progress.t * to.z;
                for (const r of riders) r.entity.setPosition(riderPos.add2(pos, r.offset));
            })
            .onComplete(onComplete)
            .start();
    }

    async function spawn(cubePos: Vec3, color: number, originScreen?: { x: number; y: number }): Promise<void> {
        await ready;
        const inst = acquire();
        const bee = inst.root;

        const camComp = camera.camera!;
        const canvas = app.graphicsDevice.canvas;
        const origin = originScreen
            ? camComp.screenToWorld(originScreen.x, originScreen.y, depth)
            : cubePos.clone();
        bee.setPosition(origin);

        // Visible at the shot cell right away, standing in for the sculpture cube destroyCube
        // just removed — it sits still until the bee arrives, so nothing pops in/out of view.
        inst.cubeMeshInstance.material = materialFor(color);
        inst.cube.setPosition(cubePos);
        inst.cube.enabled = true;

        const exit = camComp.screenToWorld(canvas.clientWidth / 2, canvas.clientHeight * EXIT_SCREEN_Y_FRACTION, depth);

        // Grab point sits on the cube's near edge, facing back the way the bee flew in from —
        // ponytail: falls back to an arbitrary axis on the (rare) zero-distance case rather than
        // solving for a "best" edge, since that only happens without a resolved fix-slot origin.
        const approach = new Vec3().sub2(cubePos, origin);
        if (approach.lengthSq() < 1e-6) approach.copy(Vec3.FORWARD);
        approach.normalize();
        const grabOffset = approach.clone().mulScalar(-GRAB_DISTANCE);
        const grabPos = new Vec3().add2(cubePos, grabOffset);
        const zero = new Vec3();

        flyArc([{ entity: bee, offset: zero }], origin, grabPos, FLY_TO_CUBE_MS, Easing.Quadratic.Out, () => {
            flyArc(
                [{ entity: bee, offset: grabOffset }, { entity: inst.cube, offset: zero }],
                cubePos,
                exit,
                FLY_OUT_MS,
                Easing.Quadratic.In,
                () => release(inst)
            );
        });
    }

    function update(dt: number): void {
        tweens.update();
        for (const inst of pool) {
            if (!inst.inUse) continue;
            inst.flapT += dt;
            const angle = Math.sin(inst.flapT * WING_FLAP_HZ) * WING_FLAP_DEG;
            inst.wingL?.setLocalEulerAngles(0, 0, angle);
            inst.wingR?.setLocalEulerAngles(0, 0, -angle);
        }
    }

    return { spawn, update };
}
