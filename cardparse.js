// Card parsing shared with Card Slicer (copied from its slicer.js; keep the two in step).
// Nothing in this file touches SillyTavern, so it can be tested on its own.

/** Section kinds, matched against an all-caps heading. Order matters. */
const SECTION_RULES = [
    ['relationships', /^RELATIONSHIPS?\b|\bRELATIONSHIPS?$/],
    ['canon', /\bCANON\s+POINT\b/],
    ['identity', /\bIDENTITY\b/],
    ['speech', /\bSPEECH\b|\bVOICE\b/],
    ['personality', /\bPERSONALITY\b/],
    ['history', /\bHISTORY\b/],
    ['knowledge', /\bKNOWLEDGE\b/],
    ['likes', /\bLIKES?\b[\s\S]*\bWANTS?\b|\bWANTS?\b[\s\S]*\bLIKES?\b/],
    ['fears', /\bFEARS?\b|\bRESENTS?\b/],
    ['goals', /\bGOALS?\b/],
    ['secrets', /\bSECRETS?\b/],
    ['coping', /\bCOPING\b/],
    ['limits', /\bLIMITS?\b/],
    ['habits', /\bHABITS?\b|\bMANNERISMS?\b/],
    ['standing', /\bSTANDING\b/],
    ['ordinary', /\bORDINARY\s+DAY\b/],
    ['social', /\bSOCIAL\s+WORLD\b/],
    ['inner', /\bINNER\s+LIFE\b/],
    ['appearance', /\bAPPEARANCE\b/],
    ['contradictions', /\bCONTRADICTIONS?\b/],
    ['boundaries', /\bBOUNDAR(?:Y|IES)\b/],
];

export const SECTION_LABELS = {
    relationships: 'Relationships', canon: 'Canon point', identity: 'Identity', speech: 'Speech and voice',
    personality: 'Personality', history: 'History', knowledge: 'Knowledge', likes: 'Like and want',
    fears: 'Fear and resent', goals: 'Goals', secrets: 'Secrets', coping: 'Coping', limits: 'Limits',
    habits: 'Small habits', standing: 'Standing', ordinary: 'Ordinary day', social: 'Social world',
    inner: 'Inner life', appearance: 'Appearance', contradictions: 'Contradictions', boundaries: 'Boundaries',
    custom: 'Other section',
};

/**
 * Three levels. Nothing that drives a character is cut at any of them.
 * - present: in the scene. The whole card; History is the newest lines, lines about people whose entry is
 *   whole, and lines matched to the scene.
 * - active: off-screen, but their agenda row involves Leon, someone in the scene or another carded character,
 *   or someone's row names them. The whole card; History is the newest lines and lines about people whose
 *   entry is whole.
 * - offscreen: everyone else. As active, but Speech keeps only its description and a few voice lines, and
 *   Small Habits and Standing are left out.
 * At every level, relationship entries for people outside the scene keep their Wants and Now lines.
 */
const DROPPED = {
    present: new Set(),
    active: new Set(),
    offscreen: new Set(['habits', 'standing']),
};

/** Sections whose lines are chosen one by one, per level. */
const LINE_FILTERED = {
    present: new Set(['history']),
    active: new Set(['history']),
    offscreen: new Set(['history']),
};

/**
 * Sections for intimate scenes only (SEX AND KINK, TURN-ONS). The card template keeps everything from them that
 * shows in everyday life under Like and Want or Fear and Resent, so they are only sent while the character is in
 * the scene. SEXUALITY is not matched: it can hold who they are attracted to.
 */
const INTIMATE_SECTION_RE = /\b(?:SEX|KINKS?|EROTIC|NSFW|FETISH(?:ES)?|TURN-?ONS?|INTIMACY|INTIMATE|BEDROOM)\b/;

/** A sample line labelled for texts or calls, kept first among an off-screen character's voice lines. */
const TEXT_LABEL_RE = /\b(?:text(?:s|ing|ed)?|phone|call(?:s|ing)?|message(?:s|d)?|DMs?|voicemail)\b/i;

