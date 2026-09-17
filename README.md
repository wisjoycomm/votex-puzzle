# Cấu trúc dự án

Monorepo npm workspaces —
**logic game không phụ thuộc engine** nằm ở `packages/`, **mỗi engine một adapter** ở `adapters/`.

```
votex-puzzle/
├── packages/          # thuần TS, không DOM, không import engine
│   ├── core/                  grid, lane, slot, thắng/thua
│   └── playable-ads-core/     nhận diện network, visibility, CTA
├── adapters/          # mỗi engine một renderer
│   ├── playcanvas/            adapter đang ship
│   └── cocos/                 Cocos Creator 3.8.6, đang port
└── scripts/           # pipeline asset dùng chung cho cả 2 adapter
```

## packages/core

| File | Nội dung |
| --- | --- |
| `events.ts` | `V3`, `GridSize`, `CellPath`, `GameEvent` |
| `grid.ts` | `VotexGrid` — flood reachability, `pathTo`, `findTarget` |
| `lane.ts` | `LaneQueue` (hàng chờ), `Shooter` (bắn) |
| `game.ts` | `GameCore`, `LevelDef`, `GameState` |
| `level-loader.ts` | `parseBoxyBlastLevel` |
| `index.ts` | bề mặt public |

Nguyên tắc: **core không biết gì về hiển thị và chạy đồng bộ**. `GameCore.update(dt)` đẩy sim tiến một bước
và phát event cho listener đăng ký sẵn qua `core.on(...)`. Adapter đọc `state` cho UI trạng thái ổn định,
dùng event cho các "cạnh" một frame (một phát bắn, một lần thắng).

## packages/playable-ads-core — lớp quảng cáo

Sáu network, mỗi network một build: `meta`, `google`, `mraid`, `applovin`, `unity`, `mintegral`
(danh sách trong `AD_NETWORKS` ở `network.ts`). Lời gọi click/kết thúc lượt dispatch trong `cta.ts` theo stamp.
`STORE_URLS` nằm một chỗ duy nhất ở `cta.ts` — cả hai adapter gọi `openStore()` không tham số.

## adapters/playcanvas

`main.ts` bootstrap + vòng lặp frame → `camera-rig.ts` (xoay) · `sculpture.ts` (khối cube) ·
`bee.ts` (đàn ong bay theo path) · `hud.ts` (lane, slot, layout) · `end-view`/`backdrop`/`sfx`.
Build single-file: mọi asset `import ... ?inline`, `vite-plugin-singlefile` gộp phần còn lại;

## adapters/cocos

Project Cocos Creator 3.8.6, script ở `assets/scripts/`:
`game-view` (gốc) · `hud-view` · `lane-view` · `hive-view` · `socket-view` · `top-hive-view` ·
`sculpture` · `bee` · `camera-rig` · `end-view` · `audio-manager` · `colors` · `tutorial-hand`.

Khác biệt đáng nhớ so với PlayCanvas:

- `core` / `playable-ads-core` resolve như **npm workspace dep** thường, không qua asset DB.
- Asset là **FBX**, import bởi editor → mesh lấy từ slot Inspector, không load runtime.
- Toon shading: `assets/effects/bee-master.effect` (`RAMP_TYPE=2` + `rampBands`). Giữ `USE_OUTLINE` **tắt** trên sculpture.
- Cube gộp bằng **GPU instancing** (`setMaterial`, không bao giờ `setMaterialInstance`), Cocos không có dynamic batching 3D.
- Touch delta của Cocos là y-up (DOM là y-down); `Quat.fromAxisAngle` nhận **radian**, PlayCanvas nhận **độ**.
- Đóng gói nằm ở `extensions/playable-build/pack.js`, **không** ở hook — Creator chỉ load extension một lần lúc khởi động.

## scripts/ — pipeline asset dùng chung

Nhận đường dẫn làm tham số nên phục vụ được cả hai adapter. Chạy tay, output commit vào repo.

| Script | Việc |
| --- | --- |
| `shrink-level.mjs` | JSON từ editor → level đã rút gọn |
| `to-webp.mjs` | PNG → WebP |
| `shrink-audio.mjs` | WAV master → MP3 mono |
| `verify-playable.mjs` | kiểm tra build: stamp, thẻ SDK, không còn ref ngoài |
| `zip-dir.cjs` | zip (CommonJS có chủ đích — Node 20 nhúng trong Creator không require được ESM) |

## Luồng phụ thuộc

```
core ─┬─> playcanvas adapter
      └─> cocos adapter
playable-ads-core ─┴──────┘
```

Chiều mũi tên chỉ có một hướng: adapter import core, **core không bao giờ import adapter**.

> Sau khi sửa `packages/core` phải build lại (`npm run build -w core`) — adapter resolve core qua
> workspace link tới `dist/`, thay đổi chưa build là vô hình với game.
