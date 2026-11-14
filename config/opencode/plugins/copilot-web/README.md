# `copilot-web`

Web search and single-URL reads through GitHub Copilot's model-native `web_search` tool, the Copilot slice of the pi
[`native-web`](../../../pi/extensions/native-web.md) extension. Server part only: [`server.ts`](./server.ts), with the
logic in [`lib/node/opencode/copilot-web.ts`](../../../../lib/node/opencode/copilot-web.ts) and the shared request /
parse helpers in [`lib/node/pi/copilot-web.ts`](../../../../lib/node/pi/copilot-web.ts).

## Native `websearch` backend

The plugin registers a `copilot` backend with `ctx.websearch.transform`, so opencode's built-in `websearch` tool runs on
Copilot instead of Exa. Each search is one `POST <copilot base>/responses` with `tools: [{type: "web_search"}]` and a
strict JSON schema, returning `{url, title, content, time.published}` results (one per source, each with a detailed
summary). When the model ignores the schema, the citations become the results instead. The backend becomes the default
when no other is selected (`setDefault`); pick another with `"websearch": { "provider": "<id>" }` in `opencode.jsonc`.

## `copilot_web_fetch` tool

A direct tool (`codemode: false`) with no permission gate: Copilot opens one `url` server-side and answers `prompt` from
that page only. It returns the model's answer, not the page, and appends a note when Copilot never reported opening the
exact URL. The built-in `webfetch` stays available for the exact page text; the tool description steers the model to
`copilot_web_fetch` when `webfetch` is blocked, the page needs JavaScript, or only an answer from a large page is
needed.

## Provider gating

Copilot web access is for Copilot models only. A session `context` hook runs
[`toolsToHide`](../../../../lib/node/opencode/copilot-web.ts) on every request: when the request's model is not on
`providerID` (default `github-copilot`), it drops `copilot_web_fetch` from the request's tools, and drops `websearch`
too while the `copilot` backend is the selected one. The built-in `webfetch` stays for every provider. Set `always` to
keep both tools on for every provider.

## Credentials and model

Credentials come from opencode's `github-copilot` integration (`ctx.integration.connection.active` / `.resolve`): the
stored GitHub OAuth token is the bearer and `metadata.apiEndpoint` is the host (`copilot-api.<host>` for an
`enterpriseUrl`, else `https://api.githubcopilot.com`). Searches always run on `model` (default `gpt-6-luna`), not the
session model, because only Copilot's GPT Responses models have `web_search`. Each call is one Copilot request on that
model; plans and org policies can disable web search.

## Options

Set options with a plugin entry in `opencode.jsonc` (see [Install](../README.md#install)). Every option also has an
`OPENCODE_COPILOT_WEB_*` environment override, which wins over the option.

| Option          | Env override                          | Default          | Effect                                                  |
| --------------- | ------------------------------------- | ---------------- | ------------------------------------------------------- |
| `enabled`       | `OPENCODE_COPILOT_WEB_ENABLED`        | `true`           | `false` disables the plugin entirely.                   |
| `websearch`     | `OPENCODE_COPILOT_WEB_WEBSEARCH`      | `true`           | Register the `copilot` websearch backend.               |
| `setDefault`    | `OPENCODE_COPILOT_WEB_SET_DEFAULT`    | `true`           | Make it the default backend when none is selected.      |
| `fetchTool`     | `OPENCODE_COPILOT_WEB_FETCH_TOOL`     | `true`           | Register the `copilot_web_fetch` tool.                  |
| `model`         | `OPENCODE_COPILOT_WEB_MODEL`          | `gpt-6-luna`     | Copilot Responses model that runs searches and fetches. |
| `timeoutMs`     | `OPENCODE_COPILOT_WEB_TIMEOUT_MS`     | `120000`         | Per-call timeout; calls also abort with the tool call.  |
| `integrationID` | `OPENCODE_COPILOT_WEB_INTEGRATION_ID` | `github-copilot` | opencode integration whose active connection is used.   |

## Limitations

- Copilot only. Unlike pi's `native-web`, opencode calls a `websearch` backend with just `{query}` (no session or
  model), so the backend cannot route by the session's provider, and there is no shared provider transport for other
  providers' native tools.

- Not a documented GitHub API: the Responses `web_search` tool on Copilot may change without notice.
- `copilot_web_fetch` cannot reach localhost, private, or authenticated URLs; Copilot fetches from its own network.
- The structured search results are model-written summaries, so quote-level accuracy depends on the search model.

## Live test

```bash
./dev/opencode-plugin-smoke.sh check copilot-web
./dev/opencode-plugin-smoke.sh start -n cw copilot-web
./dev/opencode-plugin-smoke.sh send cw 'Use websearch once for the latest bats-core release, then copilot_web_fetch once on https://github.com/bats-core/bats-core/blob/master/README.md for its one-line description. End with DONE1 and the version.'
./dev/opencode-plugin-smoke.sh wait cw '^ +DONE1' 240
./dev/opencode-plugin-smoke.sh capture cw 40
./dev/opencode-plugin-smoke.sh stop cw
```

The `websearch` tool part's `metadata.provider` is `copilot` when the backend served the search.
