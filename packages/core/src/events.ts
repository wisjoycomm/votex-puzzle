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
          at: number;
      }
    | {
          t: "laneDepleted";
          slot: number;
          at: number;
      }
    | { t: "gameWon"; at: number }
    | { t: "gameLost"; at: number };