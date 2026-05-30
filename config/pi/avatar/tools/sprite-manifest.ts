/**
 * Sprite-set manifest for the avatar extension's PNG generation workflow.
 *
 * Character-agnostic single source of truth shared by the prompt generator
 * (config/pi/avatar/tools/print-prompts.ts) and the sheet slicer
 * (config/pi/avatar/tools/slice-sheets.ts).
 *
 * Frames per state
 * ----------------
 * Each state has an ordered list of frame descriptions: frame 0 is the base
 * pose (from `poses`), and `frames[state]` lists every frame after it. A state
 * with no `frames` entry defaults to two frames (base + FRAME_B_DEFAULT). The
 * extension cycles through whatever frames exist, so the count is chosen to
 * match how each state animates:
 *   - cycle  (talk, read, write, tool + lively emotions): 3-4 frames ping-pong
 *   - random (hi, compact, success): a few alternates for variety
 *   - alt    (idle, think, wait + most emotions): 2 frames (base + a blink/beat)
 *
 * Sheets
 * ------
 * States are generated as grid "sheets" (GRID.cols x GRID.rows cells) on a flat
 * CHROMA background. Frame 0 of every state goes on sheet `a`, frame 1 on sheet
 * `b`; any frames beyond that are packed densely onto extra sheets `x1`, `x2`,
 * ... (see `sheetsFor`). The slicer maps each cell back to `<state>/<frame>.png`
 * using the same packing, so partial sets are fine - generate in batches.
 *
 * State names MUST match the keys in config/pi/avatar/emotes/ascii/ascii.yaml.
 */

/** Grid layout per sheet. cols*rows is the cells available per sheet. */
export const GRID = { cols: 4, rows: 3 } as const;

/** Cells available on one sheet. */
export const CELLS = GRID.cols * GRID.rows;

/**
 * Output sprite resolution: the median sprite is scaled to TARGET_PX * fill px
 * tall. Generated sheets are high-res (cells ~300px+), so keep this large to
 * stay near native resolution -- downscaling to ~128 and letting the terminal
 * upscale again is what makes frames look blurry. The terminal scales the PNG
 * down to the avatar's cell width at display time.
 */
export const TARGET_PX = 320;

/** Flat background color generated behind every cell, keyed out to transparent. */
export const CHROMA = '#00FF00';

/**
 * Thin border drawn around every cell as an identical registration frame. It
 * forces the model to draw each sprite at the same size and position (so frames
 * stay registered and cells never bleed into each other) and is keyed out to
 * transparent by the slicer alongside CHROMA.
 *
 * Pick a color FAR from the character's palette: image UIs desaturate/anti-alias
 * the border, so it must stay distinct even when softened, or the key will punch
 * holes in the art. Cyan suits warm characters (red/orange/pink); use magenta or
 * orange for cool ones. It must also differ from CHROMA.
 */
export const BORDER = '#00FFFF';

/** Character-agnostic art-style clause shared by every prompt. */
export const STYLE =
  'crisp pixel-art sprite, limited palette, clean 1px outlines, slightly chibi proportions, bust framing (head and shoulders), the exact same character design, outfit, and color palette in every cell';

/** Frame-1 instruction used for any state without an explicit `frames` list. */
export const FRAME_B_DEFAULT =
  'second animation beat: a subtle variation of the same expression (a blink, a slightly bigger mouth or smile, or a tiny head bob) - identical framing, palette, and outline.';

export interface SpriteGroup {
  /** Ordered state names (grid reading order on sheet `a`). */
  states: string[];
  /** Frame-0 (base) expression/pose per state. */
  poses: Record<string, string>;
  /** Frames after the base (index 1..N) per state; absent => [FRAME_B_DEFAULT]. */
  frames?: Record<string, string[]>;
}

/** One generated cell: which state/frame it holds and how to draw it. */
export interface SheetCell {
  state: string;
  frame: number;
  desc: string;
}

/** One sheet to generate: an ordered list of CELLS cells (null = leave blank). */
export interface Sheet {
  name: string;
  cells: (SheetCell | null)[];
}

