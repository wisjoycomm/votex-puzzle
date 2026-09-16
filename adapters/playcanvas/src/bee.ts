import { Easing, Group, Tween } from '@tweenjs/tween.js';
import { Asset, Color, Entity, Mat4, MeshInstance, Quat, Vec3, math } from 'playcanvas';
import type { AppBase, GraphNode, Mesh, RenderComponent } from 'playcanvas';

import BEE_MODEL_URL from './assets/models/Bee_2.glb?inline';
import { materialFor } from './colors.ts';
import { CUBE_SCALE, CUBE_WORLD_SIZE } from './sculpture.ts';
import { sfx } from './sfx.ts';

// inspect-glb: Bee_2.glb measures 1.2405 x 0.7109 x 1.2414 units and a cube is exactly 1 unit,
// so this renders the bee at ~0.012 units — roughly 1% of a cube. Deliberate for now; raise
// towards 0.5 for a bee that reads at about 60% of a cube.
const BEE_SCALE = 0.01;

// The approach (hive -> sculpture) and the channel weave are timed SEPARATELY on purpose. The
// approach is ~5x the sculpture radius while a channel is a handful of cells, so one constant
// speed across both spends ~93% of the flight on the approach and flicks through the interesting
// part in a few frames — which just looks like a bee flying straight at the cube.
const APPROACH_MS = 3600;
// One cruise speed for every distance-timed leg: descent, weave, carry-out and rise. 80ms per
// unit is 12.5 units/s, matching what APPROACH_MS works out to over a typical orbit — so the bee
// holds the same speed from the hive all the way onto the cube, with no slow-down at the grab.
const FLIGHT_MS_PER_UNIT = 80;
const FLY_OUT_MS = 4800;
const WING_FLAP_HZ = 22;
const WING_FLAP_DEG = 35;
// The engine's forward is -Z; Bee_2.glb doesn't necessarily model its own forward that way.
// ponytail: one yaw correction found by eye — flip to 0/90/270 if the bee flies sideways.
const BEE_YAW_OFFSET = 180;
// Below this the travel direction is noise, so keep the previous facing rather than snapping.
const MIN_FACING_DISTANCE = 1e-4;
// Draw each in-flight bee's route as lines. Leave on while tuning flight, off for a real build.
const DEBUG_PATHS = false;
const DEBUG_PATH_COLOR = new Color(0, 1, 0.4);
// How much a leg's midpoint bows up/sideways off the straight line, as a fraction of leg length.
const ARC_LIFT = 0.35;
const ARC_BOW = 0.2;
// Extra push outward before the climb. The bee leaves the sculpture already clear of it — the
// standoff put it there — so this is 0 by default: pushing out to the full bounding radius is
// safe but reads as the bee taking a long detour for no reason. Raise it if bees clip the model.
const ESCAPE_OUT = 0;
// How high the bee lifts before crossing to the hive, as a fraction of the bounding radius. That
// radius is the half-DIAGONAL, so it badly overstates how tall the model is; ~0.7 of it clears a
// boxy sculpture without flinging the bee into orbit.
const ESCAPE_LIFT = 0.7;
// Share of the exit flight spent swinging around the model, the rest heading for the hive.
const ESCAPE_MS_SHARE = 0.45;
// The last stretch: straight up from below the hive to inside it. Short, because it only covers
// the line-up gap — it is the bee disappearing through the hole, not travelling.
const ENTER_MS = 350;
// Spread of the line-up point below the hive, in CSS px. Without it every bee converges on one
// identical spot and a volley stacks into a single column; with it they fan out and each takes a
// slightly different line into the hole. Presentation only — core stays deterministic.
const APPROACH_SPREAD_X = 70;
const APPROACH_SPREAD_Y = 40;
// Land the bee on the face the path arrives at, not buried in the cube's center.
const GRAB_GAP = 0.05;
const GRAB_DISTANCE = CUBE_WORLD_SIZE / 2 + GRAB_GAP;
// How far back along the exit axis the bee lines up before running in. Kept deliberately short:
// pushing this past the sculpture's bounding radius would make the approach provably clear of
// every cube, but sends the bee absurdly far out. At this distance the orbit still curves around
// the model rather than across it, which avoids the blatant cases without guaranteeing it.
const STANDOFF_CELLS = 4;
// Pre-warmed so the first few shots of a fast volley don't pay GLB-instantiation cost mid-flight.
const POOL_SIZE = 10;

