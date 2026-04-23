#!/usr/bin/env bats
# Tests for lib/node/ai-tooling/pricing.ts.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_isolated_home
  export XDG_CACHE_HOME="${BATS_TEST_TMPDIR}/cache"
  PROBE="${REPO_ROOT}/tests/fixtures/ai-tooling-probe.ts"

  if ! command -v node >/dev/null 2>&1; then
    skip "node not installed"
  fi
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "${node_major}" -lt 23 ]]; then
    skip "node ${node_major} lacks built-in TypeScript type stripping"
  fi
}

seed_pricing_cache() {
  mkdir -p "${XDG_CACHE_HOME}/ai-tool-usage"
  local fetched_at="${1:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  cat >"${XDG_CACHE_HOME}/ai-tool-usage/pricing.json" <<EOF
{"fetched_at":"${fetched_at}","data":{"cached-model":{"input_cost_per_token":1e-6,"output_cost_per_token":2e-6}}}
EOF
}

@test "pricing: lookupPricing matches exact model id" {
  run node "${PROBE}" lookup-inline test-opus
  assert_success
  # Compare numerically since jq re-formats e-notation into fixed decimals.
  assert_equal "$(jq '.inputPerToken == 1e-5' <<<"${output}")" 'true'
  assert_equal "$(jq '.outputPerToken == 5e-5' <<<"${output}")" 'true'
}

@test "pricing: lookupPricing strips -YYYYMMDD date suffix" {
  run node "${PROBE}" lookup-inline test-opus-20260101
  assert_success
  assert_equal "$(jq 'type' <<<"${output}")" '"object"'
  assert_equal "$(jq '.outputPerToken == 5e-5' <<<"${output}")" 'true'
}

@test "pricing: lookupPricing strips bracketed tag like [1m]" {
  run node "${PROBE}" lookup-inline 'test-opus[1m]'
  assert_success
  assert_equal "$(jq 'type' <<<"${output}")" '"object"'
  assert_equal "$(jq '.inputPerToken == 1e-5' <<<"${output}")" 'true'
}

@test "pricing: lookupPricing falls back to anthropic/ provider prefix" {
  run node "${PROBE}" lookup-inline test-sonnet
  assert_success
  assert_equal "$(jq '.inputPerToken == 3e-6' <<<"${output}")" 'true'
}

@test "pricing: lookupPricing falls back to openai/ provider prefix" {
  run node "${PROBE}" lookup-inline test-gpt
  assert_success
  assert_equal "$(jq '.inputPerToken == 2e-6' <<<"${output}")" 'true'
}

@test "pricing: lookupPricing returns null for unknown model" {
  run node "${PROBE}" lookup-inline bogus-model
  assert_success
  assert_equal "${output}" 'null'
}

@test "pricing: loadPricing uses fresh cache without fetching" {
  seed_pricing_cache

  # If the loader tried to fetch, we'd need network. With a fresh cache it
  # must take the cache path and return source='cache'.
  run node "${PROBE}" load
  assert_success
  assert_equal "$(jq -r '.source' <<<"${output}")" 'cache'
  assert_equal "$(jq '.models' <<<"${output}")" 1
}

@test "pricing: estimateAnthropicCost charges input, output, cache read + write separately" {
  # in=$1 out=$2 cacheRead=$3 cacheWrite=$4 then tokens: in out cr cw
  run node "${PROBE}" cost-anthropic 1e-5 5e-5 1e-6 1.25e-5 1000 500 10000 2000
  assert_success
  # 1000*1e-5 + 500*5e-5 + 10000*1e-6 + 2000*1.25e-5
  # = 0.01 + 0.025 + 0.01 + 0.025 = 0.07
  run awk -v a="${output}" -v e=0.07 'BEGIN { d = a - e; if (d < 0) d = -d; exit (d > 0.0001) }'
  assert_success
}

@test "pricing: estimateOpenAICost splits cached from fresh input" {
  # OpenAI semantics: total input includes cached. input=5000 (3000 fresh
  # + 2000 cached). Rates: in=2e-6, out=8e-6, cr=5e-7.
  run node "${PROBE}" cost-openai 2e-6 8e-6 5e-7 0 5000 1000 2000 0
  assert_success
  # fresh = 5000 - 2000 = 3000.  3000*2e-6 + 2000*5e-7 + 1000*8e-6
  # = 0.006 + 0.001 + 0.008 = 0.015
  run awk -v a="${output}" -v e=0.015 'BEGIN { d = a - e; if (d < 0) d = -d; exit (d > 0.0001) }'
  assert_success
}
