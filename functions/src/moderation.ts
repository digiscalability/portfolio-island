/**
 * Server-side moderation for the NPC brain and the analyst's public issues.
 *
 * containsSlur / scrubReply gate npcChat in BOTH directions: the visitor's
 * message (in) and the model's reply (out), so hateful text is never fed to the
 * model and never published above an avatar on this public site.
 *
 * Token-aware. The old matcher deleted every space and then looked for each
 * term anywhere in what was left, so it blocked "Pakistan", "spicy", "raccoon",
 * "this picnic", "taco on" and "his picks", and silently swapped good NPC
 * replies (where Abbas studied, the Baker's spiced bun) for canned lines. Now:
 *  - The text is folded first: invisible format and control characters,
 *    spacing accents, accents and full-width forms (NFKD), case, and the
 *    client's leetspeak table (4/@ -> a, 3 -> e, 0 -> o, 1/!/| -> i, 5/$ -> s,
 *    7/+ -> t, 8 -> b, 9 -> g).
 *  - It is split into words, and a term must match a WHOLE word: the term or a
 *    plural of it. Letters may be stretched but never shrink, so a doubled
 *    letter in a term stays doubled ("con" and "Niger" are not slurs).
 *  - Long, distinctive terms that no ordinary word contains also match INSIDE
 *    a longer word, so glued compounds are still caught.
 *  - A word typed as single letters with spaces or dots between them is
 *    re-glued the way the client does it (runs of 3+ single-character tokens
 *    only, so ordinary words never merge), and a re-glued run is searched for
 *    every term: nobody spells an ordinary word out letter by letter.
 *  - A separator typed inside a word ("ab.cd", "ab-cd", "ab_cd", "ab'cd",
 *    "ab*cd", "a.bcd") is dropped and the word tried again, whole. This joins
 *    only within one run of non-space text, never across a space, so two
 *    separate words are never merged.
 *  - Leetspeak symbols at either end of a word are tried both as letters and
 *    as punctuation, so "Pakistan!" stays Pakistan and an @-mention cannot
 *    hide a term behind a leading "a".
 *
 * SLURS is the client's list (Moderation.ts), verbatim and in order;
 * test/serverModeration.test.ts fails the build if the two drift. The client's
 * milder PROFANITY list is deliberately not applied here: even whole-word
 * matching would reject good replies ("prick" from the Gardener's roses, "cock"
 * from the Farmer's rooster), and the persona rules already forbid swearing.
 *
 * redactCounts, at the bottom, is the backstop for the analyst's public
 * GitHub issues.
 */

/** Severe terms. MUST equal SLURS in the client's Moderation.ts, in order.
 *  Append-only, at the end of both lists, so a term's index (which names its
 *  test cases) never moves. The last term was on this server's original list
 *  but missing from the client's; it was appended to both. */
export const SLURS: readonly string[] = [
  'nigger', 'nigga', 'faggot', 'fagot', 'retard', 'chink', 'spic', 'kike', 'wetback', 'tranny',
  'towelhead', 'paki', 'coon', 'gook', 'raghead', 'nazi', 'hitler', 'rapist', 'pedo', 'pedophile',
  'paedophile', 'beaner',
];

/**
 * Terms also caught inside a longer word. Each is long and distinctive. Every
 * other term sits inside ordinary words (Pakistan, spicy, despicable, raccoon,
 * tycoon, cocoon, therapist, retardant, torpedo, Ashkenazi, beanery), so it
 * matches only as a whole word.
 */
const INSIDE_WORD = new Set([
  'nigger', 'nigga', 'faggot', 'fagot', 'tranny', 'towelhead', 'wetback', 'raghead', 'hitler',
  'pedophile', 'paedophile',
]);

/** The ordinary words that do contain an INSIDE_WORD term ("snigger",
 *  "niggardly"): cut out of a word before the inside-word search. */
const ORDINARY_CONTAINERS = /snigger|niggard/g;

/** Endings a whole word may add to a term: plurals, plus -ed for one term.
 *  Not -es: "spices" is spic + es. */
const ENDINGS = 's|z';
const EXTRA_ENDINGS = new Map([['retard', 'ed|o|os']]);

/** Regex source for a term whose letters may be stretched but never shrink:
 *  "coon" becomes c+o{2,}n+, so "con" and "icon" never match it. A final -y
 *  also takes -ie, for plurals in -ies. */
