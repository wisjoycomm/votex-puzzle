import {
    Camera,
    EffectAsset,
    Mat4,
    MeshRenderer,
    Node,
    Prefab,
    Quat,
    Vec3,
    geometry,
    instantiate,
    math,
    view,
} from "cc";
import type { CellPath, V3 } from "core";

import { materialFor } from "./colors";
import { playSfx } from "./audio-manager";
import { gridToLocal } from "./sculpture";
import type { Sculpture } from "./sculpture";

// One cruise speed for the whole flight, launch to delivery. Every leg is timed by its own
// measured length, so the bee never accelerates, decelerates or pauses at a leg boundary. Cubes
// are one unit apart, so 80ms per unit is 12.5 cells/s — raise it for a slower, heavier bee.
const FLIGHT_MS_PER_UNIT = 80;
// Steps used to measure a curved leg's length. Only runs once per leg, at construction.
const LENGTH_SAMPLES = 24;
// Cocos forward is -Z; Bee_2 doesn't necessarily model its own forward that way.
// ponytail: one yaw correction found by eye — flip to 0/90/270 if the bee flies sideways.
const BEE_YAW_OFFSET = 180;
// Below this the travel direction is noise, so keep the previous facing rather than snapping.
const MIN_FACING_DISTANCE = 1e-4;
// How much a leg's midpoint bows up/sideways off the straight line. Raise for a loopier swoop.
const ARC_LIFT = 0.35;
const ARC_BOW = 0.2;
// Extra push outward before the climb. Zero because the standoff already left the bee clear of
// the model; raise it if bees clip the sculpture on the way out.
const ESCAPE_OUT = 0;
// How high the bee lifts before rising out of frame, as a fraction of the bounding radius. That
// radius is the half-DIAGONAL, so it badly overstates how tall the model is; ~0.7 of it clears a
// boxy sculpture without flinging the bee into orbit.
const ESCAPE_LIFT = 0.7;
// How far past the top edge the cube rises before it is released, in screen px. Enough that it is
// gone rather than popping out at the edge.
const EXIT_MARGIN = 90;
// Land the bee on the face the path arrives at, not buried in the cube's centre. Cubes are one
// unit, so half of one plus a small gap.
const GRAB_DISTANCE = 0.5;
// How far back along the exit axis the bee lines up before running in. Deliberately short: far
// enough that the orbit curves around the model rather than across it, not far enough to prove it.
const STANDOFF_CELLS = 4;
// Pre-warmed so the first shots of a fast volley don't pay instantiation cost mid-flight.
const POOL_SIZE = 10;
// FBX material to recolour per flight. The bee carries four; swapping the lot would flatten the
// stripes, face and wings into one colour.
const BODY_MATERIAL = "body_color";
// Finite-difference step used to read a leg's heading. Small enough to be a tangent, large
// enough not to be float noise.
const TANGENT_EPS = 1e-3;

export type BeeSwarm = {
    /** Launch from firing slot `slot`, grab the cube destroyed at `cell`, carry it to the hive. */
    spawn(cell: V3, color: number, slot: number, path: CellPath | null): void;
    update(dt: number): void;
};

/** One shot as pure geometry, all in sculpture-local space. Computed once, before any leg runs. */
type Route = {
    /** Where the bee launched from, for the approach orbit. */
    origin: Vec3;
    /** The destroyed cube's cell, centred. */
    cube: Vec3;
    /** Where the bee sits holding it: one grab-distance off the face the path arrives at. */
    grab: Vec3;
    grabOffset: Vec3;
    /** Route corners, outermost first. Empty when the core had no path to hand over. */
    channel: Vec3[];
    /** Outermost corner, where the channel meets the outside. */
    mouth: Vec3;
    /** A hop further out along the exit axis, where the approach hands over to the weave. */
    standoff: Vec3;
};

type Rider = { node: Node; offset: Vec3 };

/** Position at t (0..1) along one leg, in that leg's own space. */
type Sample = (t: number, out: Vec3) => Vec3;

type Leg = {
    sample: Sample;
    ms: number;
    /** Sample is local to the sculpture and re-projected every frame, so it rides the drag rig. */
    local: boolean;
    riders: Rider[];
    next: () => Leg | null;
};

