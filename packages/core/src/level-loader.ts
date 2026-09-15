import type { V3, GridSize } from "./events.ts";
import type { LevelDef } from "./game.ts";
import type { HiveDef } from "./lane.ts";

/**
 * A cube, in either the raw editor form or the shortened one the game ships.
 *
 * The editor writes an object per cube; at 4,003 cubes that is ~92% of the file. The shipped
 * copy rewrites each as `[x, y, z, color]`, which is the same data in about a fifth of the bytes
 * and still a plain BoxyBlastLevel — so both forms parse here and neither needs a second parser.
 */
type RawCube = { GridPosition: V3; Color: number } | [number, number, number, number];

interface RawShooter {
    Color: number;
    Ammo: number;
    Line: number;
    Index: number;
}

export interface BoxyBlastLevel {
    GridSize: V3;
    /** Euler angles the author wants the sculpture first seen at. Absent in older exports. */
    DefaultRotation?: V3;
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
        const [x, y, z, color] = Array.isArray(cube)
            ? cube
            : [cube.GridPosition.x, cube.GridPosition.y, cube.GridPosition.z, cube.Color];
        cells[x + y * size.nx + z * size.nx * size.ny] = color;
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

    return { size, cells, lanes, initialRotation: raw.DefaultRotation };
}
