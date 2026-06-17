//! The JSON contract between this lambda and the web app, as real types.
//!
//! GeoJSON structure (`Feature` / `FeatureCollection` / `Geometry` / `Point` …)
//! comes from the [`typed_geojson`] crate, whose specta export
//! (`web/src/generated/geojson.ts`) is mutually assignable with
//! `@types/geojson`. This module owns only the domain payloads — each feature's
//! typed `properties` — plus the [`Snapshot`] envelope that stamps a collection
//! with its generation time.
//!
//! Single source of truth: `just build types` regenerates both web binding
//! files (domain props via specta here, GeoJSON structure from typed-geojson),
//! behind the `ts` feature so the lambda build never carries specta, and CI
//! fails if either drifts.

use serde::Serialize;
use typed_geojson::{Feature, FeatureCollection};

/// A GeoJSON `FeatureCollection` plus the epoch-ms timestamp of the snapshot.
///
/// `generated_ms` rides as an RFC 7946 foreign member — a sibling of `features`
/// — so the payload stays a valid `FeatureCollection`; the web side models it as
/// `FeatureCollection<G, P> & { generated_ms: number }`. Serialize-only: the
/// lambda writes these, nothing here reads them back, so it needs no specta
/// binding (the web alias composes typed-geojson's `FeatureCollection`).
#[derive(Serialize)]
pub struct Snapshot<G, P> {
    /// Epoch ms stamped when this snapshot was generated.
    /// (Safe in an f64/TS number until the year 287396.)
    pub generated_ms: u64,
    #[serde(flatten)]
    pub collection: FeatureCollection<G, P>,
}

impl<G, P> Snapshot<G, P> {
    /// Stamp a freshly-built set of features with their generation time.
    pub fn new(generated_ms: u64, features: Vec<Feature<G, P>>) -> Self {
        Self {
            generated_ms,
            collection: features.into_iter().collect(),
        }
    }
}

/// NWS severity, normalized: anything unrecognized becomes `Unknown`.
#[derive(Serialize, Clone, Copy)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub enum Severity {
    Extreme,
    Severe,
    Moderate,
    Minor,
    Unknown,
}

impl From<Option<&str>> for Severity {
    fn from(s: Option<&str>) -> Self {
        match s {
            Some("Extreme") => Self::Extreme,
            Some("Severe") => Self::Severe,
            Some("Moderate") => Self::Moderate,
            Some("Minor") => Self::Minor,
            _ => Self::Unknown,
        }
    }
}

/// NWS alert properties, pared down to what the map renders.
#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub struct AlertProps {
    pub id: String,
    pub event: String,
    pub severity: Severity,
    pub headline: Option<String>,
    #[serde(rename = "areaDesc")]
    pub area_desc: Option<String>,
    pub onset: Option<String>,
    pub expires: Option<String>,
}

/// One global-lattice point's temperature series (°F), aligned
/// element-for-element with the enclosing tile's `hours` axis — the
/// zoomed-out, nameless analog of [`CityForecast`]. `i`/`j` are the lattice
/// column/row, so the web can thin the grid at low zoom without re-deriving
/// the layout.
#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub struct LatticeForecast {
    // Always-present reals; override the `number | null` that bare f64 exports
    // (same trick as CityForecast::t).
    #[cfg_attr(feature = "ts", specta(type = Vec<specta_typescript::Number>))]
    pub t: Vec<f64>,
    pub i: u32,
    pub j: u32,
}

/// One city's point forecast: its name and a temperature series (°F) aligned
/// element-for-element with the enclosing tile's `hours` axis.
#[derive(Serialize, Clone)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub struct CityForecast {
    pub name: String,
    // Always-present reals; override the `number | null` that bare f64 exports.
    #[cfg_attr(feature = "ts", specta(type = Vec<specta_typescript::Number>))]
    pub t: Vec<f64>,
}

/// A point-forecast tile: a `FeatureCollection` of cities (each a
/// `Feature<Point, CityForecast>`) plus the shared forecast time axis. The
/// whole series ships per tile so the client scrubs the timeline with **no
/// refetch** — the Windy `citytile` trick. Like [`Snapshot`], the timestamp is
/// a flattened foreign member; the web models it as
/// `FeatureCollection<Point, CityForecast> & { snapshotMs, hours }`.
/// Serialize-only, so no specta binding (the web alias composes it).
#[derive(Serialize)]
pub struct CityTile<G, P> {
    #[serde(rename = "snapshotMs")]
    pub snapshot_ms: u64,
    /// Hour offsets from `snapshotMs`, e.g. `[0, 3, 6, …]`.
    pub hours: Vec<u32>,
    #[serde(flatten)]
    pub collection: FeatureCollection<G, P>,
}