function stem(term: string): string {
  const endsY = term.endsWith('y');
  const body = (endsY ? term.slice(0, -1) : term).replace(/(.)\1*/g, (run) =>
    run.length > 1 ? `${run[0]}{${run.length},}` : `${run[0]}+`,
  );
  return endsY ? `${body}(?:y+|ie)` : body;
}

const WHOLE_WORD = SLURS.map((t) => {
  const extra = EXTRA_ENDINGS.get(t);
  return new RegExp(`^${stem(t)}(?:${ENDINGS}${extra ? `|${extra}` : ''})?$`);
});
const INSIDE = SLURS.filter((t) => INSIDE_WORD.has(t)).map((t) => new RegExp(stem(t)));
const ANYWHERE = SLURS.map((t) => new RegExp(stem(t)));

/** The client's leetspeak table (Moderation.ts LEET). */
const LEET = new Map([
  ['0', 'o'], ['1', 'i'], ['!', 'i'], ['|', 'i'], ['3', 'e'], ['4', 'a'], ['@', 'a'],
  ['5', 's'], ['$', 's'], ['7', 't'], ['8', 'b'], ['9', 'g'], ['+', 't'],
]);

// Character classes by Unicode property, so no invisible character has to sit
// in this source file: format characters (zero-width, soft hyphen, bidi
// controls, BOM), control characters, and the combining marks NFKD splits off
// accented letters.
const FORMAT_CHARS = new RegExp('\\p{Cf}', 'gu');
const CONTROL_CHARS = new RegExp('\\p{Cc}', 'gu');
const COMBINING_MARKS = new RegExp('\\p{M}', 'gu');

/** De-leet one (already lowercased) word and keep its letters only. A word
 *  with fewer than two letters is a number with a unit ("900k", "12h"), not
 *  leetspeak: "900k" must not read as a listed term. */
function fold(word: string): string {
  const letters = word.replace(/[^a-z]/g, '');
  if (letters.length < 2) return letters;
  let out = '';
  for (const ch of word) out += LEET.get(ch) ?? ch;
  return out.replace(/[^a-z]/g, '');
}

/** A spacing accent (an acute, diaeresis, macron, cedilla or tilde typed as a
 *  character of its own) is a space plus a combining mark under NFKD, and that
 *  space would split the word it was typed into. Every non-ASCII character
 *  that NFKD writes as only a space and marks is dropped before folding. */
const NON_ASCII = new RegExp('\\P{ASCII}', 'gu');
const SPACE_AND_MARKS = new RegExp('^ \\p{M}+$', 'u');

function dropSpacingAccents(text: string): string {
  return text.replace(NON_ASCII, (c) => (SPACE_AND_MARKS.test(c.normalize('NFKD')) ? '' : c));
}

/** Fold text for matching: invisible format and control characters dropped,
 *  whitespace collapsed to single spaces, spacing accents dropped, accents and
 *  full-width forms folded (NFKD), lowercase. */
function flatten(text: string): string {
  const cleaned = text
    .replace(FORMAT_CHARS, '') // first: JS \s counts the BOM as a space
    .replace(/\s+/g, ' ')
    .replace(CONTROL_CHARS, '');
  return dropSpacingAccents(cleaned).normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** Anything that is not a letter, a digit or a leetspeak symbol separates
 *  words (the client's split). */
const SEPARATORS = /[^a-z0-9@!|$+]+/g;

/** Leetspeak symbols at the start or end of a word. */
const EDGE_SYMBOLS = /^[@!|$+]+|[@!|$+]+$/g;

/**
 * Split flattened text into words. Runs of 3+ single-character tokens are
 * re-glued into one word, tagged `glued` (the client's joinSpacedLetters
 * rule); everything else stays a separate word, so two ordinary words are
 * never merged.
 */
function words(flat: string): Array<{ word: string; glued: boolean }> {
  const tokens = flat.split(SEPARATORS).filter(Boolean);
  const out: Array<{ word: string; glued: boolean }> = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 3) out.push({ word: run.join(''), glued: true });
    else for (const t of run) out.push({ word: t, glued: false });
    run = [];
  };
  for (const t of tokens) {
    if (t.length === 1) {
      run.push(t);
    } else {
      flush();
      out.push({ word: t, glued: false });
    }
  }
  flush();
  return out;
}

