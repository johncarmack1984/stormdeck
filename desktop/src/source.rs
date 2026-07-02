//! Tile fetching pointed at stormdeck's martin endpoints.
//!
//! maplibre-rs (as of e2c1c4d) hardcodes its vector tile URL inside the stock
//! `VectorPlugin`'s request system (`TessellateSource::default()`); the style's
//! `sources` are not consulted. So this module carries a near-verbatim copy of
//! that request system with the fetch swapped: `StormdeckSourcePlugin` must be
//! registered BEFORE the stock `VectorPlugin`, whose request system skips any
//! tile that already has vector components — ours claims each tile first and
//! everything downstream (tessellation, populate, upload, render) stays stock.

use std::{
    borrow::Cow, collections::HashSet, marker::PhantomData, path::PathBuf, rc::Rc, sync::OnceLock,
};

use maplibre::{
    context::MapContext,
    coords::WorldTileCoords,
    environment::{Environment, OffscreenKernel},
    io::{
        apc::{AsyncProcedureCall, AsyncProcedureFuture, Context, Input, ProcedureError},
        source_client::HttpClient,
    },
    kernel::Kernel,
    platform::http_client::ReqwestHttpClient,
    plugin::Plugin,
    render::{
        graph::RenderGraph, tile_view_pattern::DEFAULT_TILE_SIZE, view_state::ViewStatePadding,
        RenderStageLabel,
    },
    schedule::Schedule,
    sdf::SymbolLayersDataComponent,
    style::{layer::StyleLayer, source::TileAddressingScheme},
    tcs::{
        system::{System, SystemContainer, SystemResult},
        world::World,
    },
    vector::{
        process_vector_tile, LayerMissing, ProcessVectorContext, VectorLayerBucketComponent,
        VectorTileRequest, VectorTransferables,
    },
};

/// Where martin serves the `world`/`region` archives. Defaults to prod;
/// override with STORMDECK_TILE_BASE (e.g. http://localhost:3030 from
/// `just dev`). The wind layer derives its weather base from this too.
pub fn tile_base() -> String {
    std::env::var("STORMDECK_TILE_BASE").unwrap_or_else(|_| "https://stormdeck.live".to_string())
}

/// The z0-6 planet archive overzooms in the web app; maplibre-rs has no
/// overzoom, so past `world`'s maxzoom we switch to the full-detail `region`
/// archive (see the region bbox in .just/common.just) and accept missing
/// tiles elsewhere.
const WORLD_MAX_ZOOM: u8 = 6;

/// HTTP disk cache next to the build artifacts (gitignored via `target/`).
pub fn http_cache_dir() -> PathBuf {
    PathBuf::from("target/tile-cache")
}

fn tile_url(coords: &WorldTileCoords) -> Option<String> {
    let tile = coords.into_tile(TileAddressingScheme::XYZ)?;
    let source = if tile.z <= WORLD_MAX_ZOOM.into() {
        "world"
    } else {
        "region"
    };
    Some(format!(
        "{}/{}/{}/{}/{}",
        tile_base(),
        source,
        tile.z,
        tile.x,
        tile.y
    ))
}

/// The APC procedure is a plain `fn` pointer (no closure state), so the
/// client lives in a global; it carries its own disk cache.
static HTTP: OnceLock<ReqwestHttpClient> = OnceLock::new();

/// Browsers cap per-host connections around this; without it a cold view
/// fires ~25 parallel fetches and trips martin's Lambda concurrency limit
/// (429s). Overflow beyond the cap retries below, but don't cause it.
const MAX_IN_FLIGHT: usize = 5;
static FETCH_GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

fn is_retryable(err: &maplibre::io::source_client::SourceFetchError) -> bool {
    match err.0.downcast_ref::<reqwest::Error>() {
        // Throttling recovers; missing tiles (404 outside the region bbox)
        // and other client errors don't.
        Some(e) => match e.status() {
            Some(status) => status.as_u16() == 429 || status.is_server_error(),
            None => true, // transport error
        },
        None => false,
    }
}

async fn fetch_throttled(
    client: &ReqwestHttpClient,
    url: &str,
) -> Result<Vec<u8>, maplibre::io::source_client::SourceFetchError> {
    let _permit = FETCH_GATE
        .get_or_init(|| tokio::sync::Semaphore::new(MAX_IN_FLIGHT))
        .acquire()
        .await
        .expect("fetch gate never closes");

    let mut attempt: u64 = 0;
    loop {
        // The error isn't Send, so it must drop before the sleep await.
        match client.fetch(url).await {
            Err(e) if attempt < 3 && is_retryable(&e) => {}
            result => return result,
        }
        attempt += 1;
        tokio::time::sleep(std::time::Duration::from_millis(250 * attempt)).await;
    }
}