/** Lines of a relationship entry kept for someone outside the scene: what they want from them and where things stand. */
const DRIVE_LINE_RE = /^\s*(?:[-*•]\s*)?\**\s*(?:Wants|Now)\b/i;

/** Field labels that start the lines of a relationship entry. */
const FIELD_RE = /^\s*(?:[-*•]\s*)?\**\s*(?:Wants|Hides|Speech|Shared(?:\s+history)?|Now|Doesn['’]?t know|Does not know|Once (?:she|he|they) (?:learns?|knows?)|As it grows|Memories|Knows)\b/i;

/** Start of a sample line inside SPEECH AND VOICE. */
const SAMPLE_START = /^(?:[-*•]\s*)?(?:\**\s*(?:Sample lines|sample lines|Samples)\b|\(|["“”]|To [A-Z][^:]{0,40}:)/;

const NAME_STOP = new Set(['the', 'a', 'an', 'and', 'of', 'mr', 'mrs', 'ms', 'dr', 'card', 'lead', 'minor', 'supporting',
    'char', 'character', 'npc', 'entry', 'location', 'setting', 'scenario', 'narrator',
    'his', 'her', 'hers', 'him', 'their', 'them', 'my', 'our', 'your', 'its', 'she', 'he', 'they', 'new', 'old']);

const SMALL_WORDS = new Set(['and', 'of', 'the', 'de', 'van', 'von', 'da', 'la', 'le', 'del']);

const RELATION_WORDS = {
    mother: ['mom', 'mother', 'mum', 'mama', 'mommy'],
    mom: ['mom', 'mother', 'mum', 'mama', 'mommy'],
    mum: ['mom', 'mother', 'mum', 'mama', 'mommy'],
    father: ['dad', 'father', 'papa', 'daddy'],
    dad: ['dad', 'father', 'papa', 'daddy'],
    stepmother: ['stepmom', 'stepmother'],
    stepfather: ['stepdad', 'stepfather'],
    sister: ['sister'],
    brother: ['brother'],
    grandmother: ['grandma', 'grandmother', 'nana', 'granny'],
    grandfather: ['grandpa', 'grandfather'],
    aunt: ['aunt', 'auntie'],
    uncle: ['uncle'],
    cousin: ['cousin'],
    son: ['son'],
    daughter: ['daughter'],
    children: ['children', 'kids', 'son', 'daughter'],
    kids: ['children', 'kids'],
    parents: ['parents', 'mom', 'dad'],
    family: ['family'],
    wife: ['wife'],
    husband: ['husband'],
    boyfriend: ['boyfriend'],
    girlfriend: ['girlfriend'],
    boss: ['boss'],
    employer: ['boss', 'employer'],
    sponsor: ['sponsor'],
    landlord: ['landlord'],
    landlady: ['landlady'],
    teacher: ['teacher'],
    coach: ['coach'],
    therapist: ['therapist'],
    roommate: ['roommate'],
    neighbor: ['neighbor', 'neighbour'],
    neighbour: ['neighbor', 'neighbour'],
};

const STOP_WORDS = new Set(('about above after again against almost alone along already although always among another anyone anything '
    + 'around because before behind being below between cannot could couldn doesn didn during either enough every everyone everything '
    + 'first from further getting given going gonna great having here herself himself however inside into itself just knows later least '
    + 'little looks makes maybe might myself never nothing often other others ourselves perhaps quite rather really right said same says '
    + 'seems should since someone something still sure takes than that their theirs them themselves then there these they thing things '
    + 'think this those though through together toward under until upon very wants were what whatever when where whether which while '
    + 'whole whose will with within without would your yours yourself yeah okay really kind sort another again thing looking turns '
    + 'turned voice back down eyes hand hands head face looks looked says said tells told asks asked away still around close').split(/\s+/));

// ---------------------------------------------------------------- headings

function splitOutsideParens(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0) {
            if (ch === ':') return [s.slice(0, i), s.slice(i + 1)];
            if ((ch === '—' || ch === '–' || ch === '-') && s[i - 1] === ' ' && s[i + 1] === ' ') return [s.slice(0, i - 1), s.slice(i + 2)];
        }
    }
    return [s, ''];
}

/**
 * Reads a line as an all-caps heading.
 * @returns {{core: string, paren: string, rest: string} | null}
 */
export function headingInfo(line) {
    let s = String(line ?? '').trim();
    if (!s || s.length > 120) return null;
    if (/^[-*•>]\s/.test(s)) return null; // bullets are never headings
    s = s.replace(/^#{1,6}\s+/, '');
    s = s.replace(/^\[([^\]]+)\]:?$/, '$1');
    s = s.replace(/^[*_]{1,3}/, '').replace(/[*_]{1,3}:?$/, '');
    const [headRaw, rest] = splitOutsideParens(s);
    const head = headRaw.replace(/[*_]+/g, '').trim();
    const pm = head.match(/^(.*?)\s*\((.*)\)\s*$/);
    const core = (pm ? pm[1] : head).trim();
    const paren = pm ? pm[2].trim() : '';
    if (!core || core.length > 60) return null;
    if (!/^[A-Z0-9][A-Z0-9 '’&/.,\-–—]*$/.test(core)) return null;
    if (/[.!?]$/.test(core)) return null; // a shouted line, not a heading
    if (core.replace(/[^A-Z]/g, '').length < 2) return null;
    return { core, paren, rest: rest.trim() };
}

export function classifyHeading(core) {
    const c = String(core).toUpperCase();
    for (const [kind, re] of SECTION_RULES) {
        if (re.test(c)) return kind;
    }
    return null;
}

function boldPersonHeader(line) {
    if (FIELD_RE.test(line)) return null;
    const m = String(line).match(/^\s*\*\*([A-Z][^*\n]{0,58}?)\*\*\s*(?:\(([^)]*)\))?\s*(?:[—–:-]\s*(.*))?$/);
    if (!m) return null;
    if (classifyHeading(m[1])) return null;
    return { core: m[1].trim(), paren: (m[2] || '').trim(), rest: (m[3] || '').trim() };
}

function plainPersonHeader(line) {
    if (FIELD_RE.test(line)) return null;
    const m = String(line).trim().match(/^([A-Z][\w'’.\-]*(?:\s+[A-Z][\w'’.\-]*){0,3})\s*(?:\(([^)]*)\))?\s*:?$/);
    if (!m) return null;
    return { core: m[1].trim(), paren: (m[2] || '').trim() };
}

function nextContentLine(lines, i) {
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        if (lines[j].trim()) return lines[j];
    }
    return '';
}

/** Quick check: does this text look like a character card? */
export function looksLikeCard(text) {
    const kinds = new Set();
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const h = headingInfo(line);
        if (!h) continue;
        const k = classifyHeading(h.core);
        if (k) kinds.add(k);
    }
    return kinds.size >= 3 && kinds.has('speech');
}