/** A route through the sculpture, in `sculptureRoot`-local space. */
export type FlightPath = {
    /** Corners only, outermost first, ending at the empty cell next to the cube. */
    points: Vec3[];
    /** Outward normal of the face the bee grabs. */
    face: Vec3;
};

export type BeeSwarm = {
    /** Send a bee to the cube just destroyed at `localCubePos`, launching from `originScreen`
     *  (the firing slot). With a `path` it flies the real channel in, grabs the face the path
     *  arrives at, and carries the cube back out the same way; without one it swoops straight. */
    spawn(localCubePos: Vec3, color: number, originScreen?: { x: number; y: number }, path?: FlightPath): void;
    update(dt: number): void;
};

// `ContainerResource`'s public .d.ts declares `instantiateRenderEntity` as `(options: any) => any`
// with no narrower overload — typed locally, matching the GlbContainer workaround in sculpture.ts.
type GlbContainer = {
    instantiateRenderEntity(): Entity;
};

type BeeInstance = {
    root: Entity;
    wingL: GraphNode | null;
    wingR: GraphNode | null;
    cube: Entity;
    cubeMeshInstance: MeshInstance;
    /** The bee's body mesh instances, recoloured per flight to match the hive that fired it. */
    bodyMeshInstances: MeshInstance[];
    flapT: number;
    inUse: boolean;
    /** Route this bee was given, in sculpture-local space — drawn when DEBUG_PATHS is on. */
    debugPoints: Vec3[] | null;
};

type Rider = { entity: Entity; offset: Vec3 };

function loadBeeContainer(app: AppBase): Promise<GlbContainer> {
    return new Promise((resolve, reject) => {
        const asset = new Asset('bee', 'container', { url: BEE_MODEL_URL });
        app.assets.add(asset);
        asset.once('load', () => resolve(asset.resource as GlbContainer));
        asset.once('error', (err: string) => reject(new Error(err)));
        app.assets.load(asset);
    });
}

const qYaw = new Quat();
const qPitch = new Quat();
const qFace = new Quat();

/**
 * Turn `entity` to face along `direction` (world space), corrected for the model's forward axis.
 *
 * Not lookAt(): that builds its basis from `direction` x up, which collapses when the bee flies
 * straight up — exactly what the lift leg and any +Y escape route do — and the model flips over.
 * Composing yaw about world-up with pitch about local-right has no degenerate case and can never
 * introduce roll, which a bee has no business doing anyway.
 */
function faceAlong(entity: Entity, direction: Vec3): void {
    const len = direction.length();
    if (len < MIN_FACING_DISTANCE) return;
    // -Z is the engine's forward, so the yaw that aims it along (x, z) is atan2(-x, -z).
    const yaw = Math.atan2(-direction.x, -direction.z) * math.RAD_TO_DEG + BEE_YAW_OFFSET;
    const pitch = Math.asin(direction.y / len) * math.RAD_TO_DEG;
    qYaw.setFromAxisAngle(Vec3.UP, yaw);
    qPitch.setFromAxisAngle(Vec3.RIGHT, pitch);
    entity.setRotation(qFace.copy(qYaw).mul(qPitch));
}

