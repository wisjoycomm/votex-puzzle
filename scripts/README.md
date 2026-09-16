# scripts/ — công cụ dùng chung

Dùng chung cho mọi adapter, nhận đường dẫn làm tham số. Chạy tay từ thư mục gốc repo,
kết quả được commit.

## to-webp.mjs — PNG → WebP (~90%)

```bash
node scripts/to-webp.mjs "adapters/cocos/assets/sprites/*.png" [--q 0.85]
```

Ghi `.webp` cạnh file nguồn, encode bằng Chrome/Edge có sẵn. Bọc glob trong nháy (cho PowerShell).
Không dùng cho `fonts/courier.png` (atlas MSDF, lossy phá viền chữ); `Dark BG 01.png` phải `--q 1`.
Bên Cocos nhớ gán lại sprite frame sau khi editor import.

## shrink-audio.mjs — WAV → MP3 mono (~97%)

```bash
node scripts/shrink-audio.mjs audios-src adapters/cocos/assets/audios [--kbps 96]
```

## shrink-level.mjs — level editor → level ship (762 kB → 63 kB)

```bash
npm run shrink-levels -w cocos-adapter
```

Mỗi cube thành `[x, y, z, color]`. Chạy lại an toàn; từ chối nếu có cube `Health != 1`.
⚠️ Bản Cocos sẽ ghi đè `DefaultRotation` sửa tay (`{y:180}`) về giá trị nguồn (`{x:45}`).

## verify-playable.mjs — kiểm tra build trước khi gửi

```bash
node scripts/verify-playable.mjs adapters/cocos/dist/*/index.html
```

Kiểm tra: một file tự chứa, dưới 5 MB, có dấu `__AD_NETWORK__` và có code đọc nó, có SDK tag,
không còn request ra ngoài. Thoát mã 1 nếu lỗi. Không mở trang — phần hiển thị tự xem bằng mắt.
