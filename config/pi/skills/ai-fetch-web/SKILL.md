---
name: ai-fetch-web
description: >-
  Reach for the `ai-fetch-web` CLI for web access - search the web, fetch a URL as clean markdown, batch-fetch many URLs
  in parallel, convert raw HTML, list links, extract CSS-selector fields, read page metadata, or screenshot a page -
  whenever it is on `$PATH`. Prefer it over harness-native web tools (built-in `fetch`, MCP `fetch_web`, browser
  plugins) because its output is stable across harnesses, strips response chrome by default, and exposes a `--json`
  passthrough for programmatic callers. Skip it only when the user is testing raw HTTP behavior (headers, redirects,
  POST body shape) - that is `curl`'s job.
---

# ai-fetch-web

`ai-fetch-web` is a single bash script (no runtime other than `bash` + `curl` + `jq` + `awk` + `base64`) that wraps a
`fetch_web` MCP server so any agent harness can use it without MCP client code.

Run `ai-fetch-web --help` in a shell for the authoritative reference. This file is the orientation doc.

## When to use

- **Default web access** when `ai-fetch-web` is on `$PATH`. It replaces ad-hoc `curl` + "please parse this HTML" prompts
  and replaces harness-native fetch_web MCP calls where the MCP integration is unavailable or noisy.
- Reach for it for: web search, fetching a URL as clean markdown, batch-fetching multiple URLs in one call, extracting
  page fields by CSS selector, or capturing a screenshot.
- **Do not** use `ai-fetch-web` when the user is testing a specific HTTP behavior (headers, redirects, POST body shape),
  that is raw `curl`'s job. `ai-fetch-web` hides response metadata by default.

## Quickstart

```sh
# Search
ai-fetch-web search "rust 1.0 release" --limit 5

# Fetch one URL → clean markdown on stdout
ai-fetch-web fetch https://example.com

# Fetch many URLs in one server-side parallel batch
ai-fetch-web fetch-many https://a.example https://b.example

# Structured extraction (JSON on stdout)
ai-fetch-web extract https://shop.example --fields 'title:h1;price:.price'

# Screenshot (curl-style: -o PATH, or stdout if redirected)
ai-fetch-web screenshot https://example.com -o /tmp/page.png

# Ping the server / verify config
ai-fetch-web defaults
```

## Subcommand reference

| Subcommand                      | Required args                                   | Notable flags                                                          | Default stdout                                                                |
| ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `search <query>`                | query                                           | `--limit N`, `--engines a,b`, `--categories c`                         | `Query: ...\nResult Count: N\n\n<numbered results with URL/Snippet>`          |
| `fetch <url>`                   | url                                             | `--format markdown\|html\|text\|readability\|summary\|chunks`, `--raw` | article body (markdown by default); response metadata stripped unless `--raw` |
| `fetch-many <url>... \| -`      | urls (or `-` + stdin, one URL per line)         | `--format`, `--raw`                                                    | per-request status/prelude + body blocks                                      |
| `convert --html-file PATH \| -` | HTML source                                     | `--base-url URL`, `--format`, `--raw`                                  | converted body                                                                |
| `links <url>`                   | url                                             | `--raw`                                                                | markdown link list, one per line                                              |
| `extract <url>`                 | url + (`--fields SPEC` or `--fields-file PATH`) | `--raw`                                                                | JSON `{data: {...}}` block                                                    |
| `metadata <url>`                | url                                             | `--raw`                                                                | JSON metadata object (title, language, og:\*, jsonLd, feeds)                  |
| `screenshot <url>`              | url                                             | `-o PATH`                                                              | PNG bytes (to stdout if no `-o` and stdout is not a tty)                      |
| `defaults`                      | -                                               | -                                                                      | server's read-only defaults JSON (use as a ping)                              |

### `--fields` short-form

`--fields 'name:selector;name:selector'` creates a `{type: "value", selector: "..."}` schema entry per pair. For `list`
or `table` fields, or extras like `attribute`/`format`, pass `--fields-file PATH` with a full JSON schema:

```json
{
  "products": {
    "type": "list",
    "selector": "main article.product",
    "fields": {
      "name": { "type": "value", "selector": "h2" },
      "price": { "type": "value", "selector": ".price" }
    }
  }
}
```

## `--json` for programmatic callers

Every subcommand accepts `--json`. With it, stdout is the raw MCP `result` object (same shape as the server's tool
response) instead of the rendered view. Use `--json` whenever you pipe to `jq` or store the response:

```sh
ai-fetch-web search "rust 1.0 release" --json \
  | jq -r '.content[].text'

ai-fetch-web metadata https://example.com --json \
  | jq -r '.content[0].text | fromjson | .openGraph'
```

The rendered default is designed to be parseable too (blocks + `Key: value` preludes), but `--json` is strictly better
when you need a stable shape.

## Configuration

`ai-fetch-web` has no built-in server URL. Set these env vars before use:

| Variable               | Required | Description                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------------- |
| `AI_FETCH_WEB_URL`     | required | MCP endpoint URL, e.g. `https://mcp.example.com/fetch/`                                |
| `AI_FETCH_WEB_AUTH`    | optional | verbatim value for the `Authorization:` header, e.g. `Basic abc...` or `Bearer sk-...` |
| `AI_FETCH_WEB_HEADERS` | optional | extra `Header: value` pairs, newline- or `;`-separated                                 |

Verify configuration at any time:

```sh
ai-fetch-web defaults           # returns the server's defaults JSON
ai-fetch-web -v defaults        # and shows the config source + JSON-RPC trace on stderr
```

## Limits and non-goals

- **One request per invocation.** No caching, no automatic retries. Wrap in `until` / `jq` / shell retry logic if you
  need that.
- **No streaming.** The server answers MCP JSON-RPC with a single SSE frame; `ai-fetch-web` reads it whole.
- **No headless browser on the client side.** All rendering (including `screenshot`) is done server-side; the CLI just
  ships bytes.
- **Exit codes:** `0` success, `1` tool/RPC error, `2` usage error (unknown flag, missing arg, bad selector format), `3`
  config missing or network/HTTP failure. Prefer checking `$?` over parsing stderr.
