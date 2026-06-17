# Live weather: NWS alerts + NOAA GFS temperatures (lattice + city tiles) and wind.

set working-directory := '..'

import 'common.just'

# Fetch live weather into web/public/weather/ for local dev (no AWS).
# Jobs: alerts | temp (city tiles + lattice) | windtex | all. 'temp'/'windtex'
# each decode ~57 GFS fields (a couple minutes); 'alerts' is quick.
local job="all":
    NWS_AREA="{{ nws_area }}" LOCAL_OUT="{{ root }}/web/public/weather" \
        cargo run --manifest-path crates/Cargo.toml -p weather-ingest -- {{ job }}

# 'temp'/'windtex' each decode ~57 GFS fields, hence the disabled read timeout.
# Invoke the deployed weather-ingest once after deploy to populate weather/
prime job="all":
    aws lambda invoke --function-name stormdeck-weather-ingest --region {{ region }} {{ profile_flag }} --payload '{"job":"{{ job }}"}' --cli-binary-format raw-in-base64-out --cli-read-timeout 0 /dev/stdout
