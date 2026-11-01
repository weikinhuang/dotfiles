import { describe, expect, it } from 'vitest';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import {
  dropCoveredMessages,
  retainedTranscriptStart,
  transcriptIndex,
  waitForRecap,
} from '../../../../../lib/node/pi/roleplay/budget-coverage.ts';

const message = (id: string): ReminderMessage => ({ role: 'user', content: id, cacheReminderEntryId: `entry:${id}:0` });

describe('budget coverage', () => {
  it('resolves copied messages by stable keys, not their changed content', () => {
    const original = message('one');
    expect(transcriptIndex({ ...original, content: 'edited' }, [original])).toBe(0);
    expect(transcriptIndex(message('missing'), [original])).toBe(-1);
  });
  it('ignores system declarations and non-transcript startup guides when locating a cut', () => {
    const transcript = [message('one'), message('two')];
    expect(
      retainedTranscriptStart(
        [{ role: 'system', content: 'system' }, { role: 'custom', content: 'guide' }, transcript[1]],
        transcript,
      ),
    ).toBe(1);
    expect(retainedTranscriptStart([{ role: 'system', content: 'system' }], transcript)).toBe(-1);
  });
  it('drops only committed transcript coverage while preserving guides and declarations', () => {
    const transcript = [message('one'), message('two'), message('three')];
    const system: ReminderMessage = { role: 'system', content: 'head' };
    const guide: ReminderMessage = { role: 'custom', content: 'guide' };
    expect(dropCoveredMessages([system, ...transcript, guide], transcript, 1)).toEqual([
      system,
      transcript[1],
      transcript[2],
      guide,
    ]);
    expect(dropCoveredMessages(transcript, transcript, 0)).toEqual(transcript);
  });
  it('waits for an existing recap without a signal', async () => {
    await expect(waitForRecap(Promise.resolve())).resolves.toBeUndefined();
  });
  it('rejects an already cancelled request', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(waitForRecap(Promise.resolve(), abort.signal)).rejects.toThrow('aborted');
  });
  it('cancels only the wait, allowing the background work to finish', async () => {
    let finish: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const abort = new AbortController();
    const waiting = waitForRecap(work, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow('aborted');
    finish?.();
    await expect(work).resolves.toBeUndefined();
  });
});
