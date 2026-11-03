/** Searchable message browser and explicit-save text editor for /context-edit. */
import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  Editor,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';

import { filterMessageEditItems, type MessageEditItem, type MessageEditRole } from '../context-edit/messages.ts';
import { collapseWhitespace, truncate } from '../shared.ts';
import {
  EXTERNAL_EDITOR_BINDING,
  formatKeyChord,
  isExternalEditorKey,
  openInExternalEditor,
} from './external-editor.ts';
import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';

export interface MessageEditResult {
  ok: boolean;
  message: string;
}

export interface MessageEditOverlayDeps {
  getItems(): MessageEditItem[];
  save(item: MessageEditItem, text: string): MessageEditResult;
  restore(id: number): MessageEditResult;
}

export interface MessageEditOverlayOptions {
  query?: string;
  editedOnly?: boolean;
  /** Open a direct handle in the editor immediately. */
  editKey?: string;
}

export class MessageEditOverlay implements Component {
  private readonly input = new Input();
  private readonly editor: Editor;
  private active = false;
  private previewFocused = false;
  private role: MessageEditRole = 'all';
  private editedOnly: boolean;
  private selectedKey?: string;
  private editing?: MessageEditItem;
  private baseline = '';
  private discardPrompt = false;
  private externalBusy = false;
  private disposed = false;
  private originalView = false;
  private listTop = 0;
  private previewTop = 0;
  private previewPage = 1;
  private previewMax = 0;
  private listPage = 1;
  private status = '';
  private previewCache?: { text: string; width: number; lines: string[] };

  constructor(
    private readonly deps: MessageEditOverlayDeps,
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly kb: KeybindingsManager,
    private readonly onClose: () => void,
    options: MessageEditOverlayOptions = {},
  ) {
    this.editedOnly = options.editedOnly ?? false;
    this.input.setValue(options.query ?? '');
    this.editor = new Editor(tui, {
      borderColor: (text) => theme.fg('accent', text),
      selectList: {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      },
    });
    // Never let the editor's submit binding save, even with custom keybindings.
    this.editor.disableSubmit = true;
    const items = this.visible();
    const chronological = items.toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const initial =
      items.find((item) => item.key === options.editKey) ??
      chronological.findLast((item) => item.role === 'assistant' && !item.stale) ??
      chronological.findLast((item) => !item.stale) ??
      items.at(-1);
    this.selectedKey = initial?.key;
    if (options.editKey && initial?.key === options.editKey) this.openEditor(initial);
  }

  get focused(): boolean {
    return this.active;
  }

  set focused(value: boolean) {
    this.active = value;
    this.syncFocus();
  }

  private syncFocus(): void {
    this.input.focused = this.active && !this.editing && !this.previewFocused;
    this.editor.focused = this.active && !!this.editing;
  }

  private visible(): MessageEditItem[] {
    return filterMessageEditItems(this.deps.getItems(), this.input.getValue(), this.role, this.editedOnly);
  }

  private selected(items = this.visible()): MessageEditItem | undefined {
    return items.find((item) => item.key === this.selectedKey) ?? items[0];
  }

  private select(item: MessageEditItem | undefined): void {
    this.selectedKey = item?.key;
    this.previewTop = 0;
  }

  private refresh(): void {
    this.syncFocus();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.editor.invalidate();
    this.input.invalidate();
    this.previewCache = undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  handleInput(data: string): void {
    if (this.externalBusy) return;
    if (this.editing) {
      this.handleEditorInput(data);
      this.refresh();
      return;
    }
    if (this.kb.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.previewFocused = !this.previewFocused;
    } else if (matchesKey(data, Key.ctrl('t'))) {
      this.role = this.role === 'all' ? 'user' : this.role === 'user' ? 'assistant' : 'all';
      this.select(this.selected());
      this.listTop = 0;
    } else if (matchesKey(data, Key.ctrl('e'))) {
      this.editedOnly = !this.editedOnly;
      this.select(this.selected());
      this.listTop = 0;
    } else if (matchesKey(data, Key.ctrl('o'))) {
      this.originalView = !this.originalView;
      this.previewTop = 0;
    } else if (matchesKey(data, Key.ctrl('r'))) {
      const item = this.selected();
      if (item?.editId !== undefined) {
        const result = this.deps.restore(item.editId);
        this.status = result.message;
        if (result.ok) this.select(this.selected());
      } else {
        this.status = 'Selected message has no edit to restore.';
      }
    } else if (this.kb.matches(data, 'tui.select.confirm')) {
      const item = this.selected();
      if (item && !item.stale) this.openEditor(item);
      else
        this.status = item?.stale
          ? 'This edit is outside the current context. Ctrl+R restores it.'
          : 'No message selected.';
    } else if (this.handleNavigation(data)) {
      // Navigation owns arrows even while the search field has focus.
    } else if (!this.previewFocused) {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) {
        this.select(this.selected());
        this.listTop = 0;
        this.status = '';
      }
    }
    this.refresh();
  }

