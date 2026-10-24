// Card Updater: the parts that don't touch SillyTavern (sections, prompt, reply parsing, diffs, checks).

import { headingInfo, classifyHeading, cleanProse, stateBlock, physicsText, mentionsAny, sigWords, overlap } from './cardparse.js';

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

/** Sections a change may touch at all (unticked ones only by hand): everything but the top lines and CANON POINT. */
export function editableRanges(text) {
    return sectionRanges(text).filter(r => r.kind !== 'preamble' && r.kind !== 'canon' && !r.inline);
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
- Anything ${name} did not see, hear or get told. Other characters' scenes without ${name} are not part of ${name}'s log. Leave such events out completely; don't list them with a note that ${name} missed them.
- Passing moods, small talk and routine that changes nothing.
- How ${u} looks, or what they wear or carry (jewellery, clothes, marks). The story may have made those up.

FORMAT
One line per event, starting with "- ", oldest first:
- [story date as the story writes it, or "undated"]: what happened. Present: who was there.
The date only, without the clock time.
Plain words, events not interpretation. Keep each line short.
- When someone says something that changes how two people stand with each other, give their words, and give the other person's answer with it.
- Name who did or said what exactly as the story says. If the story doesn't make clear who did something, write "unclear who" rather than guessing a name.
- Keep who did what to whom exactly as the story has it, and name the act as the story describes it. Never turn one act into another (touching into sex, a kiss into more), and never merge two people's acts into one.
- When the story contradicts itself (a slip in who did something, an object in two places at once), keep what the rest of the scene supports, or write "unclear".
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
- Anything involving ${u}, even when other people were there too: only in their entry for ${u} under RELATIONSHIPS. Never in HISTORY or KNOWLEDGE. Another person's entry mentions ${u} only for what is about that person (what they hide from that person, for example).
- An event with another person who has an entry: that person's entry (a few words in Shared history, or their Now line), not HISTORY.
- HISTORY only gets life changes (moving, a job, a break-up, a lasting injury) and events with nobody who has an entry.
- What they found out: KNOWLEDGE, only when it is not already an event anywhere in the card.
- What they hide: SECRETS. A Hides line in a relationship entry names the secret in a few words.
- A secret is out only when the log shows that exact fact told to someone or seen by them. Something like it happening in front of them (crying, a fight, a phone call) does not reveal it. Before you change who a secret is hidden from, read the Hides line in that person's entry; change both or neither.
- A Knows line, and KNOWLEDGE, holds only what this character found out. What they told someone else is an event: Shared history, or nowhere.
- What they fear or resent: the fear section, not PERSONALITY.
- Where they stand in a group: STANDING.
- Where things stand now (who they live with, work for, are with): IDENTITY, or the Now line of that person's entry.
- Never add a line the card already says somewhere else. A different angle is not a repeat: one entry says what happened between those two, SECRETS says who it is hidden from, another person's entry says how it touched them. The same fact told the same way twice is a repeat.
- When you change one line of a relationship entry, read the entry's other lines (Now, Wants, Hides, Speech, As it grows) and change any that no longer agree with it.`;
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
- Keep who did what to whom exactly as the log has it, and name each act as the log does. Never turn one act into another (touching into sex, a kiss into more), never swap who watched and who acted, and never merge two events into one. When the same event goes into two entries, both must say the same thing.
- A Speech line says how this character talks to that person. What the other person says, thinks or calls them is not Speech; leave it out or put it in Shared history.
- When the log shows the character saying or doing something that contradicts a line in the card (a trait, a belief, a fear, how they see someone), change that line if its section is one you may change. Otherwise report it, one per contradiction:
<conflict>the card line, quoted -> what the story shows now, with the date</conflict>`;


const KEEP_IT_SHORT = `KEEP IT SHORT AND PLAIN
The roleplay model reads the whole card on every turn, so every line costs on every reply, and it copies the way the card is written.
- One event per line. A day with several events gets several short dated lines, never one long line. This wins over copying the card: if older lines in a list are long paragraphs, new lines are still one event each.
- The date is enough. Leave out clock times unless the time itself matters (a deadline, a near miss).
- Each line is one plain sentence: when, who did what, to whom. Write it so someone who never read the scene understands it: full words, no shorthand, no half-quotes, no phrase that only makes sense if you remember the scene. Quote words only when the exact words matter, and then quote the whole sentence.
- Write like the rest of the card: flat facts. No literary turns, no lines that land, no summing up, no clothes, rooms, weather or other colour.
- Only events where this character acted, or that changed what they do, want or know from now on. Leave out what happened to the people around them (someone's car, someone else's news) unless it changed something for this character. A scene that changed nothing for them gets no line.
- Shared history in a RELATIONSHIPS entry holds only the few events that matter most between the two (about five), each its own short dated line. One day gets at most two new lines. Each keeps the moment, the words said and what changed between them, in one or two sentences of about 40 words at most, and cuts the rest, even when older lines are longer.
- When a new fact replaces an old one, change the old line instead of adding a new one.`;

/** "CARD SIZE" line for the prompts. */
export function sizeNote(tokens, limit, { tighten = false } = {}) {
    if (!limit) return `CARD SIZE: about ${tokens.toLocaleString('en-US')} tokens.`;
    const over = tokens > limit;
    const what = tighten
        ? (over ? 'The card is over the limit: cut until it is under, without losing what drives the character.' : 'Keep it under the limit.')
        : (over
            ? 'The card is already over the limit. Still put every lasting fact on it, as short as it can be: change an existing line rather than add one, and cut what a new fact replaces. Tighten shortens the card later; a missing fact can\'t be added back that way.'
            : 'Your changes must not take the card over the limit.');
    return `CARD SIZE: about ${tokens.toLocaleString('en-US')} tokens. LIMIT: ${limit.toLocaleString('en-US')} tokens. ${what}`;
}

/** "STORY DAYS" for the prompts: how each day of the story is written in the chat headers. */
export function storyDaysNote(dates) {
    if (!dates || !dates.size) return '';
    const days = [...dates.entries()].sort((a, b) => a[0] - b[0]).slice(-60).map(([, full]) => full);
    return `STORY DAYS (write dates in this form): ${days.join('; ')}`;
}

/** The rules for writing changes, shared by the update step and the fix step. */
function updateRules(u) {
    return `WHAT TO CHANGE
- Only what will still be true weeks of story time from now: who they are with and on what terms, where they live and work, what they now know, secrets that came out, goals reached or dropped, people who came into or left their life, lasting changes to how they look.
- Never write a passing state into the card: mood, where they are right now, what they are doing that day, injuries that heal within days, plans for the day. The game tracks those itself.
- Never write how ${u} looks or what they wear or carry (jewellery, clothes, marks, their body). Those are for ${u} to decide, and the story may have made them up. Keep the act and leave out the detail.
- Use only facts the log or the card states. Add no causes, reasons, motives, feelings or details the log doesn't give (why someone came, what they had just finished, that something was unannounced). Check every fact you write against the rest of the card too: if the card says something happened before, don't write that it never did.
- Read every line of the card against the log, not only the lines about the newest events. A line the log shows is no longer true gets changed wherever it is: a trait the character has now acted against for good, a "has none" or "never" the story has ended, a rule that was broken, a relationship that changed, a goal finished or dropped, a belief the story disproved, wanting to keep something they are leaving, a fear of losing what they have already given up.
- A new fact ends an old one when both can't be true at once: moving out ends wanting to keep the place; saying someone is not the one you are waiting for ends wanting them back; breaking a rule ends keeping it. Then change or remove the old part. Never leave both, in one line or on the card.
- When an event shows a lasting change in how they talk, cope or behave, keep the event in that person's entry, and also change the general line it contradicts (in PERSONALITY, SPEECH AND VOICE, SMALL HABITS, COPING, LIKES or FEARS) with a short clause such as "with Leon, since Day 7 - Friday 23 May, cries in front of him". A change in how they talk to someone also goes in that person's Speech line, in a few words.
- PERSONALITY changes only when the log shows a lasting change over many scenes and days, not after one event. Events change mood, closeness and choices, not who someone is. If you do change a PERSONALITY line, say in the reason which events show it.
- If the entry for ${u} says they have not met and now they have, change its lines into an entry for someone they know: Wants, Hides, a Speech line that says what they do when they talk to ${u} now (in front of whom, how close they stand, what they say first, what they do when they get nothing back), and Shared history.

${sayItOnce(u)}

${KEEP_IT_SHORT}

${keepWhatMatters(u)}

${CHECKS}

HOW TO WRITE A CHANGE
- To change part of a line: quote the words to change exactly in <find>, and give what replaces them in <new>. Every other word of the line stays as it is. Use this for any line longer than about thirty words. To add words at the end of a line, quote its last few words in <find> and repeat them in <new> with the addition.
- When you change part of a line, read the whole line as it will read afterwards against what is true now. Every clause in it must still be true; change any that isn't, with a longer <find> or by giving the whole line.
- Every fact you write must agree with your other changes and with the rest of the card.
- To change a short line as a whole: give the whole line as it should read in <new>, without <find>. Keep every fact of the old line in its own words; change only the words that are no longer true.
- A line that lists what someone wants, likes, fears, knows or hides grows: add the new part and keep the earlier parts that still hold. Replace a part only when the log shows it ended, and say so in the reason.
- To add a line: say which existing line it goes after, and write it with the same leading spaces, bullet and field label as the lines around it. In a dated list, a new line goes in date order: after the last line with an earlier or the same date and time of day.
- Remove a line, or words from a line, only when the log shows they are no longer true or the card already says them elsewhere; say which in the reason.
- Never write line numbers into the text.
- KNOWLEDGE lines use: "Knows X. Learned it from Y on [date]." / "Believes Z. Z is false." / "Suspects W, no confirmation."
- RELATIONSHIPS: one entry per person, as things stand now. If two people have stopped speaking or got together, the entry's Now line says what the character does now.
- Now and Wants lines say how things stand today. Don't chain dates ("since Day 6 …; since Day 7 …; since Day 8 …"): fold what still holds into the present wording, change what has ended, and leave the dated story to Shared history.
- If the log has something lasting between this character and a named person who has no entry yet (terms agreed, a relationship, a conflict that goes on), add an entry for them at the end of RELATIONSHIPS: their name in capitals as a heading line, then the field lines the other entries use (Now, Wants, Speech, Shared history), each short.
- Dates: write the story's day and date in full, the way the chat headers do (for example "Day 3 - Monday 14 October"; see STORY DAYS). Never use words that count from a day: today, tonight, this morning, yesterday, last night, tomorrow, this week, "three days ago", or running counts like "four days clean". Give a count the date it started instead. Spoken lines in quotes keep their own words.
- Keep the card's prose flat and plain: facts, behaviour, things said. No flourishes, no summing up, no interpretation. Write what the character does, never what they don't do.`;
}

const CHANGE_FORMAT = `<change type="edit" line="57">
<find>the exact words in line 57 to change</find>
<new>what replaces them</new>
<reason>which log lines this comes from</reason>
</change>
<change type="edit" line="12">
<new>the whole short line as it should read</new>
<reason>which log lines this comes from</reason>
</change>
<change type="add" after="80">
<new>the new line</new>
<reason>which log lines this comes from</reason>
</change>
<change type="remove" line="12">
<reason>which log line shows it is no longer true, or which line already says it</reason>
</change>`;

export function systemPrompt(userName) {
    const u = userName || 'the player character';
    return `You update one character card for a long-running roleplay so it matches what has happened in the story. The roleplay model reads this card on every turn and treats it as the truth about the character. You get the card with numbered lines and a dated log of what happened to the character since the card was last updated. The log already holds only what the character did, saw or was told.

You don't rewrite the card. You return a short list of changes to single lines. Every line you don't name stays exactly as it is.

${updateRules(u)}

WHAT TO RETURN
First, what is true now, as of the newest date in the log: short lines of everything lasting that the card doesn't say yet or says differently. Where they live and with whom; who they are with and on what terms; what they are leaving or have left; rules or promises broken; goals reached, started or dropped; beliefs the story disproved; secrets now out; people who came into their life and terms agreed with them; how others now see them; how they now talk, cope or behave differently, and with whom.
<now>
- one fact per line
</now>
Then the changes that put every one of those facts on the card and take away every line that still says the opposite. One block per change, in this form:
${CHANGE_FORMAT}
Change lines in the sections listed under SECTIONS YOU MAY UPDATE. A general line in another section that a lasting change contradicts (SPEECH AND VOICE, SMALL HABITS, LIKES, FEARS, COPING, LIMITS) may be changed too; those changes are reviewed by hand. Never change CANON POINT, the lines above the first section, or a quoted sample line. Most log lines change nothing on the card. Add any <conflict> lines after the changes. If nothing in the log changes this card, return only <none/> (and any <conflict> lines).
At the very end, on its own line, write the newest story date in the log: <storydate>...</storydate>`;
}

/** "HISTORY (lines 58-68)" for each section the update may touch. */
export function sectionSpans(text, ranges) {
    const lines = String(text ?? '').split(/\r?\n/);
    return ranges.map((r) => {
        let end = r.end - 1;
        while (end > r.start && !lines[end].trim()) end--;
        return `${r.title} (lines ${r.start + 1}-${end + 1})`;
    });
}

export function userPrompt({ card, title, sections, log, trackers, storyDate, tokens = 0, limit = 0, days = '' }) {
    const parts = [];
    parts.push(`CHARACTER CARD: ${title} (each line starts with its number)\n<card>\n${card}\n</card>`);
    if (tokens) parts.push(sizeNote(tokens, limit));
    parts.push(`SECTIONS YOU MAY UPDATE: ${sections.join(', ')}`);
    parts.push(`WHAT HAPPENED TO ${title} SINCE THE CARD WAS LAST UPDATED (oldest first):\n<log>\n${log.join('\n')}\n</log>`);
    if (trackers) parts.push(`THE GAME'S TRACKER ROWS ABOUT ${title} FROM THE LATEST TURN (the current situation; use them for what they know and where things stand, never copy a passing mood into the card):\n<trackers>\n${trackers}\n</trackers>`);
    if (storyDate) parts.push(`CURRENT STORY DATE: ${storyDate}`);
    if (days) parts.push(days);
    parts.push(`List what is true now for ${title}, then the changes to the card. Return only the <now> block, the <change> blocks (or <none/>), any <conflict> lines and the <storydate> line.`);
    return parts.join('\n\n');
}

// ---------------------------------------------------------------- fixing what the check found

export function fixSystemPrompt(userName) {
    const u = userName || 'the player character';
    return `You proposed changes to one character card for a long-running roleplay. A checker compared them with the log and with the card and found problems. Fix them. The roleplay model reads this card on every turn and treats it as the truth about the character. Line numbers always refer to the card as it is now, before any change.

${updateRules(u)}

WHAT TO RETURN
For each change the checker flagged, return one of these:
- a corrected version, with op set to the change's number. It may change a different line or be a different kind of change (for example an edit of the line that already covers the event instead of a new line):
${CHANGE_FORMAT.replace(/<change type/g, '<change op="3" type')}
- <drop op="3"><reason>why it goes</reason></drop> when the change shouldn't be made at all (it repeats the card, it isn't in the log, it is a passing state).
- <keep op="3"><reason>why the checker is wrong, quoting the log</reason></keep> when the checker is wrong and the change is right as it is.
For each stale line the checker listed: a change without op that makes the line true again, with stale set to the line's number (<change stale="19" type="edit" line="19">), keeping every part of the line that still holds. Changes outside SECTIONS YOU MAY UPDATE are reviewed by hand. If the checker was wrong about the line, return nothing for it.
Fix only what the checker found. The changes it didn't flag are kept as they are, so don't repeat them and don't add what they already add.`;
}

export function fixUserPrompt({ card, title, sections, log, trackers, storyDate, ops, problems, stale, tokens = 0, limit = 0, days = '' }) {
    const parts = [];
    parts.push(`CHARACTER CARD: ${title} (each line starts with its number)\n<card>\n${card}\n</card>`);
    if (tokens) parts.push(sizeNote(tokens, limit));
    parts.push(`SECTIONS YOU MAY UPDATE: ${sections.join(', ')}`);
    parts.push(`WHAT HAPPENED TO ${title} SINCE THE CARD WAS LAST UPDATED (oldest first):\n<log>\n${log.join('\n')}\n</log>`);
    if (trackers) parts.push(`THE GAME'S TRACKER ROWS ABOUT ${title} FROM THE LATEST TURN:\n<trackers>\n${trackers}\n</trackers>`);
    if (storyDate) parts.push(`CURRENT STORY DATE: ${storyDate}`);
    if (days) parts.push(days);
    parts.push(`YOUR CHANGES:\n${ops.map(describeOp).join('\n\n')}`);
    const found = [];
    for (const p of problems) found.push(`#${p.id} ${KIND_WORD[p.kind] || p.kind.toUpperCase()}: ${p.text}`);
    if (found.length) parts.push(`WHAT THE CHECKER FOUND IN YOUR CHANGES:\n${found.join('\n')}`);
    if (stale.length) parts.push(`STALE LINES THE CHECKER FOUND (the log shows they are no longer true):\n${stale.map(x => `line ${x.line} (${x.label}): ${x.text}`).join('\n')}`);
    parts.push('Fix the flagged changes and the stale lines. Return only <change>, <drop> and <keep> blocks.');
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
export function markNewLines(content, original, ranges, { also = null } = {}) {
    const lines = String(content ?? '').split(/\r?\n/);
    const orig = originalLineSet(original);
    if (also) for (const i of also) orig.delete(String(lines[i] ?? '').trim());
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

/**
 * Lines of the player's own entry under RELATIONSHIPS (without its name line). That entry is written in play, so
 * Tighten may condense it like lines updates added.
 */
export function personaEntryLines(text, personaNames) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out = new Set();
    const names = (personaNames || []).map(n => String(n).toLowerCase()).filter(Boolean);
    if (!names.length) return out;
    const rel = sectionRanges(text).find(r => r.kind === 'relationships');
    if (!rel) return out;
    let inEntry = false;
    for (let i = rel.start + 1; i < rel.end; i++) {
        const h = headingInfo(lines[i]);
        if (h) {
            const core = h.core.toLowerCase();
            inEntry = names.some(n => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(core));
            continue;
        }
        if (inEntry && lines[i].trim()) out.add(i);
    }
    return out;
}

export function stripNewMarks(text) {
    return String(text ?? '').split('\n').map(l => l.replace(/^(\s*)\[new\]\s?/i, '$1')).join('\n');
}

/** Lines of the original card that a proposed section body no longer holds word for word. */
export function lostOriginalLines(oldBody, newBody, original, { exempt = null } = {}) {
    const orig = originalLineSet(original);
    if (exempt) for (const t of exempt) orig.delete(t);
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
- The entry for ${u} under RELATIONSHIPS is written in play, so all of it is marked [new]. Its Shared history keeps only the turning points: at most eight dated lines, each one or two sentences, cutting day-by-day detail. Its Now and Wants lines say how things stand today, without a chain of dates ("since Day 6 …; since Day 7 …").
- Write dates in full, as listed under STORY DAYS.
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

export function tightenUserPrompt({ card, title, sections, tokens, limit, days = '' }) {
    return [
        `CHARACTER CARD: ${title} (lines marked [new] were added in play)\n<card>\n${card}\n</card>`,
        `SECTIONS YOU MAY TIGHTEN: ${sections.join(', ')}`,
        sizeNote(tokens, limit, { tighten: true }),
        ...(days ? [days] : []),
        `Tighten the card for ${title}. Return only the <update> blocks, or <none/>.`,
    ].join('\n\n');
}

// ---------------------------------------------------------------- step 3: checking a draft

export function checkSystemPrompt(userName, { tighten = false } = {}) {
    const u = userName || 'the player character';
    const task = tighten
        ? `A proposed change shortens sections of a character card. Compare the old and new text of each changed section with the rest of the card and report problems.
- LOST: a fact in the old text that is now nowhere in the card. Cutting a fact that the card still states in another section is fine.
- UNSUPPORTED: a statement in the new text that the old card doesn't contain.
- WRONG: something the new text changed in meaning (who did what to whom, dates, conditions such as when, usually, after).`
        : `A proposed update changes sections of a character card. Compare the old and new text of each changed section with the log of what happened and with the rest of the card, and report problems.
- LOST: a fact in the old text that the new text no longer has, while the log does not show it stopped being true.
- UNSUPPORTED: a statement in the new text that neither the log nor the old card contains.
- WRONG: something in the new text that the log contradicts: who did what to whom, which act, dates, who was there, or a name mixed up.
- TWICE: a fact the new text adds that the card already states in another section or another entry (name where). Anything involving ${u} belongs only in their entry for ${u}.`;
    return `You check proposed changes to a character card for a long-running roleplay. You don't rewrite anything; you only report.

${task}

Quote the words exactly. One tag per problem:
<lost section="HEADING">the old words that went missing</lost>
<unsupported section="HEADING">the new words with nothing behind them</unsupported>
<wrong section="HEADING">the new words, then -> what the log says</wrong>
<twice section="HEADING">the new words, then -> where the card already says it</twice>
If there are no problems, reply with exactly: <ok/>`;
}

export function checkUserPrompt({ card, title, items, log }) {
    const parts = [`CHARACTER CARD AS IT IS NOW: ${title}\n<card>\n${card}\n</card>`];
    if (log && log.length) parts.push(`WHAT HAPPENED (the log the update was written from):\n<log>\n${log.join('\n')}\n</log>`);
    parts.push(`PROPOSED CHANGES:\n${items.map(it => `<section heading="${it.title}">\n<old>\n${it.oldBody}\n</old>\n<new>\n${it.newBody}\n</new>\n</section>`).join('\n')}`);
    parts.push('Report every problem, or <ok/>.');
    return parts.join('\n\n');
}

/** @returns {{kind: 'lost'|'unsupported'|'wrong'|'twice', section: string, text: string}[] | null} null when the reply has nothing readable */
export function parseCheck(reply) {
    const text = String(reply ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const out = [];
    for (const m of text.matchAll(/<(lost|unsupported|wrong|twice)(?:\s+section="([^"]*)")?\s*>([\s\S]*?)<\/\1>/gi)) {
        const t = m[3].trim();
        if (t) out.push({ kind: m[1].toLowerCase(), section: (m[2] || '').trim(), text: t });
    }
    if (!out.length && !/<ok\s*\/?>/i.test(text)) return null;
    return out;
}

const DATE_WORDS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
    'march', 'april', 'august', 'september', 'october', 'november', 'december', 'morning', 'afternoon', 'evening', 'midnight']);

/** Which section (and, inside RELATIONSHIPS, which person's entry) each line of a card belongs to. */
export function lineLabels(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const labels = new Array(lines.length).fill('');
    for (const r of sectionRanges(text)) {
        let entry = '';
        for (let i = r.start; i < r.end; i++) {
            if (r.kind === 'relationships' && i > r.start) {
                const h = headingInfo(lines[i]);
                if (h) entry = h.core;
            }
            labels[i] = r.kind === 'relationships' && entry ? `${r.title} / ${entry}` : (r.title || 'top of the card');
        }
    }
    return labels;
}

/**
 * Added lines that say much the same as another line of the card after the change.
 * @param {string} newCard the card with the proposed changes applied
 * @param {string[]} addedLines lines the change adds
 * @param {string[]} ignoreNames names that shouldn't count as shared words (the character, the player)
 * @returns {{line: string, other: string, where: string}[]}
 */
export function findRepeats(newCard, addedLines, ignoreNames = []) {
    const exclude = new Set([...DATE_WORDS, ...ignoreNames.flatMap(n => String(n).toLowerCase().split(/\s+/))]);
    const lines = String(newCard ?? '').split(/\r?\n/);
    const labels = lineLabels(newCard);
    const sigs = lines.map(l => sigWords(l, exclude));
    const out = [];
    for (const added of addedLines) {
        const a = sigWords(added, exclude);
        if (a.size < 4) continue;
        const self = lines.findIndex(l => l === added);
        let best = null;
        lines.forEach((l, i) => {
            if (i === self || !l.trim() || l.trim() === added.trim()) return;
            const b = sigs[i];
            if (b.size < 4) return;
            const shared = overlap(a, b);
            const ratio = shared / Math.min(a.size, b.size);
            if (shared >= 4 && ratio >= 0.6 && (!best || ratio > best.ratio)) best = { ratio, i };
        });
        if (best) out.push({ line: added.trim(), other: lines[best.i].trim(), where: labels[best.i] });
    }
    return out;
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
    const removed2 = diff.filter(d => d.type === 'del').map(d => d.line.trim().replace(/[.;,]$/, '')).filter(x => x.length > 20);
    const words = (t) => t.split(/\s+/).filter(Boolean).length;
    const long = added.filter((l) => {
        const base = removed2.find(r => l.includes(r));
        return words(base ? l.replace(base, '') : l) > 70;
    });
    if (long.length) warnings.push(`${long.length} added line${long.length === 1 ? ' is' : 's are'} over 70 words: "${long[0].trim().slice(0, 60)}…"`);
    return warnings;
}

// ---------------------------------------------------------------- lines that are no longer true

export function sweepSystemPrompt(userName) {
    const u = userName || 'the player character';
    return `You find the lines of a character card that are no longer true, and write the change for each. The roleplay model reads this card on every turn as the truth about the character, so a line that is no longer true makes it play the character as they were, not as they are.

You get the card with numbered lines, WHAT IS TRUE NOW (as of the newest date), the log of what happened, and the changes already planned. Go through the card section by section, line by line, from the first section to the last, including SPEECH AND VOICE, LIKES, FEARS, COPING, SMALL HABITS, LIMITS, STANDING and ORDINARY DAY. Test each line against WHAT IS TRUE NOW and the log. Look especially for:
- where they live and who with, and what they are leaving or have left;
- who they are with and on what terms, and how others now see them;
- rules and promises already broken;
- beliefs the story has disproved;
- goals finished or dropped, and lines about wanting to keep something they are leaving;
- fears of losing something they have already chosen to give up;
- habits, and ways of talking, coping or behaving, that have changed for good.
A new fact ends an old one when both can't be true at once: moving out ends wanting to keep the place; saying someone is not the one you are waiting for ends wanting them back; breaking a rule ends keeping it.

For each line that is no longer true, write the change that makes it true again, keeping every part of the line that still holds. When it is true with one person only, add a short clause to the general line ("with ${u}, since Day 7 - Friday 23 May, …") rather than rewriting the trait. Skip lines a planned change already fixes. Don't add events; that is the planned changes' job. Never change CANON POINT, the lines above the first section, or a quoted sample line.

${updateRules(u)}

WHAT TO RETURN
One block per line that is no longer true, in this form:
${CHANGE_FORMAT}
In the reason, quote the line of WHAT IS TRUE NOW or the log that the old line contradicts. If every line is still true, return only <none/>.`;
}

export function sweepUserPrompt({ card, title, sections, now, log, trackers, storyDate, ops, tokens = 0, limit = 0, days = '' }) {
    const parts = [];
    parts.push(`CHARACTER CARD: ${title} (each line starts with its number)\n<card>\n${card}\n</card>`);
    if (tokens) parts.push(sizeNote(tokens, limit));
    parts.push(`SECTIONS THE PLAYER TICKED: ${sections.join(', ')}. Changes in other sections are fine; they are reviewed by hand.`);
    parts.push(`WHAT IS TRUE NOW:\n<now>\n${(now || []).join('\n') || '(not listed; use the log)'}\n</now>`);
    parts.push(`WHAT HAPPENED TO ${title} SINCE THE CARD WAS LAST UPDATED (oldest first):\n<log>\n${log.join('\n')}\n</log>`);
    if (trackers) parts.push(`THE GAME'S TRACKER ROWS ABOUT ${title} FROM THE LATEST TURN:\n<trackers>\n${trackers}\n</trackers>`);
    if (storyDate) parts.push(`CURRENT STORY DATE: ${storyDate}`);
    if (days) parts.push(days);
    parts.push(`CHANGES ALREADY PLANNED:\n${ops.length ? ops.map(describeOp).join('\n\n') : '(none)'}`);
    parts.push(`Go through every line of the card for ${title} and return a <change> for each line that is no longer true, or <none/>.`);
    return parts.join('\n\n');
}

// ---------------------------------------------------------------- story days

const WEEKDAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

/** Every "Day N - Weekday DD Month" the chat headers name, by day number. */
export function storyDates(chat) {
    const dates = new Map();
    for (const m of Array.isArray(chat) ? chat : []) {
        const h = String(m?.mes ?? '').match(/🗓️\s*Day\s+(\d+)\s*[-–—]\s*([^|\]\n]+)/u);
        if (h && !dates.has(Number(h[1]))) dates.set(Number(h[1]), `Day ${h[1]} - ${h[2].trim()}`);
    }
    return dates;
}

const SHORT_DAY_RE = /^(\s*(?:[-*•]\s*)?)Day (\d+)(?!\d)(?!\s*[-–—]\s*\p{L})/u;

/** "- Day 7, evening: …" → "- Day 7 - Friday 23 May, evening: …" when the headers name day 7. */
export function expandLeadDate(line, dates) {
    if (!dates || !dates.size) return line;
    return String(line).replace(SHORT_DAY_RE, (m, lead, n) => (dates.has(Number(n)) ? `${lead}${dates.get(Number(n))}` : m));
}

const BROKEN_LABEL_RE = new RegExp(`Day (\\d+)\\s*[-–—]\\s*(?:${WEEKDAYS})\\s+\\d{1,2}\\s+(?:${MONTHS})(\\d+)(?=\\s*[-–—]\\s*(?:${WEEKDAYS})\\b)`, 'g');
const FULL_LABEL_RE = new RegExp(`Day (\\d+)(?!\\d)\\s*[-–—]\\s*((?:${WEEKDAYS})\\s+\\d{1,2}\\s+(?:${MONTHS}))`, 'g');

/**
 * Day labels in a line checked against the chat headers. Labels broken by 0.7.0's date bug
 * ("Day 1 - Saturday 17 May0 - Monday 26 May") are repaired; labels whose number and date disagree are listed,
 * with the header label for that date (or for that number when the headers don't have the date).
 * @returns {{line: string, repaired: boolean, mismatches: {found: string, want: string}[]}}
 */
export function checkDayLabels(line, dates) {
    const before = String(line ?? '');
    const fixed = before.replace(BROKEN_LABEL_RE, 'Day $1$2');
    const mismatches = [];
    if (dates && dates.size) {
        for (const m of fixed.matchAll(FULL_LABEL_RE)) {
            const n = Number(m[1]);
            const date = m[2].toLowerCase().replace(/\s+/g, ' ');
            const own = dates.get(n);
            if (own && own.toLowerCase().includes(date)) continue;
            let want = '';
            for (const [, full] of dates) if (full.toLowerCase().includes(` - ${date}`)) want = full;
            if (!want && own) want = own;
            if (want) mismatches.push({ found: m[0], want });
        }
    }
    return { line: fixed, repaired: fixed !== before, mismatches };
}

/**
 * Changes for lines already on the card whose day labels are broken or disagree with the chat headers.
 * A repaired label is certain; a disagreement takes the header label for the date and comes unticked.
 */
export function dayLabelOps(content, dates, ranges) {
    const lines = String(content ?? '').split(/\r?\n/);
    const editable = new Set();
    for (const r of ranges) for (let i = r.start + 1; i < r.end; i++) editable.add(i);
    const out = [];
    lines.forEach((l, i) => {
        if (!editable.has(i) || !/Day \d/.test(l)) return;
        const c = checkDayLabels(l, dates);
        let text = c.line;
        for (const mm of c.mismatches) text = text.replace(mm.found, mm.want);
        if (text === l) return;
        out.push({
            type: 'edit', line: i + 1, find: null, text, source: 'dates', dateFix: c.mismatches.length ? 'mismatch' : 'repair',
            reason: c.mismatches.length
                ? `The day label doesn't match the chat headers: ${c.mismatches.map(mm => `"${mm.found}" → "${mm.want}"`).join(', ')}.`
                : 'Repairs a day label broken by Card Updater 0.7.0.',
        });
    });
    return out;
}

const LEAD_DATE_RE = new RegExp(`^\\s*(?:[-*•]|\\d+[.)])?\\s*(?:Day\\s+(\\d+)(?:\\s*[-–—]\\s*(?:${WEEKDAYS})\\s+(\\d{1,2})\\s+(${MONTHS}))?|(?:${WEEKDAYS})\\s+(\\d{1,2})\\s+(${MONTHS}))([^:]{0,60})`);

function timeRank(s) {
    const t = String(s).toLowerCase();
    if (/after midnight|early hours|before dawn/.test(t)) return 0;
    if (/morning|breakfast|dawn/.test(t)) return 1;
    if (/midday|noon|lunch/.test(t)) return 2;
    if (/afternoon/.test(t)) return 3;
    if (/evening|dinner|dusk/.test(t)) return 4;
    if (/night|midnight/.test(t)) return 5;
    return null;
}

/** Where a dated line sits in the story: its day number (from "Day N" or a date the headers name) and time of day. */
export function dateKey(line, dates) {
    const m = String(line ?? '').match(LEAD_DATE_RE);
    if (!m) return null;
    let day = m[1] ? Number(m[1]) : null;
    if (day === null && dates && dates.size) {
        const want = `${m[4]} ${m[5]}`.toLowerCase();
        for (const [n, full] of dates) if (full.toLowerCase().includes(want)) day = n;
    }
    const monthName = m[3] || m[5];
    const dom = Number(m[2] || m[4]);
    const cal = monthName ? MONTHS.split('|').indexOf(monthName) * 31 + dom : null;
    return { day, cal, rank: timeRank(m[6] || '') };
}

/** Compares two dated lines: by day number, else by calendar date, then by time of day. 0 when it can't tell. */
function compareKeys(a, b) {
    let d = null;
    if (a.day !== null && b.day !== null) d = a.day - b.day;
    else if (a.cal !== null && b.cal !== null) d = a.cal - b.cal;
    if (d === null) return 0;
    if (d !== 0) return d;
    return a.rank !== null && b.rank !== null ? a.rank - b.rank : 0;
}

/**
 * Where a new dated line belongs in the dated list at or right after line i: the index of the line it should
 * follow. Returns i when it can't tell or i is already right.
 */
export function datedPlace(lines, i, newLine, dates) {
    const key = dateKey(newLine, dates);
    if (!key || (key.day === null && key.cal === null)) return i;
    const indent = l => l.match(/^\s*/)[0].length;
    const dated = k => k >= 0 && k < lines.length && lines[k].trim() && dateKey(lines[k], dates) !== null;
    let b0;
    if (dated(i)) b0 = i;
    else if (dated(i + 1) && indent(lines[i + 1]) >= indent(lines[i])) b0 = i + 1;
    else return i;
    const ind = indent(lines[b0]);
    while (dated(b0 - 1) && indent(lines[b0 - 1]) === ind) b0--;
    let b1 = b0;
    while (dated(b1 + 1) && indent(lines[b1 + 1]) === ind) b1++;
    let target = b0 - 1;
    for (let k = b0; k <= b1; k++) if (compareKeys(dateKey(lines[k], dates), key) <= 0) target = k;
    if (target === i) return i;
    // Only move when the anchor is plainly in the wrong place.
    if (dated(i) && compareKeys(dateKey(lines[i], dates), key) <= 0 && (i === b1 || compareKeys(dateKey(lines[i + 1], dates), key) >= 0)) return i;
    return target;
}

// ---------------------------------------------------------------- change lists

/** The card with every line numbered from 1, the way the model sees it: "57| - Now: ...". */
export function numberCard(text) {
    return String(text ?? '').split(/\r?\n/).map((l, i) => (l ? `${i + 1}| ${l}` : `${i + 1}|`)).join('\n');
}

const LINE_NO_RE = /^\s*\d{1,4}\s*\|[ \t]?/;

/** Removes line numbers the model copied from the numbered card. */
export function stripLineNumbers(text) {
    return String(text ?? '').split('\n').map(l => l.replace(LINE_NO_RE, '')).join('\n');
}

function attrs(s) {
    const out = {};
    for (const m of String(s ?? '').matchAll(/([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/]+))/gi)) out[m[1].toLowerCase()] = String(m[2] ?? m[3] ?? m[4] ?? '').trim();
    return out;
}

function num(v) {
    const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}

const TYPE_ALIASES = { edit: 'edit', change: 'edit', replace: 'edit', rewrite: 'edit', add: 'add', insert: 'add', append: 'add', remove: 'remove', delete: 'remove', cut: 'remove' };

function stripThinking(reply) {
    return String(reply ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

/**
 * Reads a list of changes from the update or fix step.
 * @returns {{ops: object[], drops: {ref: number, reason: string}[], keeps: {ref: number, reason: string}[], storyDate: string, conflicts: string[], none: boolean}}
 */
export function parseOps(reply) {
    const text = stripThinking(reply);
    const ops = [];
    for (const m of text.matchAll(/<change\b([^>]*)>([\s\S]*?)<\/change>/gi)) {
        const a = attrs(m[1]);
        let type = TYPE_ALIASES[String(a.type || '').toLowerCase()];
        if (!type) type = a.after !== undefined ? 'add' : null;
        if (!type) continue;
        const line = type === 'add' ? num(a.after ?? a.line) : num(a.line);
        if (line === null) continue;
        const body = m[2];
        const newRaw = inner(body, 'new');
        const findRaw = inner(body, 'find');
        const textNew = newRaw === null ? '' : stripLineNumbers(newRaw.replace(/^\n+|\s+$/g, ''));
        const find = findRaw === null ? null : stripLineNumbers(findRaw.trim());
        if (type === 'edit' && find === null && !textNew.trim()) type = 'remove';
        if (type === 'edit' && find !== null && !find) continue;
        if (type === 'add' && !textNew.trim()) continue;
        ops.push({ type, line, find: type === 'edit' ? find : null, text: type === 'remove' ? '' : textNew, reason: (inner(body, 'reason') || '').trim(), ref: num(a.op), stale: num(a.stale) });
    }
    const tagged = (tag) => [...text.matchAll(new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'gi'))]
        .map(m => ({ ref: num(attrs(m[1]).op), reason: ((m[2] && inner(m[2], 'reason')) ?? m[2] ?? '').trim() }))
        .filter(x => x.ref !== null);
    const storyDate = (inner(text, 'storydate') || '').trim();
    const conflicts = [...text.matchAll(/<conflict>([\s\S]*?)<\/conflict>/gi)].map(m => m[1].trim()).filter(Boolean);
    const now = (inner(text, 'now') || '').split('\n').map(l => l.trim()).filter(l => /^[-*•]\s*\S/.test(l)).map(l => `- ${l.replace(/^[-*•]\s*/, '')}`);
    return { ops, drops: tagged('drop'), keeps: tagged('keep'), now, storyDate, conflicts, none: !ops.length && /<none\s*\/?>/i.test(text) };
}

function normChars(s) {
    const out = [];
    const map = [];
    let prevSpace = false;
    for (let k = 0; k < s.length; k++) {
        let ch = s[k];
        if ('‘’ʼ′`'.includes(ch)) ch = '\'';
        else if ('“”″'.includes(ch)) ch = '"';
        else if ('—–‒−'.includes(ch)) ch = '-';
        if (/\s/.test(ch)) {
            if (prevSpace) continue;
            ch = ' ';
            prevSpace = true;
        } else prevSpace = false;
        out.push(ch.toLowerCase());
        map.push(k);
    }
    return { text: out.join(''), map };
}

/** Finds quoted words in a line, forgiving curly quotes, dashes, spacing and case. @returns {{start: number, end: number}|null} */
export function findLoose(hay, needle) {
    const h = String(hay ?? '');
    const n = String(needle ?? '');
    if (!n.trim()) return null;
    const exact = h.indexOf(n);
    if (exact !== -1) return { start: exact, end: exact + n.length };
    const H = normChars(h);
    for (const t of [normChars(n.trim()).text, normChars(n.trim()).text.replace(/[.,;:!?]+$/, '')]) {
        if (t.length < 3) continue;
        const at = H.text.indexOf(t);
        if (at !== -1) return { start: H.map[at], end: H.map[at + t.length - 1] + 1 };
    }
    return null;
}

/** "Now", "Shared history", "With her closest person" — the label before the colon, if the line has one. */
export function fieldLabel(line) {
    const m = String(line ?? '').match(/^\s*(?:[-*•]|\d+[.)])?\s*([A-Z][A-Za-z' ]{0,40}?):/);
    return m ? m[1].trim().toLowerCase() : '';
}

function similarity(a, b) {
    const x = sigWords(a);
    const y = sigWords(b);
    if (!x.size || !y.size) return 0;
    return overlap(x, y) / Math.min(x.size, y.size);
}

const BULLET_RE = /^(\s*)(?:[-*•]|\d+[.)])\s/;
const SAMPLE_LINE_RE = /^\s*(?:[-*•]\s*)?(?:\d+[.)]\s*)?(?:\([^)]{0,80}\)\s*)?["“]/;

/** Gives new bullet lines the indentation of the line they sit with when the model left it out. */
function fitIndent(newLines, ref) {
    const r = String(ref ?? '').match(BULLET_RE);
    const indent = r ? r[1] : '';
    if (!indent) return newLines;
    return newLines.map(l => (/^(?:[-*•]|\d+[.)])\s/.test(l) ? indent + l : l));
}

function tidyLine(line) {
    const lead = line.match(/^\s*/)[0];
    return lead + line.slice(lead.length).replace(/ {2,}/g, ' ').replace(/\s+([.,;])/g, '$1').replace(/\s+$/, '');
}