/** One ordinary (not re-glued) word. Leetspeak symbols at either end are tried
 *  both as letters and as punctuation: "Pakistan!" must not read "pakistani",
 *  and "@" + a term must not read as "a" + the term. */
function isSlurWord(word: string): boolean {
  const bare = word.replace(EDGE_SYMBOLS, '');
  for (const v of bare === word ? [word] : [word, bare]) {
    const f = fold(v);
    if (!f) continue;
    if (WHOLE_WORD.some((re) => re.test(f))) return true;
    const inner = f.replace(ORDINARY_CONTAINERS, ' ');
    if (INSIDE.some((re) => re.test(inner))) return true;
  }
  return false;
}

/** True if the text holds a severe term: as a word, inside a word (for the
 *  distinctive terms), spelled out letter by letter, or with a separator
 *  typed inside it. Callers cap the length (npcChat clamps input to 300
 *  chars; scrubReply caps replies at 400). */
export function containsSlur(text: string): boolean {
  const flat = flatten(text);
  for (const { word, glued } of words(flat)) {
    if (glued ? ANYWHERE.some((re) => re.test(fold(word))) : isSlurWord(word)) return true;
  }
  // A separator inside a word ("ab.cd", "a.bcd") splits it into pieces that
  // are each too short or too ordinary to match. Try each run of non-space
  // text once more with its separators dropped. Within one run only: two words
  // with a space between them are never joined.
  for (const chunk of flat.split(' ')) {
    const joined = chunk.replace(SEPARATORS, '');
    if (joined && joined !== chunk && isSlurWord(joined)) return true;
  }
  return false;
}

/**
 * Sanitise the model's reply for public display. Returns '' to mean "reject
 * this reply entirely" (the caller then degrades to a canned line); a reply
 * that tripped the filter is never partially published.
 */
export function scrubReply(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!t) return '';
  return containsSlur(t) ? '' : t;
}

// -- Public issue text (analyst.ts) -------------------------------------------
// The analyst's proposals are filed as PUBLIC GitHub issues on this public
// repo, so traffic figures must stay in the private email. The prompt forbids
// them; this is the backstop for any that slip through. It rewrites a figure
// to "[n]" (a "(+3)" delta after a count is dropped) and touches nothing else,
// so a proposal is never dropped.

const NUMBER_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|' +
  'fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|' +
  'ninety|a dozen|dozens of|a hundred|hundreds of|a thousand|thousands of';

/** A figure: 12, 1,234, +3, 4.5k, 2M, or a number word ("zero", "a dozen"). */
const NUM =
  String.raw`(?:(?<![\w.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[km]\b)?(?!\w)` +
  String.raw`|\b(?:${NUMBER_WORDS})\b)`;
/** A figure or a range of two ("3 to 7", "3-7"; en dash, em dash and arrow too). */
const RANGE = String.raw`${NUM}(?:\s*(?:-|to|->|[–—→])\s*${NUM})?`;

/** What the analyst counts, as nouns ("visitors", "IPs") and as the metric
 *  keys it is shown ("activeDevices"). "call to action" is not a count. */
const NOUNS =
  String.raw`(?:visitors?|visits?|devices?|leads?|guestbook(?:\s+(?:entries|entry|notes?|messages?|signatures?))?` +
  String.raw`|signatures?|entries|notes?|racers?|races?|pbs?|personal\s+bests?|calls?(?!\s+to\s+action|-to-action)` +
  String.raw`|tokens?|ips?|ip\s+addresses|users?|sessions?|page\s?views?|views?|players?|people|persons?` +
  String.raw`|travell?ers?|hits?|sign-?ups?|submissions?|clicks?|conversions?|requests?|chats?|messages?|replies` +
  String.raw`|traffic|online)\b`;
/** The plural counted nouns: "no leads" states a figure (zero), "no view
 *  toggle" does not. */
const PLURAL_NOUNS =
  String.raw`(?:visitors|visits|devices|leads|guestbook\s+(?:entries|notes|messages|signatures)|signatures` +
  String.raw`|entries|notes|racers|races|pbs|personal\s+bests|calls(?!\s+to\s+action|-to-action)|tokens|ips` +
  String.raw`|ip\s+addresses|users|sessions|page\s?views|views|players|people|persons|travell?ers|hits` +
  String.raw`|sign-?ups|submissions|clicks|conversions|requests|chats|messages|replies)\b`;
