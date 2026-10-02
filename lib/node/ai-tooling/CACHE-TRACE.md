# Pi cache trace inspection

Local JSONL sidecars for comparing provider-bound system instructions, tool declarations, and conversation hashes. Use
[`ai-cache-trace`](../../../dotenv/bin/ai-cache-trace) to inspect them without provider calls or pricing lookups.

## Enable capture

The [`cache-breakpoint`](../../../config/pi/extensions/cache-breakpoint.md) extension registers:

```bash
pi --cache-trace auto --cache-trace-level hash
pi --cache-trace auto --cache-trace-level system
pi --cache-trace /existing/directory/debug.jsonl --cache-trace-level system-tools
```

Prompts use the selected model. Paid provider smoke tests require explicit approval and a hard dollar cap. For local
integration tests, explicitly select an authorized self-hosted model; never fall back to a paid model. Keep normal
extension/tool discovery enabled and re-enable the injectors under test if they were disabled only for the parent coding
session. Seed active state so the live test exercises actual reminder delivery.

| Setting                                       | Values                           | Default                                               |
| --------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `--cache-trace`, `PI_CACHE_TRACE`             | `off`, `auto`, or output path    | Off unless a destination or logging level is supplied |
| `--cache-trace-level`, `PI_CACHE_TRACE_LEVEL` | `hash`, `system`, `system-tools` | `hash`                                                |

CLI flags override their environment equivalents. A level supplied without a destination implies `auto`.
`--cache-trace off` disables payload tracing even if an environment destination exists. Invalid configuration disables
tracing with a local warning; it never blocks model execution. Set environment variables before launching pi; `/reload`
does not inherit later changes made in another shell.

## Levels and privacy

| Level          | Recorded text                                                         | Metadata                                                                                                     |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `hash`         | None                                                                  | System/tool hashes, sources and sizes; item hashes/roles; historical divergence; returned numeric usage/cost |
| `system`       | System text only, once per distinct version in a run                  | Same metadata                                                                                                |
| `system-tools` | System text and tool declarations, once per distinct version in a run | Same metadata                                                                                                |

Raw modes are **not redaction modes**. System instructions and tool declarations can contain private data or secrets.
They are explicit opt-ins, announced in local UI or stderr. Keep captures local, do not commit/share them, and delete
them when analysis is finished. Conversation bodies, tool results, response content, HTTP headers, and standalone
authentication fields are never captured as text at any level. Non-text system image blocks are hashed but not dumped.

## Sidecar layout and records

For `/sessions/<timestamp>_<id>.jsonl`, `auto` writes `/sessions/<timestamp>_<id>.cache-trace.jsonl`. The parent
directory must exist. Auto capture needs a session file; with `--no-session`, use an explicit output path. The output
must not be the session transcript itself. The transcript is never modified. Repository discovery, usage totals,
subagent counts, and recent-prompt history exclude sidecars.

Files are append-only and tightened to mode `0600`, including reused files. Symlink outputs and existing transcript
aliases (including hardlinks) are refused before any content or permission changes. Logging errors are best-effort and
warn locally once. Failed request appends restart the diagnostic run, so missing raw snapshots are not silently
referenced as if they had been written. Inspect mode/parent permissions if no sidecar appears.

Version 2 records have a `kind` and a UUID `runId`; reloads/session changes create a new run in the same file. Snapshot
deduplication uses a bounded 1,000-entry run-local cache; an old version can be re-emitted after cache reset, with the
same content address:

- `snapshot`: scope (`system` or `tools`), component SHA-256, separate text SHA-256, and opt-in text. System sources
  include top-level `system`, `instructions`, Google `systemInstruction`, and system/developer items in `messages` or
  Responses `input`. Tools include `tools`, Bedrock `toolConfig`, and Responses additional-tool declarations.
- `request`: provider/model, sequence, session/leaf IDs, whole-payload hash/size, system/tool hashes and change flags,
  per-item role/hash/size/reminder IDs, and common historical item/byte prefixes. No raw snapshot text lives here.
- `response`: matching run/sequence and allowlisted numeric usage/cost, without response text.

The parser validates snapshot text digests and refuses conflicting versions. It reads legacy content-free request/
response traces, but cannot reconstruct text that was never captured. Legacy sequence resets form separate runs.
Trailing partial JSON from a live writer is skipped with a warning; malformed complete records fail without echoing
their contents. Missing responses are shown as unknown usage, not zero cost.

## Inspect and compare

```bash
# Accept either the sidecar path or its parent pi session file.
ai-cache-trace /sessions/<timestamp>_<id>.jsonl
ai-cache-trace /sessions/<timestamp>_<id>.cache-trace.jsonl --json

# Explicit raw display; requires capture before the requests were sent.
ai-cache-trace trace.jsonl --diff
ai-cache-trace trace.jsonl --from 2 --to 3
ai-cache-trace trace.jsonl --from=2 --to=3 --tools
ai-cache-trace trace.jsonl --show-system 3

# Shared files/reloads: choose the run ID or a unique prefix from the summary.
ai-cache-trace trace.jsonl --run <run-id> --diff
```

Summary output, including `--json`, never emits snapshot text. `--diff`, `--tools`, and `--show-system` explicitly allow
raw display; combining them with `--json` includes the requested display text. Terminal control characters are escaped
for display. `--from`/`--to` require positive integers and must be supplied together. Text comparison requires one run;
multi-run ambiguity is an error rather than silently pairing unrelated requests.

`CHANGED` system/tool hashes identify local request-shape changes; a changed historical item identifies a conversation
mutation. A cache-read drop with unchanged eligible content instead points toward eviction/routing. These are diagnostic
signals, not causal proof. Snapshots are normalized text views, while hashes cover serialized provider fields; metadata
or image changes can change a hash without changing the text view. This captures the extension's payload hook, not SDK
HTTP serialization, and later payload hooks can still change the request.

## Related docs

- [`cache-breakpoint.md`](../../../config/pi/extensions/cache-breakpoint.md) - provider handling and trace flags.
- [`cost-guard.md`](../../../config/pi/extensions/cost-guard.md) - live local-only cache/cost warnings.
- [`SESSION-DOCTOR.md`](./SESSION-DOCTOR.md) - offline diagnosis from recorded token/cost counters.
