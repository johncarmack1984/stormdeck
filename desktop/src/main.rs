//! stormdeck-desktop — a native map window (maplibre-rs/wgpu) over the same
//! martin-served world/region tiles as the web app. Day-one scope: the
//! basemap in a window; weather layers come later.

use maplibre::{
    environment::OffscreenKernelConfig,
    event_loop::EventLoop,
    io::apc::SchedulerAsyncProcedureCall,
    kernel::{Kernel, KernelBuilder},
    map::Map,
    platform::{
        http_client::ReqwestHttpClient, run_multithreaded, scheduler::TokioScheduler,
        ReqwestOffscreenKernelEnvironment,
    },
    render::{
        builder::RendererBuilder,
        settings::{Backends, WgpuSettings},
        RenderPlugin,
    },
    vector::{DefaultVectorTransferables, VectorPlugin},
    window::HeadedMapWindow,
};
use maplibre_winit::{WinitEnvironment, WinitMapWindowConfig};

mod source;
mod style;

fn main() {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    run_multithreaded(async {
        type Env<S, HC, APC> = WinitEnvironment<S, HC, ReqwestOffscreenKernelEnvironment, APC, ()>;

        let cache_path = Some(source::http_cache_dir());
        let client = ReqwestHttpClient::new(cache_path.clone());

        let kernel: Kernel<Env<_, _, _>> = KernelBuilder::new()
            .with_map_window_config(WinitMapWindowConfig::new("stormdeck".to_string()))
            .with_http_client(client)
            .with_apc(SchedulerAsyncProcedureCall::new(
                TokioScheduler::new(),
                OffscreenKernelConfig {
                    cache_directory: cache_path.map(|path| path.to_string_lossy().into_owned()),
                },
            ))
            .with_scheduler(TokioScheduler::new())
            .build();

        let mut map = Map::new(
            style::stormdeck_style(),
            kernel,
            RendererBuilder::new().with_wgpu_settings(WgpuSettings {
                backends: Some(Backends::all()),
                ..WgpuSettings::default()
            }),
            vec![
                Box::new(RenderPlugin),
                Box::new(maplibre::background::BackgroundPlugin),
                // Ordered before VectorPlugin so tiles come from stormdeck,
                // not the stock hardcoded demo source (see source.rs).
                Box::new(source::StormdeckSourcePlugin::<DefaultVectorTransferables>::default()),
                Box::new(VectorPlugin::<DefaultVectorTransferables>::default()),
                Box::new(maplibre::sdf::SdfPlugin::<DefaultVectorTransferables>::default()),
            ],
        )
        .expect("failed to create map");

        map.initialize_renderer()
            .await
            .expect("failed to initialize renderer");

        // The upstream event loop only redraws after a RedrawRequested and
        // re-requests from inside the handler; nothing requests the FIRST
        // one (Resumed is an upstream FIXME), so an occluded launch renders
        // nothing and never fetches a tile. Prime the pump before running.
        map.window().request_redraw();

        map.window_mut()
            .take_event_loop()
            .expect("event loop is not available")
            .run(map, None)
            .expect("event loop failed")
    })
}
