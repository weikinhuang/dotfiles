/**
 * Questionnaire extension for pi — Claude-Code-style structured Q&A.
 *
 * Registers a `questionnaire` tool that overrides the bundled example in
 * the same slot (pi loads extensions by filename, same tool name = single
 * tool visible to the LLM). Adds six features on top of the baseline at
 * `examples/extensions/questionnaire.ts`:
 *
 *   1. `kind: "single" | "multi" | "free"` per question. Multi-select
 *      renders `[ ]`/`[x]` rows plus a dedicated `Next` terminator.
 *      Free-text questions skip the option list and drop straight into
 *      the editor.
 *   2. Per-option `preview` string, rendered in a side pane beside the
 *      highlighted option. Falls back to stacking below the options when
 *      the terminal is narrower than `PREVIEW_MIN_WIDTH`.
 *   3. Per-question notes via `n`. Notes attach to the answer in the
 *      tool-result JSON under `note`.
 *   4. Digit jump-select (`1`-`9`). On single-select the digit also
 *      Enter-confirms; on multi-select it only moves the cursor
 *      (`Space` still required to toggle), per the plan.
 *   5. "Chat about this" escape hatch on `c`. Cancels the questionnaire
 *      with `chatRequested: true` and records the question id the user
 *      was on, so the LLM can pick up the thread in prose.
 *   6. Review/Submit tab with an explicit `Submit answers / Cancel` list
 *      that matches the final sample in
 *      `plans/claude-code-questionaire-samples.txt`.
 *
 * Plan: plans/pi-questionnaire-tool.md
 * Samples: plans/claude-code-questionaire-samples.txt
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  Editor,
  type EditorTheme,
  Input,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { Type } from 'typebox';

// ─── Types ────────────────────────────────────────────────────────────────

type QuestionKind = 'single' | 'multi' | 'free';

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

type RenderOption = QuestionOption & {
  isOther?: boolean;
  isNext?: boolean;
};

interface Question {
  id: string;
  label: string;
  prompt: string;
  kind: QuestionKind;
  options: QuestionOption[];
  allowOther: boolean;
  allowNotes: boolean;
  minSelect?: number;
  maxSelect?: number;
}

interface Answer {
  id: string;
  kind: QuestionKind;
  // single
  value?: string;
  label?: string;
  index?: number;
  // multi
  values?: string[];
  labels?: string[];
  indices?: number[];
  // free / "Type something." overflow
  customText?: string;
  wasCustom?: boolean;
  // per-question note
  note?: string;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  chatRequested: boolean;
  chatContextId: string | null;
}

// ─── Schema ───────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: 'The value returned when selected.' }),
  label: Type.String({ description: 'Display label for the option.' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below the label.' })),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional multi-line string (ASCII art, code, diff) rendered in a ' +
        'side pane when this option is highlighted. Pre-wrap to ~55 cols.',
    }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: 'Unique identifier for this question.' }),
  label: Type.Optional(
    Type.String({
      description: "Short contextual label for the tab bar, e.g. 'Scope', 'Priority' " + '(defaults to Q1, Q2, ...).',
    }),
  ),
  prompt: Type.String({ description: 'The full question text to display.' }),
  kind: Type.Optional(
    Type.Union([Type.Literal('single'), Type.Literal('multi'), Type.Literal('free')], {
      description:
        'Question kind. single = radio, multi = checkboxes with a Next ' +
        "terminator, free = editor only (no options). Default: 'single'.",
    }),
  ),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, {
      description: 'Available options. Required for single/multi, ignored for free.',
    }),
  ),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something.' option. Default: true." })),
  allowNotes: Type.Optional(Type.Boolean({ description: "Allow 'n' to open a notes editor. Default: true." })),
  minSelect: Type.Optional(Type.Integer({ description: 'Multi only: minimum selections before Next enables.' })),
  maxSelect: Type.Optional(Type.Integer({ description: 'Multi only: maximum selections allowed.' })),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: 'Questions to ask.' }),
  allowChat: Type.Optional(
    Type.Boolean({
      description: "Show the 'Chat about this' escape hatch below the separator. " + 'Default: true.',
    }),
  ),
});

// ─── Layout constants ─────────────────────────────────────────────────────

const PREVIEW_MIN_WIDTH = 100; // below this, preview stacks below options
const PREVIEW_LEFT_RATIO = 0.4;
const PREVIEW_GUTTER = 2;

// ─── Helpers ──────────────────────────────────────────────────────────────

function errorResult(
  message: string,
  questions: Question[] = [],
  chatRequested = false,
): {
  content: { type: 'text'; text: string }[];
  details: QuestionnaireResult;
} {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      questions,
      answers: [],
      cancelled: true,
      chatRequested,
      chatContextId: null,
    },
  };
}

function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w >= width) return s;
  return s + ' '.repeat(width - w);
}

function zipColumns(left: string[], right: string[], leftWidth: number, gutter: number): string[] {
  const height = Math.max(left.length, right.length);
  const out: string[] = [];
  const pad = ' '.repeat(gutter);
  for (let i = 0; i < height; i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    out.push(padVisible(l, leftWidth) + pad + r);
  }
  return out;
}

function digitFromKey(data: string): number | null {
  // Cheap path: raw single-char '1'..'9'
  if (data.length === 1 && data >= '1' && data <= '9') {
    return data.charCodeAt(0) - 48;
  }
  // Kitty/CSI-u printable: matchesKey handles 'shift'-less plain keys,
  // but digits arrive as raw bytes in most terminals, so the cheap path
  // above is almost always enough. Fall through = not a digit.
  return null;
}

// ─── Tool ─────────────────────────────────────────────────────────────────

export default function questionnaire(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'questionnaire',
    label: 'Questionnaire',
    description:
      'Ask the user one or more structured questions with a rich TUI. Use ' +
      'for clarifying requirements, offering design options, or collecting ' +
      'preferences. Supports single-select, multi-select, free-text, ' +
      'per-option previews (ASCII art / code snippets), per-question notes, ' +
      "and a 'Chat about this' escape hatch.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult('questionnaire: UI unavailable. Ask the questions in chat instead.', [], true);
      }
      if (!params.questions || params.questions.length === 0) {
        return errorResult('Error: No questions provided');
      }

      // Normalize questions with defaults.
      const questions: Question[] = params.questions.map((q, i) => ({
        id: q.id,
        label: q.label || `Q${i + 1}`,
        prompt: q.prompt,
        kind: (q.kind ?? 'single') as QuestionKind,
        options: q.options ?? [],
        allowOther: q.allowOther !== false,
        allowNotes: q.allowNotes !== false,
        minSelect: q.minSelect,
        maxSelect: q.maxSelect,
      }));

      const allowChat = params.allowChat !== false;
      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        // ─── State ────────────────────────────────────────────────────
        let currentTab = 0;
        let optionIndex = 0;
        let reviewIndex = 0; // 0 = Submit answers, 1 = Cancel
        let inputMode: 'free' | 'note' | null = null;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();
        // multi-select working set per question
        const multiSelections = new Map<string, Set<number>>();
        // per-question notes
        const notes = new Map<string, string>();
        // per-question "Type something." buffers, persisted across
        // navigation so the text survives arrow-away / tab-switch.
        const otherBuffers = new Map<string, string>();

        // Editor for free / "Type something." / notes modes.
        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg('accent', s),
          selectList: {
            selectedPrefix: (t) => theme.fg('accent', t),
            selectedText: (t) => theme.fg('accent', t),
            description: (t) => theme.fg('muted', t),
            scrollInfo: (t) => theme.fg('dim', t),
            noMatch: (t) => theme.fg('warning', t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        // Dedicated single-line input for inline "Type something."
        // buffers. Lives on the option row itself under policy C:
        // every printable key on that row flows into this input, and
        // digits never jump while the cursor is on the row.
        const otherInput = new Input();

        // ─── Helpers ──────────────────────────────────────────────────
        function refresh(): void {
          cachedLines = undefined;
          tui.requestRender();
        }

        function submit(opts: { cancelled: boolean; chatRequested?: boolean; chatContextId?: string | null }): void {
          done({
            questions,
            answers: Array.from(answers.values()),
            cancelled: opts.cancelled,
            chatRequested: opts.chatRequested ?? false,
            chatContextId: opts.chatContextId ?? null,
          });
        }

        function currentQuestion(): Question | undefined {
          return questions[currentTab];
        }

        function currentOptions(): RenderOption[] {
          const q = currentQuestion();
          if (!q || q.kind === 'free') return [];
          const opts: RenderOption[] = [...q.options];
          if (q.allowOther) {
            opts.push({ value: '__other__', label: 'Type something.', isOther: true });
          }
          if (q.kind === 'multi') {
            opts.push({ value: '__next__', label: 'Next', isNext: true });
          }
          return opts;
        }

        function multiSetFor(qid: string): Set<number> {
          let s = multiSelections.get(qid);
          if (!s) {
            s = new Set<number>();
            multiSelections.set(qid, s);
          }
          return s;
        }

        function allAnswered(): boolean {
          return questions.every((q) => answers.has(q.id));
        }

        function advanceAfterAnswer(): void {
          if (questions.length === 1) {
            submit({ cancelled: false });
            return;
          }
          if (currentTab < questions.length - 1) {
            currentTab++;
          } else {
            currentTab = questions.length; // Submit tab
          }
          optionIndex = 0;
          refresh();
        }

        function saveSingleAnswer(q: Question, opt: RenderOption, index: number): void {
          const ans: Answer = {
            id: q.id,
            kind: 'single',
            value: opt.value,
            label: opt.label,
            index,
          };
          const note = notes.get(q.id);
          if (note) ans.note = note;
          answers.set(q.id, ans);
        }

        function saveCustomAnswer(q: Question, text: string): void {
          const trimmed = text.trim() || '(no response)';
          const ans: Answer = {
            id: q.id,
            kind: q.kind === 'free' ? 'free' : 'single',
            customText: trimmed,
            label: trimmed,
            value: trimmed,
            wasCustom: true,
          };
          const note = notes.get(q.id);
          if (note) ans.note = note;
          answers.set(q.id, ans);
        }

        function saveMultiAnswer(q: Question): void {
          const selSet = multiSetFor(q.id);
          const selected = [...selSet].sort((a, b) => a - b);
          const values = selected.map((i) => q.options[i]?.value ?? '');
          const labels = selected.map((i) => q.options[i]?.label ?? '');
          const ans: Answer = {
            id: q.id,
            kind: 'multi',
            values,
            labels,
            indices: selected.map((i) => i + 1),
          };
          const note = notes.get(q.id);
          if (note) ans.note = note;
          answers.set(q.id, ans);
        }

        function multiNextEnabled(q: Question): boolean {
          const selSet = multiSetFor(q.id);
          const min = q.minSelect ?? 0;
          return selSet.size >= min;
        }

        /**
         * When selection lands on a "Type something." row, hydrate
         * `otherInput` from the per-question buffer and focus it so
         * the TUI emits the cursor marker. Off-row calls defocus it.
         */
        function loadOtherIfOnRow(): void {
          const q = currentQuestion();
          if (!q) {
            otherInput.focused = false;
            return;
          }
          const opts = currentOptions();
          const opt = opts[optionIndex];
          if (opt?.isOther) {
            otherInput.setValue(otherBuffers.get(q.id) ?? '');
            otherInput.focused = true;
          } else {
            otherInput.focused = false;
          }
        }

        /** Persist the live input buffer into `otherBuffers` and defocus. */
        function saveOtherFromInput(): void {
          const q = currentQuestion();
          if (!q) return;
          otherBuffers.set(q.id, otherInput.getValue());
          otherInput.focused = false;
        }

        // Editor submit callback.
        editor.onSubmit = (value) => {
          if (!inputQuestionId || !inputMode) return;
          const q = questions.find((x) => x.id === inputQuestionId);
          if (!q) return;

          if (inputMode === 'note') {
            const trimmed = value.trim();
            if (trimmed) {
              notes.set(q.id, trimmed);
              // Attach to existing answer if we already have one.
              const existing = answers.get(q.id);
              if (existing) existing.note = trimmed;
            } else {
              notes.delete(q.id);
            }
            inputMode = null;
            inputQuestionId = null;
            editor.setText('');
            refresh();
            return;
          }

          // free mode → persists an answer and advances
          saveCustomAnswer(q, value);
          inputMode = null;
          inputQuestionId = null;
          editor.setText('');
          advanceAfterAnswer();
        };

        function handleInput(data: string): void {
          // ─── Input mode: route to editor (free question / notes) ──
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = null;
              inputQuestionId = null;
              editor.setText('');
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = currentQuestion();
          const opts = currentOptions();

          // ─── Submit / review tab ──────────────────────────────────
          if (currentTab === questions.length) {
            if (matchesKey(data, Key.up)) {
              reviewIndex = Math.max(0, reviewIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              reviewIndex = Math.min(1, reviewIndex + 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.enter)) {
              if (reviewIndex === 1) {
                submit({ cancelled: true });
                return;
              }
              if (!allAnswered()) return; // hold the user here
              submit({ cancelled: false });
              return;
            }
            if (matchesKey(data, Key.escape)) {
              submit({ cancelled: true });
            }
            return;
          }

          // ─── Free-text question: straight to editor ───────────────
          if (q && q.kind === 'free') {
            if (matchesKey(data, Key.escape)) {
              submit({ cancelled: true });
              return;
            }
            inputMode = 'free';
            inputQuestionId = q.id;
            editor.setText('');
            editor.handleInput(data);
            refresh();
            return;
          }

          if (!q) return;

          // ─── "Type something." inline input (policy C) ────────────
          // When the cursor is on a Type-something row, the row itself
          // IS the text field. Navigation keys (arrows / Tab / Enter /
          // Esc) get intercepted; every other printable key flows into
          // `otherInput`. No separate input-mode state needed.
          const activeOpt = opts[optionIndex];
          if (activeOpt?.isOther) {
            if (!otherInput.focused) {
              otherInput.setValue(otherBuffers.get(q.id) ?? '');
              otherInput.focused = true;
            }

            if (matchesKey(data, Key.enter)) {
              const text = otherInput.getValue();
              otherBuffers.set(q.id, text);
              otherInput.focused = false;
              saveCustomAnswer(q, text);
              advanceAfterAnswer();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              if (otherInput.getValue().length > 0) {
                otherInput.setValue('');
                otherBuffers.set(q.id, '');
                refresh();
              } else {
                otherInput.focused = false;
                submit({ cancelled: true });
              }
              return;
            }
            if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
              saveOtherFromInput();
              // fall through to option nav below
            } else if (
              isMulti &&
              (matchesKey(data, Key.tab) ||
                matchesKey(data, Key.shift('tab')) ||
                matchesKey(data, Key.left) ||
                matchesKey(data, Key.right))
            ) {
              saveOtherFromInput();
              // fall through to tab nav below
            } else {
              // Policy C: every other key (letters, digits, punct) is text.
              otherInput.handleInput(data);
              refresh();
              return;
            }
          }

          // ─── Chat escape hatch (not on Type-something row) ────────
          if (allowChat && data === 'c') {
            submit({
              cancelled: true,
              chatRequested: true,
              chatContextId: q.id,
            });
            return;
          }

          // ─── Tab navigation (multi-question only) ─────────────────
          if (isMulti) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              loadOtherIfOnRow();
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              loadOtherIfOnRow();
              refresh();
              return;
            }
          }

          // ─── Notes hotkey ─────────────────────────────────────────
          if (q.allowNotes && data === 'n') {
            inputMode = 'note';
            inputQuestionId = q.id;
            editor.setText(notes.get(q.id) ?? '');
            refresh();
            return;
          }

          // ─── Option navigation ────────────────────────────────────
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            loadOtherIfOnRow();
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1);
            loadOtherIfOnRow();
            refresh();
            return;
          }

          // ─── Digit jump-select ────────────────────────────────────
          const digit = digitFromKey(data);
          if (digit !== null && opts.length > 0) {
            const target = Math.min(digit - 1, opts.length - 1);
            optionIndex = target;
            const newOpt = opts[optionIndex];
            if (q.kind === 'single' && newOpt && !newOpt.isOther && !newOpt.isNext) {
              // Auto-confirm on single-select, except when landing on
              // the Type-something row (policy C: land + arm, no confirm).
              saveSingleAnswer(q, newOpt, optionIndex + 1);
              advanceAfterAnswer();
              return;
            }
            loadOtherIfOnRow();
            refresh();
            return;
          }

          // ─── Space toggle (multi) ─────────────────────────────────
          if (q.kind === 'multi' && matchesKey(data, Key.space)) {
            const opt = opts[optionIndex];
            if (opt.isNext || opt.isOther) {
              // space on Next/Other falls through to no-op
              return;
            }
            const set = multiSetFor(q.id);
            if (set.has(optionIndex)) {
              set.delete(optionIndex);
            } else {
              const max = q.maxSelect;
              if (max !== undefined && set.size >= max) return;
              set.add(optionIndex);
            }
            refresh();
            return;
          }

          // ─── Enter: select / next (other handled inline above) ────
          if (matchesKey(data, Key.enter)) {
            const opt = opts[optionIndex];
            if (!opt) return;

            if (opt.isNext) {
              if (!multiNextEnabled(q)) return;
              saveMultiAnswer(q);
              advanceAfterAnswer();
              return;
            }

            if (q.kind === 'single') {
              saveSingleAnswer(q, opt, optionIndex + 1);
              advanceAfterAnswer();
              return;
            }

            if (q.kind === 'multi') {
              // Enter on a checkbox = toggle (alias for Space, matches
              // Claude Code sample 2 where Enter "selects" options).
              const set = multiSetFor(q.id);
              if (set.has(optionIndex)) {
                set.delete(optionIndex);
              } else {
                const max = q.maxSelect;
                if (max === undefined || set.size < max) {
                  set.add(optionIndex);
                }
              }
              refresh();
              return;
            }
          }

          // ─── Cancel ───────────────────────────────────────────────
          if (matchesKey(data, Key.escape)) {
            submit({ cancelled: true });
          }
        }

        // ─── Render ───────────────────────────────────────────────────
        function renderTabBar(width: number, lines: string[]): void {
          const tabs: string[] = ['← '];
          for (let i = 0; i < questions.length; i++) {
            const isActive = i === currentTab;
            const isAnswered = answers.has(questions[i].id);
            const lbl = questions[i].label;
            const box = isAnswered ? '■' : '☐';
            const color = isAnswered ? 'success' : 'muted';
            const text = ` ${box} ${lbl} `;
            const styled = isActive ? theme.bg('selectedBg', theme.fg('text', text)) : theme.fg(color, text);
            tabs.push(`${styled} `);
          }
          const canSubmit = allAnswered();
          const isSubmitTab = currentTab === questions.length;
          const submitText = ' ✓ Submit ';
          const submitStyled = isSubmitTab
            ? theme.bg('selectedBg', theme.fg('text', submitText))
            : theme.fg(canSubmit ? 'success' : 'dim', submitText);
          tabs.push(`${submitStyled} →`);
          lines.push(truncateToWidth(` ${tabs.join('')}`, width));
          lines.push('');
        }

        function renderOptionsList(width: number): string[] {
          const out: string[] = [];
          const opts = currentOptions();
          const q = currentQuestion();
          if (!q) return out;

          const selSet = q.kind === 'multi' ? multiSetFor(q.id) : undefined;

          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            const selected = i === optionIndex;
            const prefix = selected ? theme.fg('accent', '❯ ') : '  ';
            const color = selected ? 'accent' : 'text';

            let labelText: string;
            if (opt.isNext) {
              // Render Next as a distinct row, no number.
              const enabled = multiNextEnabled(q);
              const c = enabled ? color : 'dim';
              out.push(truncateToWidth(prefix + theme.fg(c, '→ Next'), width));
              continue;
            }

            if (opt.isOther) {
              // Inline input: the row itself is the live editor when
              // selected, and shows the saved buffer (or the default
              // prompt) when not selected.
              const head = `${i + 1}. `;
              const prefixStr = prefix + theme.fg(color, head);
              if (selected) {
                const prefixW = visibleWidth(prefixStr);
                const fieldWidth = Math.max(1, width - prefixW);
                const rendered = otherInput.render(fieldWidth);
                out.push(truncateToWidth(prefixStr + (rendered[0] ?? ''), width));
              } else {
                const saved = otherBuffers.get(q.id) ?? '';
                const shown = saved.length > 0 ? saved : opt.label;
                out.push(truncateToWidth(prefixStr + theme.fg(color, shown), width));
              }
              continue;
            }

            if (q.kind === 'multi') {
              const checked = selSet?.has(i) ? 'x' : ' ';
              labelText = `${i + 1}. [${checked}] ${opt.label}`;
            } else {
              labelText = `${i + 1}. ${opt.label}`;
            }

            out.push(truncateToWidth(prefix + theme.fg(color, labelText), width));
            if (opt.description) {
              out.push(truncateToWidth(`     ${theme.fg('muted', opt.description)}`, width));
            }
          }
          return out;
        }

        function renderPreviewPane(height: number, width: number): string[] {
          const opts = currentOptions();
          const opt = opts[optionIndex];
          if (!opt || !opt.preview) return [];
          const raw = opt.preview.split('\n');
          const lines = raw.map((l) => truncateToWidth(l, width));
          // Draw a light rounded box around the preview.
          const top = theme.fg('dim', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
          const bot = theme.fg('dim', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');
          const body = lines
            .slice(0, Math.max(0, height - 2))
            .map((l) => theme.fg('dim', '│ ') + padVisible(l, width - 4) + theme.fg('dim', ' │'));
          while (body.length < Math.max(0, height - 2)) {
            body.push(theme.fg('dim', '│ ') + padVisible('', width - 4) + theme.fg('dim', ' │'));
          }
          return [top, ...body, bot];
        }

        function renderQuestionBody(width: number, lines: string[]): void {
          const q = currentQuestion();
          if (!q) return;

          lines.push(truncateToWidth(theme.fg('text', ` ${q.prompt}`), width));
          lines.push('');

          // Free-text question: editor only (no options).
          if (q.kind === 'free') {
            if (inputMode !== 'free') {
              lines.push(truncateToWidth(theme.fg('muted', ' Start typing to answer. Esc to cancel.'), width));
            } else {
              lines.push(truncateToWidth(theme.fg('muted', ' Your answer:'), width));
              for (const line of editor.render(width - 2)) {
                lines.push(truncateToWidth(` ${line}`, width));
              }
            }
            return;
          }

          // Decide split vs stacked layout based on width and preview presence.
          const opts = currentOptions();
          const activePreview = opts[optionIndex]?.preview;
          const useSplit = !!activePreview && width >= PREVIEW_MIN_WIDTH;

          if (useSplit) {
            const leftWidth = Math.max(30, Math.floor(width * PREVIEW_LEFT_RATIO));
            const rightWidth = width - leftWidth - PREVIEW_GUTTER;
            const leftLines = renderOptionsList(leftWidth);
            const rightLines = renderPreviewPane(leftLines.length, rightWidth);
            const zipped = zipColumns(leftLines, rightLines, leftWidth, PREVIEW_GUTTER);
            for (const z of zipped) lines.push(z);
          } else {
            for (const l of renderOptionsList(width)) lines.push(l);
            if (activePreview) {
              lines.push('');
              for (const l of renderPreviewPane(
                Math.min(12, activePreview.split('\n').length + 2),
                Math.min(width, 80),
              )) {
                lines.push(l);
              }
            }
          }

          // Notes indicator / editor
          const savedNote = notes.get(q.id);
          if (inputMode === 'note' && inputQuestionId === q.id) {
            lines.push('');
            lines.push(truncateToWidth(theme.fg('muted', ' Notes:'), width));
            for (const line of editor.render(width - 2)) {
              lines.push(truncateToWidth(` ${line}`, width));
            }
          } else if (savedNote) {
            lines.push('');
            lines.push(truncateToWidth(theme.fg('muted', ` Notes: `) + theme.fg('text', savedNote), width));
          }
        }

        function renderReview(width: number, lines: string[]): void {
          lines.push(truncateToWidth(theme.fg('accent', theme.bold(' Review your answers')), width));
          lines.push('');

          if (!allAnswered()) {
            const missing = questions
              .filter((q) => !answers.has(q.id))
              .map((q) => q.label)
              .join(', ');
            lines.push(
              truncateToWidth(theme.fg('warning', ` ⚠ You have not answered all questions (${missing})`), width),
            );
            lines.push('');
          }

          for (const question of questions) {
            const answer = answers.get(question.id);
            if (!answer) {
              lines.push(
                truncateToWidth(
                  `${theme.fg('muted', ` ${question.label}: `)}${theme.fg('dim', '(unanswered)')}`,
                  width,
                ),
              );
              continue;
            }
            let display: string;
            if (answer.kind === 'multi') {
              display = (answer.labels ?? []).join(', ') || '(none)';
            } else if (answer.wasCustom) {
              display = `(wrote) ${answer.label ?? ''}`;
            } else {
              display = answer.label ?? '';
            }
            let line = `${theme.fg('muted', ` ${question.label}: `)}${theme.fg('text', display)}`;
            if (answer.note) {
              line += theme.fg('dim', `  — note: ${answer.note}`);
            }
            lines.push(truncateToWidth(line, width));
          }

          lines.push('');
          lines.push(truncateToWidth(theme.fg('text', ' Ready to submit your answers?'), width));
          lines.push('');

          const rows = ['Submit answers', 'Cancel'];
          for (let i = 0; i < rows.length; i++) {
            const selected = i === reviewIndex;
            const prefix = selected ? theme.fg('accent', '❯ ') : '  ';
            const disabled = i === 0 && !allAnswered();
            const color = disabled ? 'dim' : selected ? 'accent' : 'text';
            lines.push(truncateToWidth(prefix + theme.fg(color, `${i + 1}. ${rows[i]}`), width));
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          lines.push(theme.fg('accent', '─'.repeat(width)));

          // Tab bar (always shown; acts as progress indicator even for
          // single-question questionnaires).
          renderTabBar(width, lines);

          if (currentTab === questions.length) {
            renderReview(width, lines);
          } else {
            renderQuestionBody(width, lines);
          }

          lines.push('');
          lines.push(theme.fg('accent', '─'.repeat(width)));

          if (allowChat) {
            lines.push(truncateToWidth(theme.fg('muted', '   Chat about this'), width));
            lines.push('');
          }

          const helpParts: string[] = [];
          if (inputMode) {
            helpParts.push('Enter submit', 'Esc cancel');
          } else if (currentTab === questions.length) {
            helpParts.push('↑↓ navigate', 'Enter confirm');
            if (isMulti) helpParts.push('Tab switch');
            helpParts.push('Esc cancel');
          } else {
            const q = currentQuestion();
            if (q?.kind === 'free') {
              helpParts.push('type to answer');
            } else {
              helpParts.push('↑↓ navigate', '1-9 jump');
              if (q?.kind === 'multi') helpParts.push('Space toggle');
              helpParts.push('Enter select');
            }
            if (q?.allowNotes) helpParts.push('n notes');
            if (isMulti) helpParts.push('Tab switch');
            if (allowChat) helpParts.push('c chat');
            helpParts.push('Esc cancel');
          }
          lines.push(truncateToWidth(theme.fg('dim', ' ' + helpParts.join(' · ')), width));
          lines.push(theme.fg('accent', '─'.repeat(width)));

          cachedLines = lines;
          return lines;
        }

        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
          },
          handleInput,
        };
      });

      if (result.chatRequested) {
        const qLabel = result.chatContextId
          ? (questions.find((q) => q.id === result.chatContextId)?.label ?? result.chatContextId)
          : null;
        const summary = qLabel
          ? `User requested chat about ${qLabel}. Continue the conversation ` +
            'naturally — do not re-ask via questionnaire.'
          : 'User requested chat about the questionnaire. Continue in prose.';
        return {
          content: [{ type: 'text', text: summary }],
          details: result,
        };
      }

      if (result.cancelled) {
        return {
          content: [{ type: 'text', text: 'User cancelled the questionnaire' }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        let body: string;
        if (a.kind === 'multi') {
          const parts = (a.indices ?? []).map((idx, i) => `${idx}. ${a.labels?.[i] ?? ''}`);
          body = `user selected: ${parts.join(', ') || '(none)'}`;
        } else if (a.wasCustom) {
          body = `user wrote: ${a.label ?? a.customText ?? ''}`;
        } else {
          body = `user selected: ${a.index ?? '?'}. ${a.label ?? ''}`;
        }
        const noteSuffix = a.note ? ` (note: ${a.note})` : '';
        return `${qLabel}: ${body}${noteSuffix}`;
      });

      return {
        content: [{ type: 'text', text: answerLines.join('\n') }],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as { id: string; label?: string; kind?: string }[]) ?? [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(', ');
      let text = theme.fg('toolTitle', theme.bold('questionnaire '));
      text += theme.fg('muted', `${count} question${count !== 1 ? 's' : ''}`);
      if (labels) {
        text += theme.fg('dim', ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === 'text' ? text.text : '', 0, 0);
      }
      if (details.chatRequested) {
        return new Text(
          theme.fg('accent', '💬 Chat requested') +
            (details.chatContextId ? theme.fg('dim', ` (from ${details.chatContextId})`) : ''),
          0,
          0,
        );
      }
      if (details.cancelled) {
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0);
      }
      const lines = details.answers.map((a) => {
        let body: string;
        if (a.kind === 'multi') {
          body = (a.labels ?? []).join(', ') || '(none)';
        } else if (a.wasCustom) {
          body = `(wrote) ${a.label ?? ''}`;
        } else {
          body = a.index ? `${a.index}. ${a.label ?? ''}` : (a.label ?? '');
        }
        const noteSuffix = a.note ? theme.fg('dim', `  — ${a.note}`) : '';
        const icon = a.wasCustom ? '✎' : '✓';
        return `${theme.fg('success', `${icon} `)}${theme.fg('accent', a.id)}: ${body}${noteSuffix}`;
      });
      return new Text(lines.join('\n'), 0, 0);
    },
  });
}
