/**
 * Shared types for the `comfyui` extension's pure helpers.
 *
 * Kept in one module so `config.ts`, `workflow.ts`, and `api.ts` agree
 * on the config / graph / output shapes without a circular import. No
 * pi imports - everything here is plain data validated out of untrusted
 * JSON.
 */

/** A single request header injected on every ComfyUI call (HTTP + ws). */
export interface AuthHeader {
  name: string;
  value: string;
}

/**
 * Where a tunable parameter lives inside an API-format workflow graph:
 * the `node` id (the object key in the graph) and the `key` inside that
 * node's `inputs` object.
 */
export interface InputMapping {
  node: string;
  key: string;
}

/** A named workflow: the API-format JSON file plus its parameter map. */
export interface WorkflowConfig {
  /** Path to the API-format workflow JSON. `~` is expanded by the caller. */
  file: string;
  /** Maps tunable names (`prompt`, `seed`, …) to their node id + input key. */
  inputs: Record<string, InputMapping>;
}

/** Fully-resolved extension config (defaults + user + project layers). */
export interface ComfyuiConfig {
  /** ComfyUI server origin, e.g. `http://127.0.0.1:8188`. */
  baseUrl: string;
  /** Optional auth header sent on every request; value supports `${ENV}`. */
  authHeader?: AuthHeader;
  /** Hard cap on a single generation before it is aborted (ms). */
  timeoutMs: number;
  /** Directory (relative to cwd) where generated PNGs are written. */
  saveDir: string;
  /** Name of the workflow used when the tool call omits `workflow`. */
  defaultWorkflow: string;
  /**
   * Whether the generated image is returned in the tool result (and so
   * fed back to the model on the next turn). When `false`, the image is
   * still saved to disk but the result is text-only - no image tokens
   * enter the model's context. A per-call `sendToModel` arg overrides it.
   */
  sendToModel: boolean;
  /** Named workflows keyed by the name the model passes to the tool. */
  workflows: Record<string, WorkflowConfig>;
}

/** A generated-image reference as ComfyUI reports it in `/history`. */
export interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** One node in an API-format workflow graph. */
export interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}

/** An API-format workflow graph: node id -> node. */
export type ComfyWorkflow = Record<string, ComfyNode>;
