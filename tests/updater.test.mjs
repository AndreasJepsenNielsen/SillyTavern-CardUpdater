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
    assert.ok(!t.includes('[R] Rue knows Leon paints.'), '[R] rows naming her go to the notebook block instead');
    assert.deepEqual(U.notebookLines(CHAT, ['Rue']), ['[R] Rue knows Leon paints.']);
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
    assert.ok(w.untick && w.warnings.some(x => x === "IDENTITY isn't one of the sections you ticked: check before accepting."));
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
    assert.deepEqual(U.parseOpsCheck('<ok/>'), { problems: [], stale: [], missing: [] });
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

// ---------------------------------------------------------------- 0.7.0

const DAY9 = `JULES — Lead

CANON POINT
Portrayed after the slap.

IDENTITY
- Lives alone in Ellis's penthouse.

SPEECH AND VOICE
Cool, low and unhurried; does not shout.
Sample lines:
1. (Dry) "And yet you showed up here."

SMALL HABITS
- Smokes, outside or at a window.

GOALS
- Keep the penthouse and the time to paint.

RELATIONSHIPS
ELLIS
- Wants: to keep him, the apartment and the allowance.

LEON (the neighbor)
- Now: since Day 6 she knocks; since Day 7 her lover.
- Shared history:
  - Saturday 17 May: on the landing she worked out who he is.
  - Day 8 - Saturday 24 May, afternoon: she met Dez on the stairs.
  - Day 8 - Saturday 24 May, night: she slept at his place.
- As it grows: a straight answer earns more.

APPEARANCE
- Hands: long, with paint in the creases.`;

const DATES = new Map([[1, 'Day 1 - Saturday 17 May'], [8, 'Day 8 - Saturday 24 May'], [9, 'Day 9 - Sunday 25 May']]);

test('0.7: story days come from the chat headers; short dates are written out in full', () => {
    const d = U.storyDates([{ mes: '[ 🕰️ 9:00 AM | 🗓️ Day 1 - Saturday 17 May | 📍 x ]' }, { mes: 'no header' }, { mes: '[ 🗓️ Day 9 - Sunday 25 May ]' }, { mes: '[ 🗓️ Day 9 - Sunday 25 May ]' }]);
    assert.deepEqual([...d.entries()], [[1, 'Day 1 - Saturday 17 May'], [9, 'Day 9 - Sunday 25 May']]);
    assert.equal(U.storyDaysNote(d), 'STORY DAYS (write dates in this form): Day 1 - Saturday 17 May; Day 9 - Sunday 25 May');
    assert.equal(U.expandLeadDate('  - Day 9, evening: x', d), '  - Day 9 - Sunday 25 May, evening: x');
    assert.equal(U.expandLeadDate('- Day 9 - Sunday 25 May: x', d), '- Day 9 - Sunday 25 May: x');
    assert.equal(U.expandLeadDate('- Day 4: x', d), '- Day 4: x', 'unknown days stay');
    assert.equal(U.expandLeadDate('- She moved in on Day 9.', d), '- She moved in on Day 9.', 'only a date at the start of a line');
    assert.deepEqual(U.normalizeLogLines(['- Day 9, ~6:10 PM: she moved in.'], d), ['- Day 9 - Sunday 25 May: she moved in.']);
});

test('0.7: a new dated line goes in date order, by day, calendar date and time of day', () => {
    const lines = DAY9.split('\n');
    const at = t => lines.findIndex(l => l.includes(t));
    const night = at('night: she slept');
    const afternoon = at('afternoon: she met Dez');
    assert.equal(U.datedPlace(lines, night, '  - Day 8 - Saturday 24 May, evening: they cooked.', DATES), afternoon, 'evening goes before night');
    assert.equal(U.datedPlace(lines, night, '  - Day 9 - Sunday 25 May: she moved in.', DATES), night, 'a later day stays at the end');
    assert.equal(U.datedPlace(lines, night, '  - Sunday 18 May: pasta at her door.', DATES), at('Saturday 17 May'), 'calendar dates order lines without day numbers');
    assert.equal(U.datedPlace(lines, at('- Shared history:'), '  - Day 9 - Sunday 25 May: she moved in.', DATES), night, 'added under the label, moved to its place');
    assert.equal(U.datedPlace(lines, night, '- Wants: him.', DATES), night, 'undated lines are left where the model put them');
    const [op] = U.resolveOps(DAY9, [{ id: 1, type: 'add', line: night + 1, find: null, text: '- Day 8, evening: they cooked together.' }], U.updatableRanges(DAY9), { dates: DATES });
    assert.deepEqual(op.result, ['  - Day 8 - Saturday 24 May, evening: they cooked together.'], 'indented and written out in full');
    assert.deepEqual(op.reordered, { from: night + 1, to: afternoon + 1 });
    assert.ok(U.opWarnings(op).warnings.some(w => w.startsWith(`Put in date order: after line ${afternoon + 1}`)));
    const after = U.applyOps(DAY9, [op]).split('\n');
    assert.deepEqual(after.slice(afternoon, afternoon + 3).map(l => l.trim().slice(0, 32)), ['- Day 8 - Saturday 24 May, after', '- Day 8 - Saturday 24 May, eveni', '- Day 8 - Saturday 24 May, night']);
});

test('0.7: locked sections can be changed but come unticked; canon, top lines and sample lines cannot', () => {
    const lines = DAY9.split('\n');
    const at = t => lines.findIndex(l => l.includes(t)) + 1;
    const ops = U.resolveOps(DAY9, [
        { id: 1, type: 'edit', line: at('Smokes, outside'), find: 'outside or at a window', text: 'on the street only, then showers and changes' },
        { id: 2, type: 'edit', line: at('Cool, low'), find: 'does not shout', text: 'does not shout; with Leon, since Day 8 - Saturday 24 May, louder' },
        { id: 3, type: 'edit', line: at('And yet you showed up'), find: 'And yet', text: 'But' },
        { id: 4, type: 'edit', line: at('Portrayed after'), find: 'after the slap', text: 'later' },
        { id: 5, type: 'edit', line: 1, find: 'Lead', text: 'Main' },
    ], U.updatableRanges(DAY9), { dates: DATES });
    assert.equal(ops[0].invalid, '');
    assert.equal(ops[0].outside, true);
    const w = U.opWarnings(ops[0]);
    assert.ok(w.untick && w.warnings.includes("SMALL HABITS isn't one of the sections you ticked: check before accepting."));
    assert.equal(ops[1].outside, true);
    assert.match(ops[2].invalid, /Sample lines/);
    assert.match(ops[3].invalid, /CANON POINT/);
    assert.match(ops[4].invalid, /CANON POINT/);
    const ed = U.editableRanges(DAY9).map(r => r.kind);
    assert.ok(ed.includes('speech') && ed.includes('habits') && !ed.includes('canon') && !ed.includes('preamble'));
});

test('0.7: a new relationship entry gets a blank line before its name', () => {
    const lines = DAY9.split('\n');
    const end = lines.findIndex(l => l.includes('As it grows'));
    const [op] = U.resolveOps(DAY9, [{ id: 1, type: 'add', line: end + 1, find: null, text: 'DEZ (Leon\'s other girl)\n- Now: Leon\'s girl for one more week; nothing of hers comes upstairs.\n- Speech: polite, short.' }], U.updatableRanges(DAY9), { dates: DATES });
    assert.equal(op.invalid, '');
    assert.equal(op.result[0], '');
    const after = U.applyOps(DAY9, [op]);
    assert.ok(after.includes("- As it grows: a straight answer earns more.\n\nDEZ (Leon's other girl)\n- Now: Leon's girl for one more week; nothing of hers comes upstairs.\n- Speech: polite, short.\n\nAPPEARANCE"));
    assert.equal(U.lineLabels(after).at(after.split('\n').indexOf('- Speech: polite, short.')), 'RELATIONSHIPS / DEZ');
    assert.ok(!U.opWarnings(op).warnings.some(w => w.includes('words long')));
});