type Bee = {
    root: Node;
    cube: Node;
    cubeRenderer: MeshRenderer;
    body: { renderer: MeshRenderer; index: number }[];
    inUse: boolean;
    leg: Leg | null;
    elapsed: number;
};

export function createBeeSwarm(opts: {
    /** Where bee nodes live. Not the sculpture: they must not inherit its rotation. */
    parent: Node;
    camera: Camera;
    beePrefab: Prefab;
    effect: EffectAsset;
    sculpture: Sculpture;
    /** Screen-space (px, bottom-left origin) centre of a firing slot. */
    slotScreenPos: (slot: number) => Vec3 | null;
    /** The hive cubes are carried to. Null falls back to rising off the top of the screen. */
    hiveScreenPos: () => Vec3 | null;
    /** Fired as a bee comes out of a firing slot, so that hive can react. */
    onLaunch: (slot: number) => void;
    /** Fired as a cube goes through the hole, so the top hive can react. */
    onDeliver: () => void;
}): BeeSwarm {
    const {
        parent,
        camera,
        beePrefab,
        effect,
        sculpture,
        slotScreenPos,
        hiveScreenPos,
        onLaunch,
        onDeliver,
    } = opts;
    const pool: Bee[] = [];
    let warnedBody = false;
    let warnedSlot = false;

    function makeBee(): Bee {
        const root = instantiate(beePrefab);
        root.active = false;
        parent.addChild(root);

        // Parented to the sculpture, not the bee (whose scale would compound): it sits perfectly
        // still in the hole it came out of until a leg starts driving it.
        const cube = new Node("carriedCube");
        cube.setScale(
            sculpture.cubeScale,
            sculpture.cubeScale,
            sculpture.cubeScale,
        );
        cube.active = false;
        sculpture.root.addChild(cube);
        const cubeRenderer = cube.addComponent(MeshRenderer);
        cubeRenderer.mesh = sculpture.mesh;
        cubeRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        cubeRenderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;

        const body: { renderer: MeshRenderer; index: number }[] = [];
        for (const renderer of root.getComponentsInChildren(MeshRenderer)) {
            renderer.sharedMaterials.forEach((material, index) => {
                if (material?.name.toLowerCase().startsWith(BODY_MATERIAL)) {
                    body.push({ renderer, index });
                }
            });
        }
        if (body.length === 0 && !warnedBody) {
            warnedBody = true;
            console.warn(
                `[bee] no "${BODY_MATERIAL}" material on the bee prefab`,
            );
        }

        return {
            root,
            cube,
            cubeRenderer,
            body,
            inUse: false,
            leg: null,
            elapsed: 0,
        };
    }

    for (let i = 0; i < POOL_SIZE; i++) pool.push(makeBee());

    function acquire(): Bee {
        // All POOL_SIZE mid-flight at once (a volley across every lane) — grow rather than drop
        // the effect.
        const bee =
            pool.find((b) => !b.inUse) ?? pool[pool.push(makeBee()) - 1]!;
        bee.inUse = true;
        bee.elapsed = 0;
        bee.root.active = true;
        return bee;
    }

    function release(bee: Bee): void {
        bee.root.active = false;
        bee.cube.active = false;
        bee.inUse = false;
        bee.leg = null;
    }

    const ray = new geometry.Ray();

    /** Screen point -> the world point `distance` along that ray. */
    function screenAt(x: number, y: number, distance: number, out: Vec3): Vec3 {
        camera.screenPointToRay(x, y, ray);
        return Vec3.scaleAndAdd(out, ray.o, ray.d, distance);
    }

    function spawn(
        cell: V3,
        color: number,
        slot: number,
        path: CellPath | null,
    ): void {
        const screen = slotScreenPos(slot);
        if (!screen) {
            if (!warnedSlot) {
                warnedSlot = true;
                console.warn("[bee] no screen position for firing slots");
            }
            return;
        }
        const bee = acquire();
        const route = planRoute(sculpture, cell, path, launchPoint(screen));
        dress(bee, color, route.cube);
        bee.leg = entryLegs(bee, route);
        // Place it now, not on the next update(): a pooled bee still holds the world position its
        // last flight ended at, so without this it flashes at the hive for one frame.
        place(bee, bee.leg, 0);
        // After placing, so the hive reacts on the frame the bee is actually in its hole.
        onLaunch(slot);
    }

    function sculptureDepth(): number {
        return Vec3.distance(
            camera.node.worldPosition,
            sculpture.root.worldPosition,
        );
    }

    function launchPoint(screen: Vec3): Vec3 {
        const out = screenAt(screen.x, screen.y, sculptureDepth(), new Vec3());
        const worldToLocal = Mat4.invert(
            new Mat4(),
            sculpture.root.worldMatrix,
        );
        return Vec3.transformMat4(out, out, worldToLocal);
    }

    function dress(bee: Bee, color: number, cube: Vec3): void {
        const material = materialFor(color, effect);
        bee.cubeRenderer.setSharedMaterial(material, 0);
        for (const part of bee.body) {
            part.renderer.setSharedMaterial(material, part.index);
        }
        // Visible at the shot cell right away, standing in for the sculpture cube destroyCube just
        // removed — nothing pops in or out of view.
        bee.cube.setPosition(cube);
        bee.cube.active = true;
    }

    function entryLegs(bee: Bee, route: Route): Leg {
        const beeOnly: Rider[] = [{ node: bee.root, offset: new Vec3() }];
        // Out: the CUBE retraces the channel (it's the big thing that mustn't clip), with the bee
        // riding one grab-distance off the same face.
        const cubeAndBee: Rider[] = [
            { node: bee.cube, offset: new Vec3() },
            { node: bee.root, offset: route.grabOffset },
        ];
        const leg = (
            points: Vec3[],
            riders: Rider[],
            next: () => Leg | null,
        ): Leg => localLeg(polyline(points), riders, next);

        const ascent = leg([route.mouth, route.standoff], cubeAndBee, () =>
            exitLegs(bee),
        );
        const carryOut = leg(
            [route.cube, ...route.channel.slice().reverse()],
            cubeAndBee,
            () => ascent,
        );
        const weaveIn = leg(
            [...route.channel, route.grab],
            beeOnly,
            () => carryOut,
        );
        const dropIn = leg(
            [route.standoff, route.mouth],
            beeOnly,
            () => weaveIn,
        );

        return localLeg(
            orbit(route.origin, route.standoff, Vec3.ZERO),
            beeOnly,
            () => dropIn,
        );
    }

    function localLeg(
        sample: Sample,
        riders: Rider[],
        next: () => Leg | null,
    ): Leg {
        return { sample, ms: legMs(sample), local: true, riders, next };
    }

    function exitLegs(bee: Bee): Leg {
        const from = bee.cube.worldPosition.clone();
        const riders: Rider[] = [
            { node: bee.cube, offset: new Vec3() },
            {
                node: bee.root,
                offset: Vec3.subtract(new Vec3(), bee.root.worldPosition, from),
            },
        ];
        const centre = sculpture.root.worldPosition.clone();

        const hive = hiveScreenPos();
        // InPixel, not getVisibleSize(): that one is the design resolution, and screenAt() feeds
        // screenPointToRay, which reads framebuffer pixels. Under fitWidth the two differ by the
        // whole device scale, which would aim the fallback exit well off the actual screen.
        const size = view.getVisibleSizeInPixel();
        const above = hive
            ? screenAt(hive.x, hive.y, sculptureDepth(), new Vec3())
            : screenAt(
                  size.width / 2,
                  size.height + EXIT_MARGIN,
                  sculptureDepth(),
                  new Vec3(),
              );

        const flat = new Vec3(from.x - centre.x, 0, from.z - centre.z);
        const flatDistance = flat.length();
        if (flatDistance < 1e-6) flat.set(1, 0, 0);
        flat.normalize();
        const escapeRadius = flatDistance + ESCAPE_OUT;
        const clearTop = Math.max(
            from.y,
            centre.y + sculpture.radius * ESCAPE_LIFT,
        );
        const escape = new Vec3(
            centre.x + flat.x * escapeRadius,
            Math.min(clearTop, above.y),
            centre.z + flat.z * escapeRadius,
        );
        if (!hive) above.set(escape.x, above.y, escape.z);

        // Control at the midpoint keeps it a straight line: both ends sit at or above the top of
        // the bounding sphere, so it clears the model.
        const rise = arc(escape, above, midpoint(escape, above));
        const riseOut: Leg = {
            sample: rise,
            ms: legMs(rise),
            local: false,
            riders,
            // Reaching the end of this leg IS the cube going through the hole.
            next: () => {
                playSfx("hive");
                onDeliver();
                return null;
            },
        };
        const swingOut = orbit(from, escape, centre);
        return {
            sample: swingOut,
            ms: legMs(swingOut),
            local: false,
            riders,
            next: () => riseOut,
        };
    }

    const pos = new Vec3();
    const ahead = new Vec3();
    const behind = new Vec3();
    const heading = new Vec3();
    const riderPos = new Vec3();

    function place(bee: Bee, leg: Leg, t: number): void {
        leg.sample(t, pos);
        // Heading from a finite difference along the leg, not a frame-to-frame delta: at low
        // speed that delta is mostly float noise and the bee jitters.
        leg.sample(Math.min(t + TANGENT_EPS, 1), ahead);
        leg.sample(Math.max(t - TANGENT_EPS, 0), behind);
        Vec3.subtract(heading, ahead, behind);

        for (const rider of leg.riders) {
            Vec3.add(riderPos, pos, rider.offset);
            if (leg.local) {
                Vec3.transformMat4(
                    riderPos,
                    riderPos,
                    sculpture.root.worldMatrix,
                );
            }
            rider.node.setWorldPosition(riderPos);
        }
        if (leg.local) {
            Vec3.transformQuat(heading, heading, sculpture.root.worldRotation);
        }
        faceAlong(bee.root, heading);
    }

    function update(dt: number): void {
        for (const bee of pool) {
            if (!bee.inUse || !bee.leg) continue;

            // Spend the frame ACROSS legs rather than per leg. Stopping at each boundary would
            // throw away the overshoot — up to a frame every time — and a leg shorter than one
            // frame would cost a whole frame standing still. Both read as the bee hesitating.
            let remaining = dt * 1000;
            while (bee.leg) {
                const left = Math.max(bee.leg.ms - bee.elapsed, 0);
                if (remaining < left) {
                    bee.elapsed += remaining;
                    break;
                }
                remaining -= left;
                bee.elapsed = 0;
                bee.leg = bee.leg.next();
            }

            if (!bee.leg) {
                release(bee);
                continue;
            }
            place(
                bee,
                bee.leg,
                bee.leg.ms > 0 ? Math.min(bee.elapsed / bee.leg.ms, 1) : 0,
            );
        }
    }

    return { spawn, update };
}