export const GROUPS: Record<string, SpriteGroup> = {
  activities: {
    states: ['hi', 'idle', 'wait', 'think', 'talk', 'read', 'write', 'tool', 'success', 'failure', 'compact'],
    poses: {
      hi: 'waving hello, bright welcoming smile',
      idle: 'relaxed neutral, gentle closed-mouth smile, facing forward',
      wait: 'waiting patiently, glancing aside, faint expectant look',
      think: 'thinking, eyes up, fingertip to chin',
      talk: 'talking, mouth open mid-word, animated',
      read: 'reading, eyes down and scanning',
      write: 'writing/typing, focused downward',
      tool: 'tinkering with a small gadget or tool, focused',
      success: 'triumphant grin, thumbs-up',
      failure: 'dismayed, single sweatdrop, awkward frown',
      compact: 'busy tidying up, sweeping and organizing',
    },
    frames: {
      // random: alternates for variety
      hi: ['arm raised higher, bigger open-mouth wave', 'both arms up, cheerful two-handed wave'],
      success: ['both arms up, winking', 'a little victory jump, big grin'],
      compact: ['mid-sweep, broom swung to the other side', 'crouched, tidying a small pile'],
      // alt: base + a single blink/beat
      idle: ['eyes closed in a blink'],
      wait: ['slight head tilt, fingers tapping'],
      think: ['eyes shut in concentration, small "aha" brow'],
      failure: ['eyes squeezed shut, bigger sweatdrop'],
      // cycle: ordered motion steps
      talk: ['mouth in a small "oo" shape', 'mouth half-open', 'mouth wide open'],
      read: ['eyes shifted to the next line', 'turning to the next page'],
      write: ['hand moved to the next stroke', 'pausing mid-line, pen lifted'],
      tool: ['tool rotated, a tiny spark', 'tightening it with focused eyes'],
    },
  },

  positive: {
    states: [
      'happy',
      'joy',
      'laugh',
      'smile',
      'grin',
      'excited',
      'celebrate',
      'party',
      'content',
      'relieved',
      'hopeful',
      'playful',
    ],
    poses: {
      happy: 'happy, warm smile, bright eyes',
      joy: 'overjoyed, beaming, arms a little raised',
      laugh: 'laughing, eyes closed, open grin',
      smile: 'soft gentle smile',
      grin: 'wide toothy grin',
      excited: 'excited, sparkling eyes, energetic',
      celebrate: 'celebrating, arms up, cheering',
      party: 'festive party mood, cheering',
      content: 'content, calm satisfied smile',
      relieved: 'relieved, eased smile, small exhale',
      hopeful: 'hopeful, eyes up, optimistic gleam',
      playful: 'playful, cheeky grin, tongue out',
    },
    frames: {
      joy: ['beaming wider, arms a little higher', 'eyes closed, radiant grin'],
      laugh: ['head tilted further back, bigger laugh', 'wiping a happy tear, still giggling'],
      excited: ['bouncing up, fists clenched', 'sparkles popping, even more energetic'],
      celebrate: ['confetti burst, jumping higher', 'arms switched, more confetti raining'],
      party: ['arms switched, more confetti', 'party horn raised, cheek puffed'],
      playful: ['tongue out the other side, quick wink'],
    },
  },

  affection: {
    states: [
      'love',
      'blush',
      'shy',
      'smitten',
      'wink',
      'sparkle',
      'starstruck',
      'proud',
      'cool',
      'smug',
      'calm',
      'zen',
    ],
    poses: {
      love: 'in love, heart-shaped eyes, blissful',
      blush: 'blushing, shy smile, pink cheeks',
      shy: 'shy, looking away, fidgeting',
      smitten: 'smitten, dreamy look, little hearts',
      wink: 'winking, one eye closed, playful smile',
      sparkle: 'delighted, twinkles sparkling around',
      starstruck: 'starstruck, star-shaped eyes, awe',
      proud: 'proud, chest out, confident smile',
      cool: 'cool and confident, slight smirk',
      smug: 'smug, half-lidded eyes, sly smirk',
      calm: 'calm and serene, eyes softly closed',
      zen: 'zen, peaceful, meditative',
    },
    frames: {
      love: ['little hearts floating up', 'hearts bigger, a dreamy sigh'],
      sparkle: ['twinkles popping in new spots', 'one big sparkle bursts'],
      starstruck: ['stars pop bigger', 'eyes shimmer, jaw slightly dropped'],
      wink: ['switch the winking eye, add a small heart'],
    },
  },

  negative: {
    states: [
      'sad',
      'cry',
      'sob',
      'angry',
      'annoyed',
      'grumpy',
      'frown',
      'pout',
      'disappointed',
      'heartbroken',
      'worried',
      'nervous',
    ],
    poses: {
      sad: 'sad, downturned eyes, slight frown',
      cry: 'crying, tears streaming, eyes shut',
      sob: 'sobbing hard, big tears, mouth open',
      angry: 'angry, furrowed brow, gritted teeth',
      annoyed: 'annoyed, flat unimpressed eyes',
      grumpy: 'grumpy, scowl, arms crossed',
      frown: 'frowning, unhappy mouth',
      pout: 'pouting, puffed cheeks, looking aside',
      disappointed: 'disappointed, lowered gaze',
      heartbroken: 'heartbroken, teary, broken-heart vibe',
      worried: 'worried, anxious brow, uneasy mouth',
      nervous: 'nervous, sweatdrop, tense smile',
    },
    frames: {
      cry: ['more tears welling up', 'tears streaming down, lip quivering'],
      sob: ['bigger tears bursting out', 'face scrunched up, wailing'],
      angry: ['a steam puff, brow lower'],
    },
  },

  shock: {
    states: [
      'surprised',
      'shocked',
      'scared',
      'fear',
      'panic',
      'dizzy',
      'mindblown',
      'confused',
      'curious',
      'embarrassed',
      'facepalm',
      'sick',
    ],
    poses: {
      surprised: 'surprised, wide eyes, open mouth',
      shocked: 'shocked, jaw dropped, recoiling',
      scared: 'scared, wide fearful eyes, trembling',
      fear: 'fearful, pale, shrinking back',
      panic: 'panicking, flailing, frantic eyes',
      dizzy: 'dizzy, swirly eyes, wobbling',
      mindblown: 'mind blown, awestruck, hands on head',
      confused: 'confused, tilted head, question mark',
      curious: 'curious, leaning in, intrigued',
      embarrassed: 'embarrassed, flustered, hand to face',
      facepalm: 'facepalming, hand over eyes, exasperated',
      sick: 'queasy and sick, greenish tint',
    },
    frames: {
      panic: ['arms flailing the other way, more frantic', 'sweat flying off, mouth wide open'],
      dizzy: ['eyes spun the other direction', 'wobbling harder, little stars circling'],
      mindblown: ['head-bursting effect, bigger shock', 'hands flying off the head, pure awe'],
      confused: ['question mark bobs, head tilts the other way'],
    },
  },

  lowenergy: {
    states: [
      'sleepy',
      'tired',
      'bored',
      'neutral',
      'determined',
      'mischievous',
      'evil',
      'hungry',
      'victory',
      'wave',
      'thumbsup',
    ],
    poses: {
      sleepy: 'sleepy, half-closed eyes, yawning',
      tired: 'tired, droopy eyes, slumped',
      bored: 'bored, blank stare, chin on hand',
      neutral: 'neutral, plain expression',
      determined: 'determined, fired-up eyes, clenched fist',
      mischievous: 'mischievous, sly grin, plotting',
      evil: 'evil grin, sinister look',
      hungry: 'hungry, drooling, eyeing food',
      victory: 'victory pose, V-sign, beaming',
      wave: 'waving goodbye, friendly',
      thumbsup: 'thumbs-up, approving grin',
    },
    frames: {
      victory: ['V-sign with the other hand, a little bounce', 'both hands flashing V, beaming'],
      wave: ['hand swung to the other side', 'big two-handed wave goodbye'],
      sleepy: ['a sleepy bubble grows from the nose'],
      thumbsup: ['add a sparkle, slightly bigger grin'],
    },
  },
};

