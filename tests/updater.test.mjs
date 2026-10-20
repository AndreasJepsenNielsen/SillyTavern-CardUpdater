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

test('story: summary deepest layer first, then unsummarised chat, then trackers and date', () => {
    const chat = [
        { is_user: false, name: 'Narrator', mes: 'old', extra: { sc_ghosted: true } },
        { is_user: true, mes: 'old 2', extra: { sc_ghosted: true } },
        { is_user: false, name: 'Narrator', mes: '[ 🕰️ 9:00 AM | 🗓️ Day 3 - Monday 14 October | 📍 Hall ]\nRue waves.\n<!-- GFX_START --><internal_states><details><summary>📓 GM NOTEBOOK</summary>\n1. [R] Rue knows Leon paints.\n</details></internal_states><!-- GFX_END -->' },
        { is_user: true, mes: 'I wave back.' },
        { is_user: false, is_system: true, mes: 'hidden note' },
    ];
    const store = { layers: [[{ text: 'L0 recent summary.' }], [{ text: 'L1 older summary.' }]], summarizedUpTo: 1 };
    const s = U.gatherStory(chat, store, { userName: 'Leon Kennedy' });
    assert.equal(s.summary, 'L1 older summary.\n\nL0 recent summary.');
    assert.ok(s.recent.startsWith('[#2] Narrator: [ 🕰️ 9:00 AM'));
    assert.ok(s.recent.includes('[#3] Leon Kennedy: I wave back.'));
    assert.ok(!s.recent.includes('GM NOTEBOOK'), 'state block not in the chat text');
    assert.ok(!s.recent.includes('hidden note'));
    assert.ok(s.state.includes('## 📓 GM NOTEBOOK') && s.state.includes('Rue knows Leon paints.'));
    assert.equal(s.storyDate, 'Day 3 - Monday 14 October');
    const noSummary = U.gatherStory(chat, null, { userName: 'Leon', fallbackMessages: 2 });
    assert.equal(noSummary.hasSummary, false);
    assert.ok(noSummary.recent.startsWith('[#3] Leon: I wave back.'));
});

test('prompts mention the player by name and list the sections', () => {
    assert.ok(U.systemPrompt('Leon Kennedy').includes('their entry for Leon Kennedy under RELATIONSHIPS'));
    const up = U.userPrompt({ card: 'X', title: 'Rue Bennett', sections: ['HISTORY', 'RELATIONSHIPS'], story: { summary: 's', recent: 'r', state: 't', storyDate: 'Day 3' }, userName: 'Leon' });
    assert.ok(up.includes('SECTIONS YOU MAY UPDATE: HISTORY, RELATIONSHIPS'));
    assert.ok(up.includes('CURRENT STORY DATE: Day 3'));
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
        'data: [DONE]\n',
    ];
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    let last = null;
    const text = await readStream({ body }, (p) => { last = p; });
    assert.equal(text, '<update>ok</update>');
    assert.equal(last.reasoningChars, 4);
});
