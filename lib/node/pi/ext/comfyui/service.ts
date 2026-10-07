/** Shared executor access. Keeps alternate interfaces on the same ComfyUI session runtime. */
import type { AgentToolUpdateCallback, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createGlobalSlot } from '../../global-slot.ts';
import type { GenerateDetails } from './details.ts';
import type { GenerateToolResult } from './generate.ts';
import type { GenerateParams } from './params.ts';

export interface ComfyuiGenerateRequest {
  toolCallId: string;
  params: GenerateParams;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<GenerateDetails>;
  ctx: ExtensionContext;
  requireEnhance?: boolean;
  isolatedContext?: boolean;
}

export type ComfyuiGenerator = (request: ComfyuiGenerateRequest) => Promise<GenerateToolResult>;
const getSlot = createGlobalSlot<{ generate?: ComfyuiGenerator }>('@dotfiles/pi/comfyui/generator', () => ({}));

export function installComfyuiGenerator(generate: ComfyuiGenerator): () => void {
  getSlot().generate = generate;
  return () => {
    if (getSlot().generate === generate) getSlot().generate = undefined;
  };
}

export function getComfyuiGenerator(): ComfyuiGenerator | undefined {
  return getSlot().generate;
}