/** Every state across all groups, in group order. */
export const ALL_STATES: string[] = Object.values(GROUPS).flatMap((group) => group.states);

/** Look up the group a state belongs to, or undefined. */
export function groupOf(state: string): string | undefined {
  return Object.keys(GROUPS).find((name) => GROUPS[name]?.states.includes(state) === true);
}

/** Ordered frame descriptions for a state: [base, ...frames] (>= 1 entry). */
export function frameDescriptions(groupName: string, state: string): string[] {
  const group: SpriteGroup | undefined = GROUPS[groupName];
  const base = group?.poses[state] ?? '';
  const extra = group?.frames?.[state] ?? [FRAME_B_DEFAULT];
  return [base, ...extra];
}

/** Number of frames a state has (1 + extras). */
export function frameCount(groupName: string, state: string): number {
  return frameDescriptions(groupName, state).length;
}

/** Frame count for a state looked up by name across all groups (0 if unknown). */
export function frameCountForState(state: string): number {
  const group = groupOf(state);
  return group === undefined ? 0 : frameCount(group, state);
}

/**
 * The sheets to generate for a group: `a` (frame 0 of every state), `b`
 * (frame 1 of every state that has one), then `x1`, `x2`, ... packing every
 * remaining frame (index >= 2) densely, in state then frame order.
 */
export function sheetsFor(groupName: string): Sheet[] {
  const group: SpriteGroup | undefined = GROUPS[groupName];
  if (group === undefined) return [];
  const states = group.states;
  const sheets: Sheet[] = [];

  for (let frame = 0; frame < 2; frame++) {
    const cells: (SheetCell | null)[] = [];
    for (let i = 0; i < CELLS; i++) {
      const state = states.at(i);
      const desc = state === undefined ? undefined : frameDescriptions(groupName, state).at(frame);
      cells.push(state !== undefined && desc !== undefined ? { state, frame, desc } : null);
    }
    sheets.push({ name: frame === 0 ? 'a' : 'b', cells });
  }

  const extras: SheetCell[] = [];
  for (const state of states) {
    const descs = frameDescriptions(groupName, state);
    for (let frame = 2; frame < descs.length; frame++) {
      extras.push({ state, frame, desc: descs[frame] });
    }
  }
  for (let sheet = 0; sheet * CELLS < extras.length; sheet++) {
    const cells: (SheetCell | null)[] = [];
    for (let i = 0; i < CELLS; i++) {
      cells.push(extras.at(sheet * CELLS + i) ?? null);
    }
    sheets.push({ name: `x${sheet + 1}`, cells });
  }
  return sheets;
}
