//! GFS forecast fields from NOAA's NODD bucket (public S3, no auth), decoded
//! from GRIB2 and sampled at points. This trades Open-Meteo's per-point metering
//! for free grid-bulk: one ~0.9 MB field covers the whole 0.25° planet
//! (721×1440 = 1.04M points), so any number of cities sample for free.

use std::io::Cursor;

use anyhow::{bail, ensure, Context, Result};
use grib::{from_reader, Grib2SubmessageDecoder};

const NODD: &str = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
// GFS pgrb2.0p25: 0.25° global grid, scanning +i (W→E) / −j (N→S) from (90N, 0E).
const NI: usize = 1440;
const NJ: usize = 721;
const NPTS: usize = NI * NJ;

/// Equirectangular wind-texture dimensions (the native 0.25° grid).
pub const TEX_WIDTH: u32 = NI as u32;
pub const TEX_HEIGHT: u32 = NJ as u32;
/// Surface-wind normalization half-range (m/s): u and v map linearly from
/// [−WIND_MS_MAX, WIND_MS_MAX] onto a byte, and the web denormalizes with the
/// same bounds (carried in windtex/latest.json). 40 m/s (~90 mph) covers all
/// but the most extreme 10 m winds, which clamp.
pub const WIND_MS_MAX: f32 = 40.0;

/// Composite-reflectivity (REFC) normalization range (dBZ): the grayscale precip
/// texture maps [`REFC_DBZ_MIN`, `REFC_DBZ_MAX`] linearly onto a byte, and the web
/// denormalizes with the same bounds (carried in refctex/latest.json). GFS packs
/// no-echo at a ~−20 dBZ floor (→ byte 0, which the web renders transparent);
/// 75 dBZ caps the most extreme convective cells, which clamp.
pub const REFC_DBZ_MIN: f32 = -20.0;
pub const REFC_DBZ_MAX: f32 = 75.0;

/// A decoded 0.25° global field, row-major from (90N, 0E).
pub struct Field {
    values: Vec<f32>,
}

impl Field {
    /// Decode one byte-ranged GRIB2 message (a single field) into a grid.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let grib2 = from_reader(Cursor::new(bytes)).context("parse GRIB2")?;
        let (_, submsg) = grib2.iter().next().context("GRIB2 had no submessage")?;
        let decoder = Grib2SubmessageDecoder::from(submsg).context("build GRIB2 decoder")?;
        let values: Vec<f32> = decoder.dispatch().context("decode GRIB2 values")?.collect();
        ensure!(
            values.len() == NPTS,
            "expected {NPTS} grid points, got {}",
            values.len()
        );
        Ok(Self { values })
    }

    /// Bilinear sample at (lat, lon) degrees (lon may be −180..180 or 0..360).
    pub fn sample(&self, lat: f64, lon: f64) -> f32 {
        let lon = ((lon % 360.0) + 360.0) % 360.0;
        let fx = lon / 0.25;
        let fy = (90.0 - lat.clamp(-90.0, 90.0)) / 0.25;
        let i0 = (fx.floor() as usize) % NI;
        let i1 = (i0 + 1) % NI;
        let j0 = (fy.floor() as usize).min(NJ - 1);
        let j1 = (j0 + 1).min(NJ - 1);
        let wx = fx.fract() as f32;
        let wy = fy.fract() as f32;
        let g = |j: usize, i: usize| self.values[j * NI + i];
        let top = g(j0, i0) * (1.0 - wx) + g(j0, i1) * wx;
        let bot = g(j1, i0) * (1.0 - wx) + g(j1, i1) * wx;
        top * (1.0 - wy) + bot * wy
    }
}

/// Kelvin → °F.
pub fn k_to_f(k: f32) -> f32 {
    (k - 273.15) * 9.0 / 5.0 + 32.0
}

/// Encode a u/v field pair as an equirectangular RGB PNG — R = u, G = v (each
/// normalized over ±[`WIND_MS_MAX`]), B = 0 — the format `mapbox/webgl-wind`
/// consumes. Row 0 is 90°N and column 0 is 0°E (the GFS scan order), so the
/// texture spans lon 0→360 left→right and lat 90→−90 top→bottom; both fields
/// must be the native 0.25° grid (they are, straight from [`Field::decode`]).
pub fn encode_uv_png(u: &Field, v: &Field) -> Result<Vec<u8>> {
    let norm = |x: f32| {
        (((x + WIND_MS_MAX) / (2.0 * WIND_MS_MAX)) * 255.0)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    let mut rgb = vec![0u8; NPTS * 3];
    for k in 0..NPTS {
        rgb[k * 3] = norm(u.values[k]);
        rgb[k * 3 + 1] = norm(v.values[k]);
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, NI as u32, NJ as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().context("PNG header")?;
        w.write_image_data(&rgb).context("PNG encode")?;
        w.finish().context("PNG finish")?;
    }
    Ok(out)
}

/// Encode a single scalar field as an equirectangular 8-bit **grayscale** PNG,
/// each value normalized linearly over `[min, max]` (out-of-range clamps). Same
/// layout as [`encode_uv_png`] — row 0 is 90°N, column 0 is 0°E (GFS scan order)
/// — and the web denormalizes with the same bounds (carried in the index JSON).
/// Used for the REFC precip texture (dBZ over [`REFC_DBZ_MIN`, `REFC_DBZ_MAX`]).
pub fn encode_scalar_png(field: &Field, min: f32, max: f32) -> Result<Vec<u8>> {
    let span = (max - min).max(f32::EPSILON);
    let norm = |x: f32| (((x - min) / span) * 255.0).round().clamp(0.0, 255.0) as u8;
    let gray: Vec<u8> = field.values.iter().map(|&x| norm(x)).collect();
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, NI as u32, NJ as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().context("PNG header")?;
        w.write_image_data(&gray).context("PNG encode")?;
        w.finish().context("PNG finish")?;
    }
    Ok(out)
}

