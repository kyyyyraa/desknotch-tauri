# DeskNotch 1.0.5 — build resmi (pinned)

Aplikasi ini adalah **DeskNotch Tauri v2** (Rust + WebView2). Build Chromium (Electron)
dari repo ini **sudah dihapus** — semua build, patch, dan rilis berasal dari folder ini.

## Artefak terpin

| File | Keterangan |
|---|---|
| `desknotch.exe` | binary aktif (salinan dari `src-tauri/target/release/desknotch.exe`) |
| `release/desknotch-1.0.5.exe` | binary terpin versi 1.0.5 |
| `release/SHA256SUMS.txt` | SHA-256 + MD5 binary terpin |

Versi: **1.0.5** (`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`).

## Runtime yang wajib ada di folder ini

| Folder | Isi | Ukuran |
|---|---|---|
| `desknotch-models/ggml-small.bin` | model Whisper native (whisper.cpp GGML) | 466 MB |
| `whisper-cuda/` | CLI whisper.cpp CUDA 12.4 + runtime DLL (transkripsi di RTX 3050) | ~700 MB |
| `ui/dn-models/whisper-small/` | model ONNX — **fallback** kalau native gagal | 249 MB |

## Build ulang

```sh
cd src-tauri
cargo build --release          # butuh ~20 menit, RAM dijepit jobs = 2
cd ..
cp src-tauri/target/release/desknotch.exe ./desknotch.exe
node tools/verify-build-freshness.js desknotch.exe ui   # WAJIB: harus print FRESH
```

- `.cargo/config.toml` mengunci `jobs = 2` supaya `rustc` tidak naik ke RAM 99%.
- Setelah `target/debug` dihapus, **jangan** `cargo check` (mau compile ulang ~600 crate
  debug); langsung `cargo build --release`.
- `node --check` WAJIB setelah setiap edit file JS (`ui/dn-*.js` dan chunk minified
  `ui/_next/static/chunks/02jdcovrpfbyy.js`).

## Fitur yang aktif di 1.0.5

- Notch: pill 240×30 di Y=0, click-through Win32 (`WS_EX_TRANSPARENT`, poll 80 ms),
  Z-order di atas MyDockFinder, sembunyi di fullscreen, tuck saat browser depan.
- Voice: hotkey Ctrl+Alt+V (perintah), Ctrl+Alt+D (dikte), Esc (stop), **Alt+C (buka chat)**.
  Transkripsi lewat whisper.cpp CUDA (GPU), fallback ONNX WASM kalau native gagal.
  TTS WinRT Microsoft Andika (id-ID).
- Conversation 560×340 px; jawaban LaTeX dirapikan jadi teks terbaca (`dnDeMath`).
- AI assistant: kartu izin (Tolak/Izinkan) untuk setiap rencana aksi; pipeline `askAction`
  -> `dnai:request-approval` -> `runPlan`.
- Notifikasi: hanya yang masuk **selagi** DeskNotch menyala (riwayat lama tidak diulang).
- Privacy dots: sensor native ConsentStore (mic/kamera) + daftar app terakhir.
- YouTube/tab: memakai tab browser yang sudah ada, bukan membuka tab baru.

## Log

`%APPDATA%\DeskNotch\dnptt.log` — rantai hotkey + sesi voice (pakai saat debug).
