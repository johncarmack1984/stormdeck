# SEO/GEO audit - stormdeck.live

`https://stormdeck.live` | generated 20260701T215935Z | positioning: stormdeck.live is a free, open-source (MIT) live weather map: real-time US radar and NWS severe-weather alerts plus global GFS forecasts (temperature, animated wind, precipitation, storm potential) scrubbed on one timeline, built with deck.gl + MapLibre and served from near-free-tier AWS.

## Findings (ranked)

- [HIGH] `crawl:schema.missing` - No JSON-LD structured data in server HTML (no Person/ProfilePage entity for Google or LLMs).
- [HIGH] `crawl:render.thin_shell` - Server HTML has only 1 words of text - looks like an unprerendered SPA shell (install the 'render' extra to quantify the JS-gap precisely).
- [MED] `crawl:sitemap.missing` - No /sitemap.xml (200).
- [MED] `github:github.no_topics` - repo has no topics (GitHub search keywords - add your niche terms).
- [MED] `serper:serper.unranked` - stormdeck.live ranks for none of the seed keywords (expected for a new/niche personal site; this is the baseline to move).
- [LOW] `crawl:title.length` - Title is 9 chars (aim 15-65).
- [LOW] `crawl:canonical.missing` - No rel=canonical link.
- [LOW] `gsc:gsc.no_property` - surface has no gsc_property set.
- [LOW] `bing:bing.error` - Bing API returned 400 (is the site verified for this key?).
- [LOW] `dataforseo:dataforseo.zero_volume` - 3 seed terms show ~0 volume: gfs model viewer, open source weather map, deck.gl weather map

## Signals by provider

### crawl - Tier 0 (free) - ok
- **final_url**: https://stormdeck.live
- **status**: 200
- **title**: stormdeck
- **title_len**: 9
- **meta_description**: Live weather over OpenStreetMap — deck.gl + martin
- **canonical**: None
- **html_lang**: en
- **og_tags**: 0
- **twitter_tags**: 0
- **h1_raw**: (none)
- **raw_html_words**: 1
- **jsonld_types_raw**: (none)
- **rendered**: skipped (install 'render' extra for the JS-gap)
- **robots_txt**: 403
- **sitemap_xml**: 403

### psi - Tier 0 (free) - error
- error: `HTTPStatusError: Server error '500 Internal Server Error' for url 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fstormdeck.live&key=REDACTED&strategy=mobile&category=PERFORMANCE'
For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500`

### gsc - Tier 0 (free) - skipped

### github - Tier 0 (free) - ok
- **description**: Live weather on a deck.gl map, served from AWS free tiers
- **topics**: (none)
- **stars**: 0
- **homepage**: https://stormdeck.live
- **views_14d**: 2
- **uniques_14d**: 1

### bing - Tier 0 (free) - ok
- **bing**: HTTP 400

### trends - Tier 0 (free) - ok
- **avg_interest_12m**: live wind map: 46.0, live weather radar map: 36.3, weather alerts map: 18.1, global weather forecast map: 13.5, animated wind map: 0.1  _0-100 relative_

### dataforseo - Tier 1 (SERP/volume) - ok
- **keyword_volumes**: live weather radar map: 2900/mo (comp=LOW, cpc=1.06), weather alerts map: 1900/mo (comp=LOW, cpc=1.2), live wind map: 720/mo (comp=LOW, cpc=0.22), animated wind map: 30/mo (comp=LOW, cpc=None), global weather forecast map: 10/mo (comp=LOW, cpc=None), gfs model viewer: 0/mo (comp=None, cpc=None), open source weather map: 0/mo (comp=None, cpc=None), deck.gl weather map: 0/mo (comp=None, cpc=None)
- **api_cost_usd**: 0.09

### serper - Tier 1 (SERP/volume) - ok
- **serp_positions**: live weather radar map: not in top 10, live wind map: not in top 10, animated wind map: not in top 9, weather alerts map: not in top 10, global weather forecast map: not in top 9, gfs model viewer: not in top 10, open source weather map: not in top 10, deck.gl weather map: not in top 10

### geo_probe - Tier 2 (GEO probes) - ok
- **perplexity**: surfaced 3/4, conflated 0, cited 0  _[What is stormdeck.live and what do...] surfaced; [Who built stormdeck, the live weat...] surfaced; [What are some free websites that s...] absent; [Are there open-source weather maps...] surfaced_
- **openai**: surfaced 3/4, conflated 0, cited 0  _[What is stormdeck.live and what do...] surfaced; [Who built stormdeck, the live weat...] surfaced; [What are some free websites that s...] absent; [Are there open-source weather maps...] surfaced_
- **anthropic**: surfaced 3/4, conflated 0, cited 0  _[What is stormdeck.live and what do...] surfaced; [Who built stormdeck, the live weat...] surfaced; [What are some free websites that s...] absent; [Are there open-source weather maps...] surfaced_
- **gemini**: surfaced 3/4, conflated 0, cited 0  _[What is stormdeck.live and what do...] surfaced; [Who built stormdeck, the live weat...] surfaced; [What are some free websites that s...] absent; [Are there open-source weather maps...] surfaced_

## Available if promoted (paid tiers, currently stubbed)

- **ahrefs** (Tier 3 (backlinks)): Backlink profile + referring domains + organic keyword/competitor gap - needs `AHREFS_API_KEY`
- **semrush** (Tier 3 (backlinks)): Domain/organic research + backlinks + competitor keyword gap (Semrush) - needs `SEMRUSH_API_KEY`