  private handleNavigation(data: string): boolean {
    const up = this.kb.matches(data, 'tui.select.up');
    const down = this.kb.matches(data, 'tui.select.down');
    const pageUp = matchesKey(data, Key.pageUp);
    const pageDown = matchesKey(data, Key.pageDown);
    const home = matchesKey(data, Key.home);
    const end = matchesKey(data, Key.end);
    if (!up && !down && !pageUp && !pageDown && !home && !end) return false;
    if (this.previewFocused) {
      const delta = up ? -1 : down ? 1 : pageUp ? -this.previewPage : this.previewPage;
      this.previewTop = home
        ? 0
        : end
          ? this.previewMax
          : Math.max(0, Math.min(this.previewMax, this.previewTop + delta));
    } else {
      const items = this.visible();
      const index = Math.max(
        0,
        items.findIndex((item) => item.key === this.selected(items)?.key),
      );
      const delta = up ? -1 : down ? 1 : pageUp ? -this.listPage : this.listPage;
      this.select(items[home ? 0 : end ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + delta))]);
    }
    return true;
  }

  private openEditor(item: MessageEditItem): void {
    if (item.stale) return;
    this.editing = item;
    this.editor.setText(item.text);
    this.baseline = this.editor.getExpandedText();
    this.discardPrompt = false;
    this.status = '';
    this.syncFocus();
  }

  private leaveEditor(message: string): void {
    this.editing = undefined;
    this.discardPrompt = false;
    this.status = message;
    this.select(this.selected());
  }

  private handleEditorInput(data: string): void {
    if (this.discardPrompt) {
      if (matchesKey(data, Key.ctrl('d'))) this.leaveEditor('Edit cancelled. No changes saved.');
      else if (matchesKey(data, Key.escape)) this.discardPrompt = false;
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.editor.getExpandedText() !== this.baseline) this.discardPrompt = true;
      else this.leaveEditor('No change.');
      return;
    }
    if (matchesKey(data, Key.ctrl('s')) || matchesKey(data, Key.super('s'))) {
      const text = this.editor.getExpandedText();
      if (text === this.baseline) this.leaveEditor('No change.');
      else if (this.editing) {
        const result = this.deps.save(this.editing, text);
        if (result.ok) this.leaveEditor(result.message);
        else this.status = result.message;
      }
      return;
    }
    if (isExternalEditorKey(data, this.kb)) {
      this.externalBusy = true;
      void openInExternalEditor({
        tui: this.tui,
        getText: () => this.editor.getExpandedText(),
        setText: (text) => this.editor.setText(text),
      })
        .catch((error: unknown) => {
          this.status = `External editor failed: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => {
          this.externalBusy = false;
          if (!this.disposed) this.refresh();
        });
      return;
    }
    if (matchesKey(data, Key.enter) || this.kb.matches(data, 'tui.input.submit')) {
      this.editor.insertTextAtCursor('\n');
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const rows = overlayViewportRows(this.tui.terminal.rows);
    const clip = (line: string): string => truncateToWidth(line, width);
    if (this.editing) {
      const item = this.editing;
      const dirty = this.editor.getExpandedText() !== this.baseline;
      const body = this.editor.render(Math.max(1, width));
      const cursor = body.findIndex((line) => line.includes(CURSOR_MARKER));
      return assembleWindowedBody({
        header: [
          clip(this.theme.fg('accent', `Edit ${item.id} · ${item.role}${dirty ? ' · unsaved' : ''}`)),
          clip('Future model context only. Original transcript and later turns stay intact.'),
          clip(`${item.nonTextParts} non-text part(s) preserved.`),
        ],
        body,
        footer: [
          clip(this.status),
          clip(
            this.discardPrompt
              ? 'Discard unsaved changes? Ctrl+D discard · Esc keep editing'
              : width < 80
                ? 'Ctrl+S save · Enter newline · Esc cancel'
                : 'Ctrl+S / Cmd+S save · Enter newline · Esc cancel',
          ),
          clip(
            this.discardPrompt
              ? ''
              : width < 80
                ? `${formatKeyChord(this.kb.getKeys(EXTERNAL_EDITOR_BINDING)[0])} external · Cmd+S if forwarded`
                : `${formatKeyChord(this.kb.getKeys(EXTERNAL_EDITOR_BINDING)[0])} external editor · Saving does not run the model`,
          ),
        ],
        width,
        viewportRows: rows,
        scrollTop: 0,
        keepStart: cursor >= 0 ? cursor : undefined,
        keepEnd: cursor >= 0 ? cursor + 1 : undefined,
        theme: this.theme,
      }).lines;
    }

    const all = this.deps.getItems();
    const items = this.visible();
    const selected = this.selected(items);
    const index = Math.max(
      0,
      items.findIndex((item) => item.key === selected?.key),
    );
    const header = [
      clip(
        this.theme.fg(
          'accent',
          `Context edit · ${all.filter((item) => item.editId !== undefined).length} active edits`,
        ),
      ),
      clip(
        `Role: ${this.role} · ${this.editedOnly ? 'edited only' : 'all messages'} · ${items.length} matches · ${this.previewFocused ? 'preview focused' : 'type to search'}`,
      ),
      ...this.input.render(Math.max(1, width - 8)).map((line) => clip(`Search: ${line}`)),
    ];
    const footer = [
      clip(this.status),
      ...(width < 80
        ? [
            '↑↓ move · Enter edit · Tab preview · Esc close',
            'Ctrl+T role · Ctrl+E edits · Ctrl+O compare',
            'Ctrl+R restore',
          ]
        : [
            '↑↓ select · Enter edit · Tab preview/search · Esc close',
            'Ctrl+T role · Ctrl+E edited only · Ctrl+O original/current · Ctrl+R restore',
          ]
      ).map(clip),
    ];
    const bodyRows = Math.max(0, rows - header.length - footer.length);
    const listRows = Math.min(8, Math.max(1, Math.floor(bodyRows / 3)));
    const list = assembleWindowedBody({
      header: [],
      body: items.length
        ? items.map((item) =>
            clip(
              `${item.key === selected?.key ? '> ' : '  '}${item.id} ${item.role}${item.editId !== undefined ? ` [edited #${item.editId}]` : ''}${item.stale ? ' [stale]' : ''} ${truncate(collapseWhitespace(item.text), 100)}`,
            ),
          )
        : ['No matching messages. Change the search or filters.'],
      footer: [],
      width,
      viewportRows: listRows,
      scrollTop: this.listTop,
      keepStart: index,
      keepEnd: index + 1,
      theme: this.theme,
    });
    this.listTop = list.scrollTop;
    this.listPage = list.contentRows;
    const text = selected ? (this.originalView ? selected.original : selected.text) : '';
    const wrapWidth = Math.max(1, width);
    if (!this.previewCache || this.previewCache.text !== text || this.previewCache.width !== wrapWidth) {
      this.previewCache = {
        text,
        width: wrapWidth,
        lines: text.split('\n').flatMap((line) => wrapTextWithAnsi(line, wrapWidth)),
      };
    }
    const preview = assembleWindowedBody({
      header: [],
      body: this.previewCache.lines,
      footer: [],
      width,
      viewportRows: Math.max(0, bodyRows - list.lines.length - 1),
      scrollTop: this.previewTop,
      theme: this.theme,
    });
    this.previewTop = preview.scrollTop;
    this.previewPage = preview.contentRows;
    this.previewMax = preview.maxScrollTop;
    return assembleWindowedBody({
      header,
      body: [
        ...list.lines,
        clip(
          `Preview: ${selected?.id ?? '(none)'} · ${this.originalView ? 'ORIGINAL' : 'CURRENT'}${selected?.stale ? ' · outside current context' : ''}`,
        ),
        ...preview.lines,
      ],
      footer,
      width,
      viewportRows: rows,
      scrollTop: 0,
      theme: this.theme,
    }).lines.map(clip);
  }
}
