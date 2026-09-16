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
npm run verify -w cocos-adapter
npm run verify -w playcanvas-adapter
```

Kiểm tra: đúng giới hạn dung lượng của từng network, có dấu `__AD_NETWORK__` và có code đọc nó, có SDK tag của network, và mọi
tham chiếu đều là `data:` inline (không còn file rời hay request ra ngoài). Thoát mã 1 nếu lỗi.
Không mở trang — phần hiển thị tự xem bằng mắt.

Network được đọc từ tên file, nếu không có thì lấy tên thư mục cha; `--net` để chỉ định thẳng.

## Tên file build

Cả hai adapter đều ghi bản đem ship thẳng vào `dist/` của mình theo dạng
`<name>-<network>-<YYYYMMDD-HHmm>.html`, ví dụ `cocos-adapter-google-20260917-0019.html`.

`<name>` lấy từ ô Name trong build panel (Cocos) hoặc `name` trong package.json (PlayCanvas) —
không dùng `web-mobile` vì đó là platform target, không phải tên game. File này đem gửi cho network
nên tên phải tự nói rõ game gì, network nào, build lúc nào. Các lần build cũng không ghi đè nhau.

Riêng mode `production` của PlayCanvas (không đem ship) vẫn giữ `dist/production/index.html`.

## Link store

`STORE_URLS` nằm duy nhất ở `packages/playable-ads-core/src/cta.ts`, dùng làm giá trị mặc định cho
`openStore()`. Hai adapter chỉ gọi `openStore()`, không giữ bản sao riêng nữa.

Sau khi sửa link, **phải build lại package** (`npm run build -w playable-ads-core`) vì adapter đọc
từ `dist/`.

## Network được hỗ trợ

Sáu network, mỗi cái một bản build riêng (danh sách nằm ở `AD_NETWORKS` trong `network.ts`). `mraid` là bản dùng chung (AppLovin, ironSource, Moloco —
những network nói MRAID thuần). Ba cái còn lại tách riêng vì **API khác nhau**, không phải vì nội
dung khác. Lệnh gọi lấy theo dấu `__AD_NETWORK__`, xử lý trong `playable-ads-core/cta.ts`.

| network | thẻ `<head>` | click | hết lượt chơi | cap |
|---|---|---|---|---|
| meta | — | `FbPlayableAd.onCTAClick()` | — | 5 MB |
| google | exitapi.js | `ExitApi.exit()` | — | 5 MB |
| mraid | mraid.js | `mraid.open(url)` | — | 5 MB |
| applovin | mraid.js | `mraid.open(url)` | — | 5 MB |
| unity | mraid.js | `mraid.open(url)` | — | 5 MB |
| mintegral | — | `install()` | `gameEnd()` | 5 MB |

Ngân sách dung lượng tính cho **một file html tự chứa**; đóng zip thì hầu hết network cho nhiều
hơn nhưng repo này không ship zip. Nguồn: <https://docs.lunalabs.io/docs/playable/ad-networks/overview>

Vượt ngân sách chỉ là **cảnh báo (`warn`), không phải lỗi** — mỗi network tự công bố con số riêng
và hay đổi, lại thêm cùng một file `mraid` đem gửi nhiều nơi khác mức (AdColony 2 MB,
TikTok/Tencent 3 MB). Chỉ build hỏng thật mới `FAIL`: thiếu dấu `__AD_NETWORK__`, thiếu SDK tag,
hoặc còn tham chiếu không phải inline. Thoát mã 1 chỉ khi có `FAIL`.

Hook build của Cocos chạy verifier sau khi ghi file và chỉ in kết quả ra log — **không bao giờ làm
hỏng bản build đã xong**.

Lưu ý khác:

- `mraid`, `applovin`, `unity` thực chất cùng là MRAID, gọi hàm y hệt nhau; tách build riêng chỉ
  để dấu `__AD_NETWORK__` ghi đúng nơi đã gửi file.
- **`meta`, `google`, `mintegral` xuất ra `.zip`**; ba cái còn lại là html rời. Meta bị siết ở bản
  html đơn (2 MB so với 5 MB khi zip) và Google yêu cầu html đã zip; Mintegral thì channel của nó
  vốn xuất ra cả thư mục (`index.html` + `js/`). Hook Cocos nén bằng công cụ sẵn có của hệ điều
  hành, `index.html` luôn nằm ở gốc archive.
- `npm run verify -w cocos-adapter` chỉ quét `dist/*.html`, nên các bản zip được kiểm ngay trong
  hook lúc build (trước khi nén), không phải bằng lệnh này.

Tham khảo: 

- https://docs.lunalabs.io/docs/playable/ad-networks/overview
## Build Cocos

Creator chỉ nạp phần main của extension **một lần lúc mở editor**, nên sửa pipeline xong mà editor
đang mở thì build vẫn chạy code cũ. Vì vậy phần đóng gói nằm ở `extensions/playable-build/pack.js`
và chạy được độc lập:

```bash
# build trong Creator (hoặc npm run build:all -w cocos-adapter), rồi:
npm run pack -w cocos-adapter
```

Lệnh này đọc `build/web-mobile`, xuất đủ sáu network vào `dist/` và tự kiểm tra luôn — không cần
khởi động lại Creator.