/** If an edit names a line it doesn't fit but plainly fits the line next to it, the line number was off by one. */
function retarget(lines, i, text) {
    const first = String(text).split('\n')[0];
    const lab = fieldLabel(first);
    const sim = k => (k >= 0 && k < lines.length && lines[k].trim() ? similarity(lines[k], text) : -1);
    const here = sim(i);
    if (lab) {
        if (fieldLabel(lines[i]) === lab) return i;
        for (const k of [i - 1, i + 1]) if (k >= 0 && k < lines.length && fieldLabel(lines[k]) === lab && sim(k) > here) return k;
    }
    if (here >= 0.3) return i;
    let best = i;
    let bestSim = here;
    for (const k of [i - 1, i + 1]) {
        const v = sim(k);
        if (v >= 0.6 && v > bestSim) {
            best = k;
            bestSim = v;
        }
    }
    return best;
}

/**
 * Places each change on the card: checks the line exists and sits in a section that may change, corrects
 * off-by-one line numbers, finds quoted words, and works out the lines the change produces.
 * @param {string} content the card
 * @param {object[]} ops from parseOps (each with an id)
 * @param {object[]} ranges the sections that may change
 * @returns {object[]} the ops with index, label, kind, oldLine, result, and invalid/outside/moved when they apply
 */
export function resolveOps(content, ops, ranges, { dates = null } = {}) {
    const lines = String(content ?? '').split(/\r?\n/);
    const labels = lineLabels(content);
    const kindAt = new Array(lines.length).fill('');
    for (const r of sectionRanges(content)) for (let i = r.start; i < r.end; i++) kindAt[i] = r.kind;
    const allowed = new Set();
    const headings = new Set();
    for (const r of ranges) {
        headings.add(r.start);
        for (let i = r.start + 1; i < r.end; i++) allowed.add(i);
    }
    const taken = new Map();
    return ops.map((op0) => {
        const op = { ...op0, invalid: '', outside: false, moved: op0.moved || null, result: [] };
        let i = op.line - 1;
        if (i < 0 || i >= lines.length) {
            op.invalid = `The card has no line ${op.line}.`;
            return op;
        }
        if (op.type === 'edit' && op.find === null) {
            const j = retarget(lines, i, op.text);
            if (j !== i) {
                op.moved = { from: op.moved?.from ?? op.line, to: j + 1 };
                i = j;
            }
        } else if (op.type === 'edit' && !findLoose(lines[i], op.find)) {
            const j = [i - 1, i + 1].find(k => k >= 0 && k < lines.length && findLoose(lines[k], op.find));
            if (j !== undefined) {
                op.moved = { from: op.moved?.from ?? op.line, to: j + 1 };
                i = j;
            }
        }
        op.index = i;
        op.line = i + 1;
        op.label = labels[i] || '';
        op.kind = kindAt[i] || '';
        op.oldLine = lines[i];
        if (op.type !== 'add' && !lines[i].trim()) {
            op.invalid = `Line ${op.line} is blank.`;
            return op;
        }
        if (op.kind === 'canon' || op.kind === 'preamble' || (!op.kind && i < (ranges[0]?.start ?? 0))) {
            op.invalid = 'CANON POINT and the lines above the first section are not changed by updates.';
            return op;
        }
        if (op.kind === 'speech' && op.type !== 'add' && SAMPLE_LINE_RE.test(lines[i])) {
            op.invalid = 'Sample lines keep the character\'s own words.';
            return op;
        }
        op.outside = op.type === 'add' ? !(allowed.has(i) || headings.has(i)) : !allowed.has(i);
        if (op.type !== 'add') {
            if (taken.has(i)) {
                op.invalid = `Change #${taken.get(i)} already changes line ${op.line}.`;
                return op;
            }
            taken.set(i, op.id);
        }
        if (op.type === 'remove') return op;
        if (op.type === 'edit' && op.find !== null) {
            const at = findLoose(lines[i], op.find);
            if (!at) {
                op.invalid = `The words to change are not in line ${op.line}: "${op.find.slice(0, 100)}"`;
                return op;
            }
            op.result = [tidyLine(lines[i].slice(0, at.start) + op.text + lines[i].slice(at.end))];
        } else if (op.type === 'edit') {
            op.result = fitIndent(op.text.split('\n'), lines[i]);
        } else {
            // A new line after "- Shared history:" belongs with the indented lines under it.
            const next = lines[i + 1];
            const ref = /:\s*$/.test(lines[i]) && next && next.match(BULLET_RE)?.[1].length > (lines[i].match(/^\s*/)[0].length) ? next : lines[i];
            op.result = fitIndent(op.text.split('\n'), ref).map(l => expandLeadDate(l, dates));
            // A dated line goes in date order.
            const place = datedPlace(lines, i, op.result[0], dates);
            if (place !== i) {
                op.reordered = { from: i + 1, to: place + 1 };
                i = place;
                op.index = i;
                op.line = i + 1;
                op.oldLine = lines[i] ?? '';
                op.label = labels[Math.max(0, i)] || op.label;
            }
            // A new relationship entry gets a blank line before its name.
            if (headingInfo(op.result[0]) && !/^\s*[-*•]/.test(op.result[0]) && lines[i] && lines[i].trim()) op.result = ['', ...op.result];
        }
        if (dates && dates.size) op.result = op.result.map(l => checkDayLabels(l, dates).line);
        if (op.type === 'edit' && op.result.join('\n') === lines[i]) op.invalid = 'It leaves the line as it is.';
        return op;
    });
}

/** The card with the given changes made. Lines are found by their place in the card as it was, so order doesn't matter. */
export function applyOps(content, ops) {
    const lines = String(content ?? '').split(/\r?\n/);
    const replace = new Map();
    const after = new Map();
    for (const op of ops) {
        if (op.invalid || !Number.isInteger(op.index)) continue;
        if (op.type === 'add') {
            if (!after.has(op.index)) after.set(op.index, []);
            after.get(op.index).push(...op.result);
        } else if (!replace.has(op.index)) {
            replace.set(op.index, op.type === 'remove' ? [] : op.result);
        }
    }
    const out = [];
    lines.forEach((l, i) => {
        out.push(...(replace.has(i) ? replace.get(i) : [l]));
        if (after.has(i)) out.push(...after.get(i));
    });
    return out.join('\n');
}

/** One change as the check and fix steps see it. */
export function describeOp(op) {
    const where = op.label ? ` (${op.label})` : '';
    const head = op.type === 'add' ? `#${op.id} ADD after line ${op.line}${where}`
        : op.type === 'remove' ? `#${op.id} REMOVE line ${op.line}${where}` : `#${op.id} CHANGE line ${op.line}${where}`;
    const out = [head];
    if (op.type === 'add') out.push(`AFTER: ${String(op.oldLine ?? '').trim()}`);
    else out.push(`OLD: ${String(op.oldLine ?? '').trim()}`);
    if (op.type === 'edit' && op.find !== null && op.find !== undefined) {
        out.push(`REPLACES THE WORDS: "${op.find}"`, `WITH: "${op.text}"`, `NEW LINE: ${(op.result || []).map(l => l.trim()).join('\n')}`);
    } else if (op.type !== 'remove') out.push(`NEW: ${(op.result || []).map(l => l.trim()).join('\n')}`);
    if (op.reason) out.push(`REASON: ${op.reason}`);
    return out.join('\n');
}

// ---------------------------------------------------------------- the log, cleaned for the update

const DAY_START = /(?:Day\s+\d|undated|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Lasting)/;

/**
 * Log lines as the update step gets them: lines the model ran together are split, clock times after the date are
 * dropped (the date is enough, and the update copied them), and exact repeats are left out.
 */
export function normalizeLogLines(lines, dates = null) {
    const split = [];
    for (const raw of lines || []) {
        const parts = String(raw).split(new RegExp(`(?<=[.!?")\\]])\\s*-\\s+(?=${DAY_START.source})`));
        parts.forEach((p, k) => split.push(k === 0 ? p : `- ${p}`));
    }
    const seen = new Set();
    const out = [];
    for (const raw of split) {
        let l = String(raw).trim();
        if (!l) continue;
        if (!l.startsWith('- ')) l = `- ${l.replace(/^[-*•]\s*/, '')}`;
        // "- Day 7, ~3:42 PM: x" → "- Day 7: x"; "- Day 7 - Friday 23 May, 3:12 PM: x" → "- Day 7 - Friday 23 May: x"
        l = l.replace(/^- ([^:\n]*?),?\s*(?:at\s+)?~?\s*(?:\d{1,2}:\d{2}\s*(?:[AaPp]\.?[Mm]\.?)?|\d{1,2}\s*[AaPp]\.?[Mm]\.?)\s*:/, (m, date) => (date.trim() ? `- ${date.trim()}:` : '- undated:'));
        l = expandLeadDate(l, dates);
        const key = l.replace(/^- [^:]*:\s*/, '').toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
    }
    return out;
}

