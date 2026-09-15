import { Easing, Group, Tween } from '@tweenjs/tween.js';
import type { GameState } from 'core';

import { hexFor } from './colors.ts';

const FLY_MS = 220;

export type Hud = {
    refresh(state: GameState, slotForLane: (lane: number) => number | undefined): void;
    setStatus(text: string): void;
    /** Screen-space center of a lane's fix slot (the active/firing socket), for effects that
     *  should originate from where a shot visually comes from. */
    getFixSlotScreenPos(lane: number): { x: number; y: number } | undefined;
    destroy(): void;
}

type LaneEls = {
    active: HTMLElement;
    activeFill: HTMLElement;
    /** Front slot (index 0) is the clickable button; the rest are a preview peek of what's next. */
    queueSlots: { el: HTMLElement; fill: HTMLElement }[];
}

const QUEUE_PREVIEW = 3;

// A pure view of GameCore's state: every element is re-derived from `state` on each call,
// never stored as its own source of truth.
export function createHud(container: HTMLElement, onActivate: (lane: number) => void): Hud {
    container.innerHTML = '';

    const status = document.createElement('div');
    status.className = 'hud-status';
    container.appendChild(status);

    const lanesEl = document.createElement('div');
    lanesEl.className = 'hud-lanes';
    container.appendChild(lanesEl);

    const laneEls: LaneEls[] = [];
    const tweens = new Group();

    // Sockets never move — refresh() only repaints a fill in place. To sell "the chosen hive
    // flies up into the fix slot", animate a throwaway clone over the real DOM instead of the
    // (stationary) elements themselves.
    function flyToken(from: HTMLElement, to: HTMLElement, background: string, text: string): void {
        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();

        const clone = document.createElement('div');
        clone.className = 'hud-hive__fill hud-hive__fill--flying';
        clone.style.left = `${fromRect.left}px`;
        clone.style.top = `${fromRect.top}px`;
        clone.style.width = `${fromRect.width}px`;
        clone.style.height = `${fromRect.height}px`;
        clone.style.background = background;
        clone.textContent = text;
        document.body.appendChild(clone);

        const pos = { x: 0, y: 0 };
        new Tween(pos, tweens)
            .to({ x: toRect.left - fromRect.left, y: toRect.top - fromRect.top }, FLY_MS)
            .easing(Easing.Quadratic.Out)
            .onUpdate(() => (clone.style.transform = `translate(${pos.x}px, ${pos.y}px)`))
            .onComplete(() => clone.remove())
            .start();
    }

    // Each hive is a fixed Slot.png socket (always visible, empty or not) with a colored fill
    // dot layered on top showing the hive's color/ammo — the socket art itself never changes.
    function makeFill(): HTMLElement {
        const fill = document.createElement('div');
        fill.className = 'hud-hive__fill';
        return fill;
    }

    function ensureLanes(count: number): void {
        if (laneEls.length > 0) return;
        for (let i = 0; i < count; i++) {
            const lane = document.createElement('div');
            lane.className = 'hud-lane';

            const activeFill = makeFill();
            const active = document.createElement('div');
            active.className = 'hud-hive hud-hive--active';
            active.appendChild(activeFill);

            // The front slot is a real button; the rest are non-interactive previews stacked
            // behind it (partially overlapped in CSS) so the player can see what's coming, not
            // just the single hive they can currently tap.
            const queueEl = document.createElement('div');
            queueEl.className = 'hud-queue';
            const queueSlots: { el: HTMLElement; fill: HTMLElement }[] = [];
            for (let q = 0; q < QUEUE_PREVIEW; q++) {
                const fill = makeFill();
                const el = q === 0 ? document.createElement('button') : document.createElement('div');
                el.className = 'hud-hive hud-hive--queued';
                el.appendChild(fill);
                if (q === 0) {
                    el.addEventListener('click', () => {
                        const background = fill.style.background;
                        if (background) {
                            flyToken(el, active, background, fill.textContent ?? '');
                            queueEl.classList.add('hud-queue--shift');
                            requestAnimationFrame(() => queueEl.classList.remove('hud-queue--shift'));
                        }
                        onActivate(i);
                    });
                } else {
                    el.classList.add('hud-hive--preview');
                }
                queueEl.appendChild(el);
                queueSlots.push({ el, fill });
            }

            const divider = document.createElement('div');
            divider.className = 'hud-divider';

            lane.append(active, divider, queueEl);
            lanesEl.appendChild(lane);
            laneEls.push({ active, activeFill, queueSlots });
        }
    }

    function renderHive(fill: HTMLElement, color: number | undefined, ammo: number | undefined): void {
        fill.classList.toggle('hud-hive__fill--empty', color === undefined);
        fill.style.background = color === undefined ? '' : hexFor(color);
        fill.textContent = ammo === undefined ? '' : String(ammo);
    }

    function refresh(state: GameState, slotForLane: (lane: number) => number | undefined): void {
        tweens.update();
        ensureLanes(state.columns.length);
        state.columns.forEach((queue, laneIndex) => {
            const els = laneEls[laneIndex]!;
            const slot = slotForLane(laneIndex);
            const active = slot !== undefined ? state.slots[slot] : null;
            renderHive(els.activeFill, active?.color, active?.ammo);

            els.queueSlots.forEach((s, q) => {
                const hive = queue[q];
                renderHive(s.fill, hive?.color, hive?.ammo);
                if (q === 0) (s.el as HTMLButtonElement).disabled = !hive;
            });
        });
    }

    function setStatus(text: string): void {
        status.textContent = text;
    }

    function getFixSlotScreenPos(lane: number): { x: number; y: number } | undefined {
        const els = laneEls[lane];
        if (!els) return undefined;
        const rect = els.active.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    function destroy(): void {
        container.innerHTML = '';
    }

    return { refresh, setStatus, getFixSlotScreenPos, destroy };
}
