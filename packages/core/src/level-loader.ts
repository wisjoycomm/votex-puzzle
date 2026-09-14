import type { V3, GridSize } from "./events.ts";
import type { LevelDef } from "./game.ts";
import type { HiveDef } from "./lane.ts";

interface RawCube {
    GridPosition: V3;
    Color: number;
}

interface RawShooter {
    Color: number;
    Ammo: number;
    Line: number;
    Index: number;
}

export interface BoxyBlastLevel {
    GridSize: V3;
    Cubes: RawCube[];
    LineCount: number;
    ShooterSpawnData: RawShooter[];
}

export function parseBoxyBlastLevel(raw: BoxyBlastLevel): LevelDef {
    const size: GridSize = {
        nx: raw.GridSize.x,
        ny: raw.GridSize.y,
        nz: raw.GridSize.z,
    };

    const cells: (number | null)[] = new Array(
        size.nx * size.ny * size.nz,
    ).fill(null);
    for (const cube of raw.Cubes) {
        const { x, y, z } = cube.GridPosition;
        cells[x + y * size.nx + z * size.nx * size.ny] = cube.Color;
    }

    const rawLanes: RawShooter[][] = Array.from(
        { length: raw.LineCount },
        () => [],
    );
    for (const shooter of raw.ShooterSpawnData) {
        rawLanes[shooter.Line]?.push(shooter);
    }
    const lanes: HiveDef[][] = rawLanes.map((line) =>
        line
            .slice()
            .sort((a, b) => a.Index - b.Index)
            .map((s) => ({ color: s.Color, ammo: s.Ammo })),
    );

    return { size, cells, lanes };
}
