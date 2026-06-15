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

/// Open-Meteo current conditions at one grid point.
#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
pub struct GridProps {
    #[serde(rename = "tempF")]
    pub temp_f: Option<f64>,
    pub rh: Option<f64>,
    #[serde(rename = "windMph")]
    pub wind_mph: Option<f64>,
    #[serde(rename = "windDir")]
    pub wind_dir: Option<f64>,
    pub code: Option<f64>,
    /// Lattice column/row; null off the global grid. Always emitted —
    /// conditional omission would split the exported type into
    /// serialize/deserialize phases for no consumer benefit.
    pub i: Option<u32>,
    pub j: Option<u32>,
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

#[cfg(all(test, feature = "ts"))]
mod export {
    use specta::Types;
    use specta_typescript::Typescript;

    /// Writes the two web binding files; `just build types` runs this.
    #[test]
    fn export_bindings() {
        // Domain payloads → weather.ts. Registering AlertProps pulls in
        // Severity; GridProps stands alone.
        let weather = Types::default()
            .register::<super::AlertProps>()
            .register::<super::GridProps>()
            .register::<super::CityForecast>()
            .register::<super::CityTileIndex>();
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
    use super::{GridProps, Snapshot};
    use typed_geojson::{Feature, Point};

    /// The flattened envelope must serialize as a valid GeoJSON
    /// `FeatureCollection` with `generated_ms` riding alongside `features` —
    /// the exact wire shape the web app reads.
    #[test]
    fn snapshot_serializes_as_a_feature_collection() {
        let snap = Snapshot::new(
            1_700_000_000_000,
            vec![Feature::new(
                Point::new(vec![-96.8, 32.8]),
                GridProps {
                    temp_f: Some(70.0),
                    rh: None,
                    wind_mph: None,
                    wind_dir: None,
                    code: None,
                    i: None,
                    j: None,
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
        // GridProps' serde rename survives.
        assert_eq!(f["properties"]["tempF"], 70.0);
    }
}
