#[allow(unused_imports)]
use crate::*;
use std::collections::HashMap;
use vello::peniko::{Blob, ImageAlphaType, ImageBrush, ImageData, ImageFormat};

// ------------------------------------------------------------- image assets

/// Phase 4.2: decoded image assets, keyed by the asset name that
/// `NodeKind::Image` references. Load PNGs once, render everywhere.
#[derive(Default, Clone)]
pub struct Assets {
    images: HashMap<String, ImageBrush>,
    failed: std::collections::HashSet<String>,
}
impl Assets {
    pub fn new() -> Self {
        Self::default()
    }
    /// Decode a PNG (any bit depth/color type png-crate supports -> RGBA8).
    pub fn load_png(&mut self, name: &str, path: &str) -> Result<(), String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        self.load_png_bytes(name, &bytes)
    }

    /// Same decode from in-memory bytes (the AssetStore sync path).
    pub fn load_png_bytes(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
        let info = reader.info();
        let pixels = u64::from(info.width) * u64::from(info.height);
        let output = reader.output_buffer_size().ok_or("bad png size")?;
        if self.decoded_bytes().saturating_add(pixels * 4) > 128 * 1024 * 1024
            || pixels > 16_777_216
            || output > 64 * 1024 * 1024
        {
            return Err("image exceeds 16 megapixel / 64 MiB budget".into());
        }
        let mut buf = vec![0u8; output];
        let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
        let (w, h) = (info.width, info.height);
        let rgba: Vec<u8> = match info.color_type {
            png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
            png::ColorType::Rgb => buf[..info.buffer_size()]
                .as_chunks::<3>()
                .0
                .iter()
                .flat_map(|p| [p[0], p[1], p[2], 255])
                .collect(),
            png::ColorType::Grayscale => buf[..info.buffer_size()]
                .iter()
                .flat_map(|&g| [g, g, g, 255])
                .collect(),
            png::ColorType::GrayscaleAlpha => buf[..info.buffer_size()]
                .as_chunks::<2>()
                .0
                .iter()
                .flat_map(|p| [p[0], p[0], p[0], p[1]])
                .collect(),
            other => return Err(format!("unsupported color type {other:?}")),
        };
        self.images.insert(
            name.into(),
            ImageBrush {
                image: ImageData {
                    data: Blob::from(rgba),
                    format: ImageFormat::Rgba8,
                    alpha_type: ImageAlphaType::Alpha,
                    width: w,
                    height: h,
                },
                sampler: Default::default(),
            },
        );
        Ok(())
    }
    pub fn load_image_bytes(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.starts_with(b"\x89PNG") {
            return self.load_png_bytes(name, bytes);
        }
        let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
        if self
            .decoded_bytes()
            .saturating_add(u64::from(w) * u64::from(h) * 4)
            > 128 * 1024 * 1024
            || u64::from(w) * u64::from(h) > 16_777_216
        {
            return Err("image exceeds 16 megapixel budget".into());
        }
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let rgba = reader
            .decode()
            .map_err(|e| e.to_string())?
            .into_rgba8()
            .into_raw();
        self.images.insert(
            name.into(),
            ImageBrush {
                image: ImageData {
                    data: Blob::from(rgba),
                    format: ImageFormat::Rgba8,
                    alpha_type: ImageAlphaType::Alpha,
                    width: w,
                    height: h,
                },
                sampler: Default::default(),
            },
        );
        Ok(())
    }

    /// Idempotent decode of embedded PNG/JPEG assets, shared by every sink.
    pub fn sync_store(&mut self, store: &x_core::AssetStore) -> usize {
        self.sync_store_cancellable(store, &|| false)
            .expect("uncancellable sync")
    }

    pub fn sync_store_cancellable(
        &mut self,
        store: &x_core::AssetStore,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<usize, String> {
        let mut added = 0;
        for rec in store.iter_sorted() {
            if cancelled() {
                return Err("operation cancelled".into());
            }
            if self.images.contains_key(&rec.id)
                || self.failed.contains(&rec.id)
                || !matches!(rec.mime.as_str(), "image/png" | "image/jpeg")
            {
                continue;
            }
            if self.load_image_bytes(&rec.id, &rec.bytes).is_ok() {
                added += 1;
            } else {
                self.failed.insert(rec.id.clone());
            }
        }
        if cancelled() {
            return Err("operation cancelled".into());
        }
        Ok(added)
    }

    /// Direct insertion for trusted procedural images.
    pub fn insert_raw(&mut self, name: &str, image: ImageBrush) {
        self.images.insert(name.into(), image);
    }
    pub fn memory_bytes(&self) -> usize {
        self.decoded_bytes().min(usize::MAX as u64) as usize
    }
    pub fn evict_except(&mut self, keep: &std::collections::HashSet<String>) -> usize {
        let before = self.memory_bytes();
        self.images
            .retain(|k, _| keep.contains(k) || !k.starts_with("asset://"));
        self.failed.retain(|k| keep.contains(k));
        before.saturating_sub(self.memory_bytes())
    }
    fn decoded_bytes(&self) -> u64 {
        self.images
            .values()
            .map(|i| {
                u64::from(i.image.width)
                    .saturating_mul(u64::from(i.image.height))
                    .saturating_mul(4)
            })
            .fold(0, u64::saturating_add)
    }

    pub fn get(&self, name: &str) -> Option<&ImageBrush> {
        self.images.get(name)
    }

    /// Return an adjusted copy for a render command without mutating the
    /// content-addressed source asset. Image adjustments are document state,
    /// not cache state, so the original bytes remain reusable by other nodes.
    pub fn get_adjusted(
        &self,
        name: &str,
        adjustments: x_core::ImageAdjustments,
    ) -> Option<ImageBrush> {
        let source = self.images.get(name)?;
        let adjustments = ImageAdjustments {
            exposure: adjustments.exposure,
            contrast: adjustments.contrast,
            saturation: adjustments.saturation,
            temperature: adjustments.temperature,
            tint: adjustments.tint,
            highlights: adjustments.highlights,
            shadows: adjustments.shadows,
        };
        if !adjustments.has_adjustments() {
            return Some(source.clone());
        }
        let bytes = source.image.data.data();
        let mut adjusted = Vec::with_capacity(bytes.len());
        for pixel in bytes.chunks_exact(4) {
            let color = Color::from_rgba8(pixel[0], pixel[1], pixel[2], pixel[3]);
            let rgba = adjustments.apply_to_color(color).to_rgba8();
            adjusted.extend_from_slice(&[rgba.r, rgba.g, rgba.b, rgba.a]);
        }
        Some(ImageBrush {
            image: ImageData {
                data: Blob::from(adjusted),
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                width: source.image.width,
                height: source.image.height,
            },
            sampler: source.sampler.clone(),
        })
    }
    /// Sorted asset names (image replace UI / pickers).
    pub fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.images.keys().cloned().collect();
        v.sort();
        v
    }
    pub fn len(&self) -> usize {
        self.images.len()
    }
    pub fn is_empty(&self) -> bool {
        self.images.is_empty()
    }
}