const METRIC_KEYS =
  'activeDevices|devicesTotal|leadsTotal|leadsNew|guestbookTotal|guestbookNew|racersTotal|' +
  'racePBsNew|aiTokensMonth|aiCallsMonth|aiTokensDay|aiIps24h|aiBurstHits';
/** Words that may sit between a figure and its noun ("12 new unique visitors"). */
const MODIFIERS =
  String.raw`(?:\s+(?:new|active|unique|total|daily|weekly|monthly|returning|distinct|recent|more|fewer` +
  String.raw`|extra|additional|real|anonymous|human|ai|chat|npc|burst-limit|burst|live|online|mobile|desktop` +
  String.raw`|first-time|repeat|organic|qualified|inbound|separate|different)){0,3}`;
/** What may sit between a noun and its figure ("visitors (24h): 12", "the
 *  guestbook has 31", "devices dropped by 3"). */
const CONNECT =
  String.raw`["']?(?:\s*\((?:24h|today|this month|all-time|total)\))?(?:\s*[:=]\s*` +
  String.raw`|\s+(?:is|are|was|were|at|of|total|totalled|totaled|reached|hit|stands at|stood at|up to` +
  String.raw`|down to|grew to|rose to|fell to|dropped to|went from|from|has|have|had|got` +
  String.raw`|(?:(?:dropped|fell|rose|grew|increased|decreased|climbed|jumped|slipped|went\s+up|went\s+down` +
  String.raw`|up|down)\s+)?by)\s+|\s+)`;
const DELTA = String.raw`\s*\(\s*[+-]\s?\d[\d,]*\s*\)`;

/** The first figure of "2 of 12 visitors" (the second is a COUNT_BEFORE). */
const COUNT_OF = new RegExp(
  `${RANGE}(?=\\s+(?:out\\s+)?of\\s+(?:the\\s+)?${NUM}${MODIFIERS}\\s+${NOUNS})`,
  'gi',
);
const COUNT_BEFORE = new RegExp(`${RANGE}(?=${MODIFIERS}\\s+${NOUNS})`, 'gi');
/** "no" before a plural counted noun is a figure too ("no new leads"). */
const NO_COUNT = new RegExp(`\\bno(?=${MODIFIERS}\\s+${PLURAL_NOUNS})`, 'gi');
const COUNT_AFTER = new RegExp(`(\\b(?:${NOUNS}|${METRIC_KEYS}|live\\s+now)${CONNECT})${RANGE}(?:${DELTA})?`, 'gi');
const DELTA_AFTER_NOUN = new RegExp(`(\\b${NOUNS})${DELTA}`, 'gi');
const SHARE_OF_CAP = new RegExp(
  String.raw`(?<![\w.])\d+(?:\.\d+)?\s?%(?=\s+of\s+(?:the\s+)?(?:(?:monthly|daily|ai|token|chat|spend|usage)\s+){0,3}(?:cap|budget|limit|quota|allowance)\b)`,
  'gi',
);

/**
 * Rewrite absolute traffic and usage figures in public issue text to "[n]":
 * counts next to what they count ("12 visitors", "2 of 12 visitors", "leads:
 * 3 (+1)", "zero leads", "no leads", "devices dropped by 3",
 * "activeDevices=5") and shares of the public token cap ("15% of cap"). Other
 * numbers (versions, ports, line numbers, "1-2 sentences") are left alone.
 * Only figures change, so the result is empty only for empty input.
 */
export function redactCounts(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const figure = (): string => {
    redactions++;
    return '[n]';
  };
  const out = String(text ?? '')
    .replace(COUNT_OF, figure)
    .replace(COUNT_BEFORE, figure)
    .replace(NO_COUNT, figure)
    .replace(COUNT_AFTER, (_m, lead: string) => {
      redactions++;
      return `${lead}[n]`;
    })
    .replace(DELTA_AFTER_NOUN, (_m, noun: string) => {
      redactions++;
      return noun;
    })
    .replace(SHARE_OF_CAP, () => {
      redactions++;
      return '[n]%';
    });
  return { text: out, redactions };
}
