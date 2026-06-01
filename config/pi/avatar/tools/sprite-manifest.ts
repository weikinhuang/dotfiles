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

  reactions: {
    states: [
      'eureka',
      'focused',
      'skeptical',
      'frustrated',
      'overwhelmed',
      'smirk',
      'deadpan',
      'eyeroll',
      'shrug',
      'sigh',
      'cozy',
      'nostalgic',
    ],
    poses: {
      eureka: 'eureka moment, lightbulb above the head, finger raised, delighted',
      focused: 'intensely focused, narrowed eyes, locked in',
      skeptical: 'skeptical, one eyebrow raised, doubtful',
      frustrated: 'frustrated, gritted teeth, clenched fists',
      overwhelmed: 'overwhelmed, swamped, swirl of stress marks',
      smirk: 'confident one-sided smirk',
      deadpan: 'deadpan, flat blank stare, dot eyes',
      eyeroll: 'rolling eyes upward, exasperated',
      shrug: 'shrugging, palms up, indifferent',
      sigh: 'heavy sigh, breath escaping, shoulders dropping',
      cozy: 'cozy and comfy, wrapped up warm with a mug',
      nostalgic: 'nostalgic, wistful faraway gaze, small smile',
    },
    frames: {
      eureka: ['a lightbulb flickers on above the head', 'lightbulb glows bright, eyes sparkling, finger up'],
      frustrated: ['steam puffs from the head, fists clenched tighter', 'hair-tug, gritted teeth, veins popping'],
      sigh: ['shoulders slump as a long breath escapes', 'deflated, head drooping'],
      focused: ['eyes narrow a touch more, faint determination'],
      skeptical: ['eyebrow raises higher, head tilts slightly'],
      overwhelmed: ['more stress marks spinning around the head'],
      deadpan: ['a single slow blink, still expressionless'],
      eyeroll: ['eyes roll fully up and to the side'],
      shrug: ['shoulders drop back down, hands turning over'],
      cozy: ['takes a small sip from the warm mug, eyes closing'],
      nostalgic: ['gaze drifts further away, a wistful little smile'],
    },
  },

  social: {
    states: ['grateful', 'apologetic', 'pleading', 'flirty', 'jealous', 'disgusted', 'sleeping'],
    poses: {
      grateful: 'grateful, hands pressed together, warm thankful smile',
      apologetic: 'apologetic, sheepish, small bow, hand rubbing neck',
      pleading: 'pleading, big shiny puppy eyes, hands clasped',
      flirty: 'flirty, playful eyebrow, slight wink',
      jealous: 'jealous, pouty side-glance, faint green spark',
      disgusted: 'disgusted, recoiling, tongue out in distaste',
      sleeping: 'fast asleep, eyes shut, peaceful, "Zzz" drifting up',
    },
    frames: {
      grateful: ['a deeper bow, hands pressed together', 'looking up with a warm thankful smile'],
      pleading: ['eyes grow bigger and shinier, hands clasped tighter', 'a hopeful tilt, lip trembling slightly'],
      flirty: ['blows a little kiss with a wink', 'playful eyebrow raise, finger to lips'],
      sleeping: ['a sleep bubble grows from the nose, slow breathing', 'bubble pops, "Zzz" drifts higher'],
      apologetic: ['bows the head lower, hand rubbing the back of the neck'],
      jealous: ['side-glance narrows, a small green spark flares'],
      disgusted: ['recoils further, hand raised to block, tongue out'],
    },
  },

  devotion: {
    states: ['adore', 'swoon', 'yearning', 'kiss', 'hug', 'infatuated'],
    poses: {
      adore: 'adoring, hands clasped at the heart, devoted shining gaze',
      swoon: 'swooning, swept off feet, hearts bursting',
      yearning: 'yearning, reaching a hand out, wistful longing',
      kiss: 'blowing a kiss, puckered lips, a heart drifting off',
      hug: 'arms wide open for a warm embrace',
      infatuated: 'infatuated, spiraling heart eyes, hearts everywhere',
    },
    frames: {
      swoon: ['knees buckling, hearts bursting around', 'swept off feet, eyes spiraling into hearts'],
      kiss: ['puckers lips, a heart launches off', 'a second heart drifts up, eyes closed sweetly'],
      hug: ['arms open wider, leaning in for the embrace', 'wraps into a warm squeeze, eyes closed'],
      infatuated: ['hearts swirl faster, spinning dizzily', 'completely lovestruck, eyes huge hearts'],
      adore: ['hands clasped at the heart, eyes shining with devotion'],
      yearning: ['reaches a hand further outward, longing deepens'],
    },
  },

  workflow: {
    states: ['debug', 'plan', 'fetch'],
    poses: {
      debug: 'debugging, peering through a magnifying glass, investigating',
      plan: 'planning, sketching a roadmap on a floating blueprint',
      fetch: 'fetching, waiting on a request, antenna with signal waves',
    },
    frames: {
      debug: [
        'magnifying glass sweeps the other way, eyes narrowed',
        'spots something - a tiny "!" and a focused squint',
      ],
      plan: ['sketches another box on the floating blueprint', 'taps the plan with a confident nod'],
      fetch: ['signal waves pulse outward from the antenna', 'a packet arrives with a little ping'],
    },
  },

  // Tasteful mature-flirtation expressions for adult roleplay, kept strictly
  // SFW: head-and-shoulders, fully clothed, emotion- and gaze-driven only - no
  // nudity, suggestive posing, or explicit content. See `sheetRules` in
  // print-prompts.ts for the extra guard clause applied to this group.
  sultry: {
    states: [
      'sultry',
      'smoulder',
      'tease',
      'bitelip',
      'comehither',
      'breathless',
      'flustered',
      'whisper',
      'purr',
      'nuzzle',
      'smooch',
      'coy',
    ],
    poses: {
      sultry: 'half-lidded bedroom eyes, slow sly smile, warm flush',
      smoulder: 'intense smoldering gaze, chin slightly down, lips together',
      tease: 'provocative playful smirk, one finger curling, daring eyes',
      bitelip: 'biting the lower lip, coy heat, glancing aside',
      comehither: 'inviting come-here look, a single beckoning finger, sly smile',
      breathless: 'flushed and lightly breathless, lips parted, caught off guard',
      flustered: 'hot-and-bothered, deep blush, fanning the face with a hand',
      whisper: 'leaning in close, a hand cupped to the mouth, intimate murmur',
      purr: 'content cat-like satisfied look, half-closed eyes, sly smile',
      nuzzle: 'affectionate close nuzzle, eyes softly shut, warm',
      smooch: 'a bold playful kiss, eyes shut, a heart drifting off',
      coy: 'shy-but-daring sidelong glance over the shoulder, small smile',
    },
    frames: {
      tease: ['a quick wink with the smirk, finger to the lips', 'tongue just touching the lip, one brow raised'],
      flustered: ['fans the face faster, blush deepening', 'looks away, steam puffing, totally flustered'],
      smooch: ['puckers up, a heart launches off', 'eyes shut, a second heart drifts up'],
      sultry: ['a slow wink, smile curling wider'],
      smoulder: ['gaze sharpens, a single brow lifts'],
      bitelip: ['lip bite eases into a coy smile'],
      comehither: ['finger curls again, head tilts invitingly'],
      breathless: ['a soft exhale, blush rising'],
      whisper: ['leans in a touch closer, eyes flicking up'],
      purr: ['eyes close fully, a satisfied little smile'],
      nuzzle: ['nuzzles in closer, a small contented sigh'],
      coy: ['peeks back a little further, smile widening'],
    },
  },

  // Coding-agent problem-solving reactions: how the avatar feels about what it
  // found mid-task. SFW; runs alongside the automatic activity states.
  insight: {
    states: [
      'aha',
      'stumped',
      'impressed',
      'concerned',
      'oops',
      'eager',
      'resigned',
      'exhausted',
      'debugging-rage',
      'scheming',
      'listen',
      'disagree',
    ],
    poses: {
      aha: 'a quiet "I see it now" moment, small knowing smile, eyes lighting up',
      stumped: 'genuinely stuck, hand on head, brow furrowed, at a loss',
      impressed: 'impressed by something elegant, eyebrows up, admiring nod',
      concerned: 'mildly concerned, slight worried brow, no panic',
      oops: 'mild "oops" recognition, sheepish wince, tongue poked out',
      eager: 'eager and focused energy, leaning in, bright fired-up eyes',
      resigned: 'resigned acceptance, flat tired smile, a small shrug',
      exhausted: 'utterly spent, drooping eyes, slumped, beyond tired',
      'debugging-rage': 'comically furious at a bug, gritted teeth, fists shaking',
      scheming: 'plotting something clever, sly grin, fingers steepled',
      listen: 'actively listening, leaning in, attentive open look',
      disagree: 'polite disagreement, slight head shake, skeptical mouth',
    },
    frames: {
      aha: ['a small spark of realization, eyes widening a touch'],
      impressed: ['a slow approving nod, faint admiring smile'],
      'debugging-rage': ['steam bursts from the head, fists shaking harder', 'fed up, hair on end, a vein popping'],
      scheming: ['fingertips tap together, grin widening', 'a tiny glint as the plan clicks'],
      listen: ['a small attentive nod, head tilting in'],
      disagree: ['a firmer head shake, hand raised slightly'],
      eager: ['leans in further, eyes sparkling brighter'],
      exhausted: ['a long slow blink, head sagging lower'],
    },
  },

  // Composure and conversational beats: steadier moods and reactions that color
  // a reply without being a strong emotion. SFW.
  composure: {
    states: [
      'patient',
      'nod',
      'encourage',
      'sympathetic',
      'coffee',
      'amused',
      'serene',
      'miffed',
      'melancholy',
      'cheeky',
    ],
    poses: {
      patient: 'waiting calmly and intentionally, easy patient smile, hands settled',
      nod: 'an affirming nod of agreement, warm and sure',
      encourage: 'supportive cheering, fist raised, encouraging grin',
      sympathetic: 'sympathetic, gentle caring eyes, head tilted softly',
      coffee: 'caffeinated and powered up, holding a steaming mug, bright eyes',
      amused: 'mildly amused, soft smile holding back a chuckle',
      serene: 'deeply serene, eyes softly closed, untroubled calm',
      miffed: 'mildly miffed, faint frown, slightly narrowed eyes',
      melancholy: 'quietly melancholy, wistful downcast gaze, faint sad smile',
      cheeky: 'cheeky and playful, sly grin, one brow raised, tongue out',
    },
    frames: {
      nod: ['head dips into a clear, sure nod'],
      encourage: ['pumps the fist higher, brighter cheer', 'both fists up, beaming encouragement'],
      coffee: ['takes a sip, eyes perking up', 'a little steam puff, energized grin'],
      patient: ['a slow patient blink, gentle smile holding'],
      amused: ['the smile tugs wider, a small huff of a laugh'],
      serene: ['the calm settles deeper, a soft exhale'],
      cheeky: ['a quick wink with the cheeky grin'],
    },
  },

  // Persona-roleplay warmth: expressive emotional range for character
  // interaction, extending devotion/social without overlap. SFW.
  bonding: {
    states: [
      'longing',
      'captivated',
      'tender',
      'giggle',
      'sass',
      'melting',
      'touched',
      'vulnerable',
      'gasp',
      'cuddle',
      'devoted',
      'cherish',
    ],
    poses: {
      longing: 'deep longing, reaching a hand out, aching wistful gaze',
      captivated: 'utterly captivated, entranced shining eyes, lips parted',
      tender: 'gentle tenderness, soft caring smile, half-lidded warm eyes',
      giggle: 'a light playful giggle, hand over the mouth, eyes crinkling',
      sass: 'playful sass, hand on hip, smirk and a raised brow',
      melting: 'melting into softness, swooning happy sigh, yielding smile',
      touched: 'emotionally moved, teary grateful smile, hand to chest',
      vulnerable: 'emotionally open and vulnerable, soft uncertain eyes',
      gasp: 'a sharp surprised gasp, hand to mouth, wide eyes',
      cuddle: 'leaning in for a sustained cuddle, arms wrapping, cozy',
      devoted: 'devoted loyalty, hands at the heart, steady adoring gaze',
      cherish: 'cherishing, hands cupped protectively around the heart',
    },
    frames: {
      longing: ['the hand reaches a little further, gaze deepening'],
      giggle: ['the giggle bubbles up, shoulders shaking lightly', 'eyes shut, a bright stifled laugh'],
      gasp: ['the gasp sharpens, eyes going wider', 'hand pressed to the mouth, breath caught'],
      cuddle: ['nestles in closer, eyes drifting shut', 'a warm contented squeeze'],
      melting: ['knees going soft, a dreamy sigh escaping'],
      touched: ['a happy tear wells up, smile trembling'],
      sass: ['hip cocks the other way, smirk sharpening'],
      cherish: ['draws the hands in closer, eyes warming'],
    },
  },

  // Closeness and attachment dynamics: clingier, needier, or more protective
  // shades for sustained roleplay. SFW.
  closeness: {
    states: [
      'shiver',
      'protective',
      'bratty',
      'eager-to-please',
      'doting',
      'comforted',
      'smitten-speechless',
      'bashful',
      'clingy',
      'needy',
      'safe',
      'nestle',
    ],
    poses: {
      shiver: 'a shiver of excited anticipation, hugging self, bright eyes',
      protective: 'protective and guarding, arm raised to shield, firm look',
      bratty: 'playfully bratty, pouting smirk, arms crossed, looking away',
      'eager-to-please': 'eager to please, hopeful upturned eyes, hands together',
      doting: 'doting affectionate attentiveness, fond soft smile, head tilt',
      comforted: 'receiving comfort, eased relieved smile, leaning into care',
      'smitten-speechless': 'speechless with affection, blank dazed hearts, flushed',
      bashful: 'bashful, peeking out from behind raised hands, pink cheeks',
      clingy: 'clingy, holding on tight, big pleading reluctant-to-let-go eyes',
      needy: 'needy for attention, reaching out, soft whimpering pout',
      safe: 'feeling safe and secure, settled content sigh, soft smile',
      nestle: 'nestling in close, snuggled down, eyes softly shut',
    },
    frames: {
      shiver: ['a quick shiver runs through, hugging tighter'],
      protective: ['steps in front, shielding arm firmer, eyes sharp'],
      bratty: ['turns the nose up, pout deepening', 'a sidelong "hmph", arms tighter'],
      'eager-to-please': ['leans in hopefully, eyes shining brighter'],
      'smitten-speechless': ['hearts swirl in the eyes, jaw going slack'],
      bashful: ['peeks out a little more, blush spreading'],
      clingy: ['clutches on tighter, lip wobbling'],
      needy: ['reaches out further, a soft needy whine'],
      nestle: ['snuggles down deeper, a small happy sigh'],
    },
  },

  // Playful mischief and mock-drama: teasing, sulking, and rebellious beats for
  // banter. SFW.
  antics: {
    states: ['prank', 'mock-pout', 'gloat', 'dizzy-love', 'defiant', 'obedient'],
    poses: {
      prank: 'plotting a harmless prank, mischievous grin, hands rubbing together',
      'mock-pout': 'fake exaggerated sulking, theatrical pout, arms crossed',
      gloat: 'playful smug gloating, chin up, self-satisfied grin',
      'dizzy-love': 'swooning lovestruck, spinning heart eyes, dizzy and giddy',
      defiant: 'defiant and challenging, chin raised, fist up, daring grin',
      obedient: 'obedient and compliant, attentive salute, ready posture',
    },
    frames: {
      prank: ['hands rub together faster, grin widening', 'a sly glance aside, plan ready'],
      'mock-pout': ['turns away in mock huff, pout bigger', 'peeks back to check if it worked'],
      gloat: ['chin tips higher, grin smugger'],
      'dizzy-love': ['hearts spin faster, head wobbling', 'eyes spiral fully into hearts'],
      defiant: ['fist pumps up, grin sharpening'],
      obedient: ['snaps a crisp salute, posture straightening'],
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
