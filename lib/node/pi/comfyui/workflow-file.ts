/** Direct-file workflows have no semantic input map: submit them unchanged. */
import { resolve } from 'node:path';

import { expandTilde } from '../path-expand.ts';
import type { ComfyWorkflow } from './types.ts';
import { loadWorkflowGraph } from './workflow.ts';

const FILE_OPTIONS = new Set(['workflowFile', 'background', 'sendToModel', 'ephemeral', 'previewMaxDimension']);

export type FileWorkflowResult = { file: string; graph: ComfyWorkflow } | { error: string };

/** Validate options and read one snapshot before any uploads or submission. */
export function prepareWorkflowFile(
  params: Readonly<Record<string, unknown>>,
  cwd: string,
  home: string,
): FileWorkflowResult {
  const path = params.workflowFile;
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { error: 'workflowFile must be a non-empty local API-format JSON path' };
  }
  const unsupported = Object.keys(params).filter((key) => {
    if (params[key] === undefined || FILE_OPTIONS.has(key)) return false;
    // Explicitly disabling these is harmless; configured defaults are bypassed.
    return !((key === 'enhance' || key === 'autoRefine') && params[key] === false);
  });
  if (unsupported.length > 0) {
    return {
      error:
        `workflowFile executes the graph as authored; incompatible options: ${unsupported.join(', ')}. ` +
        'Edit the API JSON values, or use a named workflow with input mappings.',
    };
  }
  const file = resolve(cwd, expandTilde(path.trim(), home));
  const loaded = loadWorkflowGraph(file, cwd, home);
  if (!loaded.graph) return { error: loaded.error ?? 'failed to load workflowFile' };
  for (const [id, node] of Object.entries(loaded.graph)) {
    if (typeof node.class_type !== 'string' || node.class_type.trim().length === 0) {
      return { error: `workflowFile node "${id}" needs a non-empty class_type; use API format, not canvas/UI JSON` };
    }
  }
  return { file, graph: loaded.graph };
}
