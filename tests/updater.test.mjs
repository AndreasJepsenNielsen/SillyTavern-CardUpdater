import assert from 'node:assert/strict';
import test from 'node:test';
import * as U from '../updater.js';
import { completionsUrl, isLocalUrl, readStream } from '../connection.js';

const CARD = `# RUE BENNETT — *Lead*

CANON POINT
Portrayed at Season 2, Episode 3. Nothing after this has happened.

IDENTITY
17. Lives with her mother Leslie and sister Gia.

PERSONALITY
1. Alone: lies on the floor with the TV on.
9. Crossed: goes cold, says the cruellest true thing, then leaves.

SPEECH AND VOICE
Calm, dry, reasonable even when lying.
(Teased) "Okay, wow. Rude."

HISTORY
Age 13: her dad dies.
Saturday 13 October 2018: Laurie gives her the suitcase.

RELATIONSHIPS

JULES VAUGHN (girlfriend)
- Wants: for Jules to stay.
- Speech: quieter, more questions.

HER DAD
Died when she was 13. She still wears his hoodie.

LEON KENNEDY (cousin)
- Doesn't know: him at all.
- Speech: flat, sarcastic.

ADDICTION
- Prefers pills.

LIMITS
Won't sell to Gia. (At a limit) "No. Not her."`;

test('sections: ranges by heading; relationships run to the next known section', () => {
    const r = U.sectionRanges(CARD);
    assert.deepEqual(r.map(x => x.kind), ['preamble', 'canon', 'identity', 'personality', 'speech', 'history', 'relationships', 'limits']);
    const lines = CARD.split('\n');
    const rel = U.rangeBody(lines, r.find(x => x.kind === 'relationships'));
    assert.ok(rel.includes('HER DAD') && rel.includes('LEON KENNEDY') && rel.includes('ADDICTION'), 'own sections inside RELATIONSHIPS stay in its range');
    assert.ok(!rel.includes('LIMITS'));
    assert.equal(U.rangeBody(lines, r.find(x => x.kind === 'history')), 'Age 13: her dad dies.\nSaturday 13 October 2018: Laurie gives her the suitcase.');
});

test('sections: custom heading outside relationships is its own range', () => {
    const card = 'IDENTITY\nX.\n\nSPEECH AND VOICE\nFlat.\n\nFAITH AND USING\nPrays.\n\nHISTORY\nAge 5: born.';
    assert.deepEqual(U.sectionRanges(card).map(x => x.kind), ['identity', 'speech', 'custom', 'history']);
});

test('updatable ranges skip speech, limits and the preamble', () => {
    const kinds = U.updatableRanges(CARD).map(r => r.kind);
    assert.deepEqual(kinds, ['identity', 'personality', 'history', 'relationships']);
    assert.deepEqual(U.updatableRanges(CARD, new Set(['history'])).map(r => r.kind), ['history']);
});

test('applying replacements changes only those sections, byte for byte elsewhere', () => {
    const ranges = U.sectionRanges(CARD);
    const hist = ranges.find(x => x.kind === 'history');
    const ident = ranges.find(x => x.kind === 'identity');
    const out = U.applyReplacements(CARD, [
        { start: hist.start, end: hist.end, body: 'Age 13: her dad dies.\nSaturday 13 October 2018: Laurie gives her the suitcase.\nDay 3 - Monday 14 October: meets Leon at the Marlowe.' },
        { start: ident.start, end: ident.end, body: '17. Lives with Lexi Howard since Day 2 - Sunday 13 October.\n\n' },
    ]);
    assert.ok(out.includes('HISTORY\nAge 13: her dad dies.\nSaturday 13 October 2018: Laurie gives her the suitcase.\nDay 3 - Monday 14 October: meets Leon at the Marlowe.\n\nRELATIONSHIPS'));
    assert.ok(out.includes('IDENTITY\n17. Lives with Lexi Howard since Day 2 - Sunday 13 October.\n\nPERSONALITY'));
    // everything else unchanged
    const strip = (t) => t.replace(/IDENTITY\n[^\n]*\n/, '').replace(/HISTORY\n[\s\S]*?\n\nRELATIONSHIPS/, 'HISTORY\n\nRELATIONSHIPS');
    assert.equal(strip(out), strip(CARD));
});

test('replacing the last section adds no trailing blank lines', () => {
    const r = U.sectionRanges(CARD).find(x => x.kind === 'limits');
    const out = U.applyReplacements(CARD, [{ start: r.start, end: r.end, body: 'Won\'t sell to Gia.' }]);
    assert.ok(out.endsWith('LIMITS\nWon\'t sell to Gia.'));
});

test('canon point gets the update date, and replaces an older one', () => {
    const once = U.canonPointBody('Portrayed at Season 2, Episode 3. Nothing after this has happened.', 'Day 3 - Monday 14 October');
    assert.equal(once, 'Portrayed at Season 2, Episode 3, updated with the story up to Day 3 - Monday 14 October. Nothing after this has happened.');
    const twice = U.canonPointBody(once, 'Day 9 - Sunday 20 October');
    assert.equal(twice, 'Portrayed at Season 2, Episode 3, updated with the story up to Day 9 - Sunday 20 October. Nothing after this has happened.');
});

test('reply parsing: updates, storydate, none, thinking stripped', () => {
    const reply = `<think>let me think <update><heading>X</heading><text>no</text></update></think>
<update>
<heading>**HISTORY**</heading>
<reason>She met Leon at the Marlowe.</reason>
<text>
Age 13: her dad dies.
Day 3 - Monday 14 October: meets Leon.
</text>
</update>
<storydate>Day 3 - Monday 14 October</storydate>`;
    const p = U.parseReply(reply);
    assert.equal(p.updates.length, 1);
    assert.equal(p.updates[0].heading, 'HISTORY');
    assert.equal(p.updates[0].text, 'Age 13: her dad dies.\nDay 3 - Monday 14 October: meets Leon.');
    assert.equal(p.storyDate, 'Day 3 - Monday 14 October');
    assert.equal(U.parseReply('<none/>\n<storydate>Day 1</storydate>').none, true);
});

test('matching a heading to a section: exact title, then kind', () => {
    const ranges = U.updatableRanges('WHAT SHE LIKES AND WANTS\nx\nSPEECH AND VOICE\ny\nHISTORY OF RUE\nz\nRELATIONSHIPS\nJULES\n- Wants: a', new Set(['history', 'relationships']));
    assert.equal(U.matchRange(ranges, 'HISTORY OF RUE').kind, 'history');
    assert.equal(U.matchRange(ranges, 'History').kind, 'history');
    assert.equal(U.matchRange(ranges, 'Relationships').kind, 'relationships');
    assert.equal(U.matchRange(ranges, 'PERSONALITY'), null);
});

test('checks: removed history lines, dropped entries, words counting from a day, personality', () => {
    const w1 = U.checkUpdate('history', 'Age 13: dad dies.\nAge 16: overdoses.', 'Age 13: dad dies.\nYesterday she met Leon.');
    assert.ok(w1.some(w => w.includes('Removes or rewrites 1 existing history line')));
    assert.ok(w1.some(w => w.includes('yesterday')));
    const w2 = U.checkUpdate('relationships', 'JULES VAUGHN (girlfriend)\n- Wants: x\n\nHER DAD\nDied.', 'JULES VAUGHN (girlfriend)\n- Wants: y');
    assert.ok(w2.some(w => w.includes('Drops "HER DAD"')));
    const w3 = U.checkUpdate('history', 'a', 'a\nClean since Day 3 - Monday. Says "I\'ll do it tomorrow" to Ali.');
    assert.equal(w3.length, 0, 'quoted speech and named dates are fine');
    assert.ok(U.checkUpdate('personality', 'a', 'b').some(w => w.startsWith('Personality change')));
    assert.deepEqual(U.relativeTimeWords('Four days clean. Moved in three days ago.').sort(), ['four days clean', 'three days ago']);
});

test('diff marks added and removed lines', () => {
    const d = U.lineDiff('a\nb\nc', 'a\nc\nd');
    assert.deepEqual(d.map(x => x.type + x.line), ['samea', 'delb', 'samec', 'addd']);
});

const STATE = (who) => `<!-- GFX_START --><internal_states><details><summary>📓 GM NOTEBOOK</summary>\n1. [R] Rue knows Leon paints.\n2. [T] Nate meets Cal at 8 PM.\n</details><details><summary>💞 BONDS</summary>\n- <b>Rue</b> | BOND 3\n</details>\n- Physics: ${who}\n</internal_states><!-- GFX_END -->`;

