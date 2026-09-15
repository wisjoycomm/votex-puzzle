export interface V3 {
    x: number;
    y: number;
    z: number;
}

export interface GridSize {
    nx: number;
    ny: number;
    nz: number;
}

/** A collision-free route from outside the sculpture to one face of a cube. */
export interface CellPath {
    /** Corners only, in grid coordinates: first is the point just outside the grid, last is the
     *  empty cell adjacent to the cube. Collinear runs are collapsed, and the bend limit caps
     *  this at 4 points. A cube sitting on the boundary yields a single point. */
    points: V3[];
    /** Outward unit normal of the face the bee arrives at. */
    face: V3;
}

export type GameEvent =
    | {
          t: "hiveActivated";
          slot: number;
          color: number;
          ammo: number;
          at: number;
      }
    | {
          t: "cubeShot";
          slot: number;
          cell: V3;
          color: number;
          ammoRemaining: number;
          /** How a bee could physically reach this cube, captured before it was removed.
           *  Presentation only — the simulation doesn't care that anything flies. */
          path: CellPath | null;
          at: number;
      }
    | {
          t: "laneDepleted";
          slot: number;
          at: number;
      }
    | { t: "gameWon"; at: number }
    | { t: "gameLost"; at: number };