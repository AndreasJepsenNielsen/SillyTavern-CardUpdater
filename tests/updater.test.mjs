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

test('loop guard: repeating thinking is caught, normal thinking is not', async () => {
    const { isLooping, reasoningField } = await import('../connection.js');
    const para = 'Wait, does Jules know about this? She was at the gallery, so she saw it. Let me check the next line again. ';
    assert.equal(isLooping(para.repeat(40)), true);
    const normal = Array.from({ length: 200 }, (_, i) => `Line ${i}: event number ${i * 7} happens at the party with person ${i % 13}.`).join(' ');
    assert.equal(isLooping(normal), false);
    assert.equal(isLooping('short'), false);
    assert.deepEqual(reasoningField('off'), { enabled: false });
    assert.deepEqual(reasoningField('low'), { effort: 'low' });
    assert.equal(reasoningField('default'), null);
});

test('connection: a looping stream is stopped early with the end of the thinking attached', async () => {
    const { send, ModelError } = await import('../connection.js');
    const enc = new TextEncoder();
    const para = 'Hmm, should this line go in? Let me reconsider the whole part from the top once more. ';
    let sentChunks = 0;
    const body = new ReadableStream({
        pull(c) {
            if (sentChunks++ > 2000) return c.close();
            c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { reasoning: para } }] }) + '\n'));
        },
    });
    const realFetch = globalThis.fetch;
    let sent = null;
    try {
        globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, body }; };
        const s = { source: 'openai', apiUrl: 'https://example.test/api/v1', apiModel: 'm', maxTokens: 60000, temperature: 0.8 };
        const err = await send(s, 'sys', 'user', { reasoning: 'off' }).catch(e => e);
        assert.ok(err instanceof ModelError && err.retryable, String(err));
        assert.match(err.message, /stuck repeating itself/);
        assert.ok(err.reasoningTail.includes('reconsider the whole part'));
        assert.ok(sentChunks < 400, `stopped early (${sentChunks} chunks)`);
        assert.deepEqual(sent.reasoning, { enabled: false });
        assert.equal(sent.temperature, 0.8);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('connection: a model that refuses thinking off is reported as such', async () => {
    const { send, ThinkingRequiredError } = await import('../connection.js');
    const realFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400}}' });
        const s = { source: 'openai', apiUrl: 'https://example.test/api/v1', apiModel: 'z-ai/glm-5.3-flash', maxTokens: 1000 };
        await assert.rejects(send(s, 'sys', 'user', { reasoning: 'off' }), (e) => e instanceof ThinkingRequiredError);
        await assert.rejects(send(s, 'sys', 'user', { reasoning: 'low' }), (e) => !(e instanceof ThinkingRequiredError) && /400/.test(e.message));
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('tighten: only lines added in play are marked, headings and other sections are not', () => {
    const original = 'IDENTITY\n17. Lives with her mother.\n\nHISTORY\nAge 13: her dad dies.\n\nLIMITS\nWon\'t sell to Gia.';
    const updated = 'IDENTITY\n17. Lives with her mother.\nNow sleeps on Lexi\'s couch.\n\nHISTORY\nAge 13: her dad dies.\nDay 3 - Monday 14 October: wakes at Lexi\'s.\nDay 3 - Monday 14 October: wakes on Lexi\'s couch, texts Leon.\n\nLIMITS\nWon\'t sell to Gia.\nAdded limit outside the ticked sections.';
    const ranges = U.updatableRanges(updated, new Set(['identity', 'history']));
    const m = U.markNewLines(updated, original, ranges);
    assert.equal(m.newLines, 3);
    assert.ok(m.text.includes('[new] Now sleeps on Lexi\'s couch.'));
    assert.ok(m.text.includes('\n17. Lives with her mother.\n'), 'original line unmarked');
    assert.ok(m.text.includes('\nAdded limit outside the ticked sections.'), 'sections not ticked are left unmarked');
    assert.ok(!m.text.includes('[new] HISTORY'));
    assert.equal(U.stripNewMarks('[new] a\n  [new] - b\nc'), 'a\n  - b\nc');
});

test('tighten: flags changes to lines from the original card', () => {
    const original = 'HISTORY\nAge 13: her dad dies.\nAge 16: overdoses.';
    assert.deepEqual(U.lostOriginalLines('Age 13: her dad dies.\nAge 16: overdoses.\nDay 3: x.\nDay 3: x again.', 'Age 13: her dad dies.\nAge 16: overdoses.\nDay 3: x.', original), []);
    assert.deepEqual(U.lostOriginalLines('Age 13: her dad dies.\nAge 16: overdoses.\nDay 3: x.', 'Age 13: dad dies.\nAge 16: overdoses.', original), ['Age 13: her dad dies.']);
});

test('prompts: say-it-once, keep-it-short and the size note', () => {
    const sys = U.systemPrompt('Leon');
    assert.ok(sys.includes('SAY IT ONCE') && sys.includes('KEEP IT SHORT AND PLAIN'));
    assert.ok(sys.includes('One event per line') && sys.includes('about five'));
    assert.ok(sys.includes('This wins over copying the card') && sys.includes('Leave out clock times') && sys.includes('As it grows) and change any that no longer agree'));
    assert.ok(U.tightenSystemPrompt('Leon').includes('Split a [new] line that crams several events'));
    assert.ok(U.tightenSystemPrompt('Leon').includes('Only lines marked [new]'));
    assert.match(U.sizeNote(8012, 5000), /about 8,012 tokens\. LIMIT: 5,000 tokens\. The card is already over the limit/);
    assert.match(U.sizeNote(3000, 5000), /must not take the card over the limit/);
    assert.equal(U.sizeNote(3000, 0), 'CARD SIZE: about 3,000 tokens.');
    const up = U.userPrompt({ card: 'X', title: 'Jules', sections: ['HISTORY'], log: ['- a'], tokens: 8000, limit: 5000 });
    assert.ok(up.includes('CARD SIZE: about 8,000 tokens. LIMIT: 5,000 tokens.'));
    const tp = U.tightenUserPrompt({ card: '[new] x', title: 'Jules', sections: ['HISTORY', 'RELATIONSHIPS'], tokens: 8000, limit: 5000 });
    assert.ok(tp.includes('SECTIONS YOU MAY TIGHTEN: HISTORY, RELATIONSHIPS') && tp.includes('LIMIT: 5,000'));
});

test('0.4 rules: keep order, names, contradictions, homes, explicit facts', () => {
    const sys = U.systemPrompt('Leon');
    for (const part of ['WHAT TO KEEP WHEN YOU CONDENSE', 'Never keep an answer without what it answered', 'comparisons the character draws between Leon', '[check: what is unclear]', '<conflict>', 'What they hide: SECRETS', 'Never soften, censor or drop explicit or sexual facts', 'keep conditions and qualifiers']) {
        assert.ok(sys.includes(part), part);
    }
    assert.ok(U.logSystemPrompt('Jules', 'Leon').includes('write "unclear who" rather than guessing'));
    assert.ok(U.logSystemPrompt('Jules', 'Leon').includes('Never turn one act into another'));
    assert.ok(U.logSystemPrompt('Jules', 'Leon').includes("don't list them with a note that Jules missed them"));
    assert.ok(sys.includes('never swap who watched and who acted') && sys.includes('A Speech line says how this character talks to that person'));
    assert.ok(U.tightenSystemPrompt('Leon').includes('Only lines marked [new]'));
    const withOriginal = U.tightenSystemPrompt('Leon', { original: true });
    assert.ok(withOriginal.includes('one line per period') && !withOriginal.includes('Only lines marked [new]'));
});

test('0.4 reply: conflicts are read, [check:] and very long lines are flagged', () => {
    const p = U.parseReply('<update><heading>HISTORY</heading><text>a</text></update>\n<conflict>"closest person: she has none" -> calls Leon the only thing she has, Day 6</conflict>\n<conflict> </conflict>');
    assert.deepEqual(p.conflicts, ['"closest person: she has none" -> calls Leon the only thing she has, Day 6']);
    assert.deepEqual(U.parseReply('<none/>\n<conflict>x -> y</conflict>').conflicts, ['x -> y']);
    const w = U.checkUpdate('knowledge', 'a', 'a\n- Does not know: what [check: who hurt Leon\'s face] did over four years.');
    assert.ok(w.some(x => x.includes('Unsure who did it') && x.includes("who hurt Leon's face")));
    const long = U.checkUpdate('relationships', 'a', `a\n- ${'word '.repeat(80)}`);
    assert.ok(long.some(x => x.includes('over 70 words')));
});

