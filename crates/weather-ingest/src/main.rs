//! Fetches live weather and publishes JSON/PNG snapshots for the map to consume.
//!
//! Sources:
//!   - NWS active alerts (api.weather.gov, public domain)
//!   - NOAA GFS via NODD (public S3, no auth): 2 m temperature as a whole-planet
//!     lattice + per-city tiles, 10 m wind as u/v textures, composite
//!     reflectivity (REFC) as precip textures, and surface CAPE as
//!     storm-potential textures — all decoded from GRIB2 in `gfs.rs`, so one
//!     ~0.9 MB field covers the planet for free.
//!
//! Runs in two modes:
//!   - AWS Lambda (AWS_LAMBDA_RUNTIME_API set): writes to s3://$BUCKET/weather/,
//!     invoked by EventBridge Scheduler with
//!     {"job": "alerts" | "temp" | "windtex" | "refc" | "cape" | "all"}
//!   - CLI (`cargo run -p weather-ingest -- all`): writes to $LOCAL_OUT
//!     (default web/public/weather/) so `just dev` has live data.

mod contract;
mod gfs;
mod s3;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use contract::{
    AlertProps, CapeTexIndex, CityForecast, CityTile, CityTileIndex, LatticeForecast, RefcTexIndex,
    Severity, Snapshot, WindTexIndex,
};
use lambda_runtime::LambdaEvent;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{info, warn};
use typed_geojson::{Feature, Point};

#[derive(Clone)]
struct Config {
    /// NWS area code; empty means every active alert in the US.
    nws_area: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            nws_area: std::env::var("NWS_AREA").unwrap_or_default(),
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as u64
}

