import type { V3 } from 'core';
import { Quat, Vec3, math } from 'playcanvas';
import type { Entity } from 'playcanvas';

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

// ponytail: raw pointer events, switch to app.mouse/app.touch if multi-touch is ever needed.
export function createCameraRig(
    canvas: HTMLCanvasElement,
    root: Entity,
    camera: Entity,
    hitsUi: (x: number, y: number) => boolean,
    initialRotation?: V3
): CameraRig {
    // The level's DefaultRotation: the angle its author wants the sculpture first seen at. Only
    // x (pitch) and y (yaw) are used — the rig has no roll, deliberately.
    //
    // Negated because the level editor is left-handed (Y-up, +Z forward) and PlayCanvas is
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
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
        // HUD buttons render on this same canvas now (no DOM overlay to intercept the click
        // first), so a tap on one would otherwise also start a drag.
        if (hitsUi(e.clientX, e.clientY)) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        targetYaw += dx * DRAG_SPEED;
        targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch - dy * DRAG_SPEED));
    };

    const onPointerUp = (e: PointerEvent) => {
        dragging = false;
        canvas.releasePointerCapture(e.pointerId);
    };

    // Trackpad swipe (deltaX) or mouse wheel (deltaY), both just add to targetYaw like a drag.
    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        targetYaw += delta * WHEEL_SPEED;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const qYaw = new Quat();
    const qPitch = new Quat();
    const qOrbit = new Quat();

    function update(dt: number): void {
        if (!dragging) targetYaw -= AUTO_ROTATE_SPEED * dt;

        const t = 1 - Math.exp(-SMOOTHING * dt); // framerate-independent easing
        yaw = math.lerpAngle(yaw, targetYaw, t);
        pitch = math.lerp(pitch, targetPitch, t);

        // Not setLocalEulerAngles: its X-then-Y order applies yaw around the pitched local Y
        // axis, so the spin axis tilts with pitch. Compose explicitly so yaw is always world-up.
        qYaw.setFromAxisAngle(Vec3.UP, yaw);
        qPitch.setFromAxisAngle(Vec3.RIGHT, pitch);
        qOrbit.copy(qYaw).mul(qPitch);
        root.setLocalRotation(qOrbit);
    }

    const dir = new Vec3();
    const inverseRotation = new Quat();

    // Reachability is grid-local, so the view direction must be translated into root's rotating space.
    function getViewDir(): V3 {
        dir.copy(camera.getPosition()).sub(root.getPosition()).normalize();
        inverseRotation.copy(root.getRotation()).invert();
        inverseRotation.transformVector(dir, dir);
        return { x: dir.x, y: dir.y, z: dir.z };
    }

    function destroy(): void {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
    }

    return { update, getViewDir, destroy };
}
