# Lambda packaging + type generation. The martin zip must exist before
# 'just cdk synth' / 'just cdk deploy'; weather-ingest is no longer
# packaged here — cargo-lambda-cdk compiles it at synth.

set working-directory := '..'

# Package the prebuilt martin release binary as a Lambda zip — the one
# artifact synth needs staged (weather-ingest builds itself at synth).
martin:
    scripts/build-martin-lambda.sh build/martin-lambda.zip

# Regenerate web/src/generated/weather.ts from the Rust payload
# contract (weather-ingest's contract.rs, via specta), then format it
# to the project style. CI reruns this pipeline and fails on drift.
types:
    cargo test --manifest-path crates/Cargo.toml -p weather-ingest --features ts export_bindings
    cd web && pnpm exec biome format --write src/generated/weather.ts
