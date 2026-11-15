use std::path::Path;
use windows::core::Result;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

pub struct WinRtOcr {
    engine: OcrEngine,
}

impl WinRtOcr {
    pub fn new() -> Result<Self> {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        Ok(Self { engine })
    }

    /// Recognizes text from image file bytes (PNG, JPEG, BMP) using 100% native Windows WinRT OcrEngine
    pub fn recognize_bytes(&self, bytes: &[u8]) -> Result<String> {
        if bytes.is_empty() {
            return Ok(String::new());
        }

        // Write bytes into an in-memory random access stream
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        stream.Seek(0)?;

        // Decode image to SoftwareBitmap
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let software_bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

        // Perform OCR recognition
        let ocr_result = self.engine.RecognizeAsync(&software_bitmap)?.get()?;
        let recognized_text = ocr_result.Text()?.to_string();

        Ok(recognized_text)
    }

    /// Recognizes text from an image file path
    pub fn recognize_file<P: AsRef<Path>>(&self, path: P) -> Result<String> {
        let bytes = std::fs::read(path).map_err(|e| {
            windows::core::Error::new(
                windows::core::HRESULT(0x80070002_u32 as i32), // ERROR_FILE_NOT_FOUND
                format!("Failed to read image file: {}", e),
            )
        })?;
        self.recognize_bytes(&bytes)
    }
}

unsafe impl Send for WinRtOcr {}
unsafe impl Sync for WinRtOcr {}