test('0.7: Now and Wants written as a chain of dates are flagged', () => {
    const lines = DAY9.split('\n');
    const now = lines.findIndex(l => l.startsWith('- Now: since Day 6')) + 1;
    const [op] = U.resolveOps(DAY9, [{ id: 1, type: 'edit', line: now, find: 'her lover.', text: 'her lover; since Day 8 she sleeps there; since Day 9 she lives there.' }], U.updatableRanges(DAY9));
    assert.ok(U.opWarnings(op).warnings.some(w => w.startsWith('Reads as a chain of dates')));
    const [ok] = U.resolveOps(DAY9, [{ id: 1, type: 'edit', line: now, find: null, text: '- Now: her boyfriend; she lives with him.' }], U.updatableRanges(DAY9));
    assert.ok(!U.opWarnings(ok).warnings.some(w => w.startsWith('Reads as a chain')));
});

test('0.7: the update lists what is true now first, and the rules for ending old facts, general lines and new entries', () => {
    const p = U.parseOps('<now>\n- Lives in Leon\'s apartment since Day 9 - Sunday 25 May.\n- Tells Ellis it is over on Tuesday 27 May.\n</now>\n<change type="remove" line="20"><reason>x</reason></change>');
    assert.deepEqual(p.now, ["- Lives in Leon's apartment since Day 9 - Sunday 25 May.", '- Tells Ellis it is over on Tuesday 27 May.']);
    assert.deepEqual(U.parseOps('<none/>').now, []);
    const sys = U.systemPrompt('Leon');
    for (const part of ['<now>', 'what they are leaving or have left', 'moving out ends wanting to keep the place', 'With Leon, since Day 7 - Friday 23 May, she cries in front of him.', 'a sentence of its own about that person', 'Never join it onto another sentence', 'The latest word wins', 'add an entry for them at the end of RELATIONSHIPS', 'Now and Wants lines say how things stand today', 'a new line goes in date order', 'see STORY DAYS', 'reviewed by hand', 'quoted sample line']) assert.ok(sys.includes(part), part);
    const up = U.userPrompt({ card: 'C', title: 'Jules', sections: ['GOALS (lines 1-2)'], log: ['- a'], days: 'STORY DAYS (write dates in this form): Day 9 - Sunday 25 May' });
    assert.ok(up.includes('STORY DAYS (write dates in this form): Day 9 - Sunday 25 May') && up.includes('Return only the <now> block'));
    assert.match(U.sizeNote(7800, 5000), /Still put every lasting fact on it/);
    assert.match(U.sizeNote(7800, 5000, { tighten: true }), /cut until it is under/);
    assert.ok(U.opsCheckSystemPrompt('Leon').includes("a line that now says two things that can't both be true"));
    assert.ok(U.fixSystemPrompt('Leon').includes('For each stale line the checker listed: a change without op'));
});

test('0.7: the pass for lines no longer true gets the card, what is true now, the log and the planned changes', () => {
    const sys = U.sweepSystemPrompt('Leon');
    for (const part of ['line by line, from the first section to the last', 'SPEECH AND VOICE, LIKES, FEARS, COPING, SMALL HABITS, LIMITS', 'fears of losing something they have already chosen to give up', 'With Leon, since Day 7 - Friday 23 May, she …', 'never a clause joined on with a comma or a semicolon', 'Skip lines a planned change already fixes', 'SAY IT ONCE', '<change type="edit" line="57">']) assert.ok(sys.includes(part), part);
    const ops = U.resolveOps(DAY9, [{ id: 1, type: 'edit', line: 7, find: 'alone in Ellis\'s penthouse', text: 'with Leon in his apartment' }], U.updatableRanges(DAY9));
    const up = U.sweepUserPrompt({ card: U.numberCard(DAY9), title: 'Jules', sections: ['IDENTITY (lines 6-7)'], now: ['- Lives with Leon.'], log: ['- Day 9: moved in.'], ops, days: 'STORY DAYS: x' });
    assert.ok(up.includes('<now>\n- Lives with Leon.\n</now>') && up.includes('#1 CHANGE line 7 (IDENTITY)') && up.includes('SECTIONS THE PLAYER TICKED: IDENTITY (lines 6-7). Changes in other sections are fine') && up.includes('STORY DAYS: x'));
    assert.ok(U.sweepUserPrompt({ card: 'C', title: 'J', sections: [], now: [], log: [], ops: [] }).includes('(not listed; use the log)'));
});

test('0.7: Tighten may condense the player\'s own entry by default, and flags only other original lines', () => {
    const persona = U.personaEntryLines(DAY9, ['Leon Kennedy', 'Leon']);
    const lines = DAY9.split('\n');
    assert.deepEqual([...persona].map(i => lines[i].trim().slice(0, 12)), ['- Now: since', '- Shared his', '- Saturday 1', '- Day 8 - Sa', '- Day 8 - Sa', '- As it grow']);
    const marked = U.markNewLines(DAY9, DAY9, U.updatableRanges(DAY9), { also: persona });
    assert.equal(marked.newLines, 6);
    assert.ok(marked.text.includes('[new] - Now: since Day 6') && !marked.text.includes('[new] - Wants: to keep him'));
    const exempt = new Set([...persona].map(i => lines[i].trim()));
    assert.deepEqual(U.lostOriginalLines('- Now: since Day 6 she knocks; since Day 7 her lover.\n- Wants: x', '- Wants: x', DAY9, { exempt }), []);
    assert.deepEqual(U.lostOriginalLines('- Wants: to keep him, the apartment and the allowance.', '- Wants: nothing.', DAY9, { exempt }), ['- Wants: to keep him, the apartment and the allowance.']);
    const t = U.tightenSystemPrompt('Leon');
    assert.ok(t.includes('at most eight dated lines') && t.includes('Write dates in full, as listed under STORY DAYS'));
    assert.ok(U.tightenUserPrompt({ card: 'C', title: 'J', sections: ['HISTORY'], tokens: 7800, limit: 5000, days: 'STORY DAYS: x' }).includes('STORY DAYS: x'));
});

// ---------------------------------------------------------------- 0.7.1

const D11 = new Map([[1, 'Day 1 - Saturday 17 May'], [9, 'Day 9 - Sunday 25 May'], [10, 'Day 10 - Monday 26 May'], [11, 'Day 11 - Tuesday 27 May']]);

test('0.7.1: "Day 1" never matches the start of "Day 10"', () => {
    assert.equal(U.expandLeadDate('  - Day 10 - Monday 26 May: she told Ellis.', D11), '  - Day 10 - Monday 26 May: she told Ellis.');
    assert.equal(U.expandLeadDate('  - Day 10, evening: x', D11), '  - Day 10 - Monday 26 May, evening: x');
    assert.equal(U.expandLeadDate('  - Day 1: x', D11), '  - Day 1 - Saturday 17 May: x');
    assert.deepEqual(U.normalizeLogLines(['- Day 10 - Monday 26 May, evening: a', '- Day 11, ~3 PM: b'], D11), ['- Day 10 - Monday 26 May, evening: a', '- Day 11 - Tuesday 27 May: b']);
});

