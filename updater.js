// Card Updater: the parts that don't touch SillyTavern (sections, prompt, reply parsing, diffs, checks).

import { headingInfo, classifyHeading, cleanProse, stateBlock, physicsText, mentionsAny } from './cardparse.js';

/** Sections the updater may change, in the order they're offered. */
export const UPDATABLE = [
    ['identity', 'Identity'],
    ['personality', 'Personality'],
    ['appearance', 'Appearance'],
    ['history', 'History'],
    ['knowledge', 'Knowledge'],
    ['secrets', 'Secrets'],
    ['goals', 'Goals'],
    ['relationships', 'Relationships'],
    ['ordinary', 'Ordinary day'],
    ['social', 'Social world'],
    ['standing', 'Standing'],
];

const UPDATABLE_KINDS = new Set(UPDATABLE.map(([k]) => k));

// ---------------------------------------------------------------- sections in the raw card

/**
 * Splits a card into line ranges by its section headings, keeping the text exactly as written.
 * Inside RELATIONSHIPS every all-caps line is a person's entry, so the range runs to the next known section.
 * @returns {{kind: string, title: string, heading: string, inline: boolean, start: number, end: number}[]}
 */
export function sectionRanges(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out = [];
    let cur = { kind: 'preamble', title: '', heading: '', inline: false, start: 0, end: 0 };
    let inRelationships = false;
    const open = (kind, title, heading, inline, i) => {
        cur.end = i;
        if (cur.kind !== 'preamble' || cur.end > cur.start) out.push(cur);
        cur = { kind, title, heading, inline, start: i, end: lines.length };
    };
    lines.forEach((line, i) => {
        const h = headingInfo(line);
        if (!h) return;
        const kind = classifyHeading(h.core);
        if (kind) {
            open(kind, h.core, line, !!h.rest, i);
            inRelationships = kind === 'relationships';
            return;
        }
        if (inRelationships) return;
        if (!h.rest && h.core.replace(/[^A-Z]/g, '').length >= 4 && out.length + (cur.kind === 'preamble' ? 0 : 1) > 0) {
            open('custom', h.core, line, false, i);
        }
    });
    cur.end = lines.length;
    if (cur.kind !== 'preamble' || cur.end > cur.start) out.push(cur);
    return out;
}

/** The body of a range (without its heading line and without trailing blank lines). */
export function rangeBody(lines, r) {
    const body = lines.slice(r.kind === 'preamble' ? r.start : r.start + 1, r.end);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    return body.join('\n');
}

/** Ranges the updater may offer: an updatable kind, heading on its own line, first of its kind. */
export function updatableRanges(text, kinds = UPDATABLE_KINDS) {
    const seen = new Set();
    return sectionRanges(text).filter((r) => {
        if (!kinds.has(r.kind) || r.inline || seen.has(r.kind)) return false;
        seen.add(r.kind);
        return true;
    });
}

/**
 * Puts new section bodies into the card. Everything else stays byte for byte; each replaced section keeps
 * its heading line and the blank lines that followed it.
 * @param {string} text the card
 * @param {{start: number, end: number, body: string}[]} replacements by range
 */
