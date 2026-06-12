# Shared variables — imported by the root justfile and the modules.
# Override per invocation: just bbox="-100,30,-95,35" tiles extract

# Absolute repo root: modules run with different working directories
# (their home folder), so shared paths can't be relative.
root := parent_directory(source_directory())

# Area of interest: minLon,minLat,maxLon,maxLat (default: DFW metroplex)
bbox := "-98.2,31.8,-95.8,33.6"
# NWS alert area (state/territory code); empty = every US alert
nws_area := ""
tiles_file := root / "tiles/region.pmtiles"
world_file := root / "tiles/world.pmtiles"

# Where the stack lives. us-east-2: us-east-1 pricing without its outage
# record. (A future custom domain still needs its ACM cert in us-east-1 —
# CloudFront rule — but that's a tiny cert-only stack; the app is free to
# live anywhere.)
region := "us-east-2"
# AWS profile for infra commands; empty = ambient credentials.
# Usage: just profile=my-admin cdk bootstrap
profile := ""
profile_flag := if profile == "" { "" } else { "--profile " + profile }
