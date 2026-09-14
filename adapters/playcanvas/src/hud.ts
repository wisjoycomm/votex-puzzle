import type { GameState } from 'core';

import { hexFor } from './colors.ts';

export type Hud = {
    refresh(state: GameState, slotForLane: (lane: number) => number | undefined): void;
    setStatus(text: string): void;
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
                    el.addEventListener('click', () => onActivate(i));
                } else {
                    el.classList.add('hud-hive--preview');
                }
                queueEl.appendChild(el);
                queueSlots.push({ el, fill });
            }

            lane.append(active, queueEl);
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

    function destroy(): void {
        container.innerHTML = '';
    }

    return { refresh, setStatus, destroy };
}
