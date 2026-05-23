/**
 * Per-source warning de-dup helper shared by config-loading extensions.
 *
 * Several extensions (`filesystem`, `persona`, `preset`, `sandbox`,
 * `verify-before-claim`, `iteration-loop`, `subagent`, `bash-exit-watchdog`,
 * `small-model-addendum`) load layered config files and surface parse
 * warnings via `ctx.ui.notify`. Each one inlined the same shape:
 *
 *   const seen = new Set<string>();
 *   for (const w of warnings) {
 *     const key = `${w.source}|${w.reason}`;
 *     if (seen.has(key)) continue;
 *     seen.add(key);
 *     ctx.ui.notify(`<tag>: ${w.source}: ${w.reason}`, 'warning');
 *   }
 *
 * That shape is now centralised here so a behavioural tweak (separator,
 * severity, fatal-error promotion) lands in one place. The helper is
 * pi-free: `notify` is injected as a plain function so the lib stays out
 * of `@earendil-works/*` import territory.
 *
 * Usage from an extension:
 *
 *   const tracker = createNotifyOnce({ tag: 'persona' });
 *   pi.on('session_shutdown', () => tracker.reset());
 *   // …
 *   tracker.surface(ctx.ui.notify.bind(ctx.ui), warnings);
 */

/**
 * Minimal `{ source, reason }` warning shape every config loader in the
 * repo already emits in some form. Most concrete loader types
 * (`FilesystemPolicyWarning`, `ConfigWarning`) widen this with extra
 * fields - and a few use a different field name like `path`. The
 * helper is generic over the actual shape and only needs you to
 * supply the {@link NotifyOnceOptions.keyOf} / {@link NotifyOnceOptions.render}
 * functions when your warning doesn't expose `source` / `reason`
 * directly.
 */
export interface NotifyWarning {
  source: string;
  reason: string;
}

/** Notify severity passed to the injected `notify` function. */
export type NotifySeverity = 'info' | 'warning' | 'error';

/** Plain function shape compatible with `ExtensionContext.ui.notify`. */
export type NotifyFn = (message: string, severity?: NotifySeverity) => void;

export interface NotifyOnceOptions<W = NotifyWarning> {
  /** Prefix prepended to every notify, e.g. `"persona"`. */
  tag: string;
  /** Severity passed to `notify`. Default `"warning"`. */
  severity?: NotifySeverity;
  /**
   * Custom dedup-key builder. Default `${w.source}|${w.reason}`. Override
   * when a single source legitimately produces multiple distinct
   * warnings (e.g. include a kind discriminant in the key) OR when your
   * warning shape doesn't expose `source` / `reason` directly
   * (`PersonaWarning` exposes `path` instead of `source`).
   */
  keyOf?: (warning: W) => string;
  /**
   * Custom render. Default `"<tag>: <source>: <reason>"`. Override when
   * the legacy notify text used a different separator and you want to
   * preserve it.
   */
  render?: (warning: W, tag: string) => string;
}

export interface NotifyOnceTracker<W = NotifyWarning> {
  /**
   * Call once per loader pass. Each unique `keyOf(warning)` triggers
   * exactly one `notify(...)` call across the lifetime of the tracker.
   */
  surface(notify: NotifyFn, warnings: readonly W[]): void;
  /** Forget every key seen so far. Called from `session_shutdown` so a
   *  /reload fires fresh notifies for still-broken sources. */
  reset(): void;
  /** Number of unique keys surfaced so far. Test-only convenience. */
  size(): number;
}

/**
 * Build a fresh per-tracker `Set<string>` of seen keys plus the
 * `surface` / `reset` closures. The factory is pi-free; the only
 * pi-coupled bit is the `NotifyFn` the caller threads in at call time.
 *
 * Generic over the warning shape so callers can pass `PersonaWarning`,
 * `FilesystemPolicyWarning`, `ConfigWarning`, etc. directly. Provide
 * {@link NotifyOnceOptions.keyOf} / {@link NotifyOnceOptions.render}
 * when the shape doesn't expose `source` / `reason` directly.
 */
export function createNotifyOnce<W extends object = NotifyWarning>(
  options: NotifyOnceOptions<W>,
): NotifyOnceTracker<W> {
  const tag = options.tag;
  const severity: NotifySeverity = options.severity ?? 'warning';
  const keyOf =
    options.keyOf ??
    ((w: W) => {
      const nw = w as unknown as NotifyWarning;
      return `${nw.source}|${nw.reason}`;
    });
  const render =
    options.render ??
    ((w: W, t: string) => {
      const nw = w as unknown as NotifyWarning;
      return `${t}: ${nw.source}: ${nw.reason}`;
    });
  const seen = new Set<string>();
  return {
    surface(notify, warnings) {
      for (const w of warnings) {
        const key = keyOf(w);
        if (seen.has(key)) continue;
        seen.add(key);
        notify(render(w, tag), severity);
      }
    },
    reset() {
      seen.clear();
    },
    size() {
      return seen.size;
    },
  };
}
