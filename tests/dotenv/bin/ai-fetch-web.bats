#!/usr/bin/env bats
# Tests for dotenv/bin/ai-fetch-web.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home
  SCRIPT="${REPO_ROOT}/dotenv/bin/ai-fetch-web"

  export AI_FETCH_WEB_URL="http://mock.invalid/mcp/"
  export AI_FETCH_WEB_AUTH="Bearer test-token"

  # Default canned body + status for the curl stub. Tests override as needed.
  export FAKE_CURL_BODY_FILE="${BATS_TEST_TMPDIR}/body"
  export FAKE_CURL_STATUS="200"
  export FAKE_CURL_CAPTURE_DIR="${BATS_TEST_TMPDIR}/capture"
  mkdir -p "${FAKE_CURL_CAPTURE_DIR}"
  printf '{}' >"${FAKE_CURL_BODY_FILE}"

  stub_curl
}

# A curl stub that:
#   * parses `-o <path>` / `-w <fmt>` / `--data-binary <payload>` / the URL,
#   * writes FAKE_CURL_BODY_FILE to `-o <path>` (or stdout),
#   * captures URL / HEADERS / PAYLOAD into separate files under
#     FAKE_CURL_CAPTURE_DIR so newline-containing payloads survive,
#   * exits with FAKE_CURL_STATUS as its %{http_code} output on stdout.
stub_curl() {
  stub_command curl <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""
payload=""
url=""
headers=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -X) shift 2 ;;
    -H) headers+=("$2"); shift 2 ;;
    -sS|--silent|--show-error) shift ;;
    --max-time) shift 2 ;;
    --data-binary) payload="$2"; shift 2 ;;
    http*|https*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s' "${url}" >"${FAKE_CURL_CAPTURE_DIR}/url"
: >"${FAKE_CURL_CAPTURE_DIR}/headers"
for h in "${headers[@]}"; do
  printf '%s\n' "${h}" >>"${FAKE_CURL_CAPTURE_DIR}/headers"
done
printf '%s' "${payload}" >"${FAKE_CURL_CAPTURE_DIR}/payload"
if [[ -n "${out}" ]]; then
  cat "${FAKE_CURL_BODY_FILE}" >"${out}"
else
  cat "${FAKE_CURL_BODY_FILE}"
fi
printf '%s' "${FAKE_CURL_STATUS}"
EOF
}

# Writes an SSE-wrapped tools/call `{content:[{type:"text",text:TEXT}]}`
# result to FAKE_CURL_BODY_FILE. Uses compact JSON because SSE `data:`
# frames must be single-line per the spec (and my awk parser enforces it).
set_tool_text_response() {
  local text="$1"
  local body
  body="$(jq -cn --arg t "${text}" \
    '{jsonrpc:"2.0", id:1, result:{content:[{type:"text", text:$t}]}}')"
  printf 'event: message\ndata: %s\n\n' "${body}" >"${FAKE_CURL_BODY_FILE}"
}

# Writes a bare-JSON tools/call result instead of SSE.
set_tool_text_bare_response() {
  local text="$1"
  jq -cn --arg t "${text}" \
    '{jsonrpc:"2.0", id:1, result:{content:[{type:"text", text:$t}]}}' \
    >"${FAKE_CURL_BODY_FILE}"
}

# Writes a tools/call `isError:true` response with a given error text.
set_tool_error_response() {
  local text="$1"
  local body
  body="$(jq -cn --arg t "${text}" \
    '{jsonrpc:"2.0", id:1, result:{isError:true, content:[{type:"text", text:$t}]}}')"
  printf 'event: message\ndata: %s\n\n' "${body}" >"${FAKE_CURL_BODY_FILE}"
}

# Writes a JSON-RPC transport-level error.
set_rpc_error_response() {
  local msg="$1"
  local body
  body="$(jq -cn --arg m "${msg}" \
    '{jsonrpc:"2.0", id:1, error:{code:-32601, message:$m}}')"
  printf 'event: message\ndata: %s\n\n' "${body}" >"${FAKE_CURL_BODY_FILE}"
}