function pathLength(points: Vec3[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += new Vec3().sub2(points[i]!, points[i - 1]!).length();
    }
    return total;
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
export function createBeeSwarm(
    app: AppBase,
    camera: Entity,
    cubeMesh: Mesh,
    depth: number,
    sculptureRoot: Entity,
    /** Half-diagonal of the sculpture's bounding box. The exit flight stays outside it, which is
     *  safe at any rotation because a sphere doesn't change shape when you spin it. */
    sculptureRadius: number,
    /** Where a bee lines up below the hive, and the point inside it they finish at. Both in canvas
     *  (CSS px) space, queried per flight rather than captured once, so they survive a resize. */
    hivePos: {
        approachScreenPos: () => { x: number; y: number };
        entranceScreenPos: () => { x: number; y: number };
    }
): BeeSwarm {
    const tweens = new Group();
    const pool: BeeInstance[] = [];
    let container: GlbContainer | null = null;
    // Tween.js defaults both start() and update() to wall-clock time. Driving them from an
    // accumulated dt instead means a scaled dt (the x2/x3 control) scales bee flight too —
    // but only if BOTH ends use this clock, or every tween finishes the instant it starts.
    let clock = 0;

    function makeInstance(): BeeInstance {
        const root = container!.instantiateRenderEntity();
        root.setLocalScale(BEE_SCALE, BEE_SCALE, BEE_SCALE);
        root.enabled = false;
        app.root.addChild(root);

        // Parented to the sculpture, not the bee (whose BEE_SCALE would compound) and not app.root
        // (where it would hold a fixed WORLD position and visibly tear away from the shape as it
        // rotates, reading as the cube lifting before the bee ever gets there). As a child of the
        // sculpture it sits perfectly still in the hole until a leg starts driving it.
        const cube = new Entity('grabbedCube');
        cube.addComponent('render', {});
        cube.setLocalScale(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);
        const cubeMeshInstance = new MeshInstance(cubeMesh, materialFor(0), cube);
        cube.render!.meshInstances = [cubeMeshInstance];
        cube.enabled = false;
        sculptureRoot.addChild(cube);

        // inspect-glb: Bee_2.glb carries four materials — Body_Color, Body_Black, Smile_Texture and
        // lambert1. Only the first is the tintable shell; swapping the lot would flatten the
        // stripes, face and wings into one colour. Collected before any swap, since a recoloured
        // instance no longer answers to the original name.
        const bodyMeshInstances = root
            .findComponents('render')
            .flatMap((component) => (component as RenderComponent).meshInstances)
            .filter((meshInstance) => meshInstance.material.name === 'Body_Color');

        return {
            root,
            wingL: root.findByName('Wing_L'),
            wingR: root.findByName('Wing_R'),
            cube,
            cubeMeshInstance,
            bodyMeshInstances,
            flapT: 0,
            inUse: false,
            debugPoints: null
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

    /**
     * Walks `points` at constant speed, re-projecting into world space every frame. The path is
     * local to `sculptureRoot`, which keeps turning under the drag rig while the bee flies — bake
     * it to world once at spawn and the bee drifts off the channel as the sculpture rotates.
     * Straight segments, not arcs: the channel is only guaranteed clear along the line itself.
     */
    function flyLocalPath(
        riders: Rider[],
        points: Vec3[],
        ms: number,
        easing: typeof Easing.Quadratic.Out,
        onComplete: () => void,
        facing?: Entity
    ): void {
        const lengths: number[] = [];
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            const len = new Vec3().sub2(points[i]!, points[i - 1]!).length();
            lengths.push(len);
            total += len;
        }
        if (lengths.length === 0 || total < 1e-6) {
            onComplete();
            return;
        }

        const progress = { t: 0 };
        const local = new Vec3();
        const world = new Vec3();
        const heading = new Vec3();
        const matrix = new Mat4();

        new Tween(progress, tweens)
            .to({ t: 1 }, ms)
            .easing(easing)
            .onUpdate(() => {
                let travelled = progress.t * total;
                let seg = 0;
                while (seg < lengths.length - 1 && travelled > lengths[seg]!) {
                    travelled -= lengths[seg]!;
                    seg++;
                }
                const f = lengths[seg]! < 1e-6 ? 0 : Math.min(travelled / lengths[seg]!, 1);
                local.lerp(points[seg]!, points[seg + 1]!, f);

                matrix.copy(sculptureRoot.getWorldTransform());
                for (const r of riders) {
                    world.add2(local, r.offset);
                    matrix.transformPoint(world, world);
                    r.entity.setPosition(world);
                }

                if (facing) {
                    // Direction of the segment being flown, not a frame-to-frame delta — at low
                    // speed that delta is mostly float noise and the bee jitters.
                    heading.sub2(points[seg + 1]!, points[seg]!);
                    matrix.transformVector(heading, heading);
                    faceAlong(facing, heading);
                }
            })
            .onComplete(onComplete)
            .start(clock);
    }

    /**
     * Swings AROUND the sculpture rather than across it: direction and distance are interpolated
     * separately, so every point on the leg sits at least as far from the centre as the nearer
     * endpoint instead of cutting the chord between them.
     *
     * This is the leg a straight hive-to-mouth line got wrong: escape routes are filtered to
     * camera-facing faces, which includes +Y, so a cube venting out of the top handed the bee an
     * approach that ran from below the model straight up through it. Note this only guarantees
     * clearance when both endpoints are outside the sculpture's bounding radius — with the short
     * STANDOFF_CELLS they usually aren't, so this avoids the blatant crossings rather than
     * proving there are none.
     */
    function flyOrbit(
        riders: Rider[],
        from: Vec3,
        to: Vec3,
        ms: number,
        easing: typeof Easing.Quadratic.Out,
        onComplete: () => void,
        facing?: Entity
    ): void {
        const fromLen = Math.max(from.length(), 1e-3);
        const toLen = Math.max(to.length(), 1e-3);
        const fromDir = from.clone().normalize();
        const toDir = to.clone().normalize();

        // Directly opposite endpoints have no well-defined arc between them: the midpoint
        // collapses onto the centre, the one place we must not fly through.
        if (fromDir.dot(toDir) < -0.999) {
            flyLocalPath(riders, [from, to], ms, easing, onComplete, facing);
            return;
        }

        const progress = { t: 0 };
        const dir = new Vec3();
        const local = new Vec3();
        const prev = new Vec3();
        const world = new Vec3();
        const heading = new Vec3();
        const matrix = new Mat4();

        new Tween(progress, tweens)
            .to({ t: 1 }, ms)
            .easing(easing)
            .onUpdate(() => {
                prev.copy(local);
                dir.lerp(fromDir, toDir, progress.t).normalize();
                local.copy(dir).mulScalar(fromLen + (toLen - fromLen) * progress.t);

                matrix.copy(sculptureRoot.getWorldTransform());
                for (const r of riders) {
                    world.add2(local, r.offset);
                    matrix.transformPoint(world, world);
                    r.entity.setPosition(world);
                }

                if (facing && progress.t > 0) {
                    heading.sub2(local, prev);
                    matrix.transformVector(heading, heading);
                    faceAlong(facing, heading);
                }
            })
            .onComplete(onComplete)
            .start(clock);
    }

    /**
     * Swings around the sculpture in WORLD space, staying at least as far from `centre` as the
     * nearer endpoint. The local-space flyOrbit above rides the model's rotation, which is right
     * for the approach; this one doesn't, which is what the exit needs — the hive is fixed on
     * screen while the sculpture spins underneath.
     *
     * Safe regardless of how the player has rotated the model, because a bounding sphere is
     * rotation-invariant: outside it is outside it, at any angle.
     */
    function flyWorldOrbit(
        riders: Rider[],
        from: Vec3,
        to: Vec3,
        centre: Vec3,
        ms: number,
        easing: typeof Easing.Quadratic.Out,
        onComplete: () => void,
        facing?: Entity
    ): void {
        const fromDir = new Vec3().sub2(from, centre);
        const toDir = new Vec3().sub2(to, centre);
        const fromLen = Math.max(fromDir.length(), 1e-3);
        const toLen = Math.max(toDir.length(), 1e-3);
        fromDir.normalize();
        toDir.normalize();

        // Opposite endpoints have no well-defined arc: the midpoint collapses onto the centre,
        // which is the one place we must not pass through.
        if (fromDir.dot(toDir) < -0.999) {
            flyWorldArc(riders, from, to, ms, easing, onComplete, facing);
            return;
        }

        const progress = { t: 0 };
        const dir = new Vec3();
        const pos = new Vec3();
        const prev = new Vec3().copy(from);
        const riderPos = new Vec3();
        const heading = new Vec3();

        new Tween(progress, tweens)
            .to({ t: 1 }, ms)
            .easing(easing)
            .onUpdate(() => {
                dir.lerp(fromDir, toDir, progress.t).normalize();
                pos.copy(dir)
                    .mulScalar(fromLen + (toLen - fromLen) * progress.t)
                    .add(centre);
                for (const r of riders) r.entity.setPosition(riderPos.add2(pos, r.offset));

                if (facing && progress.t > 0) {
                    faceAlong(facing, heading.sub2(pos, prev));
                }
                prev.copy(pos);
            })
            .onComplete(onComplete)
            .start(clock);
    }

    // Tweens a single progress scalar and evaluates a quadratic bezier from it each frame,
    // rather than lerping x/y/z independently (which is what produces a straight line).
    // World space: the final leg, once the bee is clear of the sculpture.
    function flyWorldArc(
        riders: Rider[],
        from: Vec3,
        to: Vec3,
        ms: number,
        easing: typeof Easing.Quadratic.Out,
        onComplete: () => void,
        facing?: Entity,
        /** Overrides the bowed control point — the midpoint makes the leg a straight line. */
        controlOverride?: Vec3
    ): void {
        const control = controlOverride ?? arcControlPoint(from, to);
        const progress = { t: 0 };
        const pos = new Vec3();
        const riderPos = new Vec3();
        const heading = new Vec3();
        new Tween(progress, tweens)
            .to({ t: 1 }, ms)
            .easing(easing)
            .onUpdate(() => {
                const t = progress.t;
                const u = 1 - t;
                pos.x = u * u * from.x + 2 * u * t * control.x + t * t * to.x;
                pos.y = u * u * from.y + 2 * u * t * control.y + t * t * to.y;
                pos.z = u * u * from.z + 2 * u * t * control.z + t * t * to.z;
                for (const r of riders) r.entity.setPosition(riderPos.add2(pos, r.offset));

                if (facing) {
                    // Quadratic tangent: 2(1-t)(c-from) + 2t(to-c).
                    heading.set(
                        2 * u * (control.x - from.x) + 2 * t * (to.x - control.x),
                        2 * u * (control.y - from.y) + 2 * t * (to.y - control.y),
                        2 * u * (control.z - from.z) + 2 * t * (to.z - control.z)
                    );
                    faceAlong(facing, heading);
                }
            })
            .onComplete(onComplete)
            .start(clock);
    }

    async function spawn(
        localCubePos: Vec3,
        color: number,
        originScreen?: { x: number; y: number },
        path?: FlightPath
    ): Promise<void> {
        await ready;
        const inst = acquire();
        const bee = inst.root;

        const camComp = camera.camera!;

        // The hive sits in screen space; the path is local to the sculpture. Bring the launch
        // point into that space rather than hauling the whole path out of it.
        const worldToLocal = new Mat4().copy(sculptureRoot.getWorldTransform()).invert();
        const originLocal = new Vec3();
        if (originScreen) {
            camComp.screenToWorld(originScreen.x, originScreen.y, depth, originLocal);
            worldToLocal.transformPoint(originLocal, originLocal);
        } else {
            originLocal.copy(localCubePos);
        }

        // Visible at the shot cell right away, standing in for the sculpture cube destroyCube
        // just removed — it sits still until the bee arrives, so nothing pops in/out of view.
        // Bee and cargo share the hive's colour, so a shot reads as belonging to the hive it came
        // from even after the cube is out of frame.
        const material = materialFor(color);
        inst.cubeMeshInstance.material = material;
        for (const meshInstance of inst.bodyMeshInstances) meshInstance.material = material;
        inst.cube.setLocalPosition(localCubePos);
        inst.cube.enabled = true;

        // Two points on the hive: one below it to line up at, one inside it to finish at. Sharing
        // a screen x means they share a world x/z at this depth, so the last leg is purely vertical.
        const approachPoint = hivePos.approachScreenPos();
        const entrancePoint = hivePos.entranceScreenPos();
        // Jitter only the line-up point, never the entrance: the bees fan out on the way in and
        // still converge on the one hole.
        const lineUp = camComp.screenToWorld(
            approachPoint.x + (Math.random() - 0.5) * APPROACH_SPREAD_X,
            approachPoint.y + Math.random() * APPROACH_SPREAD_Y,
            depth
        );
        const exit = camComp.screenToWorld(entrancePoint.x, entrancePoint.y, depth);

        // Which face to land on. Without a path (shouldn't happen for a cube we just shot)
        // approach straight from wherever the bee launched, as before.
        const face = path ? path.face.clone() : new Vec3().sub2(originLocal, localCubePos).normalize();
        if (face.lengthSq() < 1e-6) face.copy(Vec3.FORWARD);
        const grabOffset = face.clone().mulScalar(GRAB_DISTANCE);
        const grabLocal = new Vec3().add2(localCubePos, grabOffset);

        const channel = path ? path.points : [];
        const zero = new Vec3();
        const beeOnly = [{ entity: bee, offset: zero }];

        const mouth = channel.length > 0 ? channel[0]! : grabLocal;

        // Direction the escape route leaves the grid by. For a bent path that is NOT the cube's
        // face normal, so take it from the outermost pair of waypoints.
        const exitDir = channel.length >= 2 ? new Vec3().sub2(channel[0]!, channel[1]!).normalize() : face.clone();

        // Standoff: a short hop back along the exit axis. Moving along that axis from a point
        // already outside the grid only ever moves further out, so standoff -> mouth is clear
        // whatever STANDOFF_CELLS is; it's the orbit before it that gets weaker as this shrinks.
        const standoff = new Vec3().add2(mouth, exitDir.clone().mulScalar(STANDOFF_CELLS));

        const descent = [standoff, mouth];
        const weave = [...channel, grabLocal];
        // Out: the CUBE retraces the channel (it's the big thing that mustn't clip), with the bee
        // riding one grab-distance off the same face.
        const retrace = [localCubePos, ...channel.slice().reverse()];
        const ascent = [mouth, standoff];

        // Four legs: orbit in -> weave down the channel -> carry back out -> lift away.
        const cubeAndBee = [
            { entity: inst.cube, offset: zero },
            { entity: bee, offset: grabOffset }
        ];

        // Only the provably-clear part is drawn; the orbit is a curve, not a polyline.
        inst.debugPoints = DEBUG_PATHS ? [standoff, ...channel, grabLocal] : null;

        const liftAway = (): void => {
            // Clear of the sculpture now, so finish in world space — the exit shouldn't swing
            // back around with the model if the player keeps dragging.
            const from = inst.cube.getPosition().clone();
            const beeOffset = new Vec3().sub2(bee.getPosition(), from);
            const riders = [
                { entity: inst.cube, offset: zero },
                { entity: bee, offset: beeOffset }
            ];

            const centre = sculptureRoot.getPosition().clone();

            // Where the bee comes out of the orbit: pushed to the escape radius horizontally, and
            // lifted to clear the top of the sphere — but never above the line-up point.
            //
            // That ceiling is the important part. The line-up point sits BELOW the hive, so if the
            // bee were allowed to reach hive height first it would have to drop back down to it
            // and then climb again. Capping here means every leg from now on only ever goes up.
            const flat = new Vec3(from.x - centre.x, 0, from.z - centre.z);
            const flatDistance = flat.length();
            if (flatDistance < 1e-6) flat.set(1, 0, 0);
            flat.normalize();
            // Keep whatever horizontal distance the bee already has, plus ESCAPE_OUT — don't drag
            // it out to the bounding radius it never needed to reach.
            const escapeRadius = flatDistance + ESCAPE_OUT;
            const clearTop = Math.max(from.y, centre.y + sculptureRadius * ESCAPE_LIFT);
            const escape = new Vec3(
                centre.x + flat.x * escapeRadius,
                Math.min(clearTop, lineUp.y),
                centre.z + flat.z * escapeRadius
            );

            // Control at the midpoint makes a quadratic a straight line, which is what keeps a leg
            // exactly radial — and therefore provably outside the sphere.
            const straight = (a: Vec3, b: Vec3): Vec3 => new Vec3().add2(a, b).mulScalar(0.5);

            // Leg 3: straight up from below the hive to inside it, through the hole.
            const riseIn = (): void =>
                flyWorldArc(
                    riders,
                    lineUp,
                    exit,
                    ENTER_MS,
                    Easing.Linear.None,
                    () => {
                        // Leg 3 ending IS the cube going through the hole in the hive.
                        sfx('hive');
                        release(inst);
                    },
                    bee,
                    straight(lineUp, exit)
                );

            // Leg 2: up and across to the line-up point below the hive. Both ends sit at or above
            // the top of the sphere, so the straight line between them clears the model.
            const crossTo = (): void =>
                flyWorldArc(
                    riders,
                    escape,
                    lineUp,
                    Math.max(FLY_OUT_MS * (1 - ESCAPE_MS_SHARE) - ENTER_MS, 1),
                    Easing.Linear.None,
                    riseIn,
                    bee,
                    straight(escape, lineUp)
                );

            // Leg 1: swing AROUND the model and out to the escape sphere at the same time.
            flyWorldOrbit(riders, from, escape, centre, FLY_OUT_MS * ESCAPE_MS_SHARE, Easing.Linear.None, crossTo, bee);
        };

        // Every leg below is timed at the same units-per-second, so there is no speed change
        // between flying in, weaving down the channel, and grabbing the cube.
        const riseOut = (): void =>
            flyLocalPath(
                cubeAndBee,
                ascent,
                pathLength(ascent) * FLIGHT_MS_PER_UNIT,
                Easing.Linear.None,
                liftAway,
                bee
            );

        const carryOut = (): void =>
            flyLocalPath(
                cubeAndBee,
                retrace,
                pathLength(retrace) * FLIGHT_MS_PER_UNIT,
                Easing.Linear.None,
                riseOut,
                bee
            );

        const weaveIn = (): void =>
            flyLocalPath(beeOnly, weave, pathLength(weave) * FLIGHT_MS_PER_UNIT, Easing.Linear.None, carryOut, bee);

        const dropIn = (): void =>
            flyLocalPath(beeOnly, descent, pathLength(descent) * FLIGHT_MS_PER_UNIT, Easing.Linear.None, weaveIn, bee);

        flyOrbit(beeOnly, originLocal, standoff, APPROACH_MS, Easing.Quadratic.In, dropIn, bee);
    }

    const debugA = new Vec3();
    const debugB = new Vec3();
    const debugMatrix = new Mat4();

    function update(dt: number): void {
        clock += dt * 1000;
        tweens.update(clock);
        for (const inst of pool) {
            if (!inst.inUse) continue;
            inst.flapT += dt;
            const angle = Math.sin(inst.flapT * WING_FLAP_HZ) * WING_FLAP_DEG;
            inst.wingL?.setLocalEulerAngles(0, 0, angle);
            inst.wingR?.setLocalEulerAngles(0, 0, -angle);

            // Immediate-mode lines, re-issued every frame — the route is stored in sculpture-local
            // space, so it tracks the model as it rotates just like the bee does.
            const pts = inst.debugPoints;
            if (!pts || pts.length < 2) continue;
            debugMatrix.copy(sculptureRoot.getWorldTransform());
            for (let i = 1; i < pts.length; i++) {
                debugMatrix.transformPoint(pts[i - 1]!, debugA);
                debugMatrix.transformPoint(pts[i]!, debugB);
                app.drawLine(debugA, debugB, DEBUG_PATH_COLOR);
            }
        }
    }

    return { spawn, update };
}
