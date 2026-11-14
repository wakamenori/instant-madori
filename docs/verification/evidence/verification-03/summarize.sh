#!/usr/bin/env bash
# Usage: summarize.sh events.jsonl
# Prints the measured values of plan 6.1b unit 3 from fetch-logs.sh output. The median is the
# lower middle value when the count is even. "warm" container handling excludes the first
# request after each cold start, which also builds the display data's first response.
set -euo pipefail
jq -s '
  def stats: sort | {n: length, min: .[0], median: (if length == 0 then null else .[(length - 1) / 2 | floor] end), max: .[-1]};
  def display: select(.event == "geometry.request" and .route == "/v1/sample/display");
  ([.[] | select(.event == "api.request" and .geometryStart == "cold") | .traceId]) as $coldTraces
  | {
    coldReadyMs: [.[] | select(.event == "container.ready" and .mode == "cold") | .ms] | stats,
    coldRequestGeometryMs: [.[] | select(.event == "api.request" and .geometryStart == "cold") | .geometryMs] | stats,
    warmRequestGeometryMs: [.[] | select(.event == "api.request" and .geometryStart == "warm") | .geometryMs] | stats,
    warmContainerHandlerMs: [.[] | display | select(.traceId as $t | $coldTraces | index($t) | not) | .ms] | stats,
    warmContainerHandlerMsByStart: (
      [.[] | select(.event == "container.started") | .t] as $starts
      | [.[] | display | select(.traceId as $t | $coldTraces | index($t) | not)]
      | group_by(.t as $t | [$starts[] | select(. <= $t)] | max)
      | map({start: (.[0].t as $t | [$starts[] | select(. <= $t)] | max), ms: (map(.ms) | stats)})
    ),
    maxVmHwmKib: [.[] | select(.event == "geometry.request") | .vmHwmKib] | max,
    limits: [.[] | select(.event == "geometry.limits") | {t, cgroupCpuMax, cgroupMemoryMax, parallelism}],
    counts: {
      apiRequests: [.[] | select(.event == "api.request")] | length,
      containerDisplayLines: [.[] | display] | length,
      failedApiRequests: [.[] | select(.event == "api.request" and .status != 200)] | length
    },
    containerEvents: [.[] | select(((.event // "") | tostring | startswith("container.")) or ((.message // "") | tostring | startswith("Container exited"))) | {t, event: (.event // .message), mode, ms}]
  }' "$1"