test('0.7.1: day labels are checked against the chat headers; labels broken by 0.7.0 are repaired', () => {
    assert.deepEqual(U.checkDayLabels('  - Day 1 - Saturday 17 May0 - Monday 26 May, evening: she told Ellis.', D11), { line: '  - Day 10 - Monday 26 May, evening: she told Ellis.', repaired: true, mismatches: [] });
    assert.deepEqual(U.checkDayLabels('  - Day 9 - Monday 26 May: x', D11).mismatches, [{ found: 'Day 9 - Monday 26 May', want: 'Day 10 - Monday 26 May' }]);
    assert.deepEqual(U.checkDayLabels('  - Day 11 - Tuesday 27 May: x; since Day 10 - Monday 26 May.', D11).mismatches, []);
    assert.deepEqual(U.checkDayLabels('  - Day 30 - Monday 26 June: x', D11).mismatches, [], 'days the headers don\'t name are left alone');
    const card = 'RELATIONSHIPS\nLEON\n- Shared history:\n  - Day 1 - Saturday 17 May0 - Monday 26 May: she told Ellis.\n  - Day 9 - Monday 26 May: x\n  - Day 11 - Tuesday 27 May: y';
    const ops = U.dayLabelOps(card, D11, U.editableRanges(card));
    assert.deepEqual(ops.map(o => [o.line, o.text, o.dateFix]), [
        [4, '  - Day 10 - Monday 26 May: she told Ellis.', 'repair'],
        [5, '  - Day 10 - Monday 26 May: x', 'mismatch'],
    ]);
    const resolved = U.resolveOps(card, ops.map((o, k) => ({ ...o, id: k + 1 })), U.updatableRanges(card), { dates: D11 });
    const w = resolved.map(o => U.opWarnings(o, { dates: D11 }));
    assert.equal(w[0].untick, false, 'a repair is certain');
    assert.ok(w[1].untick && w[1].warnings[0].startsWith('Check which is right'), 'a disagreement is for you to decide');
});

test('0.7.1: what the model writes gets broken labels repaired, and wrong labels flagged as a rule break', () => {
    const card = 'RELATIONSHIPS\nLEON\n- Shared history:\n  - Day 9 - Sunday 25 May: she moved in.';
    const [a, b] = U.resolveOps(card, [
        { id: 1, type: 'add', line: 4, find: null, text: '  - Day 1 - Saturday 17 May0 - Monday 26 May: she told Ellis.' },
        { id: 2, type: 'add', line: 4, find: null, text: '  - Day 9 - Tuesday 27 May: she went back for her paints.' },
    ], U.updatableRanges(card), { dates: D11 });
    assert.deepEqual(a.result, ['  - Day 10 - Monday 26 May: she told Ellis.']);
    const w = U.opWarnings(b, { dates: D11 });
    assert.ok(w.untick && w.problems.some(p => p.includes('"Day 9 - Tuesday 27 May" doesn\'t match the chat headers, which have "Day 11 - Tuesday 27 May"')));
});

test('0.7.1: rule breaks are problems: they untick the change and go to the fix step', () => {
    const card = 'RELATIONSHIPS\nLEON\n- Now: her boyfriend.\n- Shared history:\n  - Day 9 - Sunday 25 May: she moved in.';
    const ranges = U.updatableRanges(card);
    const [chain] = U.resolveOps(card, [{ id: 1, type: 'edit', line: 3, find: null, text: '- Now: her boyfriend since Day 9; since Day 10 she has told Ellis; since Day 11 she has no key.' }], ranges);
    const wc = U.opWarnings(chain);
    assert.ok(wc.untick && wc.problems.length === 1 && wc.problems[0].startsWith('Reads as a chain of dates'));
    const [clock] = U.resolveOps(card, [{ id: 1, type: 'add', line: 5, find: null, text: '  - Day 10 - Monday 26 May: she told Ellis at 9:15 PM.' }], ranges);
    assert.ok(U.opWarnings(clock).untick && U.opWarnings(clock).problems[0].startsWith('Clock time'));
    const [cut] = U.resolveOps(card, [{ id: 1, type: 'edit', line: 3, find: null, text: '- Now: hers.' }], ranges);
    assert.deepEqual(U.opWarnings(cut).problems, [], 'what an edit cuts is shown, not a rule break');
    assert.ok(U.fixUserPrompt({ card: 'C', title: 'J', sections: [], log: [], ops: [chain], problems: [{ id: 1, kind: 'rule', text: 'Reads as a chain of dates.' }], stale: [] }).includes('#1 BREAKS A RULE: Reads as a chain of dates.'));
});

test('0.7.1: whole lines and agreeing changes are checked; story slips are kept out of the log', () => {
    const card = 'IDENTITY\n- Lives with Leon; she broke it with Leon; Ellis does not know.';
    const [op] = U.resolveOps(card, [{ id: 1, type: 'edit', line: 2, find: 'Lives with Leon', text: 'Lived with Ellis until Day 10' }], U.updatableRanges(card));
    assert.ok(U.describeOp(op).includes('NEW LINE: - Lived with Ellis until Day 10; she broke it with Leon; Ellis does not know.'));
    const sys = U.systemPrompt('Leon');
    assert.ok(sys.includes('read the whole line as it will read afterwards against what is true now') && sys.includes('Every fact you write must agree with your other changes'));
    const chk = U.opsCheckSystemPrompt('Leon');
    assert.ok(chk.includes("Read each change's whole new line") && chk.includes('Two changes that state facts that disagree with each other'));
    assert.ok(U.logSystemPrompt('Jules', 'Leon').includes('When the story contradicts itself'));
});

// ---------------------------------------------------------------- 0.8.0

const NOTEBOOK_CHAT = [
    { mes: 'old <internal_states><details><summary>📓 GM\'S NOTEBOOK</summary>\n1. [R] Jules has heard from Leon: old line.\n</details></internal_states>' },
    { mes: 'Newest reply.\n<!-- GFX_START --><internal_states><details><summary>📓 GM\'S NOTEBOOK</summary>\n1. [R] Jules has heard from Leon: his mother killed herself.\n2. [R] Jules has heard where Leon stands: he wants her to move in for good.\n3. [R] Jules told Leon: she finishes maybe once a month.\n4. [R] Dez has heard from Leon: something else.\n5. [R] Jules knows the desk man talks.\n- [R] [Jules] told [Leon]: she tells Ellis on Tuesday.\n</details></internal_states><!-- GFX_END -->' },
    { is_user: true, mes: 'My turn, no notebook.' },
];

test('0.8: notebook rows naming the character are read from the newest notebook', () => {
    assert.deepEqual(U.notebookLines(NOTEBOOK_CHAT, ['Jules', 'Jules Vaughn']), [
        '[R] Jules has heard from Leon: his mother killed herself.',
        '[R] Jules has heard where Leon stands: he wants her to move in for good.',
        '[R] Jules told Leon: she finishes maybe once a month.',
        '[R] Jules knows the desk man talks.',
        '[R] [Jules] told [Leon]: she tells Ellis on Tuesday.',
    ]);
    assert.deepEqual(U.notebookLines([{ mes: 'no block' }], ['Jules']), []);
    const t = U.trackerLines(NOTEBOOK_CHAT, ['Jules']);
    assert.ok(!t.includes('has heard from') && !t.includes('told Leon') && !t.includes('desk man'), 'tracker rows leave them out; they get their own block');
});

