import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    GameCore,
    parseBoxyBlastLevel,
    type LevelDef,
    type BoxyBlastLevel,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const teddyBurgundy: BoxyBlastLevel = JSON.parse(
    readFileSync(join(here, "../src/teddy_burgundy.json"), "utf8"),
);

function smallSolidCube(lanes: { color: number; ammo: number }[][] = [[{ color: 1, ammo: 8 }]]): LevelDef {
    const size = { nx: 2, ny: 2, nz: 2 };
    const cells = new Array(8).fill(1);
    return { size, cells, lanes };
}

test("clears a small solid cube and reaches won", () => {
    const core = new GameCore(smallSolidCube(), 1);
    let shots = 0;
    core.on("cubeShot", () => shots++);
    core.activateColumn(0);

    let state = core.getState();
    for (let i = 0; i < 1000 && state.status === "playing"; i++) {
        state = core.update(0.35).state;
    }

    assert.equal(state.status, "won");
    assert.equal(shots, 8);
});

test("activateColumn front click fills an empty slot and empties the column", () => {
    const core = new GameCore(smallSolidCube(), 1);
    let activations = 0;
    core.on("hiveActivated", () => activations++);

    assert.equal(core.activateColumn(0), 0);
    assert.equal(core.activateColumn(0), null); // column is now empty, no-op
    core.update(0);

    assert.equal(activations, 1);
    assert.equal(core.getState().columns[0].length, 0);
    assert.equal(core.getState().slots[0]?.color, 1);
});

test("non-front click without booster is a no-op", () => {
    const core = new GameCore(
        smallSolidCube([[{ color: 1, ammo: 1 }, { color: 2, ammo: 1 }]]),
        1,
    );

    assert.equal(core.activateColumn(0, 1), null); // index 1, no booster
    const state = core.getState();

    assert.equal(state.slots.every((s) => s === null), true);
    assert.equal(state.columns[0].length, 2);
});

test("booster allows a non-front click and closes the gap in the column", () => {
    const core = new GameCore(
        smallSolidCube([[{ color: 1, ammo: 1 }, { color: 2, ammo: 1 }]]),
        1,
    );

    core.activateColumn(0, 1, { booster: true });
    const state = core.getState();

    assert.equal(state.slots[0]?.color, 2);
    assert.equal(state.columns[0].length, 1);
    assert.equal(state.columns[0][0].color, 1);
});

test("activateColumn is a no-op when all slots are full", () => {
    const core = new GameCore(
        {
            size: { nx: 2, ny: 2, nz: 2 },
            cells: new Array(8).fill(1),
            lanes: [
                [{ color: 1, ammo: 1 }],
                [{ color: 1, ammo: 1 }],
                [{ color: 1, ammo: 1 }],
                [{ color: 1, ammo: 1 }],
                [{ color: 1, ammo: 1 }],
                [{ color: 1, ammo: 1 }],
            ],
        },
        1,
    );

    for (let i = 0; i < 5; i++) assert.equal(core.activateColumn(i), i);
    assert.equal(core.activateColumn(5), null); // 6th column, no free slot left

    const state = core.getState();
    assert.equal(state.slots.every((s) => s !== null), true);
    assert.equal(state.columns[5].length, 1);
});

test("a queued hive never shoots; only a slotted one does", () => {
    const core = new GameCore(
        smallSolidCube([[{ color: 1, ammo: 8 }], [{ color: 1, ammo: 8 }]]),
        1,
    );
    let shots = 0;
    core.on("cubeShot", () => shots++);

    // column 1 is never activated
    core.activateColumn(0);
    for (let i = 0; i < 1000 && core.getState().status === "playing"; i++) {
        core.update(0.35);
    }

    assert.equal(core.getState().columns[1].length, 1);
    assert.equal(shots, 8);
});

test("slot frees up and becomes activatable again once its hive is exhausted", () => {
    const core = new GameCore(
        smallSolidCube([[{ color: 1, ammo: 1 }], [{ color: 1, ammo: 1 }]]),
        1,
    );

    core.activateColumn(0);
    for (let i = 0; i < 5; i++) core.update(0.35); // exhausts slot 0's single ammo

    assert.equal(core.getState().slots[0], null);

    core.activateColumn(1);
    assert.equal(core.getState().slots[0]?.color, 1);
    assert.equal(core.getState().columns[1].length, 0);
});

test("one column can hold several slots at once, taking the lowest free one each time", () => {
    const core = new GameCore(
        smallSolidCube([
            [
                { color: 1, ammo: 1 },
                { color: 2, ammo: 1 },
                { color: 3, ammo: 1 },
            ],
        ]),
        1,
    );

    assert.equal(core.activateColumn(0), 0);
    assert.equal(core.activateColumn(0), 1); // free slots exist, so it doesn't wait on slot 0
    assert.equal(core.activateColumn(0), 2);

    const state = core.getState();
    assert.equal(state.slots.filter((s) => s !== null).length, 3);
    assert.deepEqual(
        state.slots.map((s) => s?.color ?? null),
        [1, 2, 3, null, null],
    );
    assert.equal(state.columns[0].length, 0);
});

test("a freed slot is reused before higher ones", () => {
    const core = new GameCore(
        smallSolidCube([
            [{ color: 1, ammo: 1 }, { color: 2, ammo: 1 }],
            [{ color: 3, ammo: 9 }],
        ]),
        1,
    );

    assert.equal(core.activateColumn(0), 0);
    assert.equal(core.activateColumn(1), 1);

    for (let i = 0; i < 5; i++) core.update(0.35); // exhausts the 1-ammo hive in slot 0
    assert.equal(core.getState().slots[0], null);

    assert.equal(core.activateColumn(0), 0); // slot 0 is free again and slot 1 is still busy
});

test("teddy_burgundy.json parses into lanes matching the raw shooter data", () => {
    const level = parseBoxyBlastLevel(teddyBurgundy);

    assert.equal(level.size.nx, teddyBurgundy.GridSize.x);
    assert.equal(level.size.ny, teddyBurgundy.GridSize.y);
    assert.equal(level.size.nz, teddyBurgundy.GridSize.z);
    assert.equal(
        level.cells.length,
        level.size.nx * level.size.ny * level.size.nz,
    );
    assert.equal(
        level.cells.filter((c) => c !== null).length,
        teddyBurgundy.Cubes.length,
    );
    assert.equal(level.lanes.length, teddyBurgundy.LineCount);

    const expected: { color: number; ammo: number; index: number }[][] =
        Array.from({ length: teddyBurgundy.LineCount }, () => []);
    for (const s of teddyBurgundy.ShooterSpawnData) {
        expected[s.Line]?.push({ color: s.Color, ammo: s.Ammo, index: s.Index });
    }
    expected.forEach((lane) => lane.sort((a, b) => a.index - b.index));

    level.lanes.forEach((lane, i) => {
        assert.deepEqual(
            lane,
            expected[i]!.map(({ color, ammo }) => ({ color, ammo })),
        );
    });
});

test("GameCore boots teddy_burgundy.json and fires from column 0 without throwing", () => {
    const level = parseBoxyBlastLevel(teddyBurgundy);
    const core = new GameCore(level, 1);

    core.activateColumn(0);
    const front = teddyBurgundy.ShooterSpawnData
        .filter((s) => s.Line === 0)
        .sort((a, b) => a.Index - b.Index)[0]!;
    assert.deepEqual(core.getState().slots[0], {
        color: front.Color,
        ammo: front.Ammo,
    });

    for (let i = 0; i < 3; i++) core.update(0.35);

    assert.equal(core.getState().status, "playing");
});