test('0.5: strict homes and edit-not-rewrite are in the update rules', () => {
    const sys = U.systemPrompt('Leon');
    assert.ok(sys.includes('Anything involving Leon, even when other people were there too: only in their entry for Leon'));
    assert.ok(sys.includes('HISTORY only gets life changes'));
    assert.ok(sys.includes("You don't rewrite the card. You return a short list of changes"));
});

test('0.5: check replies are read; nothing readable is null', () => {
    const r = U.parseCheck('<think>x</think><lost section="RELATIONSHIPS">the part where he doesn\'t ask her to be anything</lost>\n<unsupported section="RELATIONSHIPS">Ellis checks the counters</unsupported>\n<twice section="HISTORY">she had sex with Leon -> RELATIONSHIPS / LEON</twice>');
    assert.deepEqual(r.map(x => x.kind + ':' + x.section), ['lost:RELATIONSHIPS', 'unsupported:RELATIONSHIPS', 'twice:HISTORY']);
    assert.deepEqual(U.parseCheck('<ok/>'), []);
    assert.equal(U.parseCheck('I looked and it seems fine.'), null);
    assert.ok(U.checkSystemPrompt('Leon').includes('belongs only in their entry for Leon'));
    assert.ok(U.checkSystemPrompt('Leon', { tighten: true }).includes('now nowhere in the card'));
    const up = U.checkUserPrompt({ card: 'C', title: 'Jules', items: [{ title: 'HISTORY', oldBody: 'a', newBody: 'b' }], log: ['- x'] });
    assert.ok(up.includes('<section heading="HISTORY">\n<old>\na\n</old>\n<new>\nb\n</new>\n</section>') && up.includes('<log>\n- x\n</log>'));
});

test('0.5: repeats across sections are found, with where the other copy is', () => {
    const card = `HISTORY
- Day 7 - Friday 23 May: she had sex with Leon in her kitchen; Leon delayed Ellis at the elevator while she cleaned.

KNOWLEDGE
- Knows the desk man told Ellis about Leon shoving past the marshal.

RELATIONSHIPS

LEON (neighbor)
- Now: her lover since Day 7.
- Shared history:
  - Day 7, afternoon: they had sex in her kitchen; Leon delayed Ellis at the elevator while she cleaned up.

ELLIS
- Wants: to keep him.`;
    const reps = U.findRepeats(card, ['- Day 7 - Friday 23 May: she had sex with Leon in her kitchen; Leon delayed Ellis at the elevator while she cleaned.'], ['Jules', 'Leon']);
    assert.equal(reps.length, 1);
    assert.equal(reps[0].where, 'RELATIONSHIPS / LEON');
    assert.deepEqual(U.findRepeats(card, ['- Wants: to keep him.'], []), [], 'short lines are not compared');
    const labels = U.lineLabels(card);
    assert.equal(labels[1], 'HISTORY');
    assert.equal(labels[14], 'RELATIONSHIPS / ELLIS');
});

test('0.5: the long-line warning ignores an existing long line that only got a sentence added', () => {
    const old = '- ' + 'word '.repeat(75).trim() + '.';
    const appended = old.replace(/\.$/, '') + '. Fridays he can run late.';
    assert.deepEqual(U.checkUpdate('ordinary', old, appended).filter(w => w.includes('70 words')), []);
    assert.equal(U.checkUpdate('ordinary', 'short', '- ' + 'word '.repeat(80)).filter(w => w.includes('70 words')).length, 1);
});

// ---------------------------------------------------------------- 0.6: change lists

const JULES = `JULES VAUGHN — Lead

CANON POINT
Portrayed after the slap (Season 3, Episode 6). Nothing after this has happened.

IDENTITY
- Paid mistress of Ellis. He is her only client.
- Her terms with Ellis: paid, kept in his apartment, and exclusive to him by his rule, because he will not bring anything home to his wife.

PERSONALITY
1. Alone: paints for hours.
2. With her closest person: she has none. With Ellis she is light and agreeable.

SPEECH AND VOICE
Cool and low.

HISTORY
- Age 17: met Rue at a party.
- Early May: slept with Rue in the penthouse.

RELATIONSHIPS
ELLIS
- Wants: to keep him.

LEON (the neighbor)
- Now: eats with him at his place on a standing invitation from Monday 19 May.
- Shared history:
  - Monday 19 May: tea at his place, where she set her terms.
  - Day 6 - Thursday 22 May: the real talk.
- As it grows: a straight answer earns more.

APPEARANCE
- Hands: long, with paint in the creases.`;