fn field_url(date: &str, hour: u8, fhour: u16) -> String {
    format!("{NODD}/gfs.{date}/{hour:02}/atmos/gfs.t{hour:02}z.pgrb2.0p25.f{fhour:03}")
}

/// Byte range `[start, end)` of `var:level` within the GRIB file, from its `.idx`
/// (the trailing field reads to EOF, so `end` is `None`).
fn idx_byte_range(idx: &str, var: &str, level: &str) -> Result<(u64, Option<u64>)> {
    let lines: Vec<&str> = idx.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() >= 5 && f[3] == var && f[4] == level {
            let start = f[1].parse().context("idx byte offset")?;
            let end = lines
                .get(i + 1)
                .and_then(|l| l.split(':').nth(1))
                .and_then(|o| o.parse().ok());
            return Ok((start, end));
        }
    }
    bail!("{var}:{level} not in .idx")
}

/// Fetch one field: read the `.idx`, byte-range the message, decode the grid.
pub async fn fetch_field(
    http: &reqwest::Client,
    date: &str,
    hour: u8,
    fhour: u16,
    var: &str,
    level: &str,
) -> Result<Field> {
    let base = field_url(date, hour, fhour);
    let idx = http
        .get(format!("{base}.idx"))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let (start, end) = idx_byte_range(&idx, var, level)?;
    let range = match end {
        Some(e) => format!("bytes={start}-{}", e - 1),
        None => format!("bytes={start}-"),
    };
    let bytes = http
        .get(&base)
        .header("range", range)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    Field::decode(&bytes)
}

/// The newest GFS cycle (00/06/12/18Z) that should be fully written: floor to a
/// 6-hour boundary at least `CYCLE_LAG_S` before `now_s`. Returns `("YYYYMMDD", hour)`.
const CYCLE_LAG_S: u64 = 6 * 3600;
pub fn latest_cycle(now_s: u64) -> (String, u8) {
    let cyc = (now_s.saturating_sub(CYCLE_LAG_S) / (6 * 3600)) * (6 * 3600);
    let (y, m, d) = civil_from_days((cyc / 86400) as i64);
    (format!("{y:04}{m:02}{d:02}"), ((cyc % 86400) / 3600) as u8)
}

/// Epoch ms of a cycle (its reference time = forecast hour 0).
pub fn cycle_ms(date: &str, hour: u8) -> Result<u64> {
    let y: i64 = date[0..4].parse().context("cycle year")?;
    let m: i64 = date[4..6].parse().context("cycle month")?;
    let d: i64 = date[6..8].parse().context("cycle day")?;
    let days = days_from_civil(y, m, d) as u64;
    Ok((days * 86400 + u64::from(hour) * 3600) * 1000)
}

// Howard Hinnant's civil/serial date algorithms (days since 1970-01-01).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_png_encodes_grayscale_with_clamped_bounds() {
        // A full-grid field with a few known values; everything else at the floor.
        let mut values = vec![REFC_DBZ_MIN; NPTS];
        values[0] = REFC_DBZ_MIN; // floor → byte 0
        values[1] = REFC_DBZ_MAX; // ceil → byte 255
        values[2] = REFC_DBZ_MIN - 100.0; // below range clamps → 0
        values[3] = REFC_DBZ_MAX + 100.0; // above range clamps → 255
        values[4] = (REFC_DBZ_MIN + REFC_DBZ_MAX) / 2.0; // midpoint → ~128
        let png = encode_scalar_png(&Field { values }, REFC_DBZ_MIN, REFC_DBZ_MAX).unwrap();

        // Decode it back: grayscale, native grid dims, and the byte mapping holds.
        let mut reader = png::Decoder::new(Cursor::new(&png)).read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (NI as u32, NJ as u32));
        assert_eq!(info.color_type, png::ColorType::Grayscale);
        assert_eq!((buf[0], buf[1], buf[2], buf[3]), (0, 255, 0, 255));
        assert!(
            (i32::from(buf[4]) - 128).abs() <= 1,
            "midpoint byte was {}",
            buf[4]
        );
    }

    #[test]
    fn dates_round_trip() {
        // 2026-06-15 00Z
        let ms = cycle_ms("20260615", 0).unwrap();
        assert_eq!(ms, 1_781_481_600_000);
        let (y, m, d) = civil_from_days((ms / 1000 / 86400) as i64);
        assert_eq!((y, m, d), (2026, 6, 15));
    }

    // Decodes a real TMP:2m message saved to /tmp during the session; ignored so
    // CI never depends on it. Run:
    //   cargo test -p weather-ingest gfs::tests::decode -- --ignored --nocapture
    #[test]
    #[ignore = "reads a local GRIB fixture; not for CI"]
    fn decode_samples_sane_temps() {
        let bytes = std::fs::read("/tmp/gfs_tmp2m.grib2").unwrap();
        let field = Field::decode(&bytes).unwrap();
        for (name, lat, lon) in [
            ("Dallas", 32.78, -96.80),
            ("New York", 40.71, -74.01),
            ("Reykjavik", 64.15, -21.94),
            ("Singapore", 1.35, 103.82),
        ] {
            let f = k_to_f(field.sample(lat, lon));
            println!("{name:10} {f:6.1} °F");
            assert!((-60.0..140.0).contains(&f), "{name}: {f} °F out of range");
        }
    }
}
