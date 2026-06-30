// Shared eval instrumentation for pi behavioral evals.
//
// Captures BOTH model channels + timing + terminal status so a trial can be
// CLASSIFIED instead of silently looking "empty". This is the single most
// useful piece of the harness: without it, a long-thinking trial, a server
// hang, and a real empty answer all look identical (zero content).
//
// Per trial it records:
//   - content   : final answer text       (assistantMessageEvent text_delta)
//   - thinking  : reasoning tokens         (assistantMessageEvent thinking_delta)
//                 <- the channel that makes trials look blank while the model
//                    is actually working; capture it or you will chase ghosts
//   - tools     : tool_execution_start names (Qwen goes agentic at thinking>off)
//   - timing    : ttFirst / ttThinking / ttContent / ttDone (ms from prompt)
//   - status    : ok | length | error | timeout | stall | throw
//                 stall = no stream activity for stallMs => server hang
//                 (distinct from a slow-but-progressing reasoning phase; a real
//                  hang streams NOTHING, a loop streams the same tokens)
//   - repeat    : heuristic flag for a degenerate repeat loop
//
// Usage:
//   import { instrumentedAsk, fmtRec } from './instrument.mjs';
//   const rec = await instrumentedAsk(session, 'question?', { timeoutMs: 90000, stallMs: 30000 });
//   console.log(fmtRec(rec), rec.content);

export function detectRepeat(s) {
  const toks = (s || '').split(/\s+/).filter(Boolean);
  if (toks.length < 30) return false;
  const tri = new Map();
  let max = 0;
  for (let i = 0; i + 3 <= toks.length; i++) {
    const k = toks[i] + ' ' + toks[i + 1] + ' ' + toks[i + 2];
    const c = (tri.get(k) || 0) + 1;
    tri.set(k, c);
    if (c > max) max = c;
  }
  return max >= 8; // same 3-gram 8+ times => likely a loop
}

export async function instrumentedAsk(session, prompt, { timeoutMs = 180_000, stallMs = 45_000 } = {}) {
  const rec = {
    content: '',
    thinking: '',
    tools: [],
    events: 0,
    t0: Date.now(),
    lastActivity: Date.now(),
    ttFirst: null,
    ttThinking: null,
    ttContent: null,
    ttDone: null,
    status: 'pending',
    stopReason: null,
    errorMessage: null,
  };
  const unsub = session.subscribe((ev) => {
    rec.events++;
    rec.lastActivity = Date.now();
    if (rec.ttFirst == null) rec.ttFirst = Date.now() - rec.t0;
    if (ev.type === 'tool_execution_start') rec.tools.push(ev.toolName);
    if (ev.type !== 'message_update') return;
    const a = ev.assistantMessageEvent;
    if (!a) return;
    if (a.type === 'thinking_delta') {
      if (rec.ttThinking == null) rec.ttThinking = Date.now() - rec.t0;
      rec.thinking += a.delta ?? '';
    } else if (a.type === 'text_delta') {
      if (rec.ttContent == null) rec.ttContent = Date.now() - rec.t0;
      rec.content += a.delta ?? '';
    } else if (a.type === 'done') {
      rec.ttDone = Date.now() - rec.t0;
      rec.stopReason = a.reason;
    } else if (a.type === 'error') {
      rec.stopReason = a.reason;
      rec.errorMessage = a.errorMessage ?? null;
    }
  });

  let timer, stallTimer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (rec.status === 'pending') rec.status = 'timeout';
      resolve();
    }, timeoutMs);
    stallTimer = setInterval(() => {
      if (Date.now() - rec.lastActivity > stallMs) {
        if (rec.status === 'pending') rec.status = 'stall';
        resolve();
      }
    }, 3000);
  });

  try {
    await Promise.race([
      session.prompt(prompt).then(() => {
        if (rec.status === 'pending') {
          rec.status = rec.stopReason === 'length' ? 'length' : rec.errorMessage ? 'error' : 'ok';
        }
      }),
      guard,
    ]);
  } catch (e) {
    rec.status = 'throw';
    rec.errorMessage = String(e?.message ?? e);
  } finally {
    clearTimeout(timer);
    clearInterval(stallTimer);
    unsub();
  }
  rec.repeat = detectRepeat(rec.content) || detectRepeat(rec.thinking);
  return rec;
}

// One-line classification string for logs.
export function fmtRec(rec) {
  const s = (n) => (n == null ? '-' : (n / 1000).toFixed(0) + 's');
  return (
    `status=${rec.status}${rec.stopReason ? '/' + rec.stopReason : ''}` +
    ` ttContent=${s(rec.ttContent)} think=${rec.thinking.length}c content=${rec.content.length}c` +
    ` tools=${rec.tools.length}${rec.repeat ? ' REPEAT!' : ''}${rec.errorMessage ? ' err=' + rec.errorMessage.slice(0, 40) : ''}`
  );
}

// Resolve the installed pi SDK dist without hardcoding a node version path.
// Falls back through the global module root. Override with PI_SDK_PATH.
export async function loadPiSdk() {
  if (process.env.PI_SDK_PATH) return import(process.env.PI_SDK_PATH);
  const { execSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const root = execSync('npm root -g').toString().trim();
  return import(join(root, '@earendil-works/pi-coding-agent/dist/index.js'));
}