fn send_layers_missing<T: VectorTransferables, C: Context>(
    context: &C,
    coords: WorldTileCoords,
    layers: &HashSet<StyleLayer>,
) -> Result<(), ProcedureError> {
    for layer in layers {
        context
            .send_back(<T as VectorTransferables>::LayerMissing::build_from(
                coords,
                layer.id.clone(),
            ))
            .map_err(ProcedureError::Send)?;
    }
    Ok(())
}

pub fn fetch_stormdeck_tile_apc<
    K: OffscreenKernel,
    T: VectorTransferables,
    C: Context + Clone + Send,
>(
    input: Input,
    context: C,
    _kernel: K,
) -> AsyncProcedureFuture {
    Box::pin(async move {
        let Input::TileRequest { coords, style } = input else {
            return Err(ProcedureError::IncompatibleInput);
        };

        let requested_layers: HashSet<StyleLayer> = style.layers.iter().cloned().collect();
        if requested_layers.is_empty() {
            return Ok(());
        }

        let Some(url) = tile_url(&coords) else {
            return send_layers_missing::<T, C>(&context, coords, &requested_layers);
        };

        let client = HTTP.get_or_init(|| ReqwestHttpClient::new(Some(http_cache_dir())));

        match fetch_throttled(client, &url).await {
            Ok(data) => {
                let data = data.into_boxed_slice();

                let mut pipeline_context = ProcessVectorContext::<T, C>::new(context);
                process_vector_tile(
                    &data,
                    VectorTileRequest {
                        coords,
                        layers: requested_layers,
                    },
                    &mut pipeline_context,
                )
                .map_err(|e| ProcedureError::Execution(Box::new(e)))?;
            }
            Err(e) => {
                // Out-of-coverage region tiles land here (404) by design.
                log::info!("tile unavailable at {url}: {e:?}");
                send_layers_missing::<T, C>(&context, coords, &requested_layers)?;
            }
        }

        Ok(())
    })
}

pub struct StormdeckRequestSystem<E: Environment, T> {
    kernel: Rc<Kernel<E>>,
    phantom_t: PhantomData<T>,
}

impl<E: Environment, T> StormdeckRequestSystem<E, T> {
    pub fn new(kernel: &Rc<Kernel<E>>) -> Self {
        Self {
            kernel: kernel.clone(),
            phantom_t: Default::default(),
        }
    }
}

impl<E: Environment, T: VectorTransferables> System for StormdeckRequestSystem<E, T> {
    fn name(&self) -> Cow<'static, str> {
        "stormdeck_vector_request".into()
    }

    fn run(
        &mut self,
        MapContext {
            style,
            view_state,
            world,
            ..
        }: &mut MapContext,
    ) -> SystemResult {
        let view_region = view_state.create_view_region(
            view_state.zoom().zoom_level(DEFAULT_TILE_SIZE),
            ViewStatePadding::Loose,
        );

        if view_state.did_camera_change() || view_state.did_zoom_change() {
            if let Some(view_region) = &view_region {
                for coords in view_region.iter() {
                    if coords.build_quad_key().is_none() {
                        continue;
                    }

                    if world
                        .tiles
                        .query::<&VectorLayerBucketComponent>(coords)
                        .is_some()
                    {
                        continue;
                    }

                    world
                        .tiles
                        .spawn_mut(coords)
                        .unwrap()
                        .insert(VectorLayerBucketComponent::default())
                        .insert(SymbolLayersDataComponent::default());

                    log::info!("tile request started: {coords}");

                    self.kernel
                        .apc()
                        .call(
                            Input::TileRequest {
                                coords,
                                style: style.clone(),
                            },
                            fetch_stormdeck_tile_apc::<
                                E::OffscreenKernelEnvironment,
                                T,
                                <E::AsyncProcedureCall as AsyncProcedureCall<
                                    E::OffscreenKernelEnvironment,
                                >>::Context,
                            >,
                        )
                        .unwrap();
                }
            }
        }
        Ok(())
    }
}

/// Registers only the request system; must precede the stock `VectorPlugin`
/// in the plugin list so tiles are claimed before its request system runs.
pub struct StormdeckSourcePlugin<T>(PhantomData<T>);

impl<T> Default for StormdeckSourcePlugin<T> {
    fn default() -> Self {
        Self(Default::default())
    }
}

impl<E: Environment, T: VectorTransferables> Plugin<E> for StormdeckSourcePlugin<T> {
    fn build(
        &self,
        schedule: &mut Schedule,
        kernel: Rc<Kernel<E>>,
        _world: &mut World,
        _graph: &mut RenderGraph,
    ) {
        schedule.add_system_to_stage(
            RenderStageLabel::Extract,
            SystemContainer::new(StormdeckRequestSystem::<E, T>::new(&kernel)),
        );
    }
}
