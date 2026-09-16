import { EventMouse, EventTouch, Input, Node, Quat, Vec3, input, math } from 'cc';
import type { V3 } from 'core';

const DRAG_SPEED = 0.3; // degrees per pixel
const WHEEL_SPEED = 0.3; // degrees per wheel-delta unit
const PITCH_LIMIT = 60;
const AUTO_ROTATE_SPEED = 3; // degrees per second, while not being dragged
const SMOOTHING = 10; // exponential decay rate

export type CameraRig = {
    update(dt: number): void;
    getViewDir(): V3;
    destroy(): void;
};

/** Shortest-arc lerp between two angles in degrees. Cocos has no lerpAngle. */
function lerpAngle(from: number, to: number, t: number): number {
    let delta = (to - from) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return from + delta * t;
}

// ponytail: no UI hit-test yet, because there is no UI yet. Phase F must add one — a global
// `input` listener fires even when the touch landed on a Button, so without it every tap on a
// hive icon will also spin the sculpture.
export function createCameraRig(root: Node, camera: Node, initialRotation?: V3): CameraRig {
    // The level's DefaultRotation: the angle its author wants the sculpture first seen at. Only
    // x (pitch) and y (yaw) are used — the rig has no roll, deliberately.
    //
    // Negated because the level editor is left-handed (Y-up, +Z forward) and Cocos is
    // right-handed, which flips the sense of a rotation about X and Y. Taken at face value the
    // teddy's +45 lays it on its back and shows the camera the top of its head.
    //
    // Pitch is clamped like any other, so a level can't open somewhere the drag rig could never
    // return to.
    const startPitch = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, -(initialRotation?.x ?? 0))
    );
    const startYaw = -(initialRotation?.y ?? 0);

    // target* is set from input; yaw/pitch ease toward it each frame (see update()). Both start
    // at the level's angle so it opens there rather than swinging into it from zero.
    let targetYaw = startYaw;
    let targetPitch = startPitch;
    let yaw = startYaw;
    let pitch = startPitch;
    let dragging = false;

    const onTouchStart = (): void => {
        dragging = true;
    };

    const onTouchMove = (event: EventTouch): void => {
        if (!dragging) return;
        const delta = event.getDelta();
        // Cocos touch deltas are y-UP, where the DOM pointer events the PlayCanvas rig reads are
        // y-down — hence `+=` here against that rig's `-=`. Same gesture, same result.
        targetYaw += delta.x * DRAG_SPEED;
        targetPitch = Math.max(
            -PITCH_LIMIT,
            Math.min(PITCH_LIMIT, targetPitch + delta.y * DRAG_SPEED)
        );
    };

    const onTouchEnd = (): void => {
        dragging = false;
    };

    // Trackpad swipe or mouse wheel, both just add to targetYaw like a drag.
    const onWheel = (event: EventMouse): void => {
        const x = event.getScrollX();
        const y = event.getScrollY();
        targetYaw += (Math.abs(x) > Math.abs(y) ? x : y) * WHEEL_SPEED;
    };

    input.on(Input.EventType.TOUCH_START, onTouchStart);
    input.on(Input.EventType.TOUCH_MOVE, onTouchMove);
    input.on(Input.EventType.TOUCH_END, onTouchEnd);
    input.on(Input.EventType.TOUCH_CANCEL, onTouchEnd);
    input.on(Input.EventType.MOUSE_WHEEL, onWheel);

    const qYaw = new Quat();
    const qPitch = new Quat();
    const qOrbit = new Quat();

    function update(dt: number): void {
        if (!dragging) targetYaw -= AUTO_ROTATE_SPEED * dt;

        const t = 1 - Math.exp(-SMOOTHING * dt); // framerate-independent easing
        yaw = lerpAngle(yaw, targetYaw, t);
        pitch = math.lerp(pitch, targetPitch, t);

        // Not setRotationFromEuler: its X-then-Y order applies yaw around the pitched local Y
        // axis, so the spin axis tilts with pitch. Compose explicitly so yaw is always world-up.
        // Cocos takes RADIANS here, unlike PlayCanvas' degrees.
        Quat.fromAxisAngle(qYaw, Vec3.UP, math.toRadian(yaw));
        Quat.fromAxisAngle(qPitch, Vec3.RIGHT, math.toRadian(pitch));
        Quat.multiply(qOrbit, qYaw, qPitch);
        root.setRotation(qOrbit);
    }

    const dir = new Vec3();
    const inverseRotation = new Quat();

    // Reachability is grid-local, so the view direction must be translated into root's rotating space.
    function getViewDir(): V3 {
        Vec3.subtract(dir, camera.worldPosition, root.worldPosition);
        dir.normalize();
        Quat.invert(inverseRotation, root.worldRotation);
        Vec3.transformQuat(dir, dir, inverseRotation);
        return { x: dir.x, y: dir.y, z: dir.z };
    }

    function destroy(): void {
        input.off(Input.EventType.TOUCH_START, onTouchStart);
        input.off(Input.EventType.TOUCH_MOVE, onTouchMove);
        input.off(Input.EventType.TOUCH_END, onTouchEnd);
        input.off(Input.EventType.TOUCH_CANCEL, onTouchEnd);
        input.off(Input.EventType.MOUSE_WHEEL, onWheel);
    }

    return { update, getViewDir, destroy };
}
