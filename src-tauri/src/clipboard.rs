// Clipboard history watcher untuk DeskNotch.
//
// Poller 800ms membaca CF_UNICODETEXT dari clipboard Windows. Kalau teks
// BERBEDA dari yang terakhir dilihat dan tidak kosong, teksnya disimpan ke
// riwayat in-memory (max 30, terbaru dulu) dan di-push ke renderer lewat
// event "clipboard:new". Renderer yang mengelola persist riwayatnya.
//
// Clipboard juga bisa berisi GAMBAR (CF_DIB / CF_DIBV5). DIB dari clipboard
// dikonversi jadi file BMP (BITMAPFILEHEADER + DIB apa adanya) lalu dikirim
// ke renderer sebagai data URL "data:image/bmp;base64,...".
//
// File ini juga menyediakan copy_text() untuk menulis teks ke clipboard
// (dipakai renderer untuk "klik item riwayat = salin lagi") dan
// copy_image_bmp() untuk menulis gambar ke clipboard sebagai CF_DIB.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use base64::prelude::*;
use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows_sys::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_UNICODETEXT};

/// Batas jumlah item riwayat.
const MAX_HISTORY: usize = 30;
/// Interval poll clipboard.
const POLL_INTERVAL_MS: u64 = 800;
/// Pengaman pembacaan: berhenti scan null-terminator setelah 2 juta UTF-16 unit.
const MAX_TEXT_UNITS: usize = 2_000_000;
/// Batas ukuran DIB yang boleh dikonversi jadi BMP (8 MB). DIB yang lebih
/// besar dilewati supaya tidak membanjiri memory/IPC.
const MAX_DIB_BYTES: usize = 8 * 1024 * 1024;

pub struct ClipboardWatcher {
    running: Arc<AtomicBool>,
    /// Riwayat teks, terbaru di indeks 0.
    history: Arc<Mutex<Vec<String>>>,
}

impl ClipboardWatcher {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            history: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Snapshot riwayat (terbaru dulu) — tersedia kalau renderer/command butuh
    /// isi riwayat tanpa menunggu event.
    pub fn history(&self) -> Vec<String> {
        self.history.lock().map(|h| h.clone()).unwrap_or_default()
    }

    pub fn start(&self, app: AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let running = Arc::clone(&self.running);
        let history = Arc::clone(&self.history);

        std::thread::spawn(move || {
            eprintln!(
                "[ClipboardWatcher] Polling clipboard every {}ms",
                POLL_INTERVAL_MS
            );
            let mut last_text = String::new();
            // Fingerprint gambar terakhir (hash DIB) supaya gambar yang sama
            // tidak di-emit ulang setiap tick.
            let mut last_image_sig: Option<u64> = None;
            // Fast path: GetClipboardSequenceNumber tanpa perlu buka clipboard,
            // jadi kita tidak mengunci clipboard global tiap 800ms kalau tidak
            // ada yang berubah.
            let mut last_seq: u32 = 0;

            while running.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));

                let seq = unsafe { GetClipboardSequenceNumber() };
                if seq == last_seq {
                    continue;
                }
                last_seq = seq;

                let text = read_clipboard_text().unwrap_or_default();
                let image = read_clipboard_image();

                if text.is_empty() && image.is_none() {
                    continue;
                }

                let text_changed = !text.is_empty() && text != last_text;
                let image_changed = match (&image, last_image_sig) {
                    (Some((sig, _)), Some(prev)) => *sig != prev,
                    (Some(_), None) => true,
                    _ => false,
                };

                if !text_changed && !image_changed {
                    continue;
                }

                if text_changed {
                    last_text = text.clone();
                }
                if let Some((sig, _)) = &image {
                    last_image_sig = Some(*sig);
                }

                // Simpan ke riwayat, terbaru di depan, cap MAX_HISTORY.
                // Riwayat hanya berisi teks; gambar ikut terkirim lewat event.
                if text_changed {
                    if let Ok(mut h) = history.lock() {
                        h.insert(0, text.clone());
                        h.truncate(MAX_HISTORY);
                    }
                }

                let at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                // Teks lebih berguna daripada gambar, jadi kind = "text" kalau
                // teksnya ada. Gambar tetap ikut terkirim kalau clipboard punya
                // keduanya.
                let kind = if text.is_empty() { "image" } else { "text" };
                let image_data = image.map(|(_, data_url)| data_url).unwrap_or_default();

                eprintln!(
                    "[ClipboardWatcher] Emitting clipboard:new (kind={}, text={} chars, image={} bytes)",
                    kind,
                    text.len(),
                    image_data.len()
                );
                let _ = app.emit(
                    "clipboard:new",
                    serde_json::json!({
                        "text": text,
                        "image": image_data,
                        "kind": kind,
                        "at": at,
                    }),
                );
            }
        });
    }
}

