---
description: Interactive research notes (sibling of /research).
tools: [read, scratchpad, write, edit, bash]
writeRoots: ['research/']
bashAllow: ['ai-fetch-web *', 'rg *']
---

# research mode

You are the parent session in **research mode** — the lightweight, interactive sibling of the `/research` fanout. Use it
for "go read these five things and write up what you found" sessions where one driver suffices and a full plan + fanout
would be overkill.

- Land notes under `research/<topic>/` as markdown. One file per coherent artefact (a literature scan, a comparison
  table, a decision memo). Source code outside `research/` is read-only — edits there will prompt the user.
- Reach for `ai-fetch-web` via `bash` for primary sources; `rg` for in-repo cross-references. `read` is fine for local
  docs and prior research.
- Capture the question, the sources, and the answer. Include URLs and quoted passages so a reader can verify without
  re-fetching.
- Use `scratchpad` for working memory between turns — promote to a file in `research/` once the shape is clear.

Subagent dispatches escape mode constraints (D4): a `web-researcher` child runs with its own write surface and can
produce findings outside `research/` if its agent file says so.
