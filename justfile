# stormdeck — see README.md for the full walkthrough.
# Modules with a home folder keep their justfile there (cdk/, tiles/,
# web/ — `just` works directly inside those dirs); the rest live in
# .just/, with shared variables in .just/common.just. Override the
# variables per invocation: just bbox="-100,30,-95,35" tiles extract

import '.just/common.just'

# Lambda zip packaging
mod build '.just/build.just'
# The IaC (CDK → CloudFormation)
mod cdk
# OSM basemap extracts: cut + upload
mod tiles
# Weather data: local fetch + deployed lambda invoke
mod weather '.just/weather.just'
# Web app
mod web

# List recipes
default:
    @just --list --unsorted

# Run martin (:3030) + vite (:5173) against local tiles
dev:
    TILES="{{ tiles_file }}" WORLD="{{ world_file }}" scripts/dev.sh

# Typecheck + compile everything without deploying
check:
    cargo check --manifest-path crates/Cargo.toml
    cd web && pnpm run build