test('0.6: the card is numbered from 1 and the numbers come back off', () => {
    const n = U.numberCard('a\n\n  - b');
    assert.equal(n, '1| a\n2|\n3|   - b');
    assert.equal(U.stripLineNumbers('3|   - b\n12| - c\nno number'), '  - b\n- c\nno number');
    const spans = U.sectionSpans(JULES, U.updatableRanges(JULES));
    assert.ok(spans.includes('IDENTITY (lines 6-8)') && spans.includes('HISTORY (lines 17-19)') && spans.includes('RELATIONSHIPS (lines 21-30)'), spans.join(' | '));
});

test('0.6: change lists are read: edit with and without find, add, remove, aliases, drop and keep', () => {
    const p = U.parseOps(`<think>…</think>
<change type="edit" line="25"><find>eats with him</find><new>her lover since Day 7; eats with him</new><reason>log 3</reason></change>
<change type="edit" line="12">
<new>2. With her closest person: Leon.</new>
<reason>log 4</reason>
</change>
<change type="add" after="29">
<new>  - Day 7 - Friday 23 May: first sex, in her kitchen.</new>
<reason>log 5</reason>
</change>
<change type="remove" line="19"><reason>repeats</reason></change>
<change type='insert' after=8><new>- x</new></change>
<change type="edit" line="7"><new></new><reason>gone</reason></change>
<change type="edit" line="7"><find></find><new>y</new></change>
<change type="bogus" line="7"><new>y</new></change>
<change op="3" type="edit" line="12"><new>fixed</new></change>
<drop op="4"/>
<drop op="5"><reason>not in the log</reason></drop>
<keep op="6"><reason>the log says so on Day 7</reason></keep>
<conflict>a -> b</conflict>
<storydate>Day 7 - Friday 23 May</storydate>`);
    assert.deepEqual(p.ops.map(o => `${o.type}:${o.line}`), ['edit:25', 'edit:12', 'add:29', 'remove:19', 'add:8', 'remove:7', 'edit:12']);
    assert.equal(p.ops[0].find, 'eats with him');
    assert.equal(p.ops[1].find, null);
    assert.equal(p.ops[2].text, '  - Day 7 - Friday 23 May: first sex, in her kitchen.', 'leading spaces kept');
    assert.equal(p.ops[6].ref, 3);
    assert.deepEqual(p.drops, [{ ref: 4, reason: '' }, { ref: 5, reason: 'not in the log' }]);
    assert.deepEqual(p.keeps, [{ ref: 6, reason: 'the log says so on Day 7' }]);
    assert.deepEqual(p.conflicts, ['a -> b']);
    assert.equal(p.storyDate, 'Day 7 - Friday 23 May');
    assert.equal(U.parseOps('<none/>').none, true);
    assert.equal(U.parseOps('<change type="edit" line="2"><new>12| - copied number</new></change>').ops[0].text, '- copied number');
});

test('0.6: changes are placed, applied by original line, and everything else stays byte for byte', () => {
    const ranges = U.updatableRanges(JULES);
    const raw = U.parseOps(`<change type="edit" line="26"><find>eats with him</find><new>her lover since Day 7 - Friday 23 May; eats with him</new></change>
<change type="edit" line="12"><new>2. With her closest person: Leon. With Ellis she is light and agreeable.</new></change>
<change type="add" after="29"><new>- Day 7 - Friday 23 May: first sex, in her kitchen.</new></change>
<change type="add" after="29"><new>- Day 7 - Friday 23 May: she asked him to stay.</new></change>
<change type="remove" line="18"></change>`).ops.map((o, k) => ({ ...o, id: k + 1 }));
    const ops = U.resolveOps(JULES, raw, ranges);
    assert.ok(ops.every(o => !o.invalid && !o.outside), JSON.stringify(ops.map(o => o.invalid)));
    assert.equal(ops[0].label, 'RELATIONSHIPS / LEON');
    assert.equal(ops[0].result[0], '- Now: her lover since Day 7 - Friday 23 May; eats with him at his place on a standing invitation from Monday 19 May.');
    assert.deepEqual(ops[2].result, ['  - Day 7 - Friday 23 May: first sex, in her kitchen.'], 'indented like the dated lines around it');
    const after = U.applyOps(JULES, ops);
    const a = after.split('\n');
    assert.equal(a[11], '2. With her closest person: Leon. With Ellis she is light and agreeable.');
    assert.ok(!after.includes('Age 17: met Rue'));
    assert.deepEqual(a.slice(26, 31), [
        '  - Monday 19 May: tea at his place, where she set her terms.',
        '  - Day 6 - Thursday 22 May: the real talk.',
        '  - Day 7 - Friday 23 May: first sex, in her kitchen.',
        '  - Day 7 - Friday 23 May: she asked him to stay.',
        '- As it grows: a straight answer earns more.',
    ], 'adds after the same line keep their order');
    // Only the five changes differ.
    const diff = U.lineDiff(JULES, after).filter(d => d.type !== 'same');
    assert.equal(diff.filter(d => d.type === 'del').length, 3);
    assert.equal(diff.filter(d => d.type === 'add').length, 4);
    assert.equal(U.applyOps(JULES, []), JULES);
});

