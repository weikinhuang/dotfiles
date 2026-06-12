/**
 * USAGE text for the `/tts` command. Pure string module so the extension
 * shell, its command `description`, and the `--help` path share one source
 * of truth.
 */
export const TTS_USAGE = [
  'Usage: /tts [on|off|narrate on|off|voice <name>|narration-voice <name>|say <text>|status [<voice>]]',
  '',
  'on / off                 toggle RP dialogue narration',
  'narrate on / off         toggle agent-output narration',
  'voice <name>             override the RP voice for this session',
  'narration-voice <name>   override the narration voice for this session',
  'say <text>               synth + play literal text now (engine smoke test, bypasses gating)',
  'status [<voice>]         show modes/persona/engine + probe resolved voices (or one named voice)',
].join('\n');
