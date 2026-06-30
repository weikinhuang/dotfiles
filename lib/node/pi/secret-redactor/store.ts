/**
 * Session store for the `secret-redactor` extension.
 *
 * Maps each distinct secret value to a stable, non-reversible handle and
 * the placeholder the model sees in its place, and tracks which handles
 * the user has approved for rehydration / reveal. Pure - no pi imports -
 * so it's unit-testable under vitest.
 *
 * The store deliberately keeps the real value: redaction only scrubs the
 * model-bound copy of the conversation, never the local session, so the
 * value has to live somewhere the `tool_call` rehydration gate can reach
 * it. It is in-memory only and cleared on `session_shutdown`.
 */

import { createHash } from 'node:crypto';

/** Minimum handle length (hex chars taken from the value's sha256). */
const HANDLE_BASE_LEN = 4;

export interface SecretEntry {
  /** Short non-reversible hash prefix - the stable reference token. */
  handle: string;
  /** Which rule matched (e.g. `github-token`); shown in the placeholder. */
  label: string;
  /** The real secret. Never leaves the store except via an approved gate. */
  value: string;
}

/** Render the placeholder a redacted value is replaced with. */
export function makePlaceholder(label: string, handle: string): string {
  return `[REDACTED:${label}#${handle}]`;
}

/**
 * Matches either a full placeholder this module emits OR a bare `#handle`
 * reference (group 1 = handle from the placeholder form, group 2 = handle
 * from the bare form). The bare form is the fallback for a small model
 * that retyped a command but mangled the surrounding placeholder text;
 * the handle hex run is the anchor. Global + reused, so callers must
 * reset `lastIndex` (or use `matchAll`, which makes a fresh iterator).
 */
export const HANDLE_REF_RE = /\[REDACTED:[^#\]]*#([0-9a-f]{4,})\]|#([0-9a-f]{4,})/g;

export class SecretStore {
  private readonly byValue = new Map<string, SecretEntry>();
  private readonly byHandle = new Map<string, SecretEntry>();
  private readonly approved = new Set<string>();

  /**
   * Register `value` under `label`, returning its (stable) entry. Calling
   * again with the same value is idempotent - the original handle and
   * label are preserved so the placeholder never changes across turns.
   */
  register(value: string, label: string): SecretEntry {
    const existing = this.byValue.get(value);
    if (existing) return existing;
    const handle = this.allocHandle(value);
    const entry: SecretEntry = { handle, label, value };
    this.byValue.set(value, entry);
    this.byHandle.set(handle, entry);
    return entry;
  }

  /** Placeholder string for `value` under `label` (registers if new). */
  placeholderFor(value: string, label: string): string {
    const entry = this.register(value, label);
    return makePlaceholder(entry.label, entry.handle);
  }

  lookup(handle: string): SecretEntry | undefined {
    return this.byHandle.get(handle);
  }

  /** Approve a handle for rehydration / reveal. Returns false if unknown. */
  approve(handle: string): boolean {
    if (!this.byHandle.has(handle)) return false;
    this.approved.add(handle);
    return true;
  }

  isApproved(handle: string): boolean {
    return this.approved.has(handle);
  }

  entries(): SecretEntry[] {
    return [...this.byHandle.values()];
  }

  size(): number {
    return this.byHandle.size;
  }

  /** Tracked secrets that are still being redacted (i.e. not revealed). */
  redactedCount(): number {
    return this.byHandle.size - this.approved.size;
  }

  clear(): void {
    this.byValue.clear();
    this.byHandle.clear();
    this.approved.clear();
  }

  /**
   * The KNOWN handles referenced (as a full placeholder or a bare
   * `#handle`) anywhere in `text`. Unknown `#abcd` tokens (and ordinary
   * `#123` issue refs, which are too short to match the `{4,}` run) are
   * ignored, so this never flags a coincidental hash.
   */
  referencedHandles(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(HANDLE_REF_RE)) {
      const handle = m[1] ?? m[2];
      if (handle && this.byHandle.has(handle)) out.add(handle);
    }
    return [...out];
  }

  /**
   * Shortest unique hex prefix of `sha256(value)`. Grows past
   * `HANDLE_BASE_LEN` only on the (vanishingly rare) prefix collision
   * with a DIFFERENT value, so a given value's handle is deterministic
   * for the life of the store.
   */
  private allocHandle(value: string): string {
    const hex = createHash('sha256').update(value).digest('hex');
    for (let len = HANDLE_BASE_LEN; len < hex.length; len++) {
      const cand = hex.slice(0, len);
      const taken = this.byHandle.get(cand);
      if (!taken || taken.value === value) return cand;
    }
    return hex;
  }
}
