# Live weather: NWS alerts + Open-Meteo conditions grids.

set working-directory := '..'

import 'common.just'

# Fetch live weather into web/public/weather/ for local dev (no AWS).
# 'all' includes the paced global lattice (~3 min); 'alerts'/'grid' are quick.
local job="all":
    BBOX="{{ bbox }}" NWS_AREA="{{ nws_area }}" LOCAL_OUT="{{ root }}/web/public/weather" \
        cargo run --manifest-path crates/Cargo.toml -p weather-ingest -- {{ job }}

# 'all' runs the paced ~3 min global lattice, hence the disabled read timeout.
# Invoke the deployed weather-ingest once after deploy to populate weather/
prime job="all":
    aws lambda invoke --function-name stormdeck-weather-ingest --region {{ region }} {{ profile_flag }} --payload '{"job":"{{ job }}"}' --cli-binary-format raw-in-base64-out --cli-read-timeout 0 /dev/stdout
