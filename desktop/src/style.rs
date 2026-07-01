//! Protomaps light-flavor basemap style, hand-reduced for maplibre-rs.
//!
//! The web app builds its style from @protomaps/basemaps `layers()`
//! (web/src/basemap.ts). maplibre-rs supports a small subset of the style
//! spec — flat fill/line colors, zoom-stop line widths, no kind filters — so
//! this is a per-source-layer reduction using the same light-flavor palette.

use std::str::FromStr;

use csscolorparser::Color;
use maplibre::style::{
    layer::{BackgroundPaint, FillPaint, LayerPaint, LinePaint, StyleLayer, SymbolPaint},
    Style,
};
use serde_json::json;

use maplibre::style::layer::StyleProperty;

fn color(hex: &str) -> StyleProperty<Color> {
    StyleProperty::Constant(Color::from_str(hex).expect("valid hex color"))
}

fn layer(index: u32, id: &str, type_: &str, paint: LayerPaint) -> StyleLayer {
    StyleLayer {
        index,
        id: id.to_string(),
        type_: type_.to_string(),
        filter: None,
        maxzoom: None,
        minzoom: None,
        metadata: None,
        paint: Some(paint),
        source: None,
        source_layer: Some(id.to_string()),
    }
}

fn fill(index: u32, source_layer: &str, hex: &str) -> StyleLayer {
    layer(
        index,
        source_layer,
        "fill",
        LayerPaint::Fill(FillPaint {
            fill_color: Some(color(hex)),
        }),
    )
}

fn line(index: u32, source_layer: &str, hex: &str, width: serde_json::Value) -> StyleLayer {
    layer(
        index,
        source_layer,
        "line",
        LayerPaint::Line(LinePaint {
            line_color: Some(color(hex)),
            line_width: Some(StyleProperty::Expression(width)),
        }),
    )
}

/// Palette values come from @protomaps/basemaps `namedFlavor('light')`, the
/// same flavor the web basemap uses; landcover is flattened to one green.
pub fn stormdeck_style() -> Style {
    Style {
        version: 8,
        name: Some("stormdeck light".to_string()),
        metadata: Default::default(),
        sources: Default::default(),
        // maplibre-rs reads center as [lat, lon]: start over Dallas, inside
        // the region archive's full-detail bbox.
        center: Some([32.7767, -96.797]),
        zoom: Some(
            std::env::var("STORMDECK_START_ZOOM")
                .ok()
                .and_then(|z| z.parse().ok())
                .unwrap_or(6.0),
        ),
        pitch: Some(0.0),
        layers: vec![
            layer(
                0,
                "background",
                "background",
                LayerPaint::Background(BackgroundPaint {
                    background_color: Some(color("#cccccc")),
                }),
            ),
            fill(1, "earth", "#e2dfda"),
            fill(2, "landcover", "#d5e8cf"),
            fill(3, "landuse", "#cfddd5"),
            fill(4, "water", "#80deea"),
            line(
                5,
                "roads",
                "#ffffff",
                json!({ "stops": [[6, 0.5], [11, 1.0], [16, 2.5]] }),
            ),
            fill(6, "buildings", "#cccccc"),
            line(7, "boundaries", "#adadad", json!(1.0)),
            layer(
                8,
                "places",
                "symbol",
                LayerPaint::Symbol(SymbolPaint {
                    text_field: Some("{name}".to_string()),
                    text_size: Some(StyleProperty::Expression(
                        json!({ "stops": [[3, 10.0], [10, 14.0]] }),
                    )),
                }),
            ),
        ],
    }
}