export function applyReplacements(text, replacements) {
    const lines = String(text ?? '').split(/\r?\n/);
    const sorted = [...replacements].sort((a, b) => b.start - a.start);
    for (const r of sorted) {
        let tail = 0;
        for (let i = r.end - 1; i > r.start && !lines[i].trim(); i--) tail++;
        const isLast = r.end >= lines.length;
        const body = String(r.body ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split('\n');
        const blanks = new Array(isLast ? 0 : Math.max(1, tail)).fill('');
        lines.splice(r.start + 1, r.end - r.start - 1, ...body, ...blanks);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------- canon point

const CANON_UPDATED_RE = /,?\s*updated with the story up to [^.]*\./i;

/** "Portrayed at Season 3, Episode 6. Nothing after ..." → "... Episode 6, updated with the story up to Day 3 - Monday. Nothing after ..." */
export function canonPointBody(body, storyDate) {
    const b = String(body ?? '').trim();
    if (!b || !storyDate) return b;
    const date = String(storyDate).trim().replace(/\.$/, '');
    if (CANON_UPDATED_RE.test(b)) return b.replace(CANON_UPDATED_RE, `, updated with the story up to ${date}.`);
    const m = b.match(/^([^.]*?)(\.)(\s|$)/);
    if (!m) return `${b} Updated with the story up to ${date}.`;
    return `${m[1]}, updated with the story up to ${date}.${b.slice(m[0].length - m[3].length)}`;
}

// ---------------------------------------------------------------- the story

/** The newest story date from a header like `[ 🕰️ 04:35 PM | 🗓️ Day 1 - Saturday 17 May | 📍 ... ]`. */
export function storyDateFrom(chat, upTo = Infinity) {
    for (let i = Math.min((chat?.length || 0) - 1, upTo); i >= 0; i--) {
        const m = String(chat[i]?.mes ?? '').match(/🗓️\s*([^|\]\n]+)/u);
        if (m) return m[1].trim();
    }
    return '';
}

export function tagless(text) {
    return String(text ?? '')
        .replace(/<summary>([\s\S]*?)<\/summary>/gi, '\n## $1\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * The story as an ordered list of pieces: Summaryception snippets where the chat has been summarised, raw
 * messages where it hasn't. With `since`, only what comes after that message index (raw messages are used for
 * anything a still-dated snippet doesn't cover, even when Summaryception has hidden them).
 * @param {object[]} chat SillyTavern chat messages
 * @param {object} store chatMetadata.summaryception, if any
 * @param {{userName?: string, since?: number|null, firstRunMessages?: number}} opts
 * @returns {{items: {kind: 'summary'|'message', from: number, to: number, text: string, isUser?: boolean, presence?: string}[], end: number}}
 */
export function storyItems(chat, store, { userName = 'User', since = null, firstRunMessages = 0 } = {}) {
    const msgs = Array.isArray(chat) ? chat : [];
    const end = msgs.length - 1;
    const layers = Array.isArray(store?.layers) ? store.layers : [];
    const layer0 = (Array.isArray(layers[0]) ? layers[0] : []).filter(sn => sn?.text && Array.isArray(sn.turnRange));
    const items = [];
    const msgItem = (i) => {
        const m = msgs[i];
        if (!m || (m.is_system && !m?.extra?.sc_ghosted)) return null;
        const text = tagless(cleanProse(m.mes));
        if (!text) return null;
        const who = m.is_user ? userName : (m.name || 'Narrator');
        return { kind: 'message', from: i, to: i, text: `[#${i}] ${who}: ${text}`, isUser: !!m.is_user, presence: physicsText(stateBlock(m.mes)) };
    };

    const firstRun = since === null || since === undefined;
    if (firstRun) {
        // Everything: the whole summary, oldest layer first, then the chat after it.
        const hasSummary = layers.some(l => Array.isArray(l) && l.some(sn => sn?.text));
        if (hasSummary) {
            for (let li = layers.length - 1; li >= 0; li--) {
                for (const sn of Array.isArray(layers[li]) ? layers[li] : []) {
                    if (sn?.text) items.push({ kind: 'summary', from: sn.turnRange?.[0] ?? -1, to: sn.turnRange?.[1] ?? -1, text: String(sn.text).trim() });
                }
            }
        }
        const from = hasSummary
            ? (Number.isInteger(store?.summarizedUpTo) ? store.summarizedUpTo + 1 : 0)
            : (firstRunMessages > 0 ? Math.max(0, msgs.length - firstRunMessages) : 0);
        for (let i = from; i <= end; i++) {
            const it = msgItem(i);
            if (it) items.push(it);
        }
    } else {
        // Only what comes after `since`: a dated summary snippet where one starts after it, the raw message otherwise.
        let i = since + 1;
        while (i <= end) {
            const sn = layer0.find(x => x.turnRange[0] === i);
            if (sn && sn.turnRange[1] >= i) {
                items.push({ kind: 'summary', from: sn.turnRange[0], to: sn.turnRange[1], text: String(sn.text).trim() });
                i = sn.turnRange[1] + 1;
                continue;
            }
            const it = msgItem(i);
            if (it) items.push(it);
            i++;
        }
    }
    return { items, end };
}

/**
 * Keeps the pieces that involve the character: summary snippets and messages that name them (in the text or in
 * the Physics row of that message's state block), and the player's messages right before or after a kept reply,
 * since those are their actions in the same scene.
 */
export function filterForCharacter(items, names) {
    const keep = items.map(it => mentionsAny(it.text, names) || (it.presence ? mentionsAny(it.presence, names) : false));
    items.forEach((it, k) => {
        if (keep[k] || it.kind !== 'message' || !it.isUser) return;
        const prev = items[k - 1];
        const next = items[k + 1];
        if ((prev && prev.kind === 'message' && !prev.isUser && keep[k - 1]) || (next && next.kind === 'message' && !next.isUser && keep[k + 1])) keep[k] = true;
    });
    return items.filter((_, k) => keep[k]);
}

/** Splits pieces into chunks of about maxChars. */
export function chunkItems(items, maxChars = 24000) {
    const chunks = [];
    let cur = [];
    let size = 0;
    for (const it of items) {
        if (cur.length && size + it.text.length > maxChars) {
            chunks.push(cur);
            cur = [];
            size = 0;
        }
        cur.push(it);
        size += it.text.length + 2;
    }
    if (cur.length) chunks.push(cur);
    return chunks.map(c => ({ items: c, text: c.map(x => x.text).join('\n\n'), to: Math.max(-1, ...c.map(x => x.to)) }));
}

/** Rows of the latest state block that name the character (their notebook entries, bond, agenda, thoughts). */
export function trackerLines(chat, names) {
    for (let i = (chat?.length || 0) - 1; i >= 0; i--) {
        const b = stateBlock(chat[i]?.mes);
        if (!b) continue;
        const out = [];
        let section = '';
        for (const line of tagless(b).split('\n')) {
            const t = line.trim();
            if (!t) continue;
            if (t.startsWith('## ')) {
                section = t.slice(3).trim();
                continue;
            }
            if (mentionsAny(t, names)) out.push(section ? `${section}: ${t}` : t);
        }
        return out.join('\n');
    }
    return '';
}

// ---------------------------------------------------------------- step 1: the character's log

export function logSystemPrompt(name, userName) {
    const u = userName || 'the player character';
    return `You keep a dated log of what happens to one character in a long roleplay, so their character card can be updated later. You read one part of the story and list what matters to ${name}.

LIST ONLY
- What ${name} did, said, saw or heard, and who was there.
- What ${name} was told or found out, and who told them.
- Lasting changes for ${name}: moving, a new job, a relationship starting, ending or changing, a secret coming out or being kept, an injury that lasts, a change in how they look, a goal reached or dropped, someone new coming into their life.
- Everything between ${name} and ${u}.

LEAVE OUT
- Anything ${name} did not see, hear or get told. Other characters' scenes without ${name} are not part of ${name}'s log.
- Passing moods, small talk and routine that changes nothing.

FORMAT
One line per event, starting with "- ", oldest first:
- [story date as the story writes it, or "undated"]: what happened. Present: who was there.
Plain words, events not interpretation. Keep each line short.
- When someone says something that changes how two people stand with each other, give their words, and give the other person's answer with it.
- Name who did or said what exactly as the story says. If the story doesn't make clear who did something, write "unclear who" rather than guessing a name.
If nothing in this part involves ${name}, reply with exactly: NONE`;
}

export function logUserPrompt({ name, names, text, lastDate }) {
    return `CHARACTER: ${name} (also written as: ${names.join(', ')})
${lastDate ? `The story date before this part: ${lastDate}\n` : ''}
<story_part>
${text}
</story_part>

Write ${name}'s log lines for this part, or NONE.`;
}

/** Log lines from a step-1 reply. */
export function parseLog(reply) {
    const text = String(reply ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    if (/^NONE\.?$/i.test(text)) return [];
    return text.split('\n').map(l => l.trim()).filter(l => /^[-*•]\s+\S/.test(l)).map(l => `- ${l.replace(/^[-*•]\s+/, '')}`);
}

// ---------------------------------------------------------------- step 2: the card update

/** Where each kind of fact lives, so the card says everything once. */
function sayItOnce(u) {
    return `SAY IT ONCE
Each fact lives in one section, its home. Before you write a fact, find every place the card already states it. Keep it in its home; anywhere else, cut it, or keep a few words only when that section needs a different angle on it.
- Anything between this character and ${u}: their entry for ${u} under RELATIONSHIPS.
- Events with other people: one line in HISTORY. That person's RELATIONSHIPS entry gets a few words in Shared history only when the event changed things between them.
- What they found out: KNOWLEDGE, only when it is not already a HISTORY line.
- What they hide: SECRETS. A Hides line in a relationship entry names the secret in a few words.
- What they fear or resent: the fear section, not PERSONALITY.
- Where they stand in a group: STANDING.
- Where things stand now (who they live with, work for, are with): IDENTITY, or the Now line of that person's entry.
- Never add a line the card already says somewhere else.`;
}

/** What survives when lines are condensed, in order; what goes first. */
function keepWhatMatters(u) {
    return `WHAT TO KEEP WHEN YOU CONDENSE
Drop first: objects, places, logistics, what was bought, carried or driven, where someone was dropped off, who arrived when. Keep, in this order:
a) words either person said that changed how they stand with each other, in their own words;
b) the character's answer to a charged line, together with the line. Never keep an answer without what it answered, and never keep a line without the answer that followed;
c) comparisons the character draws between ${u} and someone else;
d) the character's stated stance on what they saw or did;
e) the character's own summing-up of the other person or of their own situation;
f) anything another line of the card refers back to (when a Wants or Speech line depends on something that was said, keep what was said).
Shortening keeps the meaning: keep conditions and qualifiers such as when, usually, after, only if.
Never soften, censor or drop explicit or sexual facts; keep them in the card's own words.`;
}

/** How to handle names and contradictions; both end up as warnings in the review. */
const CHECKS = `NAMES AND CONTRADICTIONS
- Write a name for who did something only when the log or the card says it plainly. If you are not sure who did it, write [check: what is unclear] in its place instead of guessing.
- When the log shows the character saying or doing something that contradicts a line in the card (a trait, a belief, a fear, how they see someone), change that line if its section is one you may change (listed above). Otherwise report it, one per contradiction:
<conflict>the card line, quoted -> what the story shows now, with the date</conflict>`;


const KEEP_IT_SHORT = `KEEP IT SHORT AND PLAIN
The roleplay model reads the whole card on every turn, so every line costs on every reply, and it copies the way the card is written.
- One event per line. A day with several events gets several short dated lines, never one long line.
- Each line is one plain sentence: when, who did what, to whom. Write it so someone who never read the scene understands it: full words, no shorthand, no half-quotes, no phrase that only makes sense if you remember the scene. Quote words only when the exact words matter, and then quote the whole sentence.
- Write like the rest of the card: flat facts. No literary turns, no lines that land, no summing up, no clothes, rooms, weather or other colour.
- Only events where this character acted, or that changed what they do, want or know from now on. Leave out what happened to the people around them (someone's car, someone else's news) unless it changed something for this character. A scene that changed nothing for them gets no line.
- Shared history in a RELATIONSHIPS entry holds only the few events that matter most between the two (about five), each its own short dated line.
- When a new fact replaces an old one, change the old line instead of adding a new one.`;

/** "CARD SIZE" line for the prompts. */
export function sizeNote(tokens, limit) {
    if (!limit) return `CARD SIZE: about ${tokens.toLocaleString('en-US')} tokens.`;
    const over = tokens > limit;
    return `CARD SIZE: about ${tokens.toLocaleString('en-US')} tokens. LIMIT: ${limit.toLocaleString('en-US')} tokens. ${over
        ? 'The card is already over the limit: add only what is essential, as few and as short lines as possible.'
        : 'Your changes must not take the card over the limit.'}`;
}

export function systemPrompt(userName) {
    const u = userName || 'the player character';
    return `You update one character card for a long-running roleplay so it matches what has happened in the story. The roleplay model reads this card on every turn and treats it as the truth about the character. You get the card and a dated log of what happened to the character since the card was last updated. The log already holds only what the character did, saw or was told. Only change what the log actually changes.

WHAT TO CHANGE
- Only what will still be true weeks of story time from now: who they are with and on what terms, where they live and work, what they now know, secrets that came out, goals reached or dropped, people who came into or left their life, lasting changes to how they look.
- Never write a passing state into the card: mood, where they are right now, what they are doing today, injuries that heal within days, plans for the day. The game tracks those itself.
- PERSONALITY changes only when the log shows a lasting change over many scenes and days, not after one event. Events change mood, closeness and choices, not who someone is. When in doubt, leave PERSONALITY alone. If you do change it, change only the affected lines and say in the reason which events show it.
- Everything between this character and ${u} goes in their entry for ${u} under RELATIONSHIPS (Wants, Hides, Speech, Shared history), not in HISTORY or KNOWLEDGE. If that entry says they have not met ${u} and they now have, rewrite it as an entry for someone they know: Wants, Hides, a Speech line that says what they do when they talk to ${u} now (in front of whom, how close they stand, what they say first, what they do when they get nothing back), and Shared history.

${sayItOnce(u)}

${KEEP_IT_SHORT}

${keepWhatMatters(u)}

${CHECKS}

HOW TO WRITE IT
- Keep the card's own format exactly: the same headings, bullet style, field labels (Wants:, Hides:, Speech:, Shared history:, Now:) and line layout. Keep every line you are not changing exactly as it is, in its place.
- HISTORY is a dated list, earliest to most recent. Keep every existing line unchanged; add new events after them in date order. Write events, not what they meant. Most log lines don't belong in the card at all.
- Add to a Shared history only events that changed things between the two. Most days add nothing there.
- KNOWLEDGE uses: "Knows X. Learned it from Y on [date]." / "Believes Z. Z is false." / "Suspects W, no confirmation." Only add what they learned in the story.
- RELATIONSHIPS: one entry per person, as things stand now. If two people have stopped speaking or got together, the entry's first line says what the character does now ("Now: ..."). Add an entry for someone new only if they are now a lasting part of this character's life.
- Dates: write the story's named day and date the way the log writes them (for example "Day 3 - Monday 14 October"). Never use words that count from a day: today, tonight, this morning, yesterday, last night, tomorrow, this week, "three days ago", or running counts like "four days clean". Give a count the date it started instead ("clean since Day 3 - Monday 14 October"). Spoken lines in quotes keep their own words.
- Keep the card's prose flat and plain, like the rest of the card: facts, behaviour, things said. No flourishes, no summing up, no interpretation.
- Write what the character does, never what they don't do.

WHAT TO RETURN
For every section you change, return the whole new body of that section (everything under its heading, without the heading line), including every line you kept:
<update>
<heading>THE SECTION HEADING EXACTLY AS IN THE CARD</heading>
<reason>One short line: which log lines this comes from.</reason>
<text>
the whole new section body
</text>
</update>
Only update the sections listed under SECTIONS YOU MAY UPDATE. Leave out sections that need no change. Add any <conflict> lines after the updates. If nothing in the log changes this card, return only <none/> (and any <conflict> lines).
At the very end, on its own line, write the newest story date in the log: <storydate>...</storydate>`;
}

export function userPrompt({ card, title, sections, log, trackers, storyDate, tokens = 0, limit = 0 }) {
    const parts = [];
    parts.push(`CHARACTER CARD: ${title}\n<card>\n${card}\n</card>`);
    if (tokens) parts.push(sizeNote(tokens, limit));
    parts.push(`SECTIONS YOU MAY UPDATE: ${sections.join(', ')}`);
    parts.push(`WHAT HAPPENED TO ${title} SINCE THE CARD WAS LAST UPDATED (oldest first):\n<log>\n${log.join('\n')}\n</log>`);
    if (trackers) parts.push(`THE GAME'S TRACKER ROWS ABOUT ${title} FROM THE LATEST TURN (the current situation; use them for what they know and where things stand, never copy a passing mood into the card):\n<trackers>\n${trackers}\n</trackers>`);
    if (storyDate) parts.push(`CURRENT STORY DATE: ${storyDate}`);
    parts.push(`Update the card for ${title}. Return only the <update> blocks (or <none/>) and the <storydate> line.`);
    return parts.join('\n\n');
}

// ---------------------------------------------------------------- tighten

const NEW_MARK = '[new] ';

/** Lines of the original card, trimmed, for telling original lines from lines added in play. */
export function originalLineSet(original) {
    return new Set(String(original ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean));
}

/**
 * The card with every line that isn't in the original marked "[new] ", for the given ranges only.
 * @returns {{text: string, newLines: number}}
 */
export function markNewLines(content, original, ranges) {
    const lines = String(content ?? '').split(/\r?\n/);
    const orig = originalLineSet(original);
    const inRange = new Set();
    for (const r of ranges) for (let i = r.start + 1; i < r.end; i++) inRange.add(i);
    let newLines = 0;
    const out = lines.map((l, i) => {
        if (!inRange.has(i) || !l.trim() || orig.has(l.trim()) || headingInfo(l)) return l;
        newLines++;
        return NEW_MARK + l;
    });
    return { text: out.join('\n'), newLines };
}

export function stripNewMarks(text) {
    return String(text ?? '').split('\n').map(l => l.replace(/^(\s*)\[new\]\s?/i, '$1')).join('\n');
}

/** Lines of the original card that a proposed section body no longer holds word for word. */
export function lostOriginalLines(oldBody, newBody, original) {
    const orig = originalLineSet(original);
    const kept = new Set(String(newBody ?? '').split('\n').map(l => l.trim()));
    return String(oldBody ?? '').split('\n').map(l => l.trim()).filter(l => l && orig.has(l) && !kept.has(l));
}

export function tightenSystemPrompt(userName, { original = false } = {}) {
    const u = userName || 'the player character';
    const scope = original
        ? `WHAT YOU MAY CHANGE
- Lines marked [new] were added by updates during play; condense them as below.
- Lines without the mark come from the original card. This time you may condense them too, but only to cut repeats and old backstory: give old backstory one line per period of the character's life, keeping only what explains how they act now or involves people still in the story. Episodes with side characters who never come up now are cut, not summarised. Keep every original line that still matters word for word.
- Never remove a heading or a section, and never touch a section that isn't listed under SECTIONS YOU MAY TIGHTEN.`
        : `WHAT YOU MAY CHANGE
- Only lines marked [new]. Those were added by updates during play.
- Lines without the mark come from the original card. Keep each of them exactly as it is, in its place, even when you'd write it differently.
- Never remove a heading or a section, and never touch a section that isn't listed under SECTIONS YOU MAY TIGHTEN.`;
    return `You tighten one character card for a long-running roleplay. Updates from play have made it long and repetitive. Make it shorter while keeping what makes the character act the way they do.

${scope}

${sayItOnce(u)}

${KEEP_IT_SHORT}

${keepWhatMatters(u)}

${CHECKS}

HOW TO TIGHTEN
- Remove a [new] line when the card already states the same fact somewhere else; leave a few words pointing to it only where the reader would otherwise miss it.
- Shorten [new] lines to one plain sentence. Keep dates and who was there.
- Merge [new] lines that say the same thing.
- Split a [new] line that crams several events into one line, then keep only the events that matter.
- Rewrite [new] lines that use shorthand or literary phrasing as plain sentences.
- If a Shared history holds more than about five events, keep the ones that matter most by the order above and cut the rest.
- Never drop a fact that matters to how the character acts or what they know just to save space.
- Keep the card's format: headings, bullet style, field labels.

WHAT TO RETURN
For every section you change, return the whole new body of that section (everything under its heading, without the heading line, and without the [new] marks), including every line you kept:
<update>
<heading>THE SECTION HEADING EXACTLY AS IN THE CARD</heading>
<reason>One short line: what was cut or merged.</reason>
<text>
the whole new section body
</text>
</update>
Add any <conflict> lines after the updates. If nothing can be cut, return only <none/> (and any <conflict> lines).`;
}

export function tightenUserPrompt({ card, title, sections, tokens, limit }) {
    return [
        `CHARACTER CARD: ${title} (lines marked [new] were added in play)\n<card>\n${card}\n</card>`,
        `SECTIONS YOU MAY TIGHTEN: ${sections.join(', ')}`,
        sizeNote(tokens, limit),
        `Tighten the card for ${title}. Return only the <update> blocks, or <none/>.`,
    ].join('\n\n');
}

// ---------------------------------------------------------------- the reply

function inner(block, tag) {
    const m = String(block).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1] : null;
}

/**
 * @returns {{updates: {heading: string, reason: string, text: string}[], storyDate: string, none: boolean}}
 */
export function parseReply(reply) {
    const text = String(reply ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const updates = [];
    for (const m of text.matchAll(/<update>([\s\S]*?)<\/update>/gi)) {
        const heading = (inner(m[1], 'heading') || '').replace(/[*#_]/g, '').trim();
        const body = inner(m[1], 'text');
        if (!heading || body === null) continue;
        updates.push({ heading, reason: (inner(m[1], 'reason') || '').trim(), text: body.replace(/^\n+|\s+$/g, '') });
    }
    const storyDate = (inner(text, 'storydate') || '').trim();
    const conflicts = [...text.matchAll(/<conflict>([\s\S]*?)<\/conflict>/gi)].map(m => m[1].trim()).filter(Boolean);
    return { updates, storyDate, conflicts, none: !updates.length && /<none\s*\/?>/i.test(text) };
}

/** Finds the range a reply's heading means: same title, else same kind. */
export function matchRange(ranges, heading) {
    const want = String(heading).toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    const norm = (t) => String(t).toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    return ranges.find(r => norm(r.title) === want) || ranges.find(r => r.kind === classifyHeading(want)) || null;
}

// ---------------------------------------------------------------- review helpers

/** Line diff (LCS). @returns {{type: 'same'|'add'|'del', line: string}[]} */
export function lineDiff(oldText, newText) {
    const a = String(oldText ?? '').split('\n');
    const b = String(newText ?? '').split('\n');
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ type: 'same', line: a[i] });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'del', line: a[i++] });
        } else {
            out.push({ type: 'add', line: b[j++] });
        }
    }
    while (i < n) out.push({ type: 'del', line: a[i++] });
    while (j < m) out.push({ type: 'add', line: b[j++] });
    return out;
}

const RELATIVE_TIME_RE = /\b(?:today|tonight|this morning|this afternoon|this evening|yesterday|last night|tomorrow|this week|last week|next week|\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|several)\s*(?:days?|weeks?|months?|hours?)\s+ago\b|\b(?:today|tonight|this morning|yesterday|last night|tomorrow|this week)\b|\b\w+\s+days?\s+clean\b/gi;

/** Words that count from a day, outside quoted speech. */
export function relativeTimeWords(text) {
    const found = new Set();
    for (const line of String(text ?? '').split('\n')) {
        const unquoted = line.replace(/"[^"]*"|“[^”]*”/g, ' ');
        for (const m of unquoted.matchAll(RELATIVE_TIME_RE)) found.add(m[0].toLowerCase());
    }
    return [...found];
}

/**
 * Warnings for one proposed section.
 * @returns {string[]}
 */
export function checkUpdate(kind, oldBody, newBody) {
    const warnings = [];
    const diff = lineDiff(oldBody, newBody);
    const removed = diff.filter(d => d.type === 'del' && d.line.trim());
    if (!String(newBody).trim()) warnings.push('The new section is empty.');
    if (kind === 'personality') warnings.push('Personality change: check the reason before accepting.');
    if (kind === 'history' && removed.length) warnings.push(`Removes or rewrites ${removed.length} existing history line${removed.length === 1 ? '' : 's'}.`);
    const lostHeads = removed.filter(d => headingInfo(d.line) && !String(newBody).includes(d.line.trim()));
    for (const d of lostHeads) warnings.push(`Drops "${d.line.trim()}".`);
    const added = diff.filter(d => d.type === 'add').map(d => d.line);
    const rel = relativeTimeWords(added.join('\n'));
    if (rel.length) warnings.push(`Counts from a day: ${rel.join(', ')}. Use the named date instead.`);
    for (const line of added) {
        const m = line.match(/\[check:([^\]]*)\]/i);
        if (m) warnings.push(`Unsure who did it, check before saving: "${m[1].trim()}"`);
    }
    const long = added.filter(l => l.split(/\s+/).filter(Boolean).length > 70);
    if (long.length) warnings.push(`${long.length} added line${long.length === 1 ? ' is' : 's are'} over 70 words: "${long[0].trim().slice(0, 60)}…"`);
    return warnings;
}