/// Baca CF_UNICODETEXT dari clipboard, kalau ada. Selalu CloseClipboard.
fn read_clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }

        let result = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT as u32);
            if handle.is_null() {
                return None;
            }
            let ptr = GlobalLock(handle as HGLOBAL);
            if ptr.is_null() {
                return None;
            }

            let wide = ptr as *const u16;
            let mut len = 0usize;
            while len < MAX_TEXT_UNITS && *wide.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(wide, len));

            GlobalUnlock(handle as HGLOBAL);
            Some(text)
        })();

        CloseClipboard();
        result
    }
}

/// Baca DIB dari clipboard (CF_DIB, fallback CF_DIBV5).
///
/// Mengembalikan byte DIB mentah (tanpa header file BMP). DIB yang lebih
/// besar dari MAX_DIB_BYTES dilewati (None).
fn read_clipboard_dib() -> Option<Vec<u8>> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }

        let result = (|| {
            let mut handle = GetClipboardData(CF_DIB as u32);
            if handle.is_null() {
                handle = GetClipboardData(CF_DIBV5 as u32);
            }
            if handle.is_null() {
                return None;
            }

            let size = GlobalSize(handle as HGLOBAL);
            if size == 0 || size > MAX_DIB_BYTES {
                return None;
            }

            let ptr = GlobalLock(handle as HGLOBAL);
            if ptr.is_null() {
                return None;
            }
            let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
            GlobalUnlock(handle as HGLOBAL);
            Some(data)
        })();

        CloseClipboard();
        result
    }
}

/// Baca gambar dari clipboard dan ubah jadi data URL BMP.
///
/// Balikin (fingerprint, data_url). Fingerprint dipakai watcher supaya
/// gambar yang sama tidak di-emit berulang.
fn read_clipboard_image() -> Option<(u64, String)> {
    let dib = read_clipboard_dib()?;
    let sig = fnv1a64(&dib);
    let bmp = dib_to_bmp(&dib);
    let data_url = format!(
        "data:image/bmp;base64,{}",
        BASE64_STANDARD.encode(&bmp)
    );
    Some((sig, data_url))
}

/// Gabung DIB mentah dengan header file BMP (BITMAPFILEHEADER 14 byte).
///
/// Offset pixel data dihitung dari DIB header: untuk BITMAPINFOHEADER
/// (40 byte) tanpa BI_BITFIELDS offsetnya 54 (14 + 40). Kalau DIB pakai
/// BI_BITFIELDS, mask warna mengikuti header sehingga offsetnya 66, dan
/// untuk DIB palet (bit count <= 8) tabel warna ikut dihitung.
fn dib_to_bmp(dib: &[u8]) -> Vec<u8> {
    let offset = bmp_pixel_offset(dib);
    let file_size = (14 + dib.len()) as u32;

    let mut out = Vec::with_capacity(14 + dib.len());
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved
    out.extend_from_slice(&offset.to_le_bytes());
    out.extend_from_slice(dib);
    out
}