# Writes a resources/read response with the given text payload.
set_resource_text_response() {
  local uri="$1"
  local text="$2"
  local body
  body="$(jq -cn --arg u "${uri}" --arg t "${text}" \
    '{jsonrpc:"2.0", id:1, result:{contents:[{uri:$u, mimeType:"application/json", text:$t}]}}')"
  printf 'event: message\ndata: %s\n\n' "${body}" >"${FAKE_CURL_BODY_FILE}"
}

# Writes a tools/call image response (base64 payload pre-encoded by caller).
set_tool_image_response() {
  local b64="$1"
  local body
  body="$(jq -cn --arg d "${b64}" \
    '{jsonrpc:"2.0", id:1, result:{content:[{type:"image", data:$d, mimeType:"image/png"}]}}')"
  printf 'event: message\ndata: %s\n\n' "${body}" >"${FAKE_CURL_BODY_FILE}"
}

# Pull captured fields out of the per-request capture directory.
captured_payload() { cat "${FAKE_CURL_CAPTURE_DIR}/payload" 2>/dev/null; }
captured_url() { cat "${FAKE_CURL_CAPTURE_DIR}/url" 2>/dev/null; }
captured_headers() { cat "${FAKE_CURL_CAPTURE_DIR}/headers" 2>/dev/null; }

# ──────────────────────────────────────────────────────────────────
# Help & dispatch
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web: --help lists all subcommands" {
  run bash "${SCRIPT}" --help
  assert_success
  assert_output --partial "Usage: ai-fetch-web"
  for op in search fetch fetch-many convert links extract metadata screenshot defaults; do
    assert_output --partial "${op}"
  done
}

@test "ai-fetch-web: unknown subcommand exits 2" {
  run bash "${SCRIPT}" bogus
  assert_failure
  [[ "${status}" -eq 2 ]]
  assert_output --partial "unknown subcommand: bogus"
}

@test "ai-fetch-web: missing op prints help to stderr and exits 2" {
  run bash "${SCRIPT}"
  assert_failure
  [[ "${status}" -eq 2 ]]
  assert_output --partial "Usage: ai-fetch-web"
}

@test "ai-fetch-web: unknown global flag exits 2" {
  run bash "${SCRIPT}" --bogus-flag search q
  assert_failure
  [[ "${status}" -eq 2 ]]
  assert_output --partial "unknown global flag"
}

# ──────────────────────────────────────────────────────────────────
# Config loading
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web: missing config exits 3" {
  unset AI_FETCH_WEB_URL AI_FETCH_WEB_AUTH
  run bash "${SCRIPT}" search q
  assert_failure
  [[ "${status}" -eq 3 ]]
  assert_output --partial "no MCP server configured"
}

@test "ai-fetch-web: AI_FETCH_WEB_AUTH env becomes Authorization header" {
  set_tool_text_response "ok"
  run bash "${SCRIPT}" search q
  assert_success
  run captured_headers
  assert_output --partial "Authorization: Bearer test-token"
  assert_output --partial "Content-Type: application/json"
  assert_output --partial "Accept: application/json, text/event-stream"
}

@test "ai-fetch-web: AI_FETCH_WEB_HEADERS splits newlines and semicolons" {
  export AI_FETCH_WEB_HEADERS="X-One: alpha
X-Two: beta;X-Three: gamma"
  set_tool_text_response "ok"
  run bash "${SCRIPT}" search q
  assert_success
  run captured_headers
  assert_output --partial "X-One: alpha"
  assert_output --partial "X-Two: beta"
  assert_output --partial "X-Three: gamma"
}

# ──────────────────────────────────────────────────────────────────
# JSON-RPC payload shape
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web search: builds tools/call with query + limit + engines" {
  set_tool_text_response "query ok"
  run bash "${SCRIPT}" search "rust 1.0" --limit 5 --engines google,bing
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r .method <<<"${payload}")" == "tools/call" ]]
  [[ "$(jq -r .params.name <<<"${payload}")" == "fetch_web-search_web" ]]
  [[ "$(jq -r .params.arguments.query <<<"${payload}")" == "rust 1.0" ]]
  [[ "$(jq -r .params.arguments.limit <<<"${payload}")" == "5" ]]
  [[ "$(jq -r '.params.arguments.engines | join(",")' <<<"${payload}")" == "google,bing" ]]
}