// ---------------------------------------------------------------- names

export function titleCase(s) {
    const t = String(s).toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    return t.replace(/(\s)(\p{L}+)/gu, (m, sp, w) => (SMALL_WORDS.has(w.toLowerCase()) ? sp + w.toLowerCase() : m));
}

/**
 * Name forms to look for in the chat: the full name and the first name, as written and in Title Case.
 * The first word on its own is only used when it is a real first name: capitalised, not possessive
 * ("Rue's mom" is not a name for Rue) and not a lowercase phrase ("sugar daddy" does not give "sugar").
 */
export function nameVariants(raw) {
    const base = String(raw ?? '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[*_#"“”]/g, '').trim();
    const first = base.split(/\s+[—–|-]\s+|:/)[0].replace(/\s+/g, ' ').trim();
    if (!first) return [];
    const words = first.split(' ').filter(Boolean);
    if (words.length > 4) return [];
    const forms = new Set();
    const add = (x) => {
        const t = String(x).trim();
        if (t.length >= 2 && !NAME_STOP.has(t.toLowerCase())) forms.add(t);
    };
    const titled = (x) => (x === x.toUpperCase() && !x.includes('.') ? titleCase(x) : null);
    add(first);
    if (titled(first)) add(titled(first));
    const w0 = words[0];
    if (words.length > 1 && /^\p{Lu}/u.test(w0) && !/['’]s$/i.test(w0)) {
        add(w0);
        if (titled(w0)) add(titled(w0));
    }
    return [...forms];
}

const reCache = new Map();
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-sensitive whole-word check. "Rue" matches "Rue's" and "Rue," but not "Ruel". */
export function mentionsAny(text, variants) {
    const t = String(text ?? '');
    for (const v of variants || []) {
        if (!v) continue;
        let re = reCache.get(v);
        if (!re) {
            re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{Ll}\\p{N}])`, 'u');
            reCache.set(v, re);
        }
        if (re.test(t)) return true;
    }
    return false;
}

/** For a relationship heading like "LESLIE BENNETT (mother)" or "HIS WIFE AND CHILDREN": does the scene mention "mom" or "wife"? */
export function relationMentioned(text, paren) {
    const p = String(paren ?? '').toLowerCase();
    if (!p) return false;
    const words = new Set();
    for (const [key, list] of Object.entries(RELATION_WORDS)) {
        if (new RegExp(`\\b${key}s?\\b`).test(p)) list.forEach(w => words.add(w));
    }
    if (!words.size) return false;
    const re = new RegExp(`\\b(?:${[...words].map(escapeRe).join('|')})s?\\b`, 'i');
    return re.test(String(text ?? ''));
}

// ---------------------------------------------------------------- parsing

/**
 * Parses a card into a preamble and sections. Relationship sections are split into one entry per person.
 * @param {string} text
 * @param {{knownNames?: string[]}} opts names of every card and the player, used to spot relationship headings
 */
export function parseCard(text, { knownNames = [] } = {}) {
    const lines = String(text ?? '').split(/\r?\n/);
    const known = new Set(knownNames.map(n => String(n).toLowerCase()));
    const out = { preamble: [], sections: [] };
    let cur = null;
    let person = null;

    const isKnown = (core) => {
        const lc = core.toLowerCase();
        if (known.has(lc)) return true;
        const firstWord = lc.split(/\s+/)[0];
        return known.has(firstWord);
    };

    const startPerson = (info, line, sure) => {
        person = { header: line, core: info.core, paren: info.paren, inline: !!info.rest, lines: [], sure };
        cur.persons.push(person);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const h = headingInfo(line);
        if (h) {
            const kind = classifyHeading(h.core);
            if (kind) {
                cur = { kind, heading: line, title: h.core, lines: [], intro: [], persons: [] };
                out.sections.push(cur);
                person = null;
                continue;
            }
            // Inside RELATIONSHIPS, every all-caps line starts an entry until the next known section.
            // Entries that turn out not to be about a person become sections of their own below.
            if (cur && cur.kind === 'relationships') {
                startPerson(h, line, false);
                continue;
            }
            if (!cur) {
                out.preamble.push(line);
                continue;
            }
            // A section of the character's own (ADDICTION, VIOLENCE): an all-caps line on its own.
            if (!h.rest && h.core.replace(/[^A-Z]/g, '').length >= 4) {
                cur = { kind: 'custom', heading: line, title: h.core, lines: [], intro: [], persons: [] };
                out.sections.push(cur);
                person = null;
                continue;
            }
        }

        if (cur && cur.kind === 'relationships') {
            const b = boldPersonHeader(line);
            if (b) {
                startPerson(b, line, true);
                continue;
            }
            const p = plainPersonHeader(line);
            if (p && (FIELD_RE.test(nextContentLine(lines, i)) || (isKnown(p.core) && /:\s*$|\)\s*$/.test(line.trim())))) {
                startPerson(p, line, true);
                continue;
            }
            if (person) person.lines.push(line);
            else cur.intro.push(line);
            continue;
        }

        if (cur) cur.lines.push(line);
        else out.preamble.push(line);
    }

    // An all-caps entry under RELATIONSHIPS with no name we know, no (relation) and no Wants/Hides/Speech
    // lines is a section of the character's own (ADDICTION, VIOLENCE). It is moved out and kept as one.
    const sections = [];
    for (const s of out.sections) {
        sections.push(s);
        if (s.kind !== 'relationships') continue;
        const persons = [];
        const own = [];
        for (const p of s.persons) {
            const isPerson = p.sure || !!p.paren || isKnown(p.core) || p.lines.some(l => FIELD_RE.test(l));
            if (isPerson) persons.push(p);
            else own.push({ kind: 'custom', heading: p.header, title: p.core, lines: p.lines, intro: [], persons: [] });
        }
        s.persons = persons;
        sections.push(...own);
    }
    out.sections = sections;

    for (const s of out.sections) {
        for (const p of s.persons) p.names = nameVariants(p.core);
    }
    return out;
}

/**
 * SPEECH AND VOICE for an off-screen character: every line that describes the voice, plus a few sample lines
 * so a cutaway or a text still sounds like them. Lines labelled for texts or calls come first, then lines to the
 * player, then the rest in card order. The kept lines stay in their original order.
 * @param {string[]} lines the section's lines
 * @param {number} count how many sample lines to keep
 * @param {string[]} playerNames
 * @returns {{lines: string[], samples: number, kept: number}}
 */
export function speechAnchors(lines, count, playerNames = []) {
    const sampleIdx = [];
    lines.forEach((l, i) => {
        const t = l.trim();
        if (t && SAMPLE_START.test(t) && !/^(?:[-*•]\s*)?\**\s*(?:Sample lines|sample lines|Samples)\b/.test(t)) sampleIdx.push(i);
    });
    const label = (l) => {
        const t = l.trim();
        const q = t.search(/["“”]/);
        return q > 0 ? t.slice(0, q) : t;
    };
    const ranked = [
        ...sampleIdx.filter(i => TEXT_LABEL_RE.test(label(lines[i]))),
        ...sampleIdx.filter(i => mentionsAny(label(lines[i]), playerNames)),
        ...sampleIdx,
    ];
    const keep = new Set();
    for (const i of ranked) {
        if (keep.size >= Math.max(0, count)) break;
        keep.add(i);
    }
    const isSample = new Set(sampleIdx);
    const out = lines.filter((l, i) => {
        if (isSample.has(i)) return keep.has(i);
        if (/^(?:[-*•]\s*)?\**\s*(?:Sample lines|sample lines|Samples)\b/.test(l.trim())) return keep.size > 0;
        return true;
    });
    return { lines: out, samples: sampleIdx.length, kept: keep.size };
}

/** The opening paragraph of SPEECH AND VOICE, without the sample lines. */
export function speechParagraph(lines) {
    const out = [];
    for (const l of lines) {
        const t = l.trim();
        if (!t) {
            if (out.length) break;
            continue;
        }
        if (SAMPLE_START.test(t)) break;
        out.push(l);
    }
    return out;
}

// ---------------------------------------------------------------- planning and slicing

/**
 * Decides which parts are kept for sure and which are candidates for matching against the scene.
 * Only the present level matches against the scene; the other levels keep by rule alone.
 * @param {ReturnType<typeof parseCard>} parsed
 * @param {{mode: 'present'|'active'|'offscreen', autoPerson: (p: object) => boolean, autoLine: (text: string) => boolean, recentHistory?: number}} opts
 * @returns {{keep: Set<string>, candidates: {id: string, kind: string, text: string}[], matchable: {id: string, kind: string, text: string}[]}}
 */
export function planCard(parsed, { mode, autoPerson, autoLine, recentHistory = 3 }) {
    const keep = new Set();
    const candidates = [];
    const matchable = [];
    const filtered = LINE_FILTERED[mode] || new Set();

    parsed.sections.forEach((sec, si) => {
        if (sec.kind === 'relationships') {
            sec.persons.forEach((p, pi) => {
                const id = `s${si}:p${pi}`;
                const text = [p.header, ...p.lines].join('\n').trim().slice(0, 1500);
                matchable.push({ id, kind: 'relationships', text });
                if (autoPerson(p)) keep.add(id);
                else if (mode === 'present') candidates.push({ id, kind: 'relationships', text });
            });
            return;
        }
        if (!filtered.has(sec.kind)) return;

        const itemIdx = [];
        sec.lines.forEach((l, li) => { if (l.trim()) itemIdx.push(li); });
        const recent = sec.kind === 'history' ? new Set(itemIdx.slice(-Math.max(0, recentHistory))) : new Set();
        for (const li of itemIdx) {
            const id = `s${si}:l${li}`;
            const text = sec.lines[li].trim();
            matchable.push({ id, kind: sec.kind, text });
            if (recent.has(li) || autoLine(text)) keep.add(id);
            else if (mode === 'present') candidates.push({ id, kind: sec.kind, text });
        }
    });

    return { keep, candidates, matchable };
}

/** A relationship entry cut down to what the character wants from the person and where things stand. */
export function driveLines(person) {
    const kept = person.lines.filter(l => DRIVE_LINE_RE.test(l));
    if (kept.length) return kept;
    if (person.inline) return []; // "**Maddy** — Wants her to leave him. ..." already says it on the heading line
    const first = person.lines.find(l => l.trim());
    return first ? [first] : [];
}

/**
 * A heading line without its markdown: "**SPEECH AND VOICE**" → "SPEECH AND VOICE",
 * "# SONIA PEREZ — *Minor*" → "SONIA PEREZ — Minor", "**Maddy** — Wants ..." → "Maddy — Wants ...".
 */
export function plainHeading(line) {
    return String(line ?? '')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/\*\*|__/g, '')
        .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[:.,;—–-])/g, '$1$2')
        .trim();
}

/** "*Shared:* Eight years" → "Shared: Eight years". Only the label; the rest of the line is left as written. */
function plainFieldLabel(line) {
    return String(line).replace(/^(\s*(?:[-•]\s*)?)\*{1,2}([^*\n]{1,30}:)\*{1,2}/, '$1$2');
}

function trimBlankEdges(lines) {
    let a = 0;
    let b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
}

/**
 * Builds the sliced card.
 * @param {ReturnType<typeof parseCard>} parsed
 * @param {'present'|'active'|'offscreen'} mode
 * @param {Set<string>} keep ids of relationship entries kept whole and of filtered lines to keep
 * @param {{voiceLines?: number, playerNames?: string[]}} [opts]
 */
export function sliceCard(parsed, mode, keep, { voiceLines = 3, playerNames = [] } = {}) {
    const out = [];
    const stats = [];
    const pre = trimBlankEdges(parsed.preamble);
    if (pre.length) {
        out.push(...pre.filter(l => l.trim()).map(l => (/^\s*#{1,6}\s/.test(l) || headingInfo(l) ? plainHeading(l) : l)), '');
    }
    const dropped = DROPPED[mode] || DROPPED.offscreen;
    const filtered = LINE_FILTERED[mode] || new Set();

    parsed.sections.forEach((sec, si) => {
        const label = sec.kind === 'custom' ? sec.title : (SECTION_LABELS[sec.kind] || sec.title);
        let body = [];
        const stat = { kind: sec.kind, label, action: 'kept', total: 0, kept: 0, cutNames: [] };

        if (sec.kind === 'relationships') {
            const intro = trimBlankEdges(sec.intro);
            body.push(...intro);
            stat.total = sec.persons.length;
            sec.persons.forEach((p, pi) => {
                if (keep.has(`s${si}:p${pi}`)) {
                    body.push(plainHeading(p.header), ...trimBlankEdges(p.lines).map(plainFieldLabel));
                    stat.kept++;
                } else {
                    body.push(plainHeading(p.header), ...driveLines(p).map(plainFieldLabel));
                    stat.cutNames.push(titleCase(p.core));
                }
            });
            stat.action = stat.kept === stat.total ? 'kept' : 'trimmed';
        } else if (dropped.has(sec.kind) || (mode !== 'present' && sec.kind === 'custom' && INTIMATE_SECTION_RE.test(sec.title))) {
            stat.action = 'dropped';
        } else if (mode === 'offscreen' && sec.kind === 'speech') {
            const a = speechAnchors(sec.lines, voiceLines, playerNames);
            body = a.lines;
            stat.total = a.samples;
            stat.kept = a.kept;
            stat.action = a.kept < a.samples ? 'voice' : 'kept';
        } else if (filtered.has(sec.kind)) {
            sec.lines.forEach((l, li) => {
                if (!l.trim()) return;
                stat.total++;
                if (keep.has(`s${si}:l${li}`)) {
                    body.push(l);
                    stat.kept++;
                }
            });
            stat.action = stat.kept === stat.total ? 'kept' : (stat.kept ? 'trimmed' : 'dropped');
        } else {
            body = trimBlankEdges(sec.lines);
        }

        // Blank lines inside a section carry nothing for the model; the headings already separate everything.
        body = body.filter(l => l.trim());
        const headingHasText = !!(headingInfo(sec.heading)?.rest);
        if (body.length || (headingHasText && stat.action !== 'dropped')) {
            out.push(plainHeading(sec.heading), ...body, '');
        } else if (stat.action !== 'dropped') {
            stat.action = 'dropped';
        }
        stats.push(stat);
    });

    const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, stats };
}

// ---------------------------------------------------------------- chat text

export function cleanProse(mes) {
    return String(mes ?? '')
        .replace(/<!--\s*GFX_START\s*-->[\s\S]*?<!--\s*GFX_END\s*-->/gi, ' ')
        .replace(/<internal_states>[\s\S]*?<\/internal_states>/gi, ' ')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ');
}

export function stateBlock(mes) {
    const s = String(mes ?? '');
    const m = s.match(/<internal_states>([\s\S]*?)<\/internal_states>/i) || s.match(/<!--\s*GFX_START\s*-->([\s\S]*?)<!--\s*GFX_END\s*-->/i);
    return m ? m[1] : '';
}

/** Names from speaker labels like `[Jules] (Tired, Guarded):` */
export function speakerLabels(text) {
    const out = new Set();
    for (const m of String(text ?? '').matchAll(/\[([^\]\n]{1,40})\]\s*\(/g)) out.add(m[1].trim());
    return out;
}

/**
 * Rows of the NPC Agendas tracker: who the preset is moving off-screen, and the row text (agenda, location,
 * who they're with). The owner is the bold name at the start, e.g. `- <b>Jules</b> | Agenda: ...`.
 * @returns {{owner: string, text: string}[]}
 */
export function agendaRows(block) {
    const rows = [];
    let inSection = false;
    for (const line of String(block ?? '').split(/\r?\n/)) {
        if (/NPC\s+AGENDAS?/i.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection && (/<\/details>/i.test(line) || /<summary>/i.test(line)) && !/<b>|\*\*/.test(line)) {
            inSection = false;
            continue;
        }
        const isRow = (inSection && /^\s*[-*•]/.test(line)) || /\bAgenda\s*:/i.test(line);
        if (!isRow) continue;
        const bold = line.match(/<b>([^<]{1,60})<\/b>/i) || line.match(/\*\*([^*]{1,60})\*\*/);
        let owner = bold ? bold[1] : '';
        if (!owner) {
            const m = line.replace(/^\s*[-*•]\s*/, '').match(/^([^|:]{1,60})[|:]/);
            owner = m ? m[1] : '';
        }
        owner = owner.replace(/<[^>]+>/g, '').trim();
        if (owner) rows.push({ owner, text: line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
    }
    return rows;
}

/** The Physics row of the state block, which says who is where in the scene. */
export function physicsText(block) {
    return String(block ?? '').split(/\r?\n/).filter(l => /\bPhysics\s*:/i.test(l)).join('\n');
}

// ---------------------------------------------------------------- keyword fallback

function stem(w) {
    return w.length > 6 ? w.replace(/(?:ings?|edly|ed|es|s)$/, '') : w;
}

export function sigWords(text, exclude = new Set()) {
    const out = new Set();
    for (const raw of String(text ?? '').toLowerCase().match(/\p{L}[\p{L}'’]{3,}/gu) || []) {
        const w = raw.replace(/['’]s$/, '');
        if (w.length < 5 || STOP_WORDS.has(w) || exclude.has(w)) continue;
        out.add(stem(w));
    }
    return out;
}

export function overlap(a, b) {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
}

// ---------------------------------------------------------------- misc

/** Same algorithm as SillyTavern's getStringHash (cyrb53). */
export function stringHash(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function approxTokens(text) {
    return Math.round(String(text ?? '').length / 3.8);
}