/**
 * `origin` only decides which face to grab when the core handed over no path — which shouldn't
 * happen for a cube it just proved reachable.
 */
function planRoute(
    sculpture: Sculpture,
    cell: V3,
    path: CellPath | null,
    origin: Vec3,
): Route {
    const cube = gridToLocal(sculpture, cell);

    const face = path
        ? new Vec3(path.face.x, path.face.y, path.face.z)
        : Vec3.subtract(new Vec3(), origin, cube).normalize();
    if (face.lengthSqr() < 1e-6) face.set(0, 0, -1);
    const grabOffset = Vec3.multiplyScalar(new Vec3(), face, GRAB_DISTANCE);
    const grab = Vec3.add(new Vec3(), cube, grabOffset);

    const channel = path
        ? path.points.map((p) => gridToLocal(sculpture, p))
        : [];
    const mouth = channel[0] ?? grab;
    // Direction the route leaves the grid by. For a bent path that is NOT the cube's face normal,
    // so take it from the outermost pair of waypoints.
    const exitDir =
        channel.length >= 2
            ? Vec3.subtract(new Vec3(), channel[0]!, channel[1]!).normalize()
            : face.clone();
    // Moving along that axis from a point already outside the grid only ever moves further out,
    // so standoff -> mouth is clear whatever STANDOFF_CELLS is.
    const standoff = Vec3.scaleAndAdd(
        new Vec3(),
        mouth,
        exitDir,
        STANDOFF_CELLS,
    );

    return { origin, cube, grab, grabOffset, channel, mouth, standoff };
}