@test "ai-fetch-web search: rejects non-numeric --limit" {
  run bash "${SCRIPT}" search hi --limit abc
  assert_failure
  [[ "${status}" -eq 2 ]]
  assert_output --partial "--limit must be a non-negative integer"
}

@test "ai-fetch-web fetch: builds tools/call with url only" {
  set_tool_text_response "some text"
  run bash "${SCRIPT}" fetch https://example.com
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r .params.name <<<"${payload}")" == "fetch_web-fetch_url" ]]
  [[ "$(jq -r .params.arguments.url <<<"${payload}")" == "https://example.com" ]]
  [[ "$(jq -r '.params.arguments | has("format")' <<<"${payload}")" == "false" ]]
}

@test "ai-fetch-web fetch: --format is passed through" {
  set_tool_text_response "body"
  run bash "${SCRIPT}" fetch https://example.com --format html
  assert_success
  [[ "$(jq -r .params.arguments.format <<<"$(captured_payload)")" == "html" ]]
}

@test "ai-fetch-web fetch-many: wraps each URL in an object" {
  set_tool_text_response "body"
  run bash "${SCRIPT}" fetch-many https://a.example https://b.example
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r .params.name <<<"${payload}")" == "fetch_web-fetch_urls" ]]
  [[ "$(jq -r '.params.arguments.urls | length' <<<"${payload}")" == "2" ]]
  [[ "$(jq -r '.params.arguments.urls[0].url' <<<"${payload}")" == "https://a.example" ]]
  [[ "$(jq -r '.params.arguments.urls[1].url' <<<"${payload}")" == "https://b.example" ]]
}

@test "ai-fetch-web fetch-many: applies --format per-URL, not top-level" {
  set_tool_text_response "body"
  run bash "${SCRIPT}" fetch-many --format markdown https://a.example
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r '.params.arguments.urls[0].format' <<<"${payload}")" == "markdown" ]]
  [[ "$(jq -r '.params.arguments | has("format")' <<<"${payload}")" == "false" ]]
}

@test "ai-fetch-web fetch-many: reads URLs from stdin with -" {
  set_tool_text_response "body"
  run bash -c "printf 'https://a.example\nhttps://b.example\n' | bash '${SCRIPT}' fetch-many -"
  assert_success
  [[ "$(jq -r '.params.arguments.urls | length' <<<"$(captured_payload)")" == "2" ]]
}

@test "ai-fetch-web convert: reads HTML from stdin via -" {
  set_tool_text_response "# H"
  run bash -c "printf '<h1>Hi</h1>' | bash '${SCRIPT}' convert --html-file -"
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r .params.name <<<"${payload}")" == "fetch_web-convert_html" ]]
  [[ "$(jq -r .params.arguments.html <<<"${payload}")" == "<h1>Hi</h1>" ]]
}

@test "ai-fetch-web convert: escapes nasty characters correctly" {
  set_tool_text_response "ok"
  local html='<p class="x">$1 \n "quoted" & <script>alert(1)</script></p>'
  run bash -c "printf '%s' '${html//\'/\'\\\'\'}' | bash '${SCRIPT}' convert --html-file -"
  assert_success
  local payload got
  payload="$(captured_payload)"
  got="$(jq -r .params.arguments.html <<<"${payload}")"
  [[ "${got}" == "${html}" ]]
}