/// Offset pixel data di dalam file BMP hasil konversi DIB.
fn bmp_pixel_offset(dib: &[u8]) -> u32 {
    const BI_BITFIELDS: u32 = 3;

    if dib.len() < 12 {
        return 54;
    }

    let header_size = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]);

    // BITMAPCOREHEADER (12 byte): tidak ada color table di spec-nya.
    if header_size == 12 {
        return 14 + 12;
    }

    if header_size < 40 || dib.len() < 40 {
        return 54;
    }

    let bit_count = u16::from_le_bytes([dib[14], dib[15]]) as u32;
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    let clr_used = u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]);

    let mut offset = 14 + header_size;
    // BI_BITFIELDS dengan BITMAPINFOHEADER: 3x mask RGB (12 byte) ditulis
    // setelah header.
    if compression == BI_BITFIELDS && header_size == 40 {
        offset += 12;
    }
    // DIB palet: entri warna 4 byte per warna.
    if bit_count > 0 && bit_count <= 8 {
        let entries = if clr_used == 0 { 1u32 << bit_count } else { clr_used };
        offset += entries * 4;
    }

    offset
}

/// Hash FNV-1a 64-bit, dipakai sebagai fingerprint gambar.
fn fnv1a64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

/// Set clipboard ke `text` (CF_UNICODETEXT). true kalau berhasil.
pub fn copy_text(text: &str) -> bool {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }

        // EmptyClipboard + SetClipboardData harus di antara Open/CloseClipboard.
        // SetClipboardData mengambil kepemilikan alokasi saat berhasil, jadi
        // GlobalFree hanya dipanggil kalau gagal.
        let ok = (|| -> bool {
            if EmptyClipboard() == 0 {
                return false;
            }

            let mut utf16: Vec<u16> = text.encode_utf16().collect();
            utf16.push(0); // null terminator

            let byte_len = utf16.len() * 2;
            let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
            if hmem.is_null() {
                return false;
            }

            let dst = GlobalLock(hmem);
            if dst.is_null() {
                GlobalFree(hmem);
                return false;
            }
            std::ptr::copy_nonoverlapping(utf16.as_ptr() as *const u8, dst as *mut u8, byte_len);
            GlobalUnlock(hmem);

            if SetClipboardData(CF_UNICODETEXT as u32, hmem as HANDLE) == std::ptr::null_mut() {
                GlobalFree(hmem);
                return false;
            }
            true
        })();

        CloseClipboard();
        ok
    }
}

/// Set clipboard sebagai gambar (CF_DIB) supaya aplikasi lain bisa paste
/// gambar.
///
/// `bmp_bytes` boleh berupa file BMP lengkap (header "BM" + DIB) atau DIB
/// saja. Clipboard DIB hanya menerima bagian DIB, jadi header file BMP
/// dilepas kalau ada. true kalau berhasil.
pub fn copy_image_bmp(bmp_bytes: &[u8]) -> bool {
    let dib: &[u8] = if bmp_bytes.len() > 14 && &bmp_bytes[0..2] == b"BM" {
        &bmp_bytes[14..]
    } else {
        bmp_bytes
    };

    if dib.is_empty() {
        return false;
    }

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }

        let ok = (|| -> bool {
            if EmptyClipboard() == 0 {
                return false;
            }

            let hmem = GlobalAlloc(GMEM_MOVEABLE, dib.len());
            if hmem.is_null() {
                return false;
            }

            let dst = GlobalLock(hmem);
            if dst.is_null() {
                GlobalFree(hmem);
                return false;
            }
            std::ptr::copy_nonoverlapping(dib.as_ptr(), dst as *mut u8, dib.len());
            GlobalUnlock(hmem);

            if SetClipboardData(CF_DIB as u32, hmem as HANDLE) == std::ptr::null_mut() {
                GlobalFree(hmem);
                return false;
            }
            true
        })();

        CloseClipboard();
        ok
    }
}

/// Ubah data URL "data:image/bmp;base64,..." menjadi bytes DIB (tanpa header
/// file BMP 14 byte) supaya bisa ditulis balik ke clipboard sebagai CF_DIB.
pub fn data_url_to_dib(data_url: &str) -> Option<Vec<u8>> {
    use base64::prelude::*;
    let b64 = data_url.split_once("base64,")?.1;
    let raw = BASE64_STANDARD.decode(b64.trim()).ok()?;
    if raw.len() < 18 {
        return None;
    }
    // Header BMP file: "BM" + 14 byte. Setelah itu header DIB + data piksel.
    Some(raw[14..].to_vec())
}