const CHAT = [
    { is_user: false, is_system: true, name: 'Narrator', mes: 'Day 1: Rue meets Leon at the gallery.', extra: { sc_ghosted: true } }, // 0 summarised
    { is_user: true, mes: 'I look at the painting.' }, // 1 summarised (user, not hidden)
    { is_user: false, is_system: true, name: 'Narrator', mes: 'Nate drives to Cal\'s.', extra: { sc_ghosted: true } }, // 2 summarised
    { is_user: false, name: 'Narrator', mes: `[ 🕰️ 9:00 AM | 🗓️ Day 3 - Monday 14 October | 📍 Lexi's ]\nShe wakes on the couch.${STATE('Rue on the couch, Lexi in the kitchen')}` }, // 3: Rue only in Physics
    { is_user: true, mes: 'I text her: "Coffee?"' }, // 4: user right after a Rue reply
    { is_user: false, name: 'Narrator', mes: `Across town, Nate cleans his car.${STATE('Nate in the garage')}` }, // 5
    { is_user: true, mes: 'I wait.' }, // 6
    { is_user: false, is_system: true, name: 'Narrator', mes: 'hidden note' }, // 7 user-hidden
];
const STORE = { layers: [[{ text: 'Day 1: Rue met Leon at the gallery. Nate drove to Cal.', turnRange: [0, 2] }], [{ text: 'Day 0: older events.' }]], summarizedUpTo: 2 };

test('story pieces, first run: whole summary oldest layer first, then the unsummarised chat', () => {
    const { items, end } = U.storyItems(CHAT, STORE, { userName: 'Leon Kennedy' });
    assert.equal(end, 7);
    assert.deepEqual(items.map(x => x.kind + x.from), ['summary-1', 'summary0', 'message3', 'message4', 'message5', 'message6']);
    assert.ok(items[2].text.startsWith('[#3] Narrator: [ 🕰️ 9:00 AM'));
    assert.ok(!items[2].text.includes('GM NOTEBOOK'), 'state block not in the story text');
    assert.equal(items[2].presence.trim(), '- Physics: Rue on the couch, Lexi in the kitchen');
    assert.ok(items[3].text.includes('[#4] Leon Kennedy: I text her'));
});

test('story pieces, later run: only after the log ends; summarised messages read raw', () => {
    const { items } = U.storyItems(CHAT, STORE, { userName: 'Leon', since: 1 });
    assert.deepEqual(items.map(x => x.kind + x.from), ['message2', 'message3', 'message4', 'message5', 'message6'], 'ghosted message 2 is read, the user-hidden note is not');
    const fromStart = U.storyItems(CHAT, STORE, { userName: 'Leon', since: -1 }).items;
    assert.equal(fromStart[0].kind, 'summary', 'a dated snippet starting after the log end is used');
    assert.equal(fromStart[1].from, 3);
});

test('filter: names in text or Physics row, plus the player\'s messages next to a kept reply', () => {
    const { items } = U.storyItems(CHAT, STORE, { userName: 'Leon' });
    const rue = U.filterForCharacter(items, ['Rue', 'Rue Bennett']).map(x => x.kind + x.from);
    assert.deepEqual(rue, ['summary0', 'message3', 'message4']);
    const nate = U.filterForCharacter(items, ['Nate']).map(x => x.kind + x.from);
    assert.deepEqual(nate, ['summary0', 'message5', 'message4', 'message6'].sort((a, b) => items.findIndex(x => x.kind + x.from === a) - items.findIndex(x => x.kind + x.from === b)));
});

test('chunks stay under the size and remember the last message they cover', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ kind: 'message', from: i, to: i, text: 'x'.repeat(1000) }));
    const chunks = U.chunkItems(items, 2500);
    assert.equal(chunks.length, 5);
    assert.equal(chunks[4].to, 9);
    assert.ok(chunks.every(c => c.text.length <= 2500));
});

test('tracker rows about the character, with their section', () => {
    const t = U.trackerLines(CHAT, ['Rue']);
    assert.ok(t.includes('📓 GM NOTEBOOK: 1. [R] Rue knows Leon paints.'));
    assert.ok(t.includes('💞 BONDS: - Rue | BOND 3'));
    assert.ok(!t.includes('Nate meets Cal'));
});

test('log replies: lines kept, NONE is empty, thinking stripped', () => {
    assert.deepEqual(U.parseLog('<think>- not this</think>\nHere:\n- Day 3: wakes at Lexi\'s. Present: Rue, Lexi.\n* Day 3: Leon texts her "Coffee?".\n'), ['- Day 3: wakes at Lexi\'s. Present: Rue, Lexi.', '- Day 3: Leon texts her "Coffee?".']);
    assert.deepEqual(U.parseLog('NONE'), []);
    assert.deepEqual(U.parseLog('none.'), []);
});

test('story date from the newest header, or before a given message', () => {
    assert.equal(U.storyDateFrom(CHAT), 'Day 3 - Monday 14 October');
    assert.equal(U.storyDateFrom(CHAT, 2), '');
});

test('prompts name the character and the player, list sections and log lines', () => {
    assert.ok(U.systemPrompt('Leon Kennedy').includes('their entry for Leon Kennedy under RELATIONSHIPS'));
    assert.ok(U.logSystemPrompt('Rue Bennett', 'Leon Kennedy').includes('Everything between Rue Bennett and Leon Kennedy.'));
    const up = U.userPrompt({ card: 'X', title: 'Rue Bennett', sections: ['HISTORY', 'RELATIONSHIPS'], log: ['- a', '- b'], trackers: 't', storyDate: 'Day 3' });
    assert.ok(up.includes('SECTIONS YOU MAY UPDATE: HISTORY, RELATIONSHIPS'));
    assert.ok(up.includes('<log>\n- a\n- b\n</log>'));
    assert.ok(up.includes('CURRENT STORY DATE: Day 3'));
    const lp = U.logUserPrompt({ name: 'Rue Bennett', names: ['Rue', 'R.B.'], text: 'story', lastDate: 'Day 2' });
    assert.ok(lp.includes('also written as: Rue, R.B.') && lp.includes('Day 2') && lp.includes('<story_part>\nstory\n</story_part>'));
});

test('connection: URLs and local detection', () => {
    assert.equal(completionsUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(completionsUrl('https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(completionsUrl('http://localhost:1234/'), 'http://localhost:1234/v1/chat/completions');
    assert.ok(isLocalUrl('http://192.168.1.20:5001/v1'));
    assert.ok(!isLocalUrl('https://openrouter.ai/api/v1'));
});

test('connection: streamed reply keeps content, counts reasoning, survives split chunks', async () => {
    const chunks = [
        'data: {"choices":[{"delta":{"reasoning":"hmm "}}]}\n',
        'data: {"choices":[{"delta":{"content":"<upd',
        'ate>"}}]}\n\ndata: {"choices":[{"delta":{"content":"ok</update>"}}]}\n',
        ': keep-alive\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: [DONE]\n',
    ];
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    let last = null;
    const out = await readStream({ body }, (p) => { last = p; });
    assert.equal(out.content, '<update>ok</update>');
    assert.equal(out.reasoningChars, 4);
    assert.equal(out.finishReason, 'stop');
    assert.equal(last.reasoningChars, 4);
});

test('connection: a reply that ran out of tokens while thinking says so', async () => {
    const { send } = await import('../connection.js');
    const enc = new TextEncoder();
    const sse = (chunks) => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    const realFetch = globalThis.fetch;
    const s = { source: 'openai', apiUrl: 'https://example.test/api/v1', apiKey: 'k', apiModel: 'm', maxTokens: 1000, temperature: 0.5 };
    try {
        globalThis.fetch = async () => ({ ok: true, body: sse(['data: {"choices":[{"delta":{"reasoning":"' + 'x'.repeat(50) + '"}}]}\n', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n']) });
        await assert.rejects(send(s, 'sys', 'user'), /used all 1000 max tokens thinking \(50 characters\)/);
        globalThis.fetch = async () => ({ ok: true, body: sse(['data: {"choices":[{"delta":{"content":"<update>half"}}]}\n', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n']) });
        await assert.rejects(send(s, 'sys', 'user'), /cut off at Max tokens/);
        globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'no' });
        await assert.rejects(send(s, 'sys', 'user'), /401 Unauthorized/);
    } finally {
        globalThis.fetch = realFetch;
    }
});