/** Straight segments, not arcs: a channel is only guaranteed clear along the line itself. */
function polyline(points: Vec3[]): Sample {
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const length = Vec3.distance(points[i]!, points[i - 1]!);
        lengths.push(length);
        total += length;
    }
    return (t, out) => {
        if (lengths.length === 0 || total < 1e-6) return out.set(points[0]!);
        let travelled = t * total;
        let seg = 0;
        while (seg < lengths.length - 1 && travelled > lengths[seg]!) {
            travelled -= lengths[seg]!;
            seg++;
        }
        const f =
            lengths[seg]! < 1e-6 ? 0 : Math.min(travelled / lengths[seg]!, 1);
        return Vec3.lerp(out, points[seg]!, points[seg + 1]!, f);
    };
}

/**
 * Swings AROUND `centre` rather than across it: direction and distance are interpolated
 * separately, so every point sits at least as far out as the nearer endpoint instead of cutting
 * the chord. Escape routes include +Y, and a straight line from below to a cube venting out of
 * the top would run through the whole model.
 */
function orbit(from: Vec3, to: Vec3, centre: Readonly<Vec3>): Sample {
    const fromDir = Vec3.subtract(new Vec3(), from, centre);
    const toDir = Vec3.subtract(new Vec3(), to, centre);
    const fromLen = Math.max(fromDir.length(), 1e-3);
    const toLen = Math.max(toDir.length(), 1e-3);
    fromDir.normalize();
    toDir.normalize();

    // Directly opposite endpoints have no well-defined arc: the midpoint collapses onto the
    // centre, the one place we must not fly through.
    if (Vec3.dot(fromDir, toDir) < -0.999) {
        return arc(from, to, arcControlPoint(from, to));
    }

    const dir = new Vec3();
    return (t, out) => {
        Vec3.lerp(dir, fromDir, toDir, t).normalize();
        return Vec3.scaleAndAdd(
            out,
            centre,
            dir,
            fromLen + (toLen - fromLen) * t,
        );
    };
}