test('0.8: the update must put every notebook line on the card; the check reports the ones it did not', () => {
    const nb = U.notebookLines(NOTEBOOK_CHAT, ['Jules']);
    const up = U.userPrompt({ card: 'C', title: 'Jules', sections: ['RELATIONSHIPS (lines 1-9)'], log: [], notebook: nb });
    assert.ok(up.includes("NOTEBOOK: THE GAME'S RECORD OF WHAT PEOPLE SAW, HEARD, FOUND OUT, KNOW AND TOLD, LINES NAMING Jules (the game deletes these lines") && up.includes('<notebook>\n[R] Jules has heard from Leon: his mother killed herself.'));
    assert.ok(!U.userPrompt({ card: 'C', title: 'Jules', sections: [], log: [] }).includes('NOTEBOOK'), 'no block without notebook lines');
    const sys = U.systemPrompt('Leon');
    assert.ok(sys.includes('keep a Knows list of what this character has learned about Leon') && sys.includes('NOTEBOOK lines (when given)') && sys.includes('what they learned about Leon or told Leon (every NOTEBOOK line)'));
    const chk = U.opsCheckUserPrompt({ card: 'C', title: 'Jules', ops: [], log: [], notebook: nb });
    assert.ok(chk.includes('must be on the card'));
    const re = U.opsCheckUserPrompt({ card: 'C', title: 'Jules', ops: [], log: [], notebook: nb, only: [] });
    assert.ok(re.includes('(a source, like the log)') && re.includes('[R] Jules told Leon'), 'the re-check of fixes gets them as a source');
    assert.ok(U.opsCheckSystemPrompt('Leon').includes('<missing>the notebook line, as it reads</missing>'));
    assert.deepEqual(U.parseOpsCheck('<missing>[R] Jules told Leon: she finishes maybe once a month.</missing>').missing, ['[R] Jules told Leon: she finishes maybe once a month.']);
    const fx = U.fixUserPrompt({ card: 'C', title: 'J', sections: [], log: [], ops: [], problems: [], stale: [], missing: ['[R] Jules told Leon: x.'] });
    assert.ok(fx.includes("NOTEBOOK LINES THE CARD DOESN'T HOLD YET (the game deletes them after this update):\n1. [R] Jules told Leon: x."));
    assert.ok(U.fixSystemPrompt('Leon').includes('<change missing="1,3,4" type="add" after="80">'));
    assert.deepEqual(U.parseOps('<change missing="2" type="add" after="9"><new>- Knows: x.</new></change>').ops[0].missing, [2]);
    assert.ok(U.tightenSystemPrompt('Leon').includes('Its Knows list keeps every item that is still true'));
});

test('0.8: the canon point keeps one form', () => {
    assert.equal(U.canonPointBody('Portrayed after the slap. Nothing after this has happened.', 'Day 11 - Tuesday 27 May'), 'Portrayed after the slap, updated with the story up to Day 11 - Tuesday 27 May. Nothing after this has happened.');
    assert.equal(U.canonPointBody('Portrayed after the slap, updated with the story up to Day 9 - Sunday 25 May. Nothing after.', 'Day 11 - Tuesday 27 May'), 'Portrayed after the slap, updated with the story up to Day 11 - Tuesday 27 May. Nothing after.');
});

// ---------------------------------------------------------------- 0.8.1

test('0.8.1: every [R] row naming the character is read; [T] rows and rows marked Untrue stay tracker rows', () => {
    const chat = [{ mes: '<internal_states><details><summary>📓 GM\'S NOTEBOOK</summary>\n1. [R] Dez saw on the thread on Day 10 that it has Jules Vaughn\'s full name; she has told no one.\n2. [R] Leon told Jules that Dez texts too much.\n3. [T] Dez thinks Leon will leave.\n4. [R] Dez believes Jules is Leon\'s cousin. Untrue.\n5. [R] Bree told Nate about the party.\n</details></internal_states>' }];
    assert.deepEqual(U.notebookLines(chat, ['Dez']), [
        "[R] Dez saw on the thread on Day 10 that it has Jules Vaughn's full name; she has told no one.",
        '[R] Leon told Jules that Dez texts too much.',
    ], 'the model decides whether she is in it or only talked about');
    const t = U.trackerLines(chat, ['Dez']);
    assert.ok(t.includes('[T] Dez thinks Leon will leave.') && t.includes('Untrue') && !t.includes('full name'));
});

test('0.8.1: the notebook rules: knowledge, secrets with who knows, what they told; only lines they are in', () => {
    const sys = U.systemPrompt('Leon');
    for (const part of ['names this character as telling, being told, seeing, overhearing, finding out or knowing something', 'anything else they found out or were told: KNOWLEDGE, or the entry for the person it is about', 'a secret: SECRETS, saying who knows it and who it is kept from', 'only mentions this character as what other people talk about']) assert.ok(sys.includes(part), part);
    const chk = U.opsCheckSystemPrompt('Leon');
    assert.ok(chk.includes('neither the log, the NOTEBOOK lines, the tracker rows nor the card') && chk.includes('The NOTEBOOK is a source just like the log'));
    assert.ok(U.opsCheckSystemPrompt('Leon', { stale: false }).includes('The NOTEBOOK is a source just like the log'), 'also when checking the fixes');
    const nb = ['[R] Dez saw x.'];
    assert.ok(U.fixUserPrompt({ card: 'C', title: 'Dez', sections: [], log: [], ops: [], problems: [], stale: [], notebook: nb }).includes('<notebook>\n[R] Dez saw x.'));
    assert.ok(U.sweepUserPrompt({ card: 'C', title: 'Dez', sections: [], now: [], log: [], ops: [], notebook: nb }).includes('(a source, like the log)'));
});

test('0.8.1: a card without CANON POINT gets one before its first section', () => {
    const card = 'DEZ — Supporting\n\nTHIS CHARACTER IS AN ADULT\n\nIDENTITY\n- 22.\n\nHISTORY\n- x';
    const op = U.canonOp(card, 'Day 12 - Thursday 29 May');
    assert.equal(U.applyOps(card, [op]), 'DEZ — Supporting\n\nTHIS CHARACTER IS AN ADULT\n\nCANON POINT\nCard updated with the story up to Day 12 - Thursday 29 May.\n\nIDENTITY\n- 22.\n\nHISTORY\n- x');
    assert.match(op.reason, /had no CANON POINT/);
    assert.equal(U.applyOps('IDENTITY\n- 22.', [U.canonOp('IDENTITY\n- 22.', 'Day 12 - Thursday 29 May')]), 'CANON POINT\nCard updated with the story up to Day 12 - Thursday 29 May.\n\nIDENTITY\n- 22.');
    const stamped = U.applyOps(card, [op]);
    assert.equal(U.canonOp(stamped, 'Day 12 - Thursday 29 May'), null, 'nothing to do once stamped');
    assert.equal(U.canonOp(stamped, 'Day 13 - Friday 30 May').result[0], 'Card updated with the story up to Day 13 - Friday 30 May.', 'the next update moves the date');
    const existing = U.canonOp('CANON POINT\nPortrayed after the slap. Nothing after.\n\nIDENTITY\n- x', 'Day 12 - Thursday 29 May');
    assert.equal(existing.type, 'edit');
    assert.equal(existing.result[0], 'Portrayed after the slap, updated with the story up to Day 12 - Thursday 29 May. Nothing after.');
});

// ---------------------------------------------------------------- 0.9.0: new cards

const STORY = [
    { mes: '[ 🗓️ Day 7 - Friday 23 May ]\n[Simon] (Smug, Relaxed): <gold:"measured">"The museum gets nothing until you say so."</gold>\n[Jules] (Tired): "Go."\n<internal_states><details><summary>NPC AGENDAS</summary>\n- <b>Ellis</b> | Agenda: drive home.\n</details></internal_states>' },
    { is_user: true, mes: '[Leon] (Calm): "Hi."' },
    { mes: '[ 🗓️ Day 8 - Saturday 24 May ]\n[Simon Aldridge] (Cornered):\n"I only came for the paintings."\n[Narrator] (Quiet): The hall empties.\n[Desk Man] (Bored): "Sign here."' },
    { mes: '[Simon] (Smug, Relaxed): <gold:"measured">"The museum gets nothing until you say so."</gold>' },
];

