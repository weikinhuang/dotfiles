/**
 * Thin re-export shim. The assistant-message navigation helpers that used
 * to live here now share the canonical `content -> text` core in
 * `./message-text.ts`; this file re-exports them so existing importers keep
 * working. Prefer importing from `./message-text.ts` directly in new code.
 */

export type {
  AssistantTextOptions,
  ExtractLastAssistantTextOptions,
  FindLastAssistantMessageOptions,
  LooseMessage,
} from './message-text.ts';
export {
  extractAssistantContentText,
  extractAssistantMessageText,
  extractLastAssistantText,
  findLastAssistantMessage,
} from './message-text.ts';