/// Active NWS alerts, slimmed to what the map renders. With no NWS_AREA
/// set this is every active alert in the US — the camera roams the planet,
/// so the feed covers everything the NWS publishes.
async fn fetch_alerts(http: &reqwest::Client, cfg: &Config) -> Result<Value> {
    let mut url =
        String::from("https://api.weather.gov/alerts/active?status=actual&message_type=alert");
    if !cfg.nws_area.is_empty() {
        url.push_str(&format!("&area={}", cfg.nws_area));
    }
    info!("fetching NWS alerts: {url}");
    let started = Instant::now();
    let body: Value = http
        .get(&url)
        .header("accept", "application/geo+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("NWS alerts response was not JSON")?;

    let features = match body.get("features").and_then(Value::as_array) {
        Some(f) => f.clone(),
        None => bail!("NWS alerts response missing 'features'"),
    };
    let total = features.len();
    // Zone-based alerts ship without geometry; the map can't draw those.
    let drawable: Vec<Feature<Value, AlertProps>> = features
        .into_iter()
        .filter(|f| !f["geometry"].is_null())
        .map(|mut f| {
            let p = &f["properties"];
            let props = AlertProps {
                id: p["id"].as_str().unwrap_or_default().to_owned(),
                event: p["event"].as_str().unwrap_or_default().to_owned(),
                severity: Severity::from(p["severity"].as_str()),
                headline: p["headline"].as_str().map(str::to_owned),
                area_desc: p["areaDesc"].as_str().map(str::to_owned),
                onset: p["onset"].as_str().map(str::to_owned),
                expires: p["expires"].as_str().map(str::to_owned),
            };
            Feature::new(f["geometry"].take(), props)
        })
        .collect();
    let scope = if cfg.nws_area.is_empty() {
        "US"
    } else {
        &cfg.nws_area
    };
    info!(
        "NWS alerts: {total} active in {scope}, {} with geometry, fetched in {:.1?}",
        drawable.len(),
        started.elapsed()
    );
    if drawable.len() < total {
        warn!(
            "dropped {} zone-based alerts without geometry",
            total - drawable.len()
        );
    }
    Ok(serde_json::to_value(Snapshot::new(now_ms(), drawable))?)
}

// --- temperature: per-city tiles (zoomed in) + a global lattice (zoomed out) -

/// Bundled top-population cities (GeoNames cities15000, deduped by metro).
const CITIES_JSON: &str = include_str!("cities.json");

#[derive(Deserialize)]
struct City {
    name: String,
    lat: f64,
    lon: f64,
    pop: u64,
}

fn cities() -> Result<Vec<City>> {
    serde_json::from_str(CITIES_JSON).context("parsing bundled cities.json")
}

/// Lowest zoom a city's label appears at, by population — keeps low zooms from
/// cluttering (megacities show first, smaller towns only once zoomed in).
fn min_zoom(pop: u64) -> u8 {
    match pop {
        p if p >= 5_000_000 => 3,
        p if p >= 1_000_000 => 4,
        p if p >= 300_000 => 5,
        _ => 6,
    }
}

/// Tile zoom range that gets point-forecast tiles, plus the GFS forecast horizon.
const CITYTILE_MIN_Z: u8 = 3;
const CITYTILE_MAX_Z: u8 = 6;
const CITYTILE_FHOUR_MAX: u16 = 168; // 7 days
const CITYTILE_STEP_H: u16 = 3; // 3-hourly (GFS pgrb2 cadence past f120)

/// Web-mercator tile (x, y) containing a lon/lat at zoom `z`.
fn lonlat_to_tile(lon: f64, lat: f64, z: u8) -> (u32, u32) {
    let n = (1u32 << z) as f64;
    let x = ((lon + 180.0) / 360.0 * n).floor().clamp(0.0, n - 1.0) as u32;
    let lat_rad = lat.to_radians();
    let y = ((1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n)
        .floor()
        .clamp(0.0, n - 1.0) as u32;
    (x, y)
}

/// Whole-planet temperature lattice spacing, in degrees. Coarse enough that the
/// zoomed-out labels don't pile up (the web thins it further below z4.5); the
/// fine detail arrives as per-city tiles once you zoom in. The same step the
/// retired Open-Meteo global grid used, now sampled free from the GFS field.
const LATTICE_STEP_DEG: f64 = 6.0;

/// A whole-planet lattice point: its location plus the column/row indices the
/// web thins by at low zoom.
struct LatticePoint {
    lat: f64,
    lon: f64,
    i: u32,
    j: u32,
}

/// The whole-planet lattice (poles trimmed for mercator), `LATTICE_STEP_DEG`
/// apart — the `-78..78 / -177..177` layout the Open-Meteo global grid used.
fn lattice_points() -> Vec<LatticePoint> {
    let mut pts = Vec::new();
    let mut lat = -78.0;
    let mut j = 0u32;
    while lat <= 78.0 {
        let mut lon = -177.0;
        let mut i = 0u32;
        while lon <= 177.0 {
            pts.push(LatticePoint { lat, lon, i, j });
            lon += LATTICE_STEP_DEG;
            i += 1;
        }
        lat += LATTICE_STEP_DEG;
        j += 1;
    }
    pts
}

/// All temperature artifacts in one pass. Each 2 m TMP field (one per forecast
/// step) is decoded once and sampled twice — at the cities and at the global
/// lattice — so the zoomed-out grid costs no extra GFS fetches. Writes:
///   - per-city tiles `citytile/{snapshot}/{z}/{x}/{y}.json` (immutable; the
///     client scrubs the whole series without refetching) + a short-lived
///     `citytile/latest.json` pointer (also the map-wide timeline's axis), and
///   - one whole-planet `lattice.json` carrying the same snapshot + hour axis,
///     so the single timeline scrubs cities, grid, and wind in lockstep.
///
/// Sourced from GFS (NODD): one decoded field samples every point for free, so
/// coverage is bounded by clutter, not API metering.
async fn fetch_temps(http: &reqwest::Client, sink: &Sink) -> Result<()> {
    let cities = cities()?;
    let lattice = lattice_points();
    let started = Instant::now();

    let (date, cyc) = gfs::latest_cycle(now_ms() / 1000);
    let snapshot_ms = gfs::cycle_ms(&date, cyc)?;
    let fhours: Vec<u16> = (0..=CITYTILE_FHOUR_MAX)
        .step_by(CITYTILE_STEP_H as usize)
        .collect();
    let hours: Vec<u32> = fhours.iter().map(|&f| u32::from(f)).collect();

    // Sample cities and the lattice from each field as it decodes (bounded
    // concurrency — one ~4 MB grid resident per in-flight step).
    let mut city_series: Vec<Vec<f64>> = vec![vec![f64::NAN; fhours.len()]; cities.len()];
    let mut lattice_series: Vec<Vec<f64>> = vec![vec![f64::NAN; fhours.len()]; lattice.len()];
    const FETCH_CONC: usize = 12;
    for chunk in fhours.chunks(FETCH_CONC) {
        let mut set = tokio::task::JoinSet::new();
        for &fh in chunk {
            let (http, date) = (http.clone(), date.clone());
            set.spawn(async move {
                gfs::fetch_field(&http, &date, cyc, fh, "TMP", "2 m above ground")
                    .await
                    .map(|field| (fh, field))
            });
        }
        while let Some(res) = set.join_next().await {
            let (fh, field) = res??;
            let k = (fh / CITYTILE_STEP_H) as usize;
            for (ci, city) in cities.iter().enumerate() {
                city_series[ci][k] = f64::from(gfs::k_to_f(field.sample(city.lat, city.lon)));
            }
            for (li, lp) in lattice.iter().enumerate() {
                lattice_series[li][k] = f64::from(gfs::k_to_f(field.sample(lp.lat, lp.lon)));
            }
        }
    }
    info!(
        "GFS {date}/{cyc:02}z: {} TMP fields sampled ({} cities + {} lattice points) in {:.1?}",
        fhours.len(),
        cities.len(),
        lattice.len(),
        started.elapsed()
    );

    // Per-city tiles (zoomed in), bucketed by each city's min zoom — denser as
    // you zoom in.
    let mut tiles: HashMap<(u8, u32, u32), Vec<Feature<Point, CityForecast>>> = HashMap::new();
    for (ci, city) in cities.iter().enumerate() {
        let feat = Feature::new(
            Point::new(vec![city.lon, city.lat]),
            CityForecast {
                name: city.name.clone(),
                t: city_series[ci].clone(),
            },
        );
        for z in min_zoom(city.pop)..=CITYTILE_MAX_Z {
            let (x, y) = lonlat_to_tile(city.lon, city.lat, z);
            tiles.entry((z, x, y)).or_default().push(feat.clone());
        }
    }

    // Serialize, then write tiles concurrently (immutable — snapshot in path).
    let mut payloads: Vec<(String, Value)> = Vec::with_capacity(tiles.len());
    for ((z, x, y), feats) in tiles {
        let body = serde_json::to_value(CityTile::new(snapshot_ms, hours.clone(), feats))?;
        payloads.push((format!("citytile/{snapshot_ms}/{z}/{x}/{y}.json"), body));
    }
    let tile_count = payloads.len();
    const WRITE_CONC: usize = 16;
    for chunk in payloads.chunks(WRITE_CONC) {
        let mut set = tokio::task::JoinSet::new();
        for (name, body) in chunk {
            let (sink, name, body) = (sink.clone(), name.clone(), body.clone());
            set.spawn(async move { sink.publish(&name, &body, 31_536_000).await });
        }
        while let Some(res) = set.join_next().await {
            res??;
        }
    }
    let index = CityTileIndex {
        snapshot_ms,
        hours: hours.clone(),
        min_zoom: CITYTILE_MIN_Z,
        max_zoom: CITYTILE_MAX_Z,
    };
    sink.publish("citytile/latest.json", &serde_json::to_value(index)?, 300)
        .await?;

    // Whole-planet lattice (zoomed out) as a single file — same snapshot + hours
    // as the tiles, so the timeline stays in lockstep. `i`/`j` let the web thin
    // the grid at low zoom.
    let lattice_count = lattice.len();
    let lattice_feats: Vec<Feature<Point, LatticeForecast>> = lattice
        .into_iter()
        .zip(lattice_series)
        .map(|(lp, t)| {
            Feature::new(
                Point::new(vec![lp.lon, lp.lat]),
                LatticeForecast {
                    t,
                    i: lp.i,
                    j: lp.j,
                },
            )
        })
        .collect();
    let lattice_body = serde_json::to_value(CityTile::new(snapshot_ms, hours, lattice_feats))?;
    sink.publish("lattice.json", &lattice_body, 3600).await?;

    info!(
        "temps: {} cities → {tile_count} tiles (z{CITYTILE_MIN_Z}-{CITYTILE_MAX_Z}) + {lattice_count} lattice points in {:.1?}",
        cities.len(),
        started.elapsed()
    );
    Ok(())
}

// --- wind u/v textures (the webgl-wind particle substrate) -------------------

/// Forecast horizon for the wind textures — the same axis as citytile, so the
/// one map-wide timeline scrubs labels and particles together.
const WINDTEX_FHOUR_MAX: u16 = 168; // 7 days
const WINDTEX_STEP_H: u16 = 3; // 3-hourly

/// Surface-wind u/v textures, one per forecast step: an equirectangular RGB PNG
/// (R = u, G = v, normalized over ±`gfs::WIND_MS_MAX`) decoded from GFS
/// UGRD/VGRD at 10 m — the format `mapbox/webgl-wind` advects particles through.
/// Snapshot-addressed like citytile (`windtex/{snapshot}/{fhour}.png`, immutable
/// — snapshot in the path) with a short-lived `windtex/latest.json` index
/// carrying the hour axis, texture dims, and the m/s bounds the web denormalizes
/// with. One ~0.9 MB GFS field per component covers the whole planet, free.
async fn fetch_windtex(http: &reqwest::Client, sink: &Sink) -> Result<()> {
    let started = Instant::now();
    let (date, cyc) = gfs::latest_cycle(now_ms() / 1000);
    let snapshot_ms = gfs::cycle_ms(&date, cyc)?;
    let fhours: Vec<u16> = (0..=WINDTEX_FHOUR_MAX)
        .step_by(WINDTEX_STEP_H as usize)
        .collect();

    // Each step holds two ~1M-point f32 grids while its PNG encodes; cap how many
    // are in flight so peak memory stays well under the function's 512 MB.
    const CONC: usize = 6;
    for chunk in fhours.chunks(CONC) {
        let mut set = tokio::task::JoinSet::new();
        for &fh in chunk {
            let (http, date) = (http.clone(), date.clone());
            set.spawn(async move {
                let (u, v) = tokio::try_join!(
                    gfs::fetch_field(&http, &date, cyc, fh, "UGRD", "10 m above ground"),
                    gfs::fetch_field(&http, &date, cyc, fh, "VGRD", "10 m above ground"),
                )?;
                anyhow::Ok((fh, gfs::encode_uv_png(&u, &v)?))
            });
        }
        while let Some(res) = set.join_next().await {
            let (fh, png) = res??;
            sink.publish_bytes(
                &format!("windtex/{snapshot_ms}/{fh}.png"),
                png,
                "image/png",
                31_536_000,
            )
            .await?;
        }
    }

    let index = WindTexIndex {
        snapshot_ms,
        hours: fhours.iter().map(|&f| u32::from(f)).collect(),
        width: gfs::TEX_WIDTH,
        height: gfs::TEX_HEIGHT,
        u_min: -gfs::WIND_MS_MAX,
        u_max: gfs::WIND_MS_MAX,
        v_min: -gfs::WIND_MS_MAX,
        v_max: gfs::WIND_MS_MAX,
    };
    sink.publish("windtex/latest.json", &serde_json::to_value(index)?, 300)
        .await?;
    info!(
        "windtex: {} steps → PNGs ({}×{}, GFS {date}/{cyc:02}z) in {:.1?}",
        fhours.len(),
        gfs::TEX_WIDTH,
        gfs::TEX_HEIGHT,
        started.elapsed()
    );
    Ok(())
}

// --- scalar GFS textures: one field per step, colormapped client-side ----------

/// Forecast horizon for the scalar GFS textures (REFC precip, CAPE storm
/// potential) — the same axis as citytile and windtex, so the one map-wide
/// timeline scrubs them all together.
const SCALARTEX_FHOUR_MAX: u16 = 168; // 7 days
const SCALARTEX_STEP_H: u16 = 3; // 3-hourly

/// Fetch one GFS scalar field per forecast step, encode each to an
/// equirectangular grayscale PNG over `[min, max]`, and write
/// `{prefix}/{snapshot}/{fhour}.png` (immutable). Returns the snapshot epoch-ms
/// and the forecast-hour axis for the caller's typed `{prefix}/latest.json`
/// index. One ~0.9 MB GFS field covers the whole planet, free; concurrency is
/// capped so peak memory stays well under the function's 512 MB (one ~1M-point
/// f32 grid resident per in-flight step while its PNG encodes).
async fn fetch_scalar_tex(
    http: &reqwest::Client,
    sink: &Sink,
    var: &str,
    level: &str,
    prefix: &str,
    min: f32,
    max: f32,
) -> Result<(u64, Vec<u16>)> {
    let started = Instant::now();
    let (date, cyc) = gfs::latest_cycle(now_ms() / 1000);
    let snapshot_ms = gfs::cycle_ms(&date, cyc)?;
    let fhours: Vec<u16> = (0..=SCALARTEX_FHOUR_MAX)
        .step_by(SCALARTEX_STEP_H as usize)
        .collect();

    const CONC: usize = 6;
    for chunk in fhours.chunks(CONC) {
        let mut set = tokio::task::JoinSet::new();
        for &fh in chunk {
            let (http, date, var, level) =
                (http.clone(), date.clone(), var.to_owned(), level.to_owned());
            set.spawn(async move {
                let field = gfs::fetch_field(&http, &date, cyc, fh, &var, &level).await?;
                anyhow::Ok((fh, gfs::encode_scalar_png(&field, min, max)?))
            });
        }
        while let Some(res) = set.join_next().await {
            let (fh, png) = res??;
            sink.publish_bytes(
                &format!("{prefix}/{snapshot_ms}/{fh}.png"),
                png,
                "image/png",
                31_536_000,
            )
            .await?;
        }
    }
    info!(
        "{prefix}: {} steps → PNGs ({}×{}, GFS {date}/{cyc:02}z) in {:.1?}",
        fhours.len(),
        gfs::TEX_WIDTH,
        gfs::TEX_HEIGHT,
        started.elapsed()
    );
    Ok((snapshot_ms, fhours))
}

/// Composite-reflectivity (REFC) precip textures — the model's depiction of
/// precipitation the web overlays when the timeline is scrubbed into the future
/// (live radar stays the truth for "now"). GFS floors no-echo at ~−20 dBZ → byte
/// 0, which the web renders transparent.
async fn fetch_refctex(http: &reqwest::Client, sink: &Sink) -> Result<()> {
    let (snapshot_ms, fhours) = fetch_scalar_tex(
        http,
        sink,
        "REFC",
        "entire atmosphere",
        "refctex",
        gfs::REFC_DBZ_MIN,
        gfs::REFC_DBZ_MAX,
    )
    .await?;
    let index = RefcTexIndex {
        snapshot_ms,
        hours: fhours.iter().map(|&f| u32::from(f)).collect(),
        width: gfs::TEX_WIDTH,
        height: gfs::TEX_HEIGHT,
        dbz_min: gfs::REFC_DBZ_MIN,
        dbz_max: gfs::REFC_DBZ_MAX,
    };
    sink.publish("refctex/latest.json", &serde_json::to_value(index)?, 300)
        .await
}

/// Surface-CAPE storm-potential textures — where the atmosphere is primed for
/// convection (J/kg). Complementary to precip + alerts, global on the shared
/// axis; stable air is 0 J/kg → byte 0, and the web renders below its display
/// threshold transparent.
async fn fetch_capetex(http: &reqwest::Client, sink: &Sink) -> Result<()> {
    let (snapshot_ms, fhours) = fetch_scalar_tex(
        http,
        sink,
        "CAPE",
        "surface",
        "capetex",
        gfs::CAPE_JKG_MIN,
        gfs::CAPE_JKG_MAX,
    )
    .await?;
    let index = CapeTexIndex {
        snapshot_ms,
        hours: fhours.iter().map(|&f| u32::from(f)).collect(),
        width: gfs::TEX_WIDTH,
        height: gfs::TEX_HEIGHT,
        cape_min: gfs::CAPE_JKG_MIN,
        cape_max: gfs::CAPE_JKG_MAX,
    };
    sink.publish("capetex/latest.json", &serde_json::to_value(index)?, 300)
        .await
}

#[derive(Clone)]
enum Sink {
    S3(s3::S3Writer),
    Local { dir: PathBuf },
}

impl Sink {
    /// Publish a JSON object (the common case: snapshots, indexes).
    async fn publish(&self, name: &str, body: &Value, max_age: u32) -> Result<()> {
        self.publish_bytes(name, serde_json::to_vec(body)?, "application/json", max_age)
            .await
    }

    /// Publish raw bytes with an explicit content type — JSON above, or the
    /// windtex PNGs (image/png).
    async fn publish_bytes(
        &self,
        name: &str,
        bytes: Vec<u8>,
        content_type: &str,
        max_age: u32,
    ) -> Result<()> {
        let len = bytes.len();
        match self {
            Sink::S3(writer) => {
                let key = format!("weather/{name}");
                writer
                    .put(
                        &key,
                        bytes,
                        content_type,
                        &format!("public, max-age={max_age}"),
                    )
                    .await?;
                info!("published s3://{}/{key} ({len} bytes)", writer.bucket);
            }
            Sink::Local { dir } => {
                let path = dir.join(name);
                // `name` may be a nested tile path (citytile/…/z/x/y.json).
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&path, &bytes)?;
                info!("wrote {} ({len} bytes)", path.display());
            }
        }
        Ok(())
    }
}

async fn run_job(job: &str, cfg: &Config, http: &reqwest::Client, sink: &Sink) -> Result<Value> {
    let mut done = Vec::new();
    if matches!(job, "alerts" | "all") {
        let alerts = fetch_alerts(http, cfg).await?;
        sink.publish("alerts.json", &alerts, 60).await?;
        done.push("alerts");
    }
    if matches!(job, "temp" | "all") {
        fetch_temps(http, sink).await?;
        done.push("temp");
    }
    if matches!(job, "windtex" | "all") {
        fetch_windtex(http, sink).await?;
        done.push("windtex");
    }
    if matches!(job, "refc" | "all") {
        fetch_refctex(http, sink).await?;
        done.push("refc");
    }
    if matches!(job, "cape" | "all") {
        fetch_capetex(http, sink).await?;
        done.push("cape");
    }
    if done.is_empty() {
        bail!("unknown job '{job}' (expected alerts | temp | windtex | refc | cape | all)");
    }
    Ok(json!({ "ok": true, "jobs": done }))
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cfg = Config::from_env()?;
    // NWS requires an identifying User-Agent with a contact in it.
    let contact = std::env::var("CONTACT")
        .unwrap_or_else(|_| "github.com/johncarmack1984/stormdeck".to_string());
    let http = reqwest::Client::builder()
        .user_agent(format!("stormdeck/0.1 ({contact})"))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(anyhow::Error::from)?;

    if std::env::var("AWS_LAMBDA_RUNTIME_API").is_ok() {
        let sink = Sink::S3(s3::S3Writer::from_env(http.clone())?);
        lambda_runtime::run(lambda_runtime::service_fn(
            move |event: LambdaEvent<Value>| {
                let (cfg, http, sink) = (cfg.clone(), http.clone(), sink.clone());
                async move {
                    let job = event
                        .payload
                        .get("job")
                        .and_then(Value::as_str)
                        .unwrap_or("all")
                        .to_string();
                    run_job(&job, &cfg, &http, &sink)
                        .await
                        .map_err(lambda_runtime::Error::from)
                }
            },
        ))
        .await
    } else {
        let job = std::env::args().nth(1).unwrap_or_else(|| "all".to_string());
        let dir = std::env::var("LOCAL_OUT").unwrap_or_else(|_| "web/public/weather".to_string());
        let sink = Sink::Local {
            dir: PathBuf::from(dir),
        };
        run_job(&job, &cfg, &http, &sink).await?;
        Ok(())
    }
}