test('0.9: people who speak on screen or have an agenda row, without a card, are found and grouped', () => {
    const found = U.uncardedPeople(STORY, { known: ['Jules', 'Jules Vaughn'], persona: ['Leon Kennedy', 'Leon'] });
    assert.deepEqual(found.map(p => [p.name, p.count]), [['Simon Aldridge', 3], ['Desk Man', 1], ['Ellis', 1]]);
    assert.deepEqual(found[0].forms, ['Simon Aldridge', 'Simon']);
    assert.deepEqual(U.uncardedPeople(STORY, { known: ['Simon', 'Ellis', 'Desk Man', 'Jules'], persona: ['Leon'] }), []);
});

test('0.9: their own lines are collected with the story\'s state, tags taken out, repeats once', () => {
    assert.deepEqual(U.spokenLines(STORY, ['Simon', 'Simon Aldridge']), [
        '(Smug, Relaxed) "The museum gets nothing until you say so."',
        '(Cornered) "I only came for the paintings."',
    ]);
    assert.deepEqual(U.spokenLines(STORY, ['Nobody']), []);
});

test('0.9: the outline of a card is its layout without its content', () => {
    const outline = U.cardOutline('JULES VAUGHN — Lead character\n\nCANON POINT\nPortrayed after.\n\nIDENTITY\n- 23.\n\nRELATIONSHIPS\nRUE BENNETT\n- Now: x\n- Wants: y\n\nELLIS\n- Wants: z\n\nAPPEARANCE\n- Tall.');
    assert.equal(outline, 'NAME — (tier) character\nCANON POINT\nIDENTITY\nRELATIONSHIPS\n  NAME (who they are to this character)\n  - Now: …\n  - Wants: …\nAPPEARANCE');
});

test('0.9: the new-card prompts: story only, tiers, own lines as samples, the template, the stamp', async () => {
    const { CARD_TEMPLATE } = await import('../template.js');
    assert.ok(CARD_TEMPLATE.startsWith('CHARACTER CARD TEMPLATE — v12') && CARD_TEMPLATE.includes('FINAL CHECKS') && CARD_TEMPLATE.trim().endsWith('says nothing their entry contradicts.'));
    const sys = U.newCardSystemPrompt('Leon', CARD_TEMPLATE);
    for (const part of ['Never invent backstory', 'the story wins over the template\'s counts', 'Minor (at most 700 tokens)', 'Sample lines come from their own lines in the story', 'Written from the story, updated with the story up to', 'CHARACTER CARD TEMPLATE — v12', '<tier>', 'an entry for Leon']) assert.ok(sys.includes(part), part);
    const up = U.newCardUserPrompt({ name: 'Simon Aldridge', forms: ['Simon Aldridge', 'Simon'], count: 3, firstDate: 'Day 7 - Friday 23 May', lastDate: 'Day 8 - Saturday 24 May', log: ['- Day 7: x'], lines: ['(Cornered) "I only came."'], notebook: ['[R] Simon told Leon: y.'], outline: 'CANON POINT', storyDate: 'Day 8 - Saturday 24 May', days: 'STORY DAYS: z' });
    for (const part of ['NEW CARD FOR: Simon Aldridge (also written as: Simon). Seen in 3 replies, from Day 7 - Friday 23 May to Day 8 - Saturday 24 May.', '<outline>\nCANON POINT', '<log>\n- Day 7: x', '<lines>\n(Cornered)', '<notebook>\n[R] Simon told Leon', 'STORY DAYS: z']) assert.ok(up.includes(part), part);
    const fix = U.newCardFixUserPrompt({ name: 'Simon', log: [] }, 'CARD', [{ kind: 'unsupported', text: 'a brother -> not in the story' }]);
    assert.ok(fix.includes('YOUR CARD:\n<card>\nCARD\n</card>') && fix.includes('UNSUPPORTED: a brother -> not in the story') && !fix.includes('Write the card for Simon. Return'));
});

test('0.9: new-card replies and check replies are read', () => {
    assert.deepEqual(U.parseNewCard('<think>x</think><tier>Supporting</tier>\n<card>\nSIMON — Supporting character\n\nIDENTITY\n- x\n</card>'), { card: 'SIMON — Supporting character\n\nIDENTITY\n- x', tier: 'supporting' });
    assert.deepEqual(U.parseNewCard('nothing'), { card: '', tier: '' });
    assert.deepEqual(U.parseCardCheck('<problem kind="missing">his job -> curator, Day 7</problem><problem kind="odd">x</problem>'), [{ kind: 'missing', text: 'his job -> curator, Day 7' }, { kind: 'wrong', text: 'x' }]);
    assert.deepEqual(U.parseCardCheck('<ok/>'), []);
    assert.equal(U.parseCardCheck('fine'), null);
    assert.ok(U.newCardCheckSystemPrompt('Leon').includes('a sample line that isn\'t one of their own lines'));
});

test('0.9: code warnings for a new card: needed sections, the entry for the player, size, dates', () => {
    const bare = 'SIMON — Minor character\n\nIDENTITY\n- Curator. Met Leon yesterday at 3 PM.';
    const w = U.newCardWarnings(bare, { tier: 'minor', personaNames: ['Leon'] });
    for (const part of ['No CANON POINT section.', 'No PERSONALITY section.', 'No SPEECH AND VOICE section.', 'No APPEARANCE section.', 'No RELATIONSHIPS section.', 'No BODY section.']) assert.ok(w.includes(part), part);
    assert.ok(w.some(x => x.startsWith('Counts from a day: yesterday')) && w.some(x => x.startsWith('Clock time: 3 PM')));
    const full = 'SIMON — Minor character\n\nCANON POINT\nWritten from the story, updated with the story up to Day 8 - Saturday 24 May.\n\nIDENTITY\n- Curator.\n\nPERSONALITY\n1. Alone: x\n\nSPEECH AND VOICE\nSmooth.\n\nRELATIONSHIPS\nJULES\n- Wants: x\n\nAPPEARANCE\n- Grey suit.\n\nBODY\n- Lean, pale, grey chest hair.';
    assert.deepEqual(U.newCardWarnings(full, { tier: 'minor', personaNames: ['Leon'] }), ['No entry for Leon under RELATIONSHIPS.']);
    assert.ok(U.newCardWarnings(`${full}\n${'- word '.repeat(1200)}`, { tier: 'minor', personaNames: [] }).some(x => x.includes('over the minor limit of 700')));
});

// ---------------------------------------------------------------- 0.9.1: one heading per list

const KNOWS_CARD = `RELATIONSHIPS
LEON (the neighbor)
- Now: her boyfriend.
- Shared history:
  - Day 9 - Sunday 25 May: she moved in.
- As it grows: x.

DEZ
- Now: Leon's other girl.
- Knows:
  - Leon showers before he touches her.
- Speech: polite.`;

test('0.9.1: a Knows section is created once, with its items as plain lines under the heading', () => {
    const r = U.updatableRanges(KNOWS_CARD);
    const ops = U.resolveOps(KNOWS_CARD, [
        { id: 1, type: 'add', line: 3, find: null, text: '- Knows: his mother killed herself.' },
        { id: 2, type: 'add', line: 3, find: null, text: '- Knows: he grew up in Chicago.' },
    ], r);
    assert.deepEqual(ops[0].result, ['- Knows:', '  - his mother killed herself.']);
    assert.deepEqual(ops[1].result, ['  - he grew up in Chicago.']);
    assert.equal(U.applyOps(KNOWS_CARD, ops).split('\n').slice(1, 6).join('\n'), 'LEON (the neighbor)\n- Now: her boyfriend.\n- Knows:\n  - his mother killed herself.\n  - he grew up in Chicago.');
});

