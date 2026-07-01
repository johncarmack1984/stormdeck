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
# Native desktop map window (maplibre-rs)
mod desktop
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

# The pushed tag fires release.yml, which writes the GitHub Release notes from
# the PRs merged since the last tag. Deploys are unaffected (they stay on
# push-to-main); the app version label is git-derived, so there are no files to
# bump. Run from a clean, pushed main.
# Cut a release: bump + push a vX.Y.Z tag (patch|minor|major, or exact X.Y.Z).
release level="patch":
    scripts/release.sh {{ level }}
