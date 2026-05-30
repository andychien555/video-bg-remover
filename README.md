# 影片去背 · 動態 WebP（Video Background Remover）

純瀏覽器、零後端的影片去背工具。上傳影片 → 逐幀去背 → **一鍵輸出透明背景的動態 WebP**。也能匯出透明背景 WebM 或 PNG 序列。

全部運算都在你的瀏覽器本機完成，影片**不會上傳到任何伺服器**，可直接部署到 GitHub Pages 等靜態空間。

> 逐幀精確處理 · 30fps · 瀏覽器內合成動態 WebP

## ✨ 功能

- **兩種去背模式**
  - **亮度鍵（Luma Key）**：適合純黑底或純白底，依亮度判斷背景。
  - **色度鍵（Chroma Key）**：適合綠幕／藍幕，可自訂背景色或從畫面取色。
- **逐幀精確去背**：依 30fps 逐幀 seek，避免漏幀，左右雙畫面即時預覽。
- **結果播放器**：處理完成後可播放、拖曳時間軸逐幀檢視。
- **動態 WebP 輸出（重點）**：在瀏覽器內用 **libwebp（WebAssembly）** 合成帶 alpha 的動態 WebP，完成後自動下載 `anim.webp`。
- **即時檔案大小預估**：調 quality / scale / skip 時，背景抽樣編碼幾張代表幀外插總大小，不用跑完整段就知道大概多大（因為 muxer 不做幀間差分，總大小 ≈ 每幀大小 × 幀數，外插很準）。
- **透明背景 WebM**：用 `MediaRecorder` 以精確 30fps 輸出（VP9，含 alpha）。
- **PNG 序列**：匯出 ZIP，並附上離線 `img2webp` 指令。
- **可調參數**：閾值／相似度、柔邊、邊緣內縮、溢色補償、亮度補償。

## 🧩 為什麼這裡的動態 WebP 透明背景是可靠的？

直接用 `ffmpeg` 轉動態 WebP 時，alpha（透明）常常出包。本工具改用 Google 官方 **libwebp** 編碼器（編譯成 WebAssembly，即 [`@jsquash/webp`](https://github.com/jamsinclair/jSquash)）——這跟命令列工具 `img2webp` 是**同一個編碼引擎**，所以透明背景可靠。

流程跟 `img2webp` 內部完全一致：

1. 每一幀用 libwebp 編碼成帶 alpha 的靜態 WebP
2. 再把這些幀 mux 成一個動態 WebP 容器（`VP8X` + `ANIM` + `ANMF` chunks）

第 2 步的 muxer 由本專案實作（`js/webp-anim.js`），依照 [WebP 容器規格](https://developers.google.com/speed/webp/docs/riff_container)，無額外第三方相依。

## 🚀 本機執行

因為使用 ES Modules 與 WebAssembly，**不能直接用 `file://` 開啟**，需要一個本機 HTTP 伺服器：

```bash
# 方法一：Python（多數 macOS / Linux 內建）
python3 -m http.server 8000

# 方法二：Node
npx serve .
```

然後開啟 <http://localhost:8000/>。

### 操作流程

1. 拖曳或點擊上傳影片（MP4 / WebM / MOV）。
2. 選擇模式：**亮度鍵**（黑/白底）或**色度鍵**（綠/藍幕）。
3. 色度鍵可選預設色、自訂顏色，或按「從畫面取色」點左側畫面取背景色。
4. 微調參數，右側即時預覽去背效果。
5. 輸出：
   - ⭐ 點「**轉成動態 WebP**」→ 處理完成自動下載 `anim.webp`。
   - 或「**處理並匯出 .webm**」→「下載 removed-bg.webm」。
   - 或「**匯出 PNG 序列 (ZIP)**」→「下載 frames.zip」（離線用 `img2webp` 合成）。

## 🌐 部署到 GitHub Pages

這是純靜態網站，部署很簡單：

1. 把整個專案 push 到一個 GitHub repo。
2. 到 repo 的 **Settings → Pages**。
3. **Source** 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/ (root)`，按 **Save**。
4. 等一兩分鐘，網址會是 `https://<你的帳號>.github.io/<repo 名稱>/`。

> 已內含 `.nojekyll`，避免 GitHub 的 Jekyll 處理動到 `vendor/` 內的檔案。

## 📋 參數說明

| 參數 | 說明 |
| --- | --- |
| 黑色閾值 / 相似度（Threshold / Similarity） | 低於此值（或與背景色越接近）視為背景。 |
| 柔邊（Feather） | 邊緣漸變範圍，避免鋸齒。 |
| 邊緣內縮（Shrink） | 向內侵蝕 alpha，消除黑邊／殘留邊框，推薦 1–3 px。 |
| 溢色補償（Spill，僅色度鍵） | 去除主體邊緣殘留的背景色（綠/藍溢色）。 |
| 亮度補償（Boost） | 提亮主體邊緣過渡色。 |

WebP / PNG 序列共用：**縮放**、**每幀間隔（抽幀）**、**WebP 品質**等選項。

## 📁 專案結構

```
.
├── index.html              # 介面
├── css/styles.css          # 樣式
├── js/
│   ├── app.js              # DOM 串接、狀態、影格擷取、三種匯出流程
│   ├── keying.js           # 純去背運算（亮度／色度鍵、alpha 侵蝕、溢色）
│   └── webp-anim.js        # 動態 WebP：libwebp 編碼 + 自製 muxer
├── vendor/                 # 鎖版本、內建的第三方相依（無 CDN 執行期相依）
│   ├── jsquash/            # @jsquash/webp 1.5.0（libwebp WASM 編碼器）
│   ├── wasm-feature-detect.js  # 1.8.0
│   └── jszip.min.js        # 3.10.1（PNG 序列打包用）
├── test/muxer-test.html    # 動態 WebP muxer 的瀏覽器自我測試
└── .nojekyll
```

## 🔒 相依套件與供應鏈

所有第三方相依都**鎖定精確版本並 vendored 進 repo**（`vendor/`），執行期不依賴任何 CDN，方便離線使用與稽核：

| 套件 | 版本 | 用途 | 授權 |
|------|------|------|------|
| [@jsquash/webp](https://github.com/jamsinclair/jSquash) | 1.5.0 | libwebp WASM 編碼器 | Apache-2.0 |
| [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) | 1.8.0 | 偵測 WASM SIMD | Apache-2.0 |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | PNG 序列打包 ZIP | MIT / GPLv3 |

`@jsquash/webp` 內含 Google libwebp（BSD-3-Clause）編譯出的 WASM。

## 🧪 測試

開啟 <http://localhost:8000/test/muxer-test.html>，會用合成的透明影格跑一遍編碼 + mux，驗證輸出是合法的動態 WebP 並由瀏覽器原生解碼。

## 🖥️ 瀏覽器需求

建議使用最新版 **Chrome / Edge**。動態 WebP 與 PNG 序列在各瀏覽器相容性最佳；含透明通道的 WebM 在不同播放器相容性不一，若要透明度最穩，優先用 **動態 WebP**。

## 📄 授權

本專案程式碼以 MIT 授權釋出，見 [LICENSE](./LICENSE)。第三方相依各自的授權見上表。