test('0.9.1: one change with several labelled lines becomes one heading and plain items', () => {
    const [op] = U.resolveOps(KNOWS_CARD, [{ id: 1, type: 'add', line: 3, find: null, text: '- Knows: his mother killed herself.\n- Knows: he grew up in Chicago.\n- Knows: he boxes.' }], U.updatableRanges(KNOWS_CARD));
    assert.deepEqual(op.result, ['- Knows:', '  - his mother killed herself.', '  - he grew up in Chicago.', '  - he boxes.']);
    const [h] = U.resolveOps(KNOWS_CARD, [{ id: 1, type: 'add', line: 3, find: null, text: '- Knows:\n- his mother killed herself.\n- he boxes.' }], U.updatableRanges(KNOWS_CARD));
    assert.deepEqual(h.result, ['- Knows:', '  - his mother killed herself.', '  - he boxes.'], 'items written flat under a heading are indented under it');
});

test('0.9.1: items for an entry that has the block go after its last line, without the label', () => {
    const lines = KNOWS_CARD.split('\n');
    const [op] = U.resolveOps(KNOWS_CARD, [{ id: 1, type: 'add', line: lines.indexOf("- Now: Leon's other girl.") + 1, find: null, text: '- Knows: nothing of hers comes upstairs.' }], U.updatableRanges(KNOWS_CARD));
    assert.deepEqual(op.result, ['  - nothing of hers comes upstairs.']);
    assert.equal(op.index, lines.indexOf('  - Leon showers before he touches her.'));
    const shared = U.resolveOps(KNOWS_CARD, [{ id: 1, type: 'add', line: 3, find: null, text: '- Shared history: Day 10 - Monday 26 May: she told Ellis.' }], U.updatableRanges(KNOWS_CARD))[0];
    assert.deepEqual(shared.result, ['  - Day 10 - Monday 26 May: she told Ellis.']);
    assert.equal(shared.index, lines.indexOf('  - Day 9 - Sunday 25 May: she moved in.'));
    const now = U.resolveOps(KNOWS_CARD, [{ id: 1, type: 'add', line: 3, find: null, text: '- Wants: him.' }], U.updatableRanges(KNOWS_CARD))[0];
    assert.deepEqual(now.result, ['- Wants: him.'], 'other fields are left as written');
});

test('0.9.1: missing notebook items come back as one change per block, covering several rows', () => {
    const sys = U.fixSystemPrompt('Leon');
    assert.ok(sys.includes('All the items that go in the same block are one change') && sys.includes('that change starts with the heading line "- Knows:"'));
    assert.deepEqual(U.parseOps('<change missing="1, 3,4" type="add" after="9"><new>- Knows:\n  - x.\n  - y.</new></change>').ops[0].missing, [1, 3, 4]);
    assert.ok(U.systemPrompt('Leon').includes('create the heading line "- Knows:" the first time') && U.systemPrompt('Leon').includes('Never repeat the label on every line'));
});

// ---------------------------------------------------------------- 0.9.2: BODY, INTIMACY, body parts named plainly

const ADULT_CARD = `MASHIRO — Lead

CANON POINT
Portrayed at the start of term. Nothing after this has happened.

IDENTITY
Kohinata Mashiro, 20, second-year art student.

RELATIONSHIPS

LEON
- Wants: him to stay.
- Speech: quiet, short.

AIKO (roommate)
- Wants: her approval.
- Speech: teasing.

LIMITS
Won't be filmed. (At a limit) "No... put it away."

SMALL HABITS
- Tucks her hair behind her ear.

APPEARANCE
- Oversized sweaters.

BODY
- Slim, small breasts, pale pink nipples.
- Bare pussy, pale lips.

INTIMACY
Likes and limits: see LIKE AND WANT and LIMITS.
Quiet at first, louder once relaxed.`;

test('0.9.2: BODY and INTIMACY are sections of their own, after RELATIONSHIPS and its entries', () => {
    const r = U.sectionRanges(ADULT_CARD);
    assert.deepEqual(r.map(x => x.kind), ['preamble', 'canon', 'identity', 'relationships', 'limits', 'habits', 'appearance', 'body', 'intimacy']);
    const lines = ADULT_CARD.split('\n');
    assert.equal(U.rangeBody(lines, r.find(x => x.kind === 'body')), '- Slim, small breasts, pale pink nipples.\n- Bare pussy, pale lips.');
    assert.equal(U.rangeBody(lines, r.find(x => x.kind === 'intimacy')), 'Likes and limits: see LIKE AND WANT and LIMITS.\nQuiet at first, louder once relaxed.');
    // Straight after RELATIONSHIPS they end its range instead of being read as people.
    const direct = 'IDENTITY\nX, 25.\n\nRELATIONSHIPS\n\nLEON\n- Wants: x.\n\nAIKO\n- Wants: y.\n\nBODY\n- Tall.\n\nINTIMACY\nLoud.';
    const d = U.sectionRanges(direct);
    assert.deepEqual(d.map(x => x.kind), ['identity', 'relationships', 'body', 'intimacy']);
    const rel = U.rangeBody(direct.split('\n'), d.find(x => x.kind === 'relationships'));
    assert.ok(rel.includes('AIKO') && !rel.includes('BODY') && !rel.includes('Tall'));
});

test('0.9.2: heading kinds: BODY and INTIMACY, never BODY LANGUAGE or BODY IMAGE', async () => {
    const P = await import('../cardparse.js');
    for (const [h, k] of [['BODY', 'body'], ['BODY (ADULTS ONLY)', 'body'], ['INTIMACY', 'intimacy'], ['INTIMATE LIFE', 'intimacy'], ['SEX AND INTIMACY', 'intimacy'],
        ['APPEARANCE', 'appearance'], ['LIMITS', 'limits'], ['WHAT THEY LIKE AND WANT', 'likes']]) {
        assert.equal(P.classifyHeading(P.headingInfo(h).core), k, h);
    }
    for (const h of ['BODY LANGUAGE', 'BODY IMAGE', 'SOMEBODY']) assert.equal(P.classifyHeading(h), null, h);
    assert.equal(P.SECTION_LABELS.body, 'Body');
    assert.equal(P.SECTION_LABELS.intimacy, 'Intimacy');
});

test('0.9.2: the updater may change BODY and INTIMACY, offered after Appearance', () => {
    const order = U.UPDATABLE.map(([k]) => k);
    assert.deepEqual(order.slice(order.indexOf('appearance'), order.indexOf('appearance') + 3), ['appearance', 'body', 'intimacy']);
    assert.deepEqual(U.updatableRanges(ADULT_CARD).map(r => r.kind), ['identity', 'relationships', 'appearance', 'body', 'intimacy']);
    const sys = U.systemPrompt('Leon');
    for (const part of [
        '- BODY changes only for something lasting on the body: a new tattoo, a piercing, a scar. Never marks, bruises, soreness or anything that fades within days.',
        '- INTIMACY changes when the story lastingly changes how they are in bed: a first time, experience gained, something they now like or refuse. Rewrite the line that no longer holds as a description of how they act and how their voice changes, never as a quoted line or a list of words.',
        '- Name body parts by their plain word (breasts, nipples, pussy, lips, clit, cock, balls, ass), never a stand-in (the pink of her, her sex, down there). The roleplay model copies the card\'s wording into the story.',
    ]) {
        assert.ok(sys.includes(part), part.slice(0, 40));
        assert.ok(U.sweepSystemPrompt('Leon').includes(part), `sweep: ${part.slice(0, 40)}`);
    }
});