@test "ai-fetch-web extract: builds schema object with type:value" {
  set_tool_text_response "{}"
  run bash "${SCRIPT}" extract https://e.example --fields 'title:h1;body:p'
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r .params.name <<<"${payload}")" == "fetch_web-extract_fields" ]]
  [[ "$(jq -r .params.arguments.url <<<"${payload}")" == "https://e.example" ]]
  [[ "$(jq -r '.params.arguments.schema.title.type' <<<"${payload}")" == "value" ]]
  [[ "$(jq -r '.params.arguments.schema.title.selector' <<<"${payload}")" == "h1" ]]
  [[ "$(jq -r '.params.arguments.schema.body.selector' <<<"${payload}")" == "p" ]]
}

@test "ai-fetch-web extract: missing --fields and --fields-file exits 2" {
  run bash "${SCRIPT}" extract https://e.example
  assert_failure
  [[ "${status}" -eq 2 ]]
  assert_output --partial "need --fields or --fields-file"
}

@test "ai-fetch-web extract: --fields-file loads full JSON schema" {
  local schema="${BATS_TEST_TMPDIR}/schema.json"
  cat >"${schema}" <<'JSON'
{
  "items": { "type": "list", "selector": "article .product", "fields": { "name": { "type": "value", "selector": "h2" } } }
}
JSON
  set_tool_text_response "{}"
  run bash "${SCRIPT}" extract https://e.example --fields-file "${schema}"
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r '.params.arguments.schema.items.type' <<<"${payload}")" == "list" ]]
  [[ "$(jq -r '.params.arguments.schema.items.fields.name.selector' <<<"${payload}")" == "h2" ]]
}

@test "ai-fetch-web defaults: uses resources/read with the defaults URI" {
  set_resource_text_response "config://fetch-web-mcp/defaults" '{"serverName":"fetch-web-mcp"}'
  run bash "${SCRIPT}" defaults
  assert_success
  local payload
  payload="$(captured_payload)"
  [[ "$(jq -r .method <<<"${payload}")" == "resources/read" ]]
  [[ "$(jq -r .params.uri <<<"${payload}")" == "config://fetch-web-mcp/defaults" ]]
  assert_output --partial '{"serverName":"fetch-web-mcp"}'
}

# ──────────────────────────────────────────────────────────────────
# SSE / JSON framing + error paths
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web: bare-JSON response is accepted" {
  set_tool_text_bare_response "bare body"
  run bash "${SCRIPT}" fetch https://example.com
  assert_success
  assert_output --partial "bare body"
}

@test "ai-fetch-web: malformed response body exits 3" {
  printf 'not-json-and-not-sse\n' >"${FAKE_CURL_BODY_FILE}"
  run bash "${SCRIPT}" fetch https://example.com
  assert_failure
  [[ "${status}" -eq 3 ]]
  assert_output --partial "could not parse response body"
}

@test "ai-fetch-web: HTTP 500 exits 3 with body excerpt" {
  export FAKE_CURL_STATUS=500
  printf 'server exploded' >"${FAKE_CURL_BODY_FILE}"
  run bash "${SCRIPT}" fetch https://example.com
  assert_failure
  [[ "${status}" -eq 3 ]]
  assert_output --partial "HTTP 500"
  assert_output --partial "server exploded"
}

@test "ai-fetch-web: JSON-RPC transport error exits 1" {
  set_rpc_error_response "method not found"
  run bash "${SCRIPT}" fetch https://example.com
  assert_failure
  [[ "${status}" -eq 1 ]]
  assert_output --partial "JSON-RPC error"
  assert_output --partial "method not found"
}

@test "ai-fetch-web: tool-level isError:true exits 1 with inner text" {
  set_tool_error_response "Tool not found"
  run bash "${SCRIPT}" fetch https://example.com
  assert_failure
  [[ "${status}" -eq 1 ]]
  assert_output --partial "tool error"
  assert_output --partial "Tool not found"
}

# ──────────────────────────────────────────────────────────────────
# Response rendering
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web fetch: strips fetch_web prelude by default" {
  set_tool_text_response "Requested URL: https://e.example
Status: 200
Article-Title: Hello

# Hello

Body paragraph."
  run bash "${SCRIPT}" fetch https://e.example
  assert_success
  # Body is printed; prelude header keys are not.
  assert_output --partial "# Hello"
  assert_output --partial "Body paragraph."
  refute_output --partial "Requested URL:"
  refute_output --partial "Article-Title:"
}

