// Card Updater: the parts that don't touch SillyTavern (sections, prompt, reply parsing, diffs, checks).

import { headingInfo, classifyHeading, cleanProse, stateBlock } from './cardparse.js';

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

// ---------------------------------------------------------------- the chat

/** The newest story date from a header like `[ 🕰️ 04:35 PM | 🗓️ Day 1 - Saturday 17 May | 📍 ... ]`. */
export function storyDateFrom(chat) {
    for (let i = (chat?.length || 0) - 1; i >= 0; i--) {
        const m = String(chat[i]?.mes ?? '').match(/🗓️\s*([^|\]\n]+)/u);
        if (m) return m[1].trim();
    }
    return '';
}

function tagless(text) {
    return String(text ?? '')
        .replace(/<summary>([\s\S]*?)<\/summary>/gi, '\n## $1\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * What the model reads: the Summaryception summary, the chat it hasn't summarised yet, and the latest state block.
 * @param {object[]} chat SillyTavern chat messages
 * @param {object} store chatMetadata.summaryception, if any
 * @param {{userName: string, fallbackMessages: number, maxChars: number}} opts
 */
export function gatherStory(chat, store, { userName = 'User', fallbackMessages = 60, maxChars = 120000 } = {}) {
    const msgs = Array.isArray(chat) ? chat : [];
    const layers = Array.isArray(store?.layers) ? store.layers : [];
    const snippets = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        for (const sn of Array.isArray(layers[i]) ? layers[i] : []) if (sn?.text) snippets.push(String(sn.text).trim());
    }
    const summary = snippets.join('\n\n');
    const hasSummary = snippets.length > 0;
    const from = hasSummary && Number.isInteger(store?.summarizedUpTo) ? store.summarizedUpTo + 1 : Math.max(0, msgs.length - fallbackMessages);

    const recent = [];
    for (let i = from; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || m.is_system || m?.extra?.sc_ghosted) continue;
        const text = tagless(cleanProse(m.mes));
        if (!text) continue;
        const who = m.is_user ? userName : (m.name || 'Narrator');
        recent.push(`[#${i}] ${who}: ${text}`);
    }
    let recentText = '';
    for (let i = recent.length - 1; i >= 0; i--) {
        const next = `${recent[i]}\n\n${recentText}`;
        if (next.length > maxChars) break;
        recentText = next;
    }

    let state = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
        const b = stateBlock(msgs[i]?.mes);
        if (b) {
            state = tagless(b);
            break;
        }
    }
    return { summary, hasSummary, recent: recentText.trim(), state, storyDate: storyDateFrom(msgs), fromIndex: from };
}

// ---------------------------------------------------------------- the prompt

export function systemPrompt(userName) {
    const u = userName || 'the player character';
    return `You update one character card for a long-running roleplay so it matches what has happened in the story. The roleplay model reads this card on every turn and treats it as the truth about the character. Only change what the story has actually changed.

WHAT TO CHANGE
- Only what will still be true weeks of story time from now: who they are with and on what terms, where they live and work, what they now know, secrets that came out, goals reached or dropped, people who came into or left their life, lasting changes to how they look.
- Never write a passing state into the card: mood, where they are right now, what they are doing today, injuries that heal within days, plans for the day. The game tracks those itself.
- PERSONALITY changes only when the story shows a lasting change over many scenes and days, not after one event. Events change mood, closeness and choices, not who someone is. When in doubt, leave PERSONALITY alone. If you do change it, change only the affected lines and say in the reason which events show it.
- The card holds only what THIS character knows. They know an event only if they were there, saw it, or were told about it, and then say who told them. The summary and chat show many things this character never saw: leave those out. This applies to ${u} too: what ${u} did out of this character's sight is not theirs to know.
- Everything between this character and ${u} goes in their entry for ${u} under RELATIONSHIPS (Wants, Hides, Speech, Shared history), not in HISTORY or KNOWLEDGE. If that entry says they have not met ${u} and they now have, rewrite it as an entry for someone they know: Wants, Hides, a Speech line that says what they do when they talk to ${u} now (in front of whom, how close they stand, what they say first, what they do when they get nothing back), and Shared history.

HOW TO WRITE IT
- Keep the card's own format exactly: the same headings, bullet style, field labels (Wants:, Hides:, Speech:, Shared history:, Now:) and line layout. Keep every line you are not changing exactly as it is, in its place.
- HISTORY is a dated list, earliest to most recent. Keep every existing line unchanged; add new events after them in date order. Each new line is what happened, when, who was there and what was said or done. Write events, not what they meant. Add only events that matter to this character, not every scene.
- KNOWLEDGE uses: "Knows X. Learned it from Y on [date]." / "Believes Z. Z is false." / "Suspects W, no confirmation." Only add what they learned in the story.
- RELATIONSHIPS: one entry per person, as things stand now. If two people have stopped speaking or got together, the entry's first line says what the character does now ("Now: ..."). Add an entry for someone new only if they are now a lasting part of this character's life. An entry holds only what this character knows.
- Dates: write the story's named day and date the way the chat headers write them (for example "Day 3 - Monday 14 October"). Never use words that count from a day: today, tonight, this morning, yesterday, last night, tomorrow, this week, "three days ago", or running counts like "four days clean". Give a count the date it started instead ("clean since Day 3 - Monday 14 October"). Spoken lines in quotes keep their own words.
- Keep the card's prose flat and plain, like the rest of the card: facts, behaviour, things said. No flourishes, no summing up, no interpretation.
- Write what the character does, never what they don't do.

WHAT TO RETURN
For every section you change, return the whole new body of that section (everything under its heading, without the heading line), including every line you kept:
<update>
<heading>THE SECTION HEADING EXACTLY AS IN THE CARD</heading>
<reason>One short line: which story events this comes from.</reason>
<text>
the whole new section body
</text>
</update>
Only update the sections listed under SECTIONS YOU MAY UPDATE. Leave out sections that need no change. If nothing in the story changes this card, return only <none/>.
At the very end, on its own line, write the story's current date as the chat headers write it: <storydate>...</storydate>`;
}

export function userPrompt({ card, title, sections, story, userName }) {
    const parts = [];
    parts.push(`CHARACTER CARD: ${title}\n<card>\n${card}\n</card>`);
    parts.push(`SECTIONS YOU MAY UPDATE: ${sections.join(', ')}`);
    if (story.summary) parts.push(`STORY SO FAR (summary of the older chat, in order):\n<summary>\n${story.summary}\n</summary>`);
    if (story.recent) parts.push(`RECENT CHAT (newest at the bottom; ${userName} is the player character):\n<chat>\n${story.recent}\n</chat>`);
    if (story.state) parts.push(`THE GAME'S TRACKERS FROM THE LATEST TURN (current situation; use it for what characters know and where things stand, never copy passing moods into the card):\n<trackers>\n${story.state}\n</trackers>`);
    if (story.storyDate) parts.push(`CURRENT STORY DATE: ${story.storyDate}`);
    parts.push(`Update the card for ${title}. Return only the <update> blocks (or <none/>) and the <storydate> line.`);
    return parts.join('\n\n');
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
    return { updates, storyDate, none: !updates.length && /<none\s*\/?>/i.test(text) };
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
    const rel = relativeTimeWords(diff.filter(d => d.type === 'add').map(d => d.line).join('\n'));
    if (rel.length) warnings.push(`Counts from a day: ${rel.join(', ')}. Use the named date instead.`);
    return warnings;
}
