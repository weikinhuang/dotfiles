/**
 * Pure formatter for the `/roleplay relationships` readout: one block per
 * relationship record with stored + decay-projected affinity, trust, last
 * interaction, and open threads. No pi imports.
 */

import { daysElapsed, decayAffinity, formatRelationshipLine, type DecayOptions } from './relationship.ts';
import { type RelationshipMeta } from './store.ts';

export interface RelationshipRow {
  id: string;
  name: string;
  meta: RelationshipMeta;
}

/** Format the relationship records (sorted by name) as of `now`. */
export function formatRelationshipsReadout(rows: readonly RelationshipRow[], now: Date, opts: DecayOptions): string {
  if (rows.length === 0) return 'Roleplay: no relationship records in the active cast.';
  const sorted = rows.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const lines = [`Relationships (${rows.length}; decay ${opts.decayPerDay}/day toward ${opts.baseline}):`];
  for (const r of sorted) {
    const current = decayAffinity(r.meta, now, opts);
    lines.push(`  ${r.name} (${r.id})`);
    lines.push(`    ${formatRelationshipLine(r.meta.affinity, current, r.meta.trust, opts.baseline)}`);
    const last = r.meta.lastInteraction;
    if (last) {
      const days = daysElapsed(last, now);
      lines.push(`    last interaction: ${last}${days === null ? '' : ` (${days} day(s) ago)`}`);
    } else {
      lines.push('    last interaction: (unset; no decay)');
    }
    lines.push(
      r.meta.openThreads.length > 0 ? `    open threads: ${r.meta.openThreads.join('; ')}` : '    open threads: (none)',
    );
  }
  return lines.join('\n');
}