@test "ai-fetch-web fetch: --raw keeps the prelude" {
  set_tool_text_response "Requested URL: https://e.example
Status: 200

# Hello"
  run bash "${SCRIPT}" fetch https://e.example --raw
  assert_success
  assert_output --partial "Requested URL: https://e.example"
  assert_output --partial "Status: 200"
  assert_output --partial "# Hello"
}

@test "ai-fetch-web fetch: --json returns raw MCP result object" {
  set_tool_text_response "body"
  run bash "${SCRIPT}" fetch https://e.example --json
  assert_success
  [[ "$(jq -r '.content[0].type' <<<"${output}")" == "text" ]]
  [[ "$(jq -r '.content[0].text' <<<"${output}")" == "body" ]]
}

@test "ai-fetch-web fetch: body without prelude passes through unchanged" {
  set_tool_text_response "no header here
just a body"
  run bash "${SCRIPT}" fetch https://e.example
  assert_success
  assert_output --partial "no header here"
  assert_output --partial "just a body"
}

@test "ai-fetch-web search: prelude-style rendered view is preserved" {
  # Search's text content is self-describing and should NOT be stripped.
  set_tool_text_response "Query: hi
Result Count: 1

1. Title
URL: https://x.example
Snippet: thing"
  run bash "${SCRIPT}" search hi
  assert_success
  assert_output --partial "Query: hi"
  assert_output --partial "Result Count: 1"
  assert_output --partial "URL: https://x.example"
}

# ──────────────────────────────────────────────────────────────────
# Screenshot
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web screenshot: writes PNG bytes to -o PATH" {
  local png_b64
  png_b64="$(printf '\x89PNG\r\n\x1a\nFAKEPNGBYTES' | base64 -w0)"
  set_tool_image_response "${png_b64}"
  local out="${BATS_TEST_TMPDIR}/shot.png"
  run bash "${SCRIPT}" screenshot https://e.example -o "${out}"
  assert_success
  [[ -f "${out}" ]]
  local head4
  head4="$(head -c 4 "${out}")"
  [[ "${head4}" == $'\x89PNG' ]]
}

@test "ai-fetch-web screenshot: refuses to dump binary to a tty" {
  # Force stdout to look like a tty by running inside `script` (util-linux).
  # If `script` isn't available, skip.
  command -v script >/dev/null 2>&1 || skip "script(1) not available"
  local log="${BATS_TEST_TMPDIR}/script.log"
  run script -q -c "AI_FETCH_WEB_URL='${AI_FETCH_WEB_URL}' AI_FETCH_WEB_AUTH='${AI_FETCH_WEB_AUTH}' PATH='${PATH}' FAKE_CURL_BODY_FILE='${FAKE_CURL_BODY_FILE}' FAKE_CURL_STATUS='${FAKE_CURL_STATUS}' FAKE_CURL_CAPTURE_FILE='${FAKE_CURL_CAPTURE_FILE}' bash '${SCRIPT}' screenshot https://e.example" "${log}"
  # The script wrapper always succeeds; check the log for our error.
  grep -q "stdout is a terminal" "${log}"
}

# ──────────────────────────────────────────────────────────────────
# Unit-level helper tests via source_without_main
# ──────────────────────────────────────────────────────────────────

@test "ai-fetch-web: parse_sse_or_json handles SSE frame" {
  source_without_main "${SCRIPT}"
  run parse_sse_or_json <<<$'event: message\ndata: {"a":1}\n\n'
  assert_success
  [[ "$(jq -r .a <<<"${output}")" == "1" ]]
}

@test "ai-fetch-web: parse_sse_or_json handles bare JSON" {
  source_without_main "${SCRIPT}"
  run parse_sse_or_json <<<'{"b":2}'
  assert_success
  [[ "$(jq -r .b <<<"${output}")" == "2" ]]
}