test('0.6: bad line numbers, blank lines, two changes to one line, sections not ticked', () => {
    const ranges = U.updatableRanges(JULES, new Set(['history', 'relationships']));
    const raw = U.parseOps(`<change type="edit" line="400"><new>x</new></change>
<change type="edit" line="16"><new>x</new></change>
<change type="remove" line="18"></change>
<change type="edit" line="18"><new>- Age 17: met Rue.</new></change>
<change type="edit" line="7"><find>only client</find><new>main client</new></change>
<change type="edit" line="26"><find>words that are not there</find><new>x</new></change>
<change type="edit" line="33"><new>- Hands: long, with paint in the creases.</new></change>`).ops.map((o, k) => ({ ...o, id: k + 1 }));
    const ops = U.resolveOps(JULES, raw, ranges);
    assert.match(ops[0].invalid, /no line 400/);
    assert.match(ops[1].invalid, /blank/);
    assert.equal(ops[2].invalid, '');
    assert.match(ops[3].invalid, /#3 already changes line 18/);
    assert.equal(ops[4].outside, true, 'IDENTITY was not ticked');
    assert.match(ops[5].invalid, /not in line 26/);
    assert.match(ops[6].invalid, /leaves the line as it is/);
    const after = U.applyOps(JULES, ops);
    assert.ok(!after.includes('Age 17'), 'valid change applied');
    assert.ok(U.applyOps(JULES, ops.filter(o => !o.outside)).includes('only client'), 'changes outside the ticked sections are applied only when passed');
    const w = U.opWarnings(ops[4]);
    assert.ok(w.untick && w.warnings.some(x => x.includes('Outside the sections you ticked')));
});

test('0.6: an edit one line off is moved to the line it plainly fits; quoted words found loosely', () => {
    const ranges = U.updatableRanges(JULES);
    const raw = U.parseOps(`<change type="edit" line="11"><new>2. With her closest person: Leon, her lover. With Ellis she is light and agreeable.</new></change>
<change type="edit" line="25"><find>EATS with him at his place on a standing invitation from Monday 19 May</find><new>is his lover and eats with him</new></change>
<change type="edit" line="27"><find>tea at his place, where she set her terms</find><new>tea at his place, where she set her terms (company and food)</new></change>`).ops.map((o, k) => ({ ...o, id: k + 1 }));
    const ops = U.resolveOps(JULES, raw, ranges);
    assert.deepEqual(ops[0].moved, { from: 11, to: 12 });
    assert.equal(ops[0].index, 11);
    assert.deepEqual(ops[1].moved, { from: 25, to: 26 });
    assert.equal(ops[1].result[0], '- Now: is his lover and eats with him.');
    assert.deepEqual(ops[2].moved, { from: 27, to: 28 });
    assert.ok(U.opWarnings(ops[0]).warnings[0].includes('said line 11; it fits line 12'));
    assert.deepEqual(U.findLoose('She said “stay” — once.', '"stay" - once'), { start: 9, end: 22 });
    assert.equal(U.findLoose('abc', 'xyz'), null);
});

test('0.6: an edit that rewrites a short labelled line stays on its line', () => {
    const ranges = U.updatableRanges(JULES);
    const ops = U.resolveOps(JULES, [{ id: 1, type: 'edit', line: 26, find: null, text: '- Now: her lover. Eats with him at his place.' }], ranges);
    assert.equal(ops[0].moved, null);
    assert.equal(ops[0].index, 25);
    const off = U.resolveOps(JULES, [{ id: 1, type: 'edit', line: 25, find: null, text: '- Now: her lover. Eats with him at his place.' }], ranges);
    assert.deepEqual(off[0].moved, { from: 25, to: 26 }, 'the label says which line it is');
});

test('0.6: warnings: Leon outside his entry, clock times, dropped names, personality, long lines', () => {
    const ranges = U.updatableRanges(JULES);
    const raw = U.parseOps(`<change type="add" after="19"><new>- Day 7 - Friday 23 May: slept with Leon in her kitchen at 3:33 PM.</new></change>
<change type="edit" line="7"><new>- Paid mistress. He is her only client.</new></change>
<change type="edit" line="12"><new>2. With her closest person: Leon.</new></change>
<change type="add" after="29"><new>  - Day 7: ${'word '.repeat(75).trim()}.</new></change>
<change type="edit" line="26"><find>at his place</find><new>at his place ~10 PM "at 9:00 sharp"</new></change>`).ops.map((o, k) => ({ ...o, id: k + 1 }));
    const ops = U.resolveOps(JULES, raw, ranges);
    const w = ops.map(o => U.opWarnings(o, { personaNames: ['Leon'] }));
    assert.ok(w[0].untick && w[0].warnings.some(x => x.includes('Mentions Leon in HISTORY')));
    assert.ok(w[0].warnings.some(x => x.includes('Clock time: 3:33 PM')));
    assert.ok(w[1].warnings.some(x => x === 'No longer says: Ellis'), w[1].warnings.join(' | '));
    assert.ok(!w[1].untick);
    assert.ok(w[2].untick && w[2].warnings.some(x => x.includes('Personality change')));
    assert.ok(w[2].warnings.some(x => x.startsWith('Cuts from the line: "she has none. With Ellis she is light and agreeable."')), w[2].warnings.join(' | '));
    assert.ok(w[3].warnings.some(x => /new line is 7\d words long/.test(x)), w[3].warnings.join(' | '));
    assert.ok(w[4].warnings.some(x => x.includes('Clock time: 10 PM')) && !w[4].warnings.some(x => x.includes('9:00')), 'quoted times are speech');
    assert.deepEqual(U.clockTimes('at ~3:42 PM, then 11:45pm, "7:08" and 3 amazing days'), ['3:42 PM', '11:45pm']);
    assert.deepEqual(U.droppedTerms('- Knows Rue owed Laurie $10,000 on Day 5.', '- Knows Rue owed Laurie money.'), ['10,000', '5']);
});

test('0.6: repeats are reported for what a change adds, not for similarity the line already had', () => {
    const card = `HISTORY
- Day 7 - Friday 23 May: she had sex with Leon in her kitchen; Leon delayed Ellis at the elevator while she cleaned.

RELATIONSHIPS
LEON (neighbor)
- Shared history:
  - Day 7, afternoon: they had sex in her kitchen; Leon delayed Ellis at the elevator while she cleaned up.
- Now: her lover.`;
    const ranges = U.updatableRanges(card);
    const add = U.resolveOps(card, [{ id: 1, type: 'add', line: 6, find: null, text: '  - Day 7: sex in her kitchen while Leon delayed Ellis at the elevator and she cleaned the counters.' }], ranges)[0];
    const reps = U.opRepeats(add, U.applyOps(card, [add]), ['Jules', 'Leon']);
    assert.equal(reps.length, 1);
    assert.match(reps[0].where, /HISTORY|RELATIONSHIPS \/ LEON/);
    const edit = U.resolveOps(card, [{ id: 1, type: 'edit', line: 6, find: 'cleaned up', text: 'cleaned up and he left', find2: null }], ranges)[0];
    assert.deepEqual(U.opRepeats(edit, U.applyOps(card, [edit]), ['Jules', 'Leon']), [], 'the old line already matched HISTORY');
});

test('0.6: the log is cleaned for the update: clock times dropped, glued lines split, repeats left out', () => {
    const out = U.normalizeLogLines([
        '- Day 6 - Thursday 22 May, ~7:08 PM: Building fire alarm. Present: Jules, Leon.',
        '- Day 7, ~12:01 AM: Jules came in. Present: Jules, Leon.',
        '- Day 7 - Friday 23 May, 3:12 PM: she watched.',
        '- Day 6, evening: Ellis arrived.',
        '- Day 7 - Friday 23 May: Jules opened the door. Present: Jules, Ellis, Simon (on landing).- Day 7 - Friday 23 May: Jules told Leon "Ten minutes. Go." Present: Jules, Leon.',
        '- Day 7: Jules came in. Present: Jules, Leon.',
        '- undated: Jules said "meet me at 7:30" to Ellis.',
    ]);
    assert.deepEqual(out, [
        '- Day 6 - Thursday 22 May: Building fire alarm. Present: Jules, Leon.',
        '- Day 7: Jules came in. Present: Jules, Leon.',
        '- Day 7 - Friday 23 May: she watched.',
        '- Day 6, evening: Ellis arrived.',
        '- Day 7 - Friday 23 May: Jules opened the door. Present: Jules, Ellis, Simon (on landing).',
        '- Day 7 - Friday 23 May: Jules told Leon "Ten minutes. Go." Present: Jules, Leon.',
        '- undated: Jules said "meet me at 7:30" to Ellis.',
    ]);
    assert.ok(U.logSystemPrompt('Jules', 'Leon').includes('without the clock time'));
});

test('0.6: check of a change list: prompt, problems by change number, stale lines, unreadable is null', () => {
    const ranges = U.updatableRanges(JULES);
    const ops = U.resolveOps(JULES, [
        { id: 1, type: 'edit', line: 26, find: 'eats with him', text: 'her lover; eats with him' },
        { id: 2, type: 'add', line: 29, find: null, text: '  - Day 7: first sex.' },
        { id: 3, type: 'remove', line: 18, find: null, text: '' },
    ], ranges);
    const up = U.opsCheckUserPrompt({ card: U.numberCard(JULES), title: 'Jules', ops, log: ['- Day 7: x'] });
    assert.ok(up.includes('#1 CHANGE line 26 (RELATIONSHIPS / LEON)\nOLD: - Now: eats with him') && up.includes('REPLACES THE WORDS: "eats with him"\nWITH: "her lover; eats with him"'));
    assert.ok(up.includes('#2 ADD after line 29 (RELATIONSHIPS / LEON)\nAFTER: - Day 6 - Thursday 22 May: the real talk.\nNEW: - Day 7: first sex.'));
    assert.ok(up.includes('#3 REMOVE line 18 (HISTORY)\nOLD: - Age 17: met Rue at a party.'));
    assert.ok(up.includes('26| - Now: eats with him'));
    const only = U.opsCheckUserPrompt({ card: 'C', title: 'Jules', ops, log: [], only: [ops[0], ops[2]] });
    assert.ok(only.includes('Check only changes #1 and #3'));
    const sys = U.opsCheckSystemPrompt('Leon');
    assert.ok(sys.includes('<stale line=') && sys.includes('only in the entry for Leon'));
    assert.ok(!U.opsCheckSystemPrompt('Leon', { stale: false }).includes('<stale'));
    const r = U.parseOpsCheck('<problem change="2" kind="twice">first sex -> line 25 says it</problem><problem change="9" kind="Invented">x</problem><stale line="12">she has none -> Leon is now her closest person, Day 7</stale>');
    assert.deepEqual(r.problems.map(p => `${p.id}:${p.kind}`), ['2:twice', '9:unsupported']);
    assert.deepEqual(r.stale, [{ line: 12, text: 'she has none -> Leon is now her closest person, Day 7' }]);
    assert.deepEqual(U.parseOpsCheck('<ok/>'), { problems: [], stale: [] });
    assert.equal(U.parseOpsCheck('Looks fine to me.'), null);
});

test('0.6: fix prompt lists every change, what the check found and the stale lines', () => {
    const ops = U.resolveOps(JULES, [{ id: 1, type: 'edit', line: 26, find: 'eats with him', text: 'her lover; eats with him' }], U.updatableRanges(JULES));
    const up = U.fixUserPrompt({ card: 'NUMBERED', title: 'Jules', sections: ['HISTORY (lines 17-19)'], log: ['- a'], ops, problems: [{ id: 1, kind: 'unsupported', text: 'her lover -> not in the log' }], stale: [{ line: 12, label: 'PERSONALITY', text: 'she has none -> Leon' }] });
    assert.ok(up.includes('#1 UNSUPPORTED: her lover -> not in the log'));
    assert.ok(up.includes('line 12 (PERSONALITY): she has none -> Leon'));
    assert.ok(up.includes('YOUR CHANGES:\n#1 CHANGE line 26'));
    const sys = U.fixSystemPrompt('Leon');
    assert.ok(sys.includes('<drop op="3">') && sys.includes('<keep op="3">') && sys.includes('stale="19"'));
    assert.ok(sys.includes('SAY IT ONCE') && sys.includes('Line numbers always refer to the card as it is now'));
});

test('0.6: update prompt asks for a change list with find for long lines and line spans', () => {
    const sys = U.systemPrompt('Leon');
    assert.ok(sys.includes('<change type="edit" line="57">\n<find>') && sys.includes('<change type="add" after="80">') && sys.includes('<change type="remove" line="12">'));
    assert.ok(sys.includes('Use this for any line longer than about thirty words'));
    assert.ok(sys.includes('Read every line of the card against the log'));
    assert.ok(sys.includes('that something was unannounced'));
    const up = U.userPrompt({ card: '1| X', title: 'Jules', sections: ['HISTORY (lines 17-19)'], log: ['- a'] });
    assert.ok(up.includes('(each line starts with its number)') && up.includes('SECTIONS YOU MAY UPDATE: HISTORY (lines 17-19)'));
});

test('0.6: word diff keeps unchanged words and marks the rest', () => {
    const d = U.wordDiff('she has none. With Ellis', 'she has Leon. With Ellis');
    assert.deepEqual(d, [{ type: 'same', text: 'she has ' }, { type: 'del', text: 'none.' }, { type: 'add', text: 'Leon.' }, { type: 'same', text: ' With Ellis' }]);
    const e = U.wordDiff("- Doesn't know: him at all.", '- Knows: he lives next to Jules.');
    assert.deepEqual(e, [{ type: 'same', text: '- ' }, { type: 'del', text: "Doesn't know: him at all." }, { type: 'add', text: 'Knows: he lives next to Jules.' }]);
});

// ---------------------------------------------------------------- 0.6.1

test('0.6.1: secrets, Knows, angles, growing lines, the player\'s looks and short Shared history are in the rules', () => {
    const sys = U.systemPrompt('Leon');
    for (const part of [
        'A secret is out only when the log shows that exact fact told to someone or seen by them',
        'read the Hides line in that person\'s entry; change both or neither',
        'What they told someone else is an event: Shared history, or nowhere',
        'A different angle is not a repeat',
        'add the new part and keep the earlier parts that still hold',
        'Never write how Leon looks or what they wear or carry',
        'One day gets at most two new lines',
    ]) assert.ok(sys.includes(part), part);
    assert.ok(U.fixSystemPrompt('Leon').includes('A secret is out only when'), 'the fix step gets the same rules');
    const chk = U.opsCheckSystemPrompt('Leon');
    for (const part of ['crying in front of someone does not tell them', 'something this character told someone written as what they know', 'Not a repeat: the same event in two people\'s entries', 'how Leon looks or what they wear or carry', 'A want, like or piece of knowledge replaced by a newer one is lost']) assert.ok(chk.includes(part), part);
    assert.ok(U.logSystemPrompt('Jules', 'Leon').includes('How Leon looks, or what they wear or carry'));
});

test('0.6.1: words an edit cuts are named, also in a quoted-words edit', () => {
    const c = U.cutPhrases("- Wants: since Day 6, his company plus the part where he doesn't ask her to be anything.", '- Wants: since Day 7, him.');
    assert.equal(c.words, 14);
    const ranges = U.updatableRanges(JULES);
    const [op] = U.resolveOps(JULES, [{ id: 1, type: 'edit', line: 26, find: 'eats with him at his place on a standing invitation from Monday 19 May', text: 'her lover' }], ranges);
    assert.ok(U.opWarnings(op).warnings.some(w => w.startsWith('Cuts from the line: "eats with him at his place on a standing invitation from Monday 19 May')));
    assert.deepEqual(U.cutPhrases('- Now: eats with him.', '- Now: her lover; eats with him.'), { words: 0, phrases: [] }, 'adding cuts nothing');
});

test('0.6.1: the version in the window matches the manifest', async () => {
    const fs = await import('node:fs');
    const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.equal(index.match(/const VERSION = '([^']+)'/)[1], manifest.version);
});
