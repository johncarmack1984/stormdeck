//! The JSON contract between this lambda and the web app, as real types.
//! Single source of truth: `just build types` regenerates
//! `web/src/generated/weather.ts` from these via specta (behind the `ts`
//! feature so the lambda build never carries it), and CI fails if the
//! two drift.
//!
//! The GeoJSON envelopes are internally-tagged enums, so the `type`
//! discriminators come out as literal `"FeatureCollection"` /
//! `"Feature"` / `"Point"` types on both sides of the wire.

use serde::Serialize;

#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
#[serde(tag = "type")]
pub enum WeatherFc<G, P> {
    FeatureCollection {
        /// Epoch ms stamped when this snapshot was generated.
        /// (Safe in an f64/TS number until the year 287396.)
        #[cfg_attr(feature = "ts", specta(type = specta_typescript::Number))]
        generated_ms: u64,
        features: Vec<WeatherFeature<G, P>>,
    },
}

#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
#[serde(tag = "type")]
pub enum WeatherFeature<G, P> {
    Feature { geometry: G, properties: P },
}

/// GeoJSON Point; coordinates are `[lon, lat]`.
#[derive(Serialize)]
#[cfg_attr(feature = "ts", derive(specta::Type))]
#[serde(tag = "type")]
pub enum PointGeom {
    Point {
        // Override: bare f64 exports as `number | null` (NaN serializes
        // to null), but these are always real coordinates.
        #[cfg_attr(
            feature = "ts",
            specta(type = (specta_typescript::Number, specta_typescript::Number))
        )]
        coordinates: [f64; 2],
    },
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

#[cfg(all(test, feature = "ts"))]
mod export {
    use specta::Types;
    use specta_typescript::Typescript;

    /// Writes web/src/generated/weather.ts; `just build types` runs this.
    #[test]
    fn export_bindings() {
        let out = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/src/generated/weather.ts"
        );
        // Types referenced by the registered ones come along for free:
        // the grid FC instantiation pulls WeatherFeature, PointGeom and
        // GridProps; AlertProps pulls Severity.
        let types = Types::default()
            .register::<super::WeatherFc<super::PointGeom, super::GridProps>>()
            .register::<super::AlertProps>();
        Typescript::default()
            .header("// Generated from crates/weather-ingest/src/contract.rs by `just build types`. Do not edit.\n")
            .export_to(out, &types, specta_serde::Format)
            .expect("export TypeScript bindings");
    }
}