test('0.9.2: stand-ins for body parts are found; the same words meaning something else are not', () => {
    for (const s of ['the pink of her showed swollen', 'the pale pink of her was wet', 'touched her sex', 'his sex hardened', 'reached down there',
        'heat in her core', 'her center ached', 'his length', 'his member', 'his manhood', 'her womanhood', 'nether regions', 'THE PINK OF HER']) {
        assert.equal(U.standInWords(s).length, 1, s);
    }
    for (const s of ['the pink of her lips', 'the pale pink of her nipples', 'her sex life', 'her sex drive', 'his sex-positive friends', 'her core values',
        'her core group of friends', 'her center of gravity', 'his length of service', 'a member of the band', 'the Netherlands', 'pink nipples']) {
        assert.deepEqual(U.standInWords(s), [], s);
    }
    assert.deepEqual(U.standInWords('The pink of her. Down there. down  there.'), ['the pink of her', 'down there']);
});

test('0.9.2: a section update with a stand-in is flagged', () => {
    const w = U.checkUpdate('intimacy', 'Quiet.', 'Quiet. Since Day 10, the pale pink of her flushes when he looks.');
    assert.ok(w.includes('Stand-in for a body part: the pale pink of her. Name the part plainly (breasts, nipples, pussy, lips, clit, cock, balls, ass).'));
    assert.ok(!U.checkUpdate('body', 'Slim.', 'Slim. Pale pink nipples. A rose tattoo on her hip since Day 12.').some(x => x.startsWith('Stand-in')));
});

test('0.9.2: a new card needs BODY unless IDENTITY gives an age under 18, and names parts plainly', () => {
    const base = (identity, extra = '') => `X — Minor\n\nCANON POINT\nWritten from the story.\n\nIDENTITY\n${identity}\n\nPERSONALITY\n1. Alone: x\n\nSPEECH AND VOICE\nSmooth.\n\nRELATIONSHIPS\nLEON\n- Wants: x\n\nAPPEARANCE\n- Grey suit.${extra}`;
    const noBody = (id) => U.newCardWarnings(base(id), { tier: 'minor', personaNames: ['Leon'] }).includes('No BODY section.');
    for (const id of ['- Curator.', '- 22, curator.', '- Age: 34. Curator.', '- 19-year-old student.', '- Rue Bennett, 18, student.', '- Fifties. Real estate.',
        '- Maria Lopez, 34, has a 5-year-old daughter.', '- Nurse. Has a 6-year-old son.', '- Teacher. Her kids, ages 5 and 7.', '- Lives with her 16-year-old little sister.']) assert.ok(noBody(id), id);
    for (const id of ['17. Lives with her mother.', '- Age: 16.', '- Aged sixteen, a junior.', '- A 15-year-old sophomore.', '- Gia Bennett, 14, Rue\'s sister.', '- 13 years old.']) assert.ok(!noBody(id), id);
    assert.equal(U.identityAge(base('- Curator.')), null);
    assert.equal(U.identityAge(base('- Rue Bennett, 17, recovering.')), 17);
    const w = U.newCardWarnings(base('- 22.', '\n\nBODY\n- Slim.\n\nINTIMACY\nThe pink of her flushes. Says little down there.'), { tier: 'minor', personaNames: ['Leon'] });
    assert.deepEqual(w, ['Stand-in for a body part: the pink of her, down there. Name the part plainly (breasts, nipples, pussy, lips, clit, cock, balls, ass).']);
});

test('0.10: the built-in template is v12 and the settings say so', async () => {
    const fs = await import('node:fs');
    const { CARD_TEMPLATE } = await import('../template.js');
    assert.ok(CARD_TEMPLATE.startsWith('CHARACTER CARD TEMPLATE — v12\n') && CARD_TEMPLATE.includes('\nBODY — adults only (18+)') && CARD_TEMPLATE.includes('\nINTIMACY — adults only.'));
    for (const part of ['\nSplices. A line about something else', 'rewritten whole, from how the newest scene ended', 'never only a label such as "the soft voice"', '\n32. Read the Now, Wants, Hides and Speech lines', '\n33. Search every section outside RELATIONSHIPS']) assert.ok(CARD_TEMPLATE.includes(part), part);
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.ok(index.includes('empty = the built-in v12') && index.includes('Empty uses the built-in template (v12)') && index.includes('Built-in: CHARACTER CARD TEMPLATE — v12'));
    assert.ok(!/\bv8\b/.test(index));
});

// ---------------------------------------------------------------- 0.10: how they are with the player character, the final read

const WITH_LEON = `JULES VAUGHN — Lead character

CANON POINT
Portrayed after the slap, updated with the story up to Day 9 - Sunday 25 May.

IDENTITY
- Paid mistress of Ellis.

PERSONALITY
1. Alone: paints for hours.
2. With her closest person: Leon, since Day 9 - Sunday 25 May. With Ellis she is light and agreeable.

SPEECH AND VOICE
Cool, low and unhurried; on the back foot she promises; with Leon, since Day 9 - Sunday 25 May, the soft voice instead.
Sample lines:
1. (To Leon, dry) "And yet you showed up here."

RELATIONSHIPS

ELLIS
- Wants: to keep him.

LEON KENNEDY
- Has seen: he moved in on Tuesday 13 May.
- Now: her lover across the hall; the when hers. Since Day 9 he sets the terms.
- Wants: to be picked out loud by him, once.
- Speech: soft and asking; she speaks only when he asks.
- Knows:
 - he is from Fontana.
 - Bree: he sent her a photo.
- Shared history:
 - Day 2 - Sunday 18 May: their first night.

INTIMACY
- With Leon he leads: silent on his order.`;

test('0.10: the lines that say how she is with the player character: the entry\'s fields and the general lines naming him', () => {
    const t = U.portraitTargets(WITH_LEON, ['Leon', 'Leon Kennedy']);
    assert.equal(t.entry, 'LEON KENNEDY');
    const at = s => WITH_LEON.split('\n').findIndex(l => l.startsWith(s));
    assert.deepEqual(t.fields.map(f => f.index), [at('- Now:'), at('- Wants: to be picked'), at('- Speech: soft')]);
    assert.deepEqual(t.general.map(g => g.index), [at('2. With her closest person'), at('Cool, low and unhurried'), at('- With Leon he leads')]);
    assert.ok(!t.general.some(g => g.text.includes('And yet you showed up')), 'sample lines stay');
    assert.ok(!t.fields.some(f => /Bree|Fontana|Has seen|Knows|Shared history/.test(f.text)), 'lists and first impressions stay');
    assert.deepEqual(U.portraitTargets(WITH_LEON, []), { entry: '', fields: [], general: [] });
});

test('0.10: the scenes are the chat itself, from the last save, newest kept', () => {
    const chat = [
        { is_user: true, mes: 'old' },
        { name: 'Narrator', mes: '[Jules] (Calm): "Before the save."' },
        { is_user: true, mes: 'I say "Be her."' },
        { name: 'Narrator', mes: 'Jules laughs. <internal_states>## Physics\n- Jules: here</internal_states>' },
        { name: 'Narrator', mes: 'Somewhere else, Ellis drives.' },
        { is_user: true, mes: 'I say "Tell me about the ocean."' },
        { name: 'Narrator', mes: 'Jules talks about the ocean at her grandmother\'s for a long time.' },
    ];
    const s = U.sceneText(chat, ['Jules'], { from: 2, userName: 'Leon' });
    assert.ok(s.text.startsWith('[#2] Leon: I say "Be her."') && s.text.includes('[#3] Narrator: Jules laughs.') && s.text.includes('[#6] Narrator: Jules talks about the ocean'));
    assert.ok(!s.text.includes('Before the save') && !s.text.includes('Ellis drives') && !s.text.includes('internal_states'));
    const short = U.sceneText(chat, ['Jules'], { from: 2, userName: 'Leon', maxChars: 120 });
    assert.ok(short.cut && short.text.includes('the ocean') && !short.text.includes('Be her'));
});