impl<G, P> CityTile<G, P> {
    /// Wrap a tile's features with the shared snapshot time + hour axis.
    pub fn new(snapshot_ms: u64, hours: Vec<u32>, features: Vec<Feature<G, P>>) -> Self {
        Self {
            snapshot_ms,
            hours,
            collection: features.into_iter().collect(),
        }
    }
}

/// The `citytile/latest.json` pointer: which snapshot is current, its time
/// axis, and the zoom range that has tiles. The web reads this first, then
/// builds tile URLs against `snapshotMs` (so old snapshots cache immutably).
#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub struct CityTileIndex {
    #[serde(rename = "snapshotMs")]
    #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
    pub snapshot_ms: u64,
    pub hours: Vec<u32>,
    #[serde(rename = "minZoom")]
    pub min_zoom: u8,
    #[serde(rename = "maxZoom")]
    pub max_zoom: u8,
}

/// The `windtex/latest.json` pointer: the current snapshot, its forecast-hour
/// axis, the equirectangular u/v texture dimensions, and the m/s bounds the PNG
/// channels were normalized over (so the web denormalizes u/v identically). The
/// per-step textures live at `windtex/{snapshotMs}/{hour}.png` (immutable);
/// the web's particle layer loads whichever step the timeline is parked on.
#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub struct WindTexIndex {
    #[serde(rename = "snapshotMs")]
    #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
    pub snapshot_ms: u64,
    pub hours: Vec<u32>,
    pub width: u32,
    pub height: u32,
    // Always-present reals; the `Number` override avoids the `number | null`
    // that a bare f32 exports (same trick as CityForecast::t).
    #[serde(rename = "uMin")]
    #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
    pub u_min: f32,
    #[serde(rename = "uMax")]
    #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
    pub u_max: f32,
    #[serde(rename = "vMin")]
    #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
    pub v_min: f32,
    #[serde(rename = "vMax")]
    #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
    pub v_max: f32,
}

#[cfg(all(test, feature = "ts"))]
mod export {
    use specta::Types;
    use specta_typescript::Typescript;

    /// Writes the two web binding files; `just build types` runs this.
    #[test]
    fn export_bindings() {
        // Domain payloads → weather.ts. Registering AlertProps pulls in
        // Severity; LatticeForecast stands alone.
        let weather = Types::default()
            .register::<super::AlertProps>()
            .register::<super::LatticeForecast>()
            .register::<super::CityForecast>()
            .register::<super::CityTileIndex>()
            .register::<super::WindTexIndex>();
        Typescript::default()
            .header("// Generated from crates/weather-ingest/src/contract.rs by `just build types`. Do not edit.\n")
            .export_to(
                concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/generated/weather.ts"),
                &weather,
                specta_serde::Format,
            )
            .expect("export weather.ts bindings");

        // GeoJSON structure (Feature/FeatureCollection/Geometry/Point/…) from
        // typed-geojson → geojson.ts. Mutually assignable with @types/geojson.
        Typescript::default()
            .header(
                "// Generated from the typed-geojson crate by `just build types`. Do not edit.\n",
            )
            .export_to(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../web/src/generated/geojson.ts"
                ),
                &typed_geojson::specta_types(),
                specta_serde::Format,
            )
            .expect("export geojson.ts bindings");
    }
}

#[cfg(test)]
mod tests {
    use super::{AlertProps, Severity, Snapshot};
    use typed_geojson::{Feature, Point};

    /// The flattened envelope must serialize as a valid GeoJSON
    /// `FeatureCollection` with `generated_ms` riding alongside `features` —
    /// the exact wire shape the web app reads. `Snapshot` now carries only
    /// alerts, so the round-trip is exercised through `AlertProps`.
    #[test]
    fn snapshot_serializes_as_a_feature_collection() {
        let snap = Snapshot::new(
            1_700_000_000_000,
            vec![Feature::new(
                Point::new(vec![-96.8, 32.8]),
                AlertProps {
                    id: "urn:oid:2.49.0.1.840.0.test".to_owned(),
                    event: "Tornado Warning".to_owned(),
                    severity: Severity::Extreme,
                    headline: None,
                    area_desc: Some("Dallas, TX".to_owned()),
                    onset: None,
                    expires: None,
                },
            )],
        );
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["type"], "FeatureCollection");
        assert_eq!(v["generated_ms"], 1_700_000_000_000_u64);
        let f = &v["features"][0];
        assert_eq!(f["type"], "Feature");
        assert_eq!(f["geometry"]["type"], "Point");
        assert_eq!(
            f["geometry"]["coordinates"],
            serde_json::json!([-96.8, 32.8])
        );
        // AlertProps' serde rename (`area_desc` → `areaDesc`) survives the flatten.
        assert_eq!(f["properties"]["areaDesc"], "Dallas, TX");
        assert_eq!(f["properties"]["event"], "Tornado Warning");
    }
}