// ---------------------------------------------------------------- checking a list of changes

export const KIND_WORD = { lost: 'LOST', unsupported: 'UNSUPPORTED', wrong: 'WRONG', twice: 'TWICE', passing: 'PASSING', placement: 'COULD NOT BE PLACED', rule: 'BREAKS A RULE' };
const KIND_ALIASES = { lost: 'lost', missing: 'lost', dropped: 'lost', unsupported: 'unsupported', invented: 'unsupported', added: 'unsupported', inferred: 'unsupported', wrong: 'wrong', contradiction: 'wrong', contradicts: 'wrong', twice: 'twice', repeat: 'twice', repeats: 'twice', duplicate: 'twice', passing: 'passing', temporary: 'passing' };

export function opsCheckSystemPrompt(userName, { stale = true } = {}) {
    const u = userName || 'the player character';
    return `You check proposed changes to a character card for a long-running roleplay. You don't write changes; you only report problems. You get the card with numbered lines, the log of what happened that the changes were written from (and the game's tracker rows, if any), and the list of changes.

Compare each change with the log and with the rest of the card:
- LOST: an edit or removal drops a fact from the old line while the log doesn't show that fact stopped being true, and the card doesn't state it anywhere else. A want, like or piece of knowledge replaced by a newer one is lost unless the log shows the old one ended.
- UNSUPPORTED: the new text states something neither the log, the tracker rows nor the card says: a cause, reason, motive, feeling or detail that was added (why someone came, what they had just done, that something was unannounced or early). Also any detail of how ${u} looks or what they wear or carry.
- WRONG: the new text contradicts the log or another line of the card: who did what to whom, which act, the order of events, a date, who was there, a name mixed up, or a fact the card states differently elsewhere. Read each change's whole new line (NEW or NEW LINE), not only the replaced words: a clause the change left in place that the log shows is no longer true is WRONG. Two changes that state facts that disagree with each other (one says she left her key behind, another that he set her key on the counter) are WRONG: report it on each of them, saying which the log supports. Also wrong: a line that now says two things that can't both be true (an old part the new fact ends: moving out ends wanting to keep the place; "not the one I'm waiting for" ends wanting someone back; breaking a rule ends keeping it); a secret marked as told or found out when the log shows only something like it happening (crying in front of someone does not tell them about an earlier time she cried); a change to who a secret is hidden from that the person's own Hides line contradicts; something this character told someone written as what they know.
- TWICE: the new text repeats something the card already says on another line, the same fact told the same way (give that line's number), or another change already adds it. Anything involving ${u} belongs only in the entry for ${u} under RELATIONSHIPS, never in HISTORY or KNOWLEDGE. Not a repeat: the same event in two people's entries when each says what it meant between those two, or a SECRETS line and a Hides line naming the same secret.
- PASSING: the new text writes a passing state into the card: a mood, where someone is right now, what they are doing that day.
${stale ? `
Then read every line of the card, in every section, against the log and list the lines the log shows are no longer true and that none of the changes fix: where they live and with whom, what they are leaving, a rule already broken, a belief the story disproved, a goal finished or dropped, wanting to keep something they are leaving, a fear of losing what they already gave up, a trait or habit they have now acted against for good. Only lines the log clearly contradicts.
` : ''}
Quote words exactly. One tag per problem:
<problem change="3" kind="lost">the words, then -> what is wrong</problem>${stale ? `
<stale line="19">the words that are no longer true -> what the log shows now, with the date</stale>` : ''}
kind is one of: lost, unsupported, wrong, twice, passing.
If there are no problems${stale ? ' and no stale lines' : ''}, reply with exactly: <ok/>`;
}

export function opsCheckUserPrompt({ card, title, ops, log, trackers = '', only = null }) {
    const ids = only ? only.map(o => `#${o.id}`) : [];
    return [
        `CHARACTER CARD AS IT IS NOW: ${title} (each line starts with its number)\n<card>\n${card}\n</card>`,
        `WHAT HAPPENED (the log the changes were written from, oldest first):\n<log>\n${(log || []).join('\n')}\n</log>`,
        ...(trackers ? [`THE GAME'S TRACKER ROWS ABOUT ${title} FROM THE LATEST TURN:\n<trackers>\n${trackers}\n</trackers>`] : []),
        `PROPOSED CHANGES:\n${ops.map(describeOp).join('\n\n')}`,
        only ? `Check only ${ids.length === 1 ? `change ${ids[0]}` : `changes ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`}; the others are listed so you can see what else the card gets. Report every problem in ${ids.length === 1 ? 'it' : 'them'}, or <ok/>.` : 'Report every problem, or <ok/>.',
    ].join('\n\n');
}

/** @returns {{problems: {id: number|null, kind: string, text: string}[], stale: {line: number, text: string}[]} | null} null when the reply has nothing readable */
export function parseOpsCheck(reply) {
    const text = stripThinking(reply);
    const problems = [];
    const stale = [];
    for (const m of text.matchAll(/<problem\b([^>]*)>([\s\S]*?)<\/problem>/gi)) {
        const a = attrs(m[1]);
        const t = m[2].trim();
        if (!t) continue;
        problems.push({ id: num(a.change ?? a.op ?? a.id), kind: KIND_ALIASES[String(a.kind || '').toLowerCase()] || 'wrong', text: t });
    }
    for (const m of text.matchAll(/<stale\b([^>]*)>([\s\S]*?)<\/stale>/gi)) {
        const line = num(attrs(m[1]).line);
        const t = m[2].trim();
        if (line !== null && t) stale.push({ line, text: t });
    }
    if (!problems.length && !stale.length && !/<ok\s*\/?>/i.test(text)) return null;
    return { problems, stale };
}

// ---------------------------------------------------------------- warnings for one change

const CLOCK_RE = /~?\s?\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:[AaPp]\.[Mm]\.|[AaPp][Mm]\b))?(?!\d)|\b(?:1[0-2]|0?[1-9])\s*(?:[AaPp]\.[Mm]\.|[AaPp][Mm]\b)/g;

/** Clock times outside quoted speech. */
export function clockTimes(text) {
    const found = new Set();
    for (const line of String(text ?? '').split('\n')) {
        const unquoted = line.replace(/"[^"]*"|“[^”]*”/g, ' ');
        for (const m of unquoted.matchAll(CLOCK_RE)) found.add(m[0].replace(/^~?\s?/, '').trim());
    }
    return [...found];
}

const TERM_STOP = new Set(['the', 'she', 'he', 'they', 'her', 'his', 'hers', 'him', 'it', 'its', 'a', 'an', 'and', 'but', 'since', 'after', 'before', 'when', 'then', 'now', 'wants', 'hides', 'speech', 'knows', 'shared', 'history', 'does', 'not', 'that', 'this', 'there', 'what', 'who', 'with', 'in', 'on', 'at', 'for', 'from', 'of', 'to', 'as', 'by', 'i', 'if', 'or', 'so', 'yes', 'no', 'believes', 'suspects', 'learned', 'told', 'day', 'as it grows', 'underneath', 'holds', 'until', 'only', 'once', 'all', 'both', 'one', 'some', 'each', 'every', 'how', 'why', 'where', 'you', 'we', 'my', 'me', 'our', 'your', 'okay', 'yeah']);