test('0.10: the rewrite prompt reads the scenes to the end and describes the earlier self, not the label', () => {
    const sys = U.portraitSystemPrompt('Leon');
    for (const part of ['The latest word wins', 'is not a standing rule unless the speaker says it is', 'find that self in the card', 'Never write only the label', 'is a pointer, not the description', 'two to five plain sentences', 'a sentence of its own, never a clause joined onto another sentence', 'Only lines listed under THE LINES TO REWRITE', '<none/>']) assert.ok(sys.includes(part), part);
    const targets = U.portraitTargets(WITH_LEON, ['Leon']);
    const up = U.portraitUserPrompt({ card: U.numberCard(WITH_LEON), title: 'Jules', entry: targets.entry, targets, scenes: '[#5] Narrator: x', cut: true, log: ['- Day 9: y'], days: 'STORY DAYS: z' });
    assert.ok(up.includes(`THE LINES TO REWRITE (the entry is LEON KENNEDY):\nline ${WITH_LEON.split('\n').findIndex(l => l.startsWith('2. With her'))+1} (PERSONALITY): 2. With her closest person`) && up.includes('older scenes left out for length') && up.includes('<scenes>\n[#5] Narrator: x\n</scenes>') && up.includes('STORY DAYS: z'));
    // The other steps leave those lines to it, and the log keeps the last word of a scene.
    assert.ok(U.systemPrompt('Leon', { portrait: true }).includes('LINES THAT ANOTHER STEP WRITES') && !U.systemPrompt('Leon').includes('LINES THAT ANOTHER STEP WRITES'));
    assert.ok(U.sweepSystemPrompt('Leon', { portrait: true }).includes('LINES THAT ANOTHER STEP WRITES') && U.fixSystemPrompt('Leon', { portrait: true }).includes('LINES THAT ANOTHER STEP WRITES'));
    const log = U.logSystemPrompt('Jules', 'Leon');
    assert.ok(log.includes('The latest word wins') && log.includes('A "Lasting" line holds only what still holds at the end of this part') && log.includes('not only the label'));
    for (const p of [U.systemPrompt('Leon'), U.sweepSystemPrompt('Leon'), U.tightenSystemPrompt('Leon')]) assert.ok(!p.includes('short clause such as'), 'no spliced clauses');
});

test('0.10: a rewritten line may be a few sentences, and the rewrite and the final read may touch Speech and Personality', () => {
    const ranges = U.updatableRanges(WITH_LEON);
    const lines = WITH_LEON.split('\n');
    const speech = lines.findIndex(l => l.startsWith('Cool, low'));
    const now = lines.findIndex(l => l.startsWith('- Now:'));
    const long = `- Now: ${'She talks all the time with him and laughs at his jokes. '.repeat(9).trim()}`;
    const [a, b] = U.resolveOps(WITH_LEON, [
        { id: 1, type: 'edit', line: now + 1, find: null, text: long, source: 'portrait' },
        { id: 2, type: 'edit', line: speech + 1, find: null, text: 'Cool, low and unhurried; on the back foot she promises. With Leon, since Day 9 - Sunday 25 May, she talks fast and all the time.', source: 'portrait' },
    ], ranges);
    const wa = U.opWarnings(a, { personaNames: ['Leon'] });
    assert.ok(!wa.untick, wa.warnings.join(' | '));
    const wb = U.opWarnings(b, { personaNames: ['Leon'] });
    assert.ok(b.outside && !wb.untick && wb.warnings.some(w => w.includes("isn't one of the sections you ticked")));
    const tooLong = U.resolveOps(WITH_LEON, [{ id: 3, type: 'edit', line: now + 1, find: null, text: `- Now: ${'word '.repeat(160)}`, source: 'portrait' }], ranges)[0];
    assert.ok(U.opWarnings(tooLong, { personaNames: ['Leon'] }).untick);
    const plain = U.resolveOps(WITH_LEON, [{ id: 4, type: 'edit', line: now + 1, find: null, text: long }], ranges)[0];
    assert.ok(U.opWarnings(plain, { personaNames: ['Leon'] }).untick, 'the update step itself still keeps lines short');
});

test('0.10: the final read sees the card as it will be and its fixes land on the right change', () => {
    const ranges = U.updatableRanges(WITH_LEON);
    const lines = WITH_LEON.split('\n');
    const now = lines.findIndex(l => l.startsWith('- Now:'));
    const wants = lines.findIndex(l => l.startsWith('- Wants: to be picked'));
    const fontana = lines.findIndex(l => l.includes('he is from Fontana'));
    let ops = U.resolveOps(WITH_LEON, [
        { id: 1, type: 'edit', line: now + 1, find: null, text: '- Now: her lover; she talks all the time with him, she speaks only when he asks.', source: 'portrait' },
        { id: 2, type: 'add', line: fontana + 1, text: ' - he boxes.', source: 'update' },
    ], ranges);
    const after = U.cardAfter(WITH_LEON, ops);
    assert.equal(after.text, U.applyOps(WITH_LEON, ops));
    const numbered = U.numberAfter(after, ops);
    const nowAt = after.text.split('\n').findIndex(l => l.startsWith('- Now:'));
    const boxAt = after.text.split('\n').findIndex(l => l.includes('he boxes'));
    const speechAt = after.text.split('\n').findIndex(l => l.startsWith('- Speech: soft'));
    assert.ok(numbered.includes(`${nowAt + 1}| [changed] - Now:`) && numbered.includes(`${boxAt + 1}| [new]  - he boxes.`) && numbered.includes(`${speechAt + 1}| - Speech: soft`));
    const found = U.parseOps([
        `<change type="edit" line="${nowAt + 1}"><new>- Now: her lover; she talks all the time with him.</new><reason>clashed with itself</reason></change>`,
        `<change type="edit" line="${speechAt + 1}"><new>- Speech: fast and bright, all the time.</new><reason>clashes with Now</reason></change>`,
        `<change type="remove" line="${boxAt + 1}"><reason>not on the card elsewhere; cut</reason></change>`,
        `<change type="edit" line="${wants + 1}"><new>- Wants: x</new><reason>a line number that is out of the card after the changes</reason></change>`,
    ].join('\n')).ops;
    const fx = U.applyCoherence(WITH_LEON, ops, after.origin, found, ranges);
    const byId = new Map(fx.ops.map(o => [o.id, o]));
    assert.equal(byId.get(1).result[0], '- Now: her lover; she talks all the time with him.');
    assert.ok(byId.get(1).coherence && byId.get(1).coherence.before.includes('speaks only when he asks'));
    assert.ok(fx.dropped.some(o => o.id === 2) && !byId.has(2));
    const fresh = fx.ops.find(o => o.source === 'coherence' && o.result?.[0] === '- Speech: fast and bright, all the time.');
    assert.ok(fresh && !fresh.invalid && fresh.index === lines.findIndex(l => l.startsWith('- Speech: soft')));
    assert.equal(fx.revised, 2);
    ops = fx.ops;
    const final = U.applyOps(WITH_LEON, ops);
    assert.ok(final.includes('- Speech: fast and bright') && !final.includes('he boxes') && !final.includes('speaks only when he asks.\n- Wants'));
    assert.ok(U.coherenceSystemPrompt('Leon').includes('A splice') && U.coherenceSystemPrompt('Leon').includes('Add no facts'));
});