/** Quadratic bezier. A control point at the midpoint makes it a straight line. */
function arc(from: Vec3, to: Vec3, control: Vec3): Sample {
    return (t, out) => {
        const u = 1 - t;
        return out.set(
            u * u * from.x + 2 * u * t * control.x + t * t * to.x,
            u * u * from.y + 2 * u * t * control.y + t * t * to.y,
            u * u * from.z + 2 * u * t * control.z + t * t * to.z,
        );
    };
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
    return Vec3.multiplyScalar(new Vec3(), Vec3.add(new Vec3(), a, b), 0.5);
}

/** Midpoint bowed up and sideways, so a leg along it reads as a swoop, not a ruler. */
function arcControlPoint(from: Vec3, to: Vec3): Vec3 {
    const delta = Vec3.subtract(new Vec3(), to, from);
    const distance = delta.length();
    const side = Vec3.cross(new Vec3(), delta, Vec3.UP);
    if (side.lengthSqr() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const out = midpoint(from, to);
    out.y += distance * ARC_LIFT;
    return Vec3.scaleAndAdd(out, out, side, distance * ARC_BOW);
}

/**
 * How long a leg takes at cruise speed. Measured off the sample rather than off the points it was
 * built from, so a bowed orbit is timed by the distance actually flown, not by its chord — which
 * is what would make a curve run faster than the straight leg either side of it.
 */
function legMs(sample: Sample): number {
    const a = new Vec3();
    const b = new Vec3();
    let total = 0;
    sample(0, a);
    for (let i = 1; i <= LENGTH_SAMPLES; i++) {
        sample(i / LENGTH_SAMPLES, b);
        total += Vec3.distance(a, b);
        a.set(b);
    }
    return total * FLIGHT_MS_PER_UNIT;
}

const qYaw = new Quat();
const qPitch = new Quat();
const qFace = new Quat();

/**
 * Turn `node` to face along `direction` (world space), corrected for the model's forward axis.
 *
 * Not lookAt(): that builds its basis from direction x up, which collapses when the bee flies
 * straight up — exactly what the lift leg does — and the model flips over. Yaw about world-up
 * composed with pitch about local-right has no degenerate case and can't introduce roll.
 */
function faceAlong(node: Node, direction: Vec3): void {
    const length = direction.length();
    if (length < MIN_FACING_DISTANCE) return;
    // -Z is forward, so the yaw that aims it along (x, z) is atan2(-x, -z).
    const yaw =
        Math.atan2(-direction.x, -direction.z) + math.toRadian(BEE_YAW_OFFSET);
    const pitch = Math.asin(Math.max(-1, Math.min(1, direction.y / length)));
    Quat.fromAxisAngle(qYaw, Vec3.UP, yaw);
    Quat.fromAxisAngle(qPitch, Vec3.RIGHT, pitch);
    node.setWorldRotation(Quat.multiply(qFace, qYaw, qPitch));
}