/** Names and numbers an edited line had that its new text no longer has. */
export function droppedTerms(oldLine, newText) {
    const terms = [];
    const seen = new Set();
    for (const m of String(oldLine ?? '').matchAll(/\b\p{Lu}[\p{L}'’-]*|\b\d+(?:[.,:]\d+)?\b/gu)) {
        const t = m[0].replace(/['’]s$/, '');
        if (t.length < 2 && !/\d/.test(t)) continue;
        if (TERM_STOP.has(t.toLowerCase()) || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
        if (!re.test(String(newText ?? ''))) terms.push(t);
    }
    return terms;
}

const words = t => String(t ?? '').split(/\s+/).filter(Boolean).length;

/**
 * What an edit takes out of its line: the removed stretches whose words don't come back anywhere in the new text.
 * @returns {{words: number, phrases: string[]}}
 */
export function cutPhrases(oldLine, newText) {
    const norm = w => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/, '');
    const left = new Map();
    for (const w of String(newText ?? '').split(/\s+/)) {
        const k = norm(w);
        if (k) left.set(k, (left.get(k) || 0) + 1);
    }
    for (const p of wordDiff(oldLine, newText)) {
        if (p.type !== 'same') continue;
        for (const w of p.text.split(/\s+/)) {
            const k = norm(w);
            if (k && left.get(k)) left.set(k, left.get(k) - 1);
        }
    }
    let count = 0;
    const phrases = [];
    for (const p of wordDiff(oldLine, newText)) {
        if (p.type !== 'del') continue;
        const gone = p.text.split(/\s+/).filter((w) => {
            const k = norm(w);
            if (!k) return false;
            if (left.get(k)) {
                left.set(k, left.get(k) - 1);
                return false;
            }
            return true;
        });
        if (gone.length) {
            count += gone.length;
            phrases.push(p.text.trim());
        }
    }
    return { words: count, phrases };
}

/** The sentence of a line that shares the most words with another text, for showing where a repeat is. */
function closestSentence(line, text) {
    const target = sigWords(text);
    let best = '';
    let bestN = -1;
    for (const s of String(line).split(/(?<=[.!?;])\s+/)) {
        const n = overlap(sigWords(s), target);
        if (n > bestN) {
            best = s;
            bestN = n;
        }
    }
    return best.trim();
}

/**
 * New lines of a change that say much the same as another line of the card (after the ticked changes).
 * Similarity the old line already had is not counted: that repeat was there before.
 * @returns {{where: string, excerpt: string}[]}
 */
export function opRepeats(op, cardAfter, ignoreNames = []) {
    if (op.type === 'remove' || op.invalid) return [];
    const exclude = new Set([...DATE_WORDS, ...ignoreNames.flatMap(n => String(n).toLowerCase().split(/\s+/))]);
    const lines = String(cardAfter ?? '').split(/\r?\n/);
    const labels = lineLabels(cardAfter);
    const sigs = lines.map(l => sigWords(l, exclude));
    const own = new Set(op.result.map(l => l.trim()));
    const oldSig = op.type === 'edit' ? sigWords(op.oldLine, exclude) : new Set();
    const out = [];
    for (const added of op.result) {
        const a = sigWords(added, exclude);
        if (a.size < 4) continue;
        let best = null;
        lines.forEach((l, i) => {
            if (!l.trim() || own.has(l.trim())) return;
            const b = sigs[i];
            if (b.size < 4) return;
            const shared = overlap(a, b);
            const ratio = shared / Math.min(a.size, b.size);
            if (shared < 4 || ratio < 0.6) return;
            if (oldSig.size && overlap(oldSig, b) / Math.min(oldSig.size, b.size) >= 0.6) return;
            if (!best || ratio > best.ratio) best = { ratio, i };
        });
        if (best) out.push({ where: labels[best.i], excerpt: closestSentence(lines[best.i], added) });
    }
    return out;
}

/**
 * Warnings for one change, and whether it should come unticked.
 * @param {object} op a resolved op
 * @param {{personaNames?: string[]}} opts
 * @returns {{warnings: string[], untick: boolean}}
 */
export function opWarnings(op, { personaNames = [], dates = null } = {}) {
    const warnings = [];
    const problems = []; // rule breaks: sent to the fix step, and unticked if they are still there
    let untick = false;
    const problem = (t) => {
        warnings.push(t);
        problems.push(t);
    };
    if (op.invalid) return { warnings: [op.invalid], problems: [], untick: true };
    if (op.moved) warnings.push(`The model said line ${op.moved.from}; it fits line ${op.moved.to}, so it was moved there.`);
    if (op.reordered) warnings.push(`Put in date order: after line ${op.reordered.to} (the model said after line ${op.reordered.from}).`);
    if (op.source === 'dates') {
        if (op.dateFix === 'mismatch') {
            warnings.push('Check which is right, the day number or the date; this takes the date.');
            untick = true;
        }
        return { warnings, problems, untick };
    }
    if (op.outside) {
        warnings.push(`${String(op.label || 'This section').split(' / ')[0]} isn't one of the sections you ticked: check before accepting.`);
        untick = true;
    }
    if (op.kind === 'personality' && op.type !== 'remove') {
        warnings.push('Personality change: check the reason before accepting.');
        untick = true;
    }
    if (op.type === 'remove') return { warnings, problems, untick };
    const newText = op.result.join('\n');
    const oldText = op.type === 'edit' ? op.oldLine : '';
    const who = (op.kind === 'history' || op.kind === 'knowledge') && !mentionsAny(oldText, personaNames) ? personaNames.find(n => mentionsAny(newText, [n])) : null;
    if (who) problem(`Mentions ${who} in ${op.kind === 'history' ? 'HISTORY' : 'KNOWLEDGE'}; anything involving ${who} belongs in their entry under RELATIONSHIPS.`);
    const oldClock = new Set(clockTimes(oldText));
    const clock = clockTimes(newText).filter(t => !oldClock.has(t));
    if (clock.length) problem(`Clock time: ${clock.join(', ')}. The date is enough.`);
    const oldRel = new Set(relativeTimeWords(oldText));
    const rel = relativeTimeWords(newText).filter(t => !oldRel.has(t));
    if (rel.length) problem(`Counts from a day: ${rel.join(', ')}. Use the named date instead.`);
    const check = newText.match(/\[check:([^\]]*)\]/i);
    if (check && !/\[check:/i.test(oldText)) problem(`Unsure who did it, check before saving: "${check[1].trim()}"`);
    const oldBad = new Set(checkDayLabels(oldText, dates).mismatches.map(m => m.found));
    for (const mm of checkDayLabels(newText, dates).mismatches) {
        if (!oldBad.has(mm.found)) problem(`"${mm.found}" doesn't match the chat headers, which have "${mm.want}".`);
    }
    if (op.type === 'edit') {
        const cut = cutPhrases(oldText, newText);
        const gone = droppedTerms(oldText, newText);
        if (cut.words >= 4) {
            const shown = cut.phrases.map(x => `"${x.length > 120 ? `${x.slice(0, 120)}…` : x}"`).slice(0, 3).join(', ');
            warnings.push(`Cuts from the line: ${shown}${cut.phrases.length > 3 ? ' …' : ''}`);
        } else if (gone.length) warnings.push(`No longer says: ${gone.slice(0, 8).join(', ')}${gone.length > 8 ? '…' : ''}`);
    }
    const chain = t => (String(t).match(/\bsince\b|\bDay \d+\b/g) || []).length;
    if (['now', 'wants'].includes(fieldLabel(op.result[0] || '')) && chain(newText) >= 3 && chain(newText) > chain(oldText)) {
        problem('Reads as a chain of dates. Now and Wants say how things stand today; the dated story goes in Shared history.');
    }
    const nw = words(newText);
    const ow = words(oldText);
    if (op.type === 'add' && nw > 50 && !headingInfo(op.result.find(l => l.trim()) || '')) problem(`The new line is ${nw} words long.`);
    if (op.type === 'edit' && ((nw > 70 && ow <= 70) || nw - ow > 40)) problem(`The line grows from ${ow} to ${nw} words.`);
    return { warnings, problems, untick: untick || problems.length > 0 };
}

/** Word-level diff. @returns {{type: 'same'|'add'|'del', text: string}[]} */
export function wordDiff(oldText, newText) {
    const a = String(oldText ?? '').split(/(\s+)/).filter(Boolean);
    const b = String(newText ?? '').split(/(\s+)/).filter(Boolean);
    const n = a.length;
    const m = b.length;
    if (n * m > 2_000_000) return [{ type: 'del', text: oldText }, { type: 'add', text: newText }];
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const out = [];
    const push = (type, text) => {
        const last = out[out.length - 1];
        if (last && last.type === type) last.text += text;
        else out.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            push('same', a[i]);
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', a[i++]);
        else push('add', b[j++]);
    }
    while (i < n) push('del', a[i++]);
    while (j < m) push('add', b[j++]);
    // A space between two changed words belongs to the change, so "him at all" reads as one struck phrase.
    const merged = [];
    out.forEach((p, k) => {
        if (p.type === 'same' && !p.text.trim() && k > 0 && k < out.length - 1 && out[k - 1].type !== 'same' && out[k + 1].type !== 'same') {
            merged.push({ type: 'del', text: p.text }, { type: 'add', text: p.text });
        } else merged.push({ ...p });
    });
    // Old words first, then new words, for each changed stretch.
    const result = [];
    let dels = '';
    let adds = '';
    const flush = () => {
        if (dels) result.push({ type: 'del', text: dels });
        if (adds) result.push({ type: 'add', text: adds });
        dels = '';
        adds = '';
    };
    for (const p of merged) {
        if (p.type === 'same') {
            flush();
            result.push(p);
        } else if (p.type === 'del') dels += p.text;
        else adds += p.text;
    }
    flush();
    return result;
}
