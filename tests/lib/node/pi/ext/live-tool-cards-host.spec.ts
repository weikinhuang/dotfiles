/** Exercise the actual SDK row and HTML exporter, including a globally installed SDK when requested. */
import { Text, type Component } from '@earendil-works/pi-tui';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';

import {
  LiveToolCards,
  type LiveCardRenderContext as ToolRenderContext,
} from '../../../../../lib/node/pi/ext/live-tool-cards.ts';

interface HostRow extends Component {
  markExecutionStarted(): void;
  updateResult(result: unknown, isPartial?: boolean): void;
}

const dist = process.env.PI_LIVE_CARD_SDK_ROOT
  ? join(process.env.PI_LIVE_CARD_SDK_ROOT, 'dist')
  : dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));

async function sdkModule(path: string): Promise<unknown> {
  return import(pathToFileURL(join(dist, path)).href);
}

test('settled host rows redraw in place while HTML exports retain the original result', async () => {
  const { initTheme, theme } = (await sdkModule('modes/interactive/theme/theme.js')) as {
    initTheme: (name: string) => void;
    theme: unknown;
  };
  initTheme('dark');
  const { ToolExecutionComponent } = (await sdkModule('modes/interactive/components/tool-execution.js')) as {
    ToolExecutionComponent: new (
      name: string,
      id: string,
      args: unknown,
      options: unknown,
      definition: unknown,
      ui: unknown,
      cwd: string,
    ) => HostRow;
  };
  const { createToolHtmlRenderer } = (await sdkModule('core/export-html/tool-renderer.js')) as {
    createToolHtmlRenderer: (options: unknown) => {
      renderCall(id: string, name: string, args: unknown): unknown;
      renderResult(id: string, name: string, content: unknown, details: unknown, isError: boolean): unknown;
    };
  };
  const cards = new LiveToolCards<string>();
  cards.reset(true);
  let value = 'live running';
  let active = true;
  const definition = {
    renderCall: (_args: unknown, _theme: unknown, context: ToolRenderContext): Text => {
      cards.capture(context);
      return new Text('background task', 0, 0);
    },
    renderResult: (
      result: { content: { text: string }[] },
      _options: unknown,
      _theme: unknown,
      context: ToolRenderContext,
    ): Text => new Text(cards.read(context) ?? result.content[0].text, 0, 0),
  };
  const ui = { requestRender: vi.fn() };
  const row = new ToolExecutionComponent('probe', 'probe-1', {}, {}, definition, ui, process.cwd());
  try {
    row.markExecutionStarted();
    cards.bind('probe-1', { mode: 'tui' }, () => ({ value, active }));
    const result = { content: [{ type: 'text', text: 'immutable spawn receipt' }], details: undefined, isError: false };
    const original = JSON.stringify(result);
    row.updateResult(result, false);
    expect(row.render(120).join('\n')).toContain('live running');
    const exporter = createToolHtmlRenderer({ getToolRenderers: () => definition, theme, cwd: process.cwd() });
    exporter.renderCall('probe-1', 'probe', {});
    expect(JSON.stringify(exporter.renderResult('probe-1', 'probe', result.content, undefined, false))).toContain(
      'immutable spawn receipt',
    );
    ui.requestRender.mockClear();
    value = 'live completed';
    active = false;
    cards.refresh();
    expect(ui.requestRender).toHaveBeenCalled();
    expect(row.render(120).join('\n')).toContain('live completed');
    expect(JSON.stringify(result)).toBe(original);
    expect(JSON.stringify(exporter.renderResult('probe-1', 'probe', result.content, undefined, false))).not.toContain(
      'live completed',
    );
  } finally {
    cards.reset();
  }
});
