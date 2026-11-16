# `decision-gate`

Lets a System One decision model (TypeSafe Jev, Cloudflare Clef, a self-hosted deployment, or any `POST /v1/systemone`
endpoint) clear shell commands that opencode would otherwise ask about. The opencode side of the pi
[`bash-permissions` decision model](../../../pi/extensions/bash-permissions.md#decision-model) layer, sharing its config
shape, questions, thresholds, and log format. Server part only: [`server.ts`](./server.ts), with the logic in
[`lib/node/decision-model/`](../../../../lib/node/decision-model/) and
[`lib/node/opencode/decision-gate.ts`](../../../../lib/node/opencode/decision-gate.ts).

## Behavior

The plugin hooks `permission.evaluate`, which opencode runs after its rules have resolved a request:

```text
opencode rules (allow / deny / ask)  ->  ask only: decision model  ->  opencode's normal prompt
```

- Only `shell` requests whose rules resolved to `ask` are considered. That includes explicit `ask` rules (such as the
  generated `sed -i *` carve-outs) and the catch-all `shell * ask`. An explicit `allow` or `deny` always stands.
- The model can only change `ask` to `allow`. When it abstains, the prompt appears exactly as it would without the
  plugin.
- It abstains on any failure (missing config, unset key, timeout, HTTP error, off-spec response, oversized command),
  when a sub-command matches the pi hardcoded-deny or privilege-escalation patterns (`curl | sh`, `sudo`, …), and when
  an answer misses the thresholds.
- Unattended runs (scheduled tasks, where opencode denies asks because nobody can answer) also benefit: an allowed
  command runs instead of being denied.

opencode's shell permission event carries only the parsed sub-commands (no metadata on 2.2.7), so the plugin also hooks
`tool.execute.before` (which runs first) and stashes each `shell` call's full command line. The model sees the most
recent stashed command in the session that contains every sub-command, with operators, pipes, and redirects intact; with
no match it sees the sub-commands joined by newlines.

The questions and thresholds are documented in the [pi doc](../../../pi/extensions/bash-permissions.md#decision-model).
Command text is redacted with the secret-redactor detectors before it is sent or logged.

## Config

Copy [`config/pi/decision-model-example.json`](../../../pi/decision-model-example.json) to
`${OPENCODE_CONFIG_DIR:-~/.config/opencode}/decision-model.json`. Set the key env var it names (for example in
`<config dir>/env`), or put the key in the file as `provider.apiKey`; the env var wins when it has a value. The file is
**user scope only**: a project `.opencode/decision-model.json` is never read, so a cloned repo cannot point the gate at
an endpoint that approves everything. It is re-read on every request.

The decision log defaults to `<config dir>/decision-model.jsonl`. Besides each `decision` record it writes a
`resolution` record for an abstain once you answer the prompt (`allow` for `once` / `always`, `deny` for `reject`,
original reply in `detail`), matched through the `permission.asked` / `permission.replied` events.

## Options

Set options with a plugin entry in `opencode.jsonc` (see [Install](../README.md#install)). Every option also has an
`OPENCODE_DECISION_GATE_*` environment override, which wins over the option.

| Option    | Env override                     | Default                            | Effect                                                         |
| --------- | -------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `enabled` | `OPENCODE_DECISION_GATE_ENABLED` | `true`                             | `false` disables the plugin entirely.                          |
| `config`  | `OPENCODE_DECISION_GATE_CONFIG`  | `<config dir>/decision-model.json` | Path to the decision-model config.                             |
| `trace`   | `OPENCODE_DECISION_GATE_TRACE`   | unset                              | Append one line per evaluate (verdict, reason, metadata keys). |

## Limitations

- Shell only. Other actions (`edit`, `external_directory`, `webfetch`) keep opencode's normal handling.
- opencode's prompt shows only the command; it does not say the model abstained or why. The reason is in the log and the
  trace.
- A command parsed into several sub-commands is judged as a whole: one shaky part means the whole command prompts.

## Live test

Point the plugin at a stub endpoint and a scratch log so nothing touches `~/.config/opencode`:

```bash
S=$(mktemp -d)
# A System One stub on 127.0.0.1:8787 (any server returning spec-shaped answers works).
cat >"$S/decision-model.json" <<EOF
{ "provider": { "baseUrl": "http://127.0.0.1:8787", "model": "stub", "apiKeyEnv": "DM_KEY" },
  "log": "$S/decisions.jsonl" }
EOF
./dev/opencode-plugin-smoke.sh check decision-gate
./dev/opencode-plugin-smoke.sh start -n dg -e DM_KEY=x -e OPENCODE_DECISION_GATE_CONFIG="$S/decision-model.json" \
  -e OPENCODE_DECISION_GATE_TRACE="$S/trace.log" decision-gate
./dev/opencode-plugin-smoke.sh send dg 'Use the shell tool to run: touch smoke-ok.txt. Then reply exactly: DONE1'
./dev/opencode-plugin-smoke.sh wait dg '^ +DONE1' 120
cat "$S/trace.log" "$S/decisions.jsonl"
./dev/opencode-plugin-smoke.sh stop dg
```
