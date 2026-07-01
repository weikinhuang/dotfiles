// Template: one behavioral-eval TRIAL of a pi extension against a small model,
// driven headless through the SDK.
//
// Configure via env:
//   PI_EVAL_MODEL    provider/model under test (e.g. anthropic/claude-haiku-4-5,
//                    llama-cpp/qwen3-6-35b-a3b). Prefer a SMALL model - that is
//                    where the interesting READ/ACT failures live.
//   PI_EVAL_EXT_DIR  path to your checkout's config/pi/extensions directory.
//
// Run ONE trial per process (a bash loop spawns fresh `node` per trial) -
// `session.dispose()` + a new session in the same process trips the
// titlebar-spinner extension on a stale ctx and crashes the run after trial 1.
// Load your provider's credentials into the shell first, then loop:
//
//   source ~/.pi/agent/env 2>/dev/null || true   # if your setup keeps creds there
//   export PI_EVAL_MODEL=provider/model           # e.g. anthropic/claude-haiku-4-5
//   for i in $(seq 1 5); do node eval-template.mjs "$i"; done
//
// This template demonstrates a READ probe (does the model use injected state?).
// For an ACT probe (does the model execute an injected directive?) the shape is
// the same but success = a side effect (file written, tool called) and you must
// give the directive its OWN turn to test small models fairly - see SKILL.md.

import { instrumentedAsk, fmtRec, loadPiSdk } from './instrument.mjs';
process.on('unhandledRejection', () => {}); // a dangling aborted prompt() after a stall must not crash

const label = process.argv[2] || '?';
// Point PI_EVAL_EXT_DIR at your checkout's config/pi/extensions (default assumes ~/.dotfiles).
const EXT = process.env.PI_EVAL_EXT_DIR || `${process.env.HOME}/.dotfiles/config/pi/extensions`;
const CWD = '/tmp/pi-eval/empty'; // empty cwd: a real repo makes a small model bash-search instead of using injected context

const { createAgentSession, AuthStorage, ModelRegistry, DefaultResourceLoader, getAgentDir, SessionManager } =
  await loadPiSdk();

// ── 1. Seed state so the fact lives ONLY where the feature puts it ──────────
// For todo/scratchpad/bg-bash-style extensions that mirror state into the
// branch, seed a custom entry BEFORE bindExtensions so reduceBranch picks it up
// and it is never visible as a conversation tool-result the model could read
// instead. (For a `memory` recall probe, write a valid memory file to a temp
// PI_MEMORY_ROOT instead - see SKILL.md "Seeding".)
const TOKEN = 'Cobalt-7'; // un-guessable: a "hit" can only come from the injected block
const sm = SessionManager.inMemory(CWD);
sm.appendCustomEntry('todo-state', {
  nextId: 3,
  todos: [
    { id: 1, text: 'Audit the auth middleware', status: 'completed' },
    { id: 2, text: `Migrate the Zephyr ledger to the ${TOKEN} datastore`, status: 'in_progress' },
  ],
});

// ── 2. Build the session ────────────────────────────────────────────────────
process.env.PI_MEMORY_DISABLE_CAPTURE = '1'; // silence unrelated extensions' turn injection
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
// provider/model under test - set PI_EVAL_MODEL (falls back to a small local model)
const spec = process.env.PI_EVAL_MODEL || 'llama-cpp/qwen3-6-35b-a3b';
const slash = spec.indexOf('/');
const model = modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
const rl = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: getAgentDir(),
  additionalExtensionPaths: [`${EXT}/todo.ts`], // load ONLY the feature(s) under test
});
await rl.reload();
const { session } = await createAgentSession({
  model,
  cwd: CWD,
  thinkingLevel: 'off', // at low/high Qwen goes agentic (10-67 tool calls) and often never answers
  tools: [], // isolate "answer from injected context only"
  authStorage,
  modelRegistry,
  resourceLoader: rl,
  sessionManager: sm,
});
await session.bindExtensions({}); // REQUIRED: createAgentSession does NOT fire session_start on its own

// ── 3. Ask a question answerable ONLY from the injected state ───────────────
const rec = await instrumentedAsk(
  session,
  'Per my active plan, which task is currently in progress right now? Reply in one short sentence.',
  { timeoutMs: 90_000, stallMs: 30_000 },
);

// ── 4. Score: present a classified one-liner, not just pass/fail ────────────
const hit = rec.content.includes(TOKEN);
console.log(`[${label}] hit=${hit ? 'Y' : 'N'} | ${fmtRec(rec)} | ${JSON.stringify(rec.content.slice(0, 110))}`);
session.dispose();
process.exit(0);
