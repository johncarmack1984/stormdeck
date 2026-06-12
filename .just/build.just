# Lambda zip packaging. Both zips must exist before 'just cdk synth'
# or 'just cdk deploy'.

set working-directory := '..'

# Build both Lambda zips
lambdas: weather martin

# Cross-compile weather-ingest for Lambda (arm64 zip)
weather:
    cargo lambda build --manifest-path crates/Cargo.toml --release --arm64 \
        --output-format zip -p weather-ingest

# Package the prebuilt martin release binary as a Lambda zip
martin:
    scripts/build-martin-lambda.sh build/martin-lambda.zip

# Regenerate web/src/generated/weather.ts from the Rust payload
# contract (weather-ingest's contract.rs, via specta), then format it
# to the project style. CI reruns this pipeline and fails on drift.
types:
    cargo test --manifest-path crates/Cargo.toml -p weather-ingest --features ts export_bindings
    cd web && pnpm exec biome format --write src/generated/weather.ts