@test "ai-fetch-web: parse_sse_or_json exits non-zero on empty body" {
  source_without_main "${SCRIPT}"
  run parse_sse_or_json </dev/null
  assert_failure
}

@test "ai-fetch-web: strip_fetch_prelude removes header block" {
  source_without_main "${SCRIPT}"
  run strip_fetch_prelude <<<$'A: one\nB: two\n\nbody line 1\nbody line 2'
  assert_success
  assert_output $'body line 1\nbody line 2'
}

@test "ai-fetch-web: strip_fetch_prelude leaves non-header input untouched" {
  source_without_main "${SCRIPT}"
  run strip_fetch_prelude <<<$'not a header\nsecond line'
  assert_success
  assert_output $'not a header\nsecond line'
}

@test "ai-fetch-web: strip_fetch_prelude handles body starting with blank line" {
  source_without_main "${SCRIPT}"
  run strip_fetch_prelude <<<$'\nbody'
  assert_success
  # Blank first line short-circuits the header detector; body survives.
  assert_output --partial "body"
}

@test "ai-fetch-web: extract_text concatenates text parts" {
  source_without_main "${SCRIPT}"
  run extract_text <<<'{"content":[{"type":"text","text":"a"},{"type":"image","data":"xx"},{"type":"text","text":"b"}]}'
  assert_success
  assert_output $'a\nb'
}

@test "ai-fetch-web: extract_image base64-decodes the first image part" {
  source_without_main "${SCRIPT}"
  local b64
  b64="$(printf 'RAWBYTES' | base64 -w0)"
  local result
  result="$(jq -cn --arg d "${b64}" \
    '{content:[{type:"text", text:"ignore"}, {type:"image", data:$d, mimeType:"image/png"}]}')"
  run extract_image <<<"${result}"
  assert_success
  assert_output "RAWBYTES"
}

@test "ai-fetch-web: parse_fields_spec wraps each value in {type:value,selector:...}" {
  source_without_main "${SCRIPT}"
  run parse_fields_spec "title:h1;body:.post p"
  assert_success
  [[ "$(jq -r .title.type <<<"${output}")" == "value" ]]
  [[ "$(jq -r .title.selector <<<"${output}")" == "h1" ]]
  [[ "$(jq -r '.body.selector' <<<"${output}")" == ".post p" ]]
}

@test "ai-fetch-web: build_args_fetch_urls wraps bare urls in objects" {
  source_without_main "${SCRIPT}"
  run build_args_fetch_urls "" https://a.example https://b.example
  assert_success
  [[ "$(jq -r '.urls | length' <<<"${output}")" == "2" ]]
  [[ "$(jq -r '.urls[0].url' <<<"${output}")" == "https://a.example" ]]
  [[ "$(jq -r '.urls[0] | has("format")' <<<"${output}")" == "false" ]]
}

@test "ai-fetch-web: build_args_fetch_urls applies format per-url" {
  source_without_main "${SCRIPT}"
  run build_args_fetch_urls "markdown" https://a.example
  assert_success
  [[ "$(jq -r '.urls[0].format' <<<"${output}")" == "markdown" ]]
}

# ──────────────────────────────────────────────────────────────────
# Live smoke tests (opt-in)
# ──────────────────────────────────────────────────────────────────
#
# Gated on DOT_AI_FETCH_WEB_LIVE=1 so the default test run stays offline
# and credential-free. Requires AI_FETCH_WEB_URL + AI_FETCH_WEB_AUTH.

@test "ai-fetch-web [live]: defaults round-trip" {
  [[ "${DOT_AI_FETCH_WEB_LIVE:-}" == "1" ]] || skip "DOT_AI_FETCH_WEB_LIVE not set"
  run bash "${SCRIPT}" defaults
  assert_success
  assert_output --partial '"serverName"'
}

@test "ai-fetch-web [live]: fetch example.com returns body content" {
  [[ "${DOT_AI_FETCH_WEB_LIVE:-}" == "1" ]] || skip "DOT_AI_FETCH_WEB_LIVE not set"
  run bash "${SCRIPT}" fetch https://example.com
  assert_success
}
