// Card Updater for SillyTavern.
// Drafts updates to character cards from what has happened in the chat. You review every section
// before anything is saved, and the previous version is kept in the chat so it can be restored.

import { looksLikeCard, nameVariants, titleCase, mentionsAny } from './cardparse.js';
import {
    UPDATABLE, updatableRanges, sectionRanges, rangeBody, applyReplacements, canonPointBody, storyItems, filterForCharacter,
    chunkItems, trackerLines, storyDateFrom, logSystemPrompt, logUserPrompt, parseLog, systemPrompt, userPrompt, parseReply,
    matchRange, lineDiff, checkUpdate,
} from './updater.js';
import { send, testConnection, summaryceptionConnection, ModelError } from './connection.js';

const MODULE = 'cardUpdater';
const LOG = '[Card Updater]';
const MAX_VERSIONS = 5;
const CHUNK_CHARS = 24000; // about 6k tokens of story per log request
const PARALLEL = 3; // log requests sent at the same time

const DEFAULTS = Object.freeze({
    source: 'openai', // 'openai' (direct endpoint) | 'profile' | 'chat'
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    maxTokens: 32000,
    temperature: 0.8,
    logThinking: 'off', // reading the story into the log is listing, not reasoning
    updateThinking: 'default',
    profileId: '',
    firstRunMessages: 0, // without a Summaryception summary, the first run reads the last N messages (0 = all)
    sections: Object.fromEntries(UPDATABLE.map(([k]) => [k, true])),
    copiedFromSummaryception: false,
});

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    const firstLoad = !Object.keys(s).length;
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = typeof v === 'object' ? structuredClone(v) : v;
    }
    for (const [k] of UPDATABLE) if (s.sections[k] === undefined) s.sections[k] = true;
    if (firstLoad) s.settingsVersion = 2;
    if ((s.settingsVersion || 1) < 2) {
        // 0.5 was the first default; GLM's reasoning models loop more easily that low.
        if (s.temperature === 0.5) s.temperature = 0.8;
        s.settingsVersion = 2;
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

// ---------------------------------------------------------------- lorebooks and cards

function activeLorebooks() {
    const c = ctx();
    const names = new Set();
    if (c.chatMetadata?.world_info) names.add(c.chatMetadata.world_info);
    $('#world_info option:selected').each(function () {
        const t = $(this).text().trim();
        if (t) names.add(t);
    });
    const charWorld = c.characters?.[c.characterId]?.data?.extensions?.world;
    if (charWorld) names.add(charWorld);
    const all = new Set(c.getWorldInfoNames ? c.getWorldInfoNames() : []);
    return [...names].filter(n => !all.size || all.has(n));
}

function cardNames(entry) {
    const names = new Set();
    const add = (raw) => nameVariants(raw).forEach(n => names.add(n));
    for (const k of Array.isArray(entry.key) ? entry.key : []) {
        const key = String(k ?? '').trim();
        if (key && !key.startsWith('/')) add(key);
    }
    add(entry.comment || '');
    const first = (String(entry.content ?? '').split(/\r?\n/).find(l => l.trim()) || '').trim();
    if (/^#{1,6}\s/.test(first)) add(first.replace(/^#+\s*/, ''));
    return [...names];
}

async function loadCards(worlds) {
    const c = ctx();
    const cards = [];
    for (const world of worlds) {
        let data;
        try {
            data = await c.loadWorldInfo(world);
        } catch (err) {
            console.warn(LOG, 'could not load lorebook', world, err);
            continue;
        }
        for (const [uid, e] of Object.entries(data?.entries || {})) {
            if (!e || typeof e.content !== 'string' || !looksLikeCard(e.content)) continue;
            const names = cardNames(e);
            const title = String(e.comment || (names[0] ? titleCase(names[0]) : `Entry ${uid}`));
            cards.push({ world, uid: String(uid), title, names, disabled: !!e.disable });
        }
    }
    return cards;
}

function countMentions(text, names) {
    let n = 0;
    for (const line of String(text).split('\n')) if (mentionsAny(line, names)) n++;
    return n;
}

// ---------------------------------------------------------------- data kept in the chat

function chatStore() {
    const md = ctx().chatMetadata;
    if (!md[MODULE] || typeof md[MODULE] !== 'object') md[MODULE] = {};
    if (!md[MODULE].versions) md[MODULE].versions = {};
    if (!md[MODULE].logs) md[MODULE].logs = {};
    return md[MODULE];
}

function versionStore() {
    return chatStore().versions;
}

/** A card's log: lines of what happened to the character, the message it covers up to, and how many lines the card holds. */
function getLog(key) {
    const l = chatStore().logs[key];
    return l && Array.isArray(l.lines) ? l : null;
}

async function keepVersion(card, content, storyDate) {
    const store = versionStore();
    const key = `${card.world}|${card.uid}`;
    const list = store[key] || [];
    list.unshift({ title: card.title, world: card.world, uid: card.uid, at: new Date().toISOString(), message: ctx().chat?.length ?? 0, storyDate: storyDate || '', content });
    store[key] = list.slice(0, MAX_VERSIONS);
    await ctx().saveMetadata();
}

async function writeEntry(world, uid, content) {
    const c = ctx();
    const data = await c.loadWorldInfo(world);
    if (!data?.entries?.[uid]) throw new Error(`Entry ${uid} is no longer in ${world}.`);
    data.entries[uid].content = content;
    await c.saveWorldInfo(world, data, true);
    try {
        c.reloadWorldInfoEditor?.(world, false);
    } catch { /* editor not open */ }
}

async function readEntry(world, uid) {
    const data = await ctx().loadWorldInfo(world);
    return data?.entries?.[uid]?.content ?? null;
}

// ---------------------------------------------------------------- planning

function approxTokens(chars) {
    return Math.round(chars / 3.8);
}

/** What a card's run will read: the story pieces involving them since their log ends, in chunks. */
function planCard(card, rebuild) {
    const c = ctx();
    const s = settings();
    const key = `${card.world}|${card.uid}`;
    const log = rebuild ? null : getLog(key);
    const since = log && Number.isInteger(log.coveredTo) ? log.coveredTo : null;
    const { items, end } = storyItems(c.chat, c.chatMetadata?.summaryception, { userName: c.name1, since, firstRunMessages: Number(s.firstRunMessages) || 0 });
    const kept = filterForCharacter(items, card.names);
    const chunks = chunkItems(kept, CHUNK_CHARS);
    const pending = log ? log.lines.length - (log.applied || 0) : 0;
    return { key, log, since, end, chunks, pending, readChars: chunks.reduce((a, ch) => a + ch.text.length, 0) };
}

function planText(card, plan) {
    const parts = [];
    if (plan.chunks.length) {
        const from = plan.since === null ? 'the whole story' : `the story after message #${plan.since}`;
        parts.push(`reads ${from}: ${plan.chunks.length} part${plan.chunks.length === 1 ? '' : 's'}, about ${approxTokens(plan.readChars).toLocaleString()} tokens`);
    } else {
        parts.push(plan.since === null ? 'nothing in the story names them' : `nothing new since message #${plan.since}`);
    }
    if (plan.pending) parts.push(`${plan.pending} logged line${plan.pending === 1 ? '' : 's'} not in the card yet`);
    if (plan.log) parts.push(`log has ${plan.log.lines.length} line${plan.log.lines.length === 1 ? '' : 's'}`);
    return `${card.title}: ${parts.join(' · ')}`;
}

/** Sends once, and once more if the model got stuck or ran out of tokens. */
async function sendWithRetry(s, system, user, opts) {
    try {
        return await send(s, system, user, opts);
    } catch (err) {
        if (opts.signal?.aborted || !(err instanceof ModelError) || !err.retryable) throw err;
        console.warn(LOG, 'retrying after:', err.message);
        if (opts.onRetry) opts.onRetry(err);
        return await send(s, system, user, opts);
    }
}

function errorHtml(prefix, err, signal) {
    if (signal?.aborted) return '<div class="cu-warn">Cancelled.</div>';
    const tail = err?.reasoningTail ? `<details><summary>End of the model's thinking</summary><pre class="cu-pre">${esc(err.reasoningTail)}</pre></details>` : '';
    return `<div class="cu-warn">${esc(prefix)}: ${esc(err?.message || err)}${err instanceof ModelError && err.retryable ? ' (tried twice)' : ''}</div>${tail}`;
}

/** Runs async tasks a few at a time; results come back in order. */
async function runPool(tasks, limit) {
    const results = new Array(tasks.length);
    let next = 0;
    let failed = null;
    const worker = async () => {
        while (next < tasks.length && !failed) {
            const i = next++;
            try {
                results[i] = await tasks[i]();
            } catch (err) {
                failed = failed || err;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    if (failed) throw failed;
    return results;
}

// ---------------------------------------------------------------- the update window

function sectionChips(s) {
    return UPDATABLE.map(([k, label]) => `<label class="checkbox_label cu-chip"><input type="checkbox" data-section="${k}"${s.sections[k] ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('');
}

async function openUpdater() {
    const c = ctx();
    const s = settings();
    if (!c.chat?.length) {
        toastr.info('Open a chat first.', 'Card Updater');
        return;
    }
    const allWorlds = c.getWorldInfoNames ? c.getWorldInfoNames() : [];
    const active = activeLorebooks();
    const hasSummary = (c.chatMetadata?.summaryception?.layers || []).some(l => Array.isArray(l) && l.length);
    const storyDate = storyDateFrom(c.chat);
    const storyText = storyItems(c.chat, c.chatMetadata?.summaryception, { userName: c.name1 }).items.map(x => x.text).join('\n');

    const root = $(`<div class="card-updater-window">
        <h3>Update character cards</h3>
        <div class="cu-muted">First the story is read in parts and turned into a short log of what happened to each character; then the card is updated from that log. Logs are kept in this chat, so next time only the new part of the story is read.${hasSummary ? ' Uses the Summaryception summary where the chat has been summarised.' : ''}${storyDate ? ` Story date: <b>${esc(storyDate)}</b>.` : ''}</div>
        <div class="cu-row"><label>Lorebook</label><select class="text_pole cu-world"></select></div>
        <div class="cu-row cu-buttons"><div class="menu_button cu-select-story">Select everyone in the story</div><div class="menu_button cu-select-none">Clear</div></div>
        <div class="cu-cards"></div>
        <div class="cu-label">Sections to update</div>
        <div class="cu-chips">${sectionChips(s)}</div>
        <label class="checkbox_label cu-rebuild"><input type="checkbox" class="cu-rebuild-box"><span>Rebuild the ticked cards' logs from the start of the story</span></label>
        <div class="cu-plan cu-muted"></div>
        <div class="cu-row cu-buttons"><div class="menu_button cu-draft">Draft updates</div><div class="menu_button cu-stop" style="display:none">Stop after this card</div></div>
        <div class="cu-status cu-muted"></div>
        <div class="cu-results"></div>
    </div>`);

    const worldSel = root.find('.cu-world');
    worldSel.append(`<option value="__active__">Active lorebooks for this chat (${active.length})</option>`);
    for (const w of allWorlds) worldSel.append(`<option value="${esc(w)}">${esc(w)}</option>`);

    let cards = [];
    const chosenCards = () => root.find('[data-card]:checked').toArray().map(el => cards[Number(el.dataset.card)]).filter(Boolean);
    const rebuild = () => root.find('.cu-rebuild-box').prop('checked');
    const renderPlan = () => {
        const chosen = chosenCards();
        if (!chosen.length) {
            root.find('.cu-plan').html('');
            return;
        }
        root.find('.cu-plan').html(chosen.map(card => `<div>${esc(planText(card, planCard(card, rebuild())))}</div>`).join(''));
    };
    const renderCards = async () => {
        const v = String(worldSel.val());
        const worlds = v === '__active__' ? active : [v];
        root.find('.cu-cards').html('<div class="cu-muted">Loading…</div>');
        cards = await loadCards(worlds);
        if (!cards.length) {
            root.find('.cu-cards').html('<div class="cu-muted">No character cards found. Cards are entries with all-caps sections like SPEECH AND VOICE and PERSONALITY.</div>');
            renderPlan();
            return;
        }
        const groups = new Map();
        for (const card of cards) {
            card.mentions = countMentions(storyText, card.names);
            if (!groups.has(card.world)) groups.set(card.world, []);
            groups.get(card.world).push(card);
        }
        let html = '';
        for (const [world, list] of groups) {
            html += `<div class="cu-group">${esc(world)}</div>`;
            list.sort((a, b) => b.mentions - a.mentions || a.title.localeCompare(b.title));
            for (const card of list) {
                const i = cards.indexOf(card);
                const log = getLog(`${card.world}|${card.uid}`);
                const seen = card.mentions ? `in ${card.mentions} line${card.mentions === 1 ? '' : 's'} of the story` : 'not in the story';
                const logged = log && Number.isInteger(log.coveredTo) ? ` · logged up to message #${log.coveredTo}` : '';
                html += `<label class="checkbox_label cu-card"><input type="checkbox" data-card="${i}"><span>${esc(card.title)}</span><span class="cu-muted">${seen}${logged}${card.disabled ? ' · disabled entry' : ''}</span></label>`;
            }
        }
        root.find('.cu-cards').html(html);
        root.find('[data-card]').on('change', renderPlan);
        renderPlan();
    };
    worldSel.on('change', renderCards);
    await renderCards();

    root.find('.cu-select-story').on('click', () => {
        root.find('[data-card]').each(function () {
            const card = cards[Number(this.dataset.card)];
            this.checked = !!card && card.mentions > 0;
        });
        renderPlan();
    });
    root.find('.cu-select-none').on('click', () => {
        root.find('[data-card]').prop('checked', false);
        renderPlan();
    });
    root.find('.cu-rebuild-box').on('change', renderPlan);
    root.find('[data-section]').on('change', function () {
        s.sections[this.dataset.section] = this.checked;
        save();
    });

    let running = false;
    let stopAfter = false;
    const abort = new AbortController();
    root.find('.cu-stop').on('click', () => {
        stopAfter = true;
        root.find('.cu-status').text('Stopping after this card…');
    });
    root.find('.cu-draft').on('click', async () => {
        if (running) return;
        const chosen = chosenCards();
        const kinds = UPDATABLE.filter(([k]) => s.sections[k]).map(([k]) => k);
        if (!chosen.length) return toastr.info('Tick at least one card.', 'Card Updater');
        if (!kinds.length) return toastr.info('Tick at least one section.', 'Card Updater');
        running = true;
        stopAfter = false;
        root.find('.cu-draft').addClass('disabled');
        root.find('.cu-stop').show();
        const doRebuild = rebuild();
        for (let i = 0; i < chosen.length; i++) {
            if (stopAfter || abort.signal.aborted) break;
            const block = $('<div class="cu-result"></div>').appendTo(root.find('.cu-results'));
            await runCard(chosen[i], kinds, doRebuild, s, block, root.find('.cu-status'), abort.signal, `${i + 1}/${chosen.length}`);
        }
        running = false;
        root.find('.cu-draft').removeClass('disabled');
        root.find('.cu-stop').hide();
        root.find('.cu-rebuild-box').prop('checked', false);
        renderPlan();
        root.find('.cu-status').text(stopAfter ? 'Stopped.' : 'Done. Review each card below and save what you want to keep.');
    });

    const popup = new c.Popup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', allowVerticalScrolling: true, leftAlign: true });
    await popup.show();
    abort.abort();
}

function cardHead(card, extra = '') {
    return `<div class="cu-card-title">${esc(card.title)} <span class="cu-muted">${esc(card.world)}${extra ? ` · ${esc(extra)}` : ''}</span></div>`;
}

async function runCard(card, kinds, rebuild, s, block, status, signal, counter) {
    const c = ctx();
    const started = Date.now();
    const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`;
    const content = await readEntry(card.world, card.uid);
    if (content === null) {
        block.html(`${cardHead(card)}<div class="cu-warn">Entry not found.</div>`);
        return;
    }
    const ranges = updatableRanges(content, new Set(kinds));
    if (!ranges.length) {
        block.html(`${cardHead(card)}<div class="cu-muted">This card has none of the ticked sections.</div>`);
        return;
    }

    // Step 1: read the new part of the story into the character's log.
    const plan = planCard(card, rebuild);
    const log = plan.log ? structuredClone(plan.log) : { coveredTo: null, lines: [], applied: 0 };
    if (plan.chunks.length) {
        let done = 0;
        const show = () => status.text(`${card.title} (${counter}): reading the story, ${done} of ${plan.chunks.length} part${plan.chunks.length === 1 ? '' : 's'} done… ${elapsed()}`);
        show();
        const tick = setInterval(show, 1000);
        const sys = logSystemPrompt(card.title, c.name1);
        const tasks = plan.chunks.map(chunk => async () => {
            const firstMsg = chunk.items.find(x => x.kind === 'message' || x.from >= 0);
            const lastDate = firstMsg && firstMsg.from > 0 ? storyDateFrom(c.chat, firstMsg.from - 1) : '';
            const reply = await sendWithRetry(s, sys, logUserPrompt({ name: card.title, names: card.names, text: chunk.text, lastDate }), { signal, reasoning: s.logThinking });
            done++;
            return parseLog(reply);
        });
        let parts;
        try {
            parts = await runPool(tasks, PARALLEL);
        } catch (err) {
            clearInterval(tick);
            console.error(LOG, err);
            block.html(`${cardHead(card, elapsed())}${errorHtml('Reading the story failed', err, signal)}<div class="cu-muted">Nothing was saved to the log, so the next run starts from the same place.</div>`);
            return;
        }
        clearInterval(tick);
        if (rebuild) {
            log.lines = [];
            log.applied = 0;
        }
        for (const lines of parts) log.lines.push(...lines);
    }
    log.coveredTo = plan.end;
    chatStore().logs[plan.key] = log;
    await c.saveMetadata();

    const newLines = log.lines.slice(log.applied || 0);
    if (!newLines.length) {
        block.html(`${cardHead(card, elapsed())}<div class="cu-muted">Nothing new involving ${esc(card.title)} since the last update.</div>`);
        return;
    }

    // Step 2: update the card from the new log lines.
    const tick2 = setInterval(() => status.text(`${card.title} (${counter}): updating the card from ${newLines.length} log lines… ${elapsed()}`), 1000);
    status.text(`${card.title} (${counter}): updating the card from ${newLines.length} log lines…`);
    let reply;
    try {
        reply = await sendWithRetry(s, systemPrompt(c.name1), userPrompt({
            card: content, title: card.title, sections: ranges.map(r => r.title), log: newLines,
            trackers: trackerLines(c.chat, card.names), storyDate: storyDateFrom(c.chat),
        }), {
            signal,
            reasoning: s.updateThinking,
            onProgress: ({ contentChars, reasoningChars }) => status.text(`${card.title} (${counter}): updating the card… ${elapsed()} · thinking ${reasoningChars.toLocaleString()} chars · writing ${contentChars.toLocaleString()} chars`),
            onRetry: () => status.text(`${card.title} (${counter}): the model got stuck, trying once more…`),
        });
    } catch (err) {
        clearInterval(tick2);
        console.error(LOG, err);
        block.html(`${cardHead(card, elapsed())}${errorHtml('Updating the card failed', err, signal)}<div class="cu-muted">The log is saved, so the next run goes straight to this step.</div>${logDetails(newLines)}`);
        return;
    }
    clearInterval(tick2);
    const parsed = parseReply(reply);
    renderReview(card, content, ranges, parsed, storyDateFrom(c.chat) || parsed.storyDate, block, elapsed(), reply, { key: plan.key, appliedTo: log.lines.length, newLines });
}

function logDetails(lines) {
    return `<details><summary>Log lines used (${lines.length})</summary><pre class="cu-pre">${esc(lines.join('\n'))}</pre></details>`;
}

function diffHtml(oldBody, newBody) {
    return lineDiff(oldBody, newBody).map((d) => {
        const cls = d.type === 'add' ? 'cu-add' : d.type === 'del' ? 'cu-del' : 'cu-same';
        const mark = d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ';
        return `<div class="${cls}">${esc(mark + d.line)}</div>`;
    }).join('');
}

function renderReview(card, content, ranges, parsed, storyDate, block, took, rawReply, logInfo) {
    const lines = content.split(/\r?\n/);
    const items = [];
    const unplaced = [];
    for (const u of parsed.updates) {
        const r = matchRange(ranges, u.heading);
        if (!r) {
            unplaced.push(u.heading);
            continue;
        }
        if (items.some(x => x.range === r)) continue;
        const oldBody = rangeBody(lines, r);
        if (oldBody.trim() === u.text.trim()) continue;
        items.push({ range: r, kind: r.kind, title: r.title, reason: u.reason, oldBody, newBody: u.text, accept: r.kind !== 'personality' });
    }

    const head = cardHead(card, took);
    const tail = `${logDetails(logInfo.newLines)}<details><summary>Model reply</summary><pre class="cu-pre">${esc(rawReply)}</pre></details>`;
    if (!items.length) {
        const why = parsed.none ? 'Nothing in the log changes this card.' : 'No usable changes in the reply.';
        block.html(`${head}<div class="cu-muted">${why}${unplaced.length ? ` Could not place: ${esc(unplaced.join(', '))}.` : ''}</div>
            <div class="cu-row cu-buttons"><div class="menu_button cu-mark">Mark these log lines as done</div></div>${tail}`);
        block.find('.cu-mark').on('click', async () => {
            const log = getLog(logInfo.key);
            if (log) log.applied = Math.max(log.applied || 0, logInfo.appliedTo);
            await ctx().saveMetadata();
            block.find('.cu-mark').replaceWith('<div class="cu-ok">Done. Next time only newer lines are used.</div>');
        });
        return;
    }

    const canon = sectionRanges(content).find(r => r.kind === 'canon' && !r.inline);
    let canonItem = null;
    if (canon && storyDate) {
        const oldBody = rangeBody(lines, canon);
        const newBody = canonPointBody(oldBody, storyDate);
        if (newBody !== oldBody) canonItem = { range: canon, kind: 'canon', title: canon.title, reason: `Marks the card as updated to ${storyDate}.`, oldBody, newBody, accept: true };
    }
    const all = canonItem ? [...items, canonItem] : items;

    const render = () => {
        let html = head;
        if (unplaced.length) html += `<div class="cu-warn">Could not place: ${esc(unplaced.join(', '))}.</div>`;
        all.forEach((it, i) => {
            const warnings = it.kind === 'canon' ? [] : checkUpdate(it.kind, it.oldBody, it.newBody);
            html += `<div class="cu-item">
                <label class="checkbox_label"><input type="checkbox" data-accept="${i}"${it.accept ? ' checked' : ''}><b>${esc(it.title)}</b></label>
                ${it.reason ? `<div class="cu-muted">${esc(it.reason)}</div>` : ''}
                ${warnings.map(w => `<div class="cu-warn">${esc(w)}</div>`).join('')}
                <div class="cu-diff">${diffHtml(it.oldBody, it.newBody)}</div>
                <details><summary>Edit before saving</summary><textarea class="text_pole cu-edit" data-edit="${i}" rows="10">${esc(it.newBody)}</textarea></details>
            </div>`;
        });
        html += `<div class="cu-row cu-buttons"><div class="menu_button cu-save">Save ticked sections</div></div>${tail}`;
        block.html(html);
        block.find('[data-accept]').on('change', function () { all[Number(this.dataset.accept)].accept = this.checked; });
        block.find('[data-edit]').on('change', function () {
            all[Number(this.dataset.edit)].newBody = this.value.replace(/\s+$/, '');
            render();
        });
        block.find('.cu-save').on('click', () => saveReview(card, content, all, storyDate, block, logInfo));
    };
    render();
}

async function saveReview(card, content, items, storyDate, block, logInfo) {
    const chosen = items.filter(it => it.accept);
    if (!chosen.length || (chosen.length === 1 && chosen[0].kind === 'canon')) {
        toastr.info('Tick at least one section to save.', 'Card Updater');
        return;
    }
    try {
        const current = await readEntry(card.world, card.uid);
        if (current !== content) {
            toastr.warning(`${card.title} was changed since it was drafted. Draft it again.`, 'Card Updater');
            return;
        }
        const updated = applyReplacements(content, chosen.map(it => ({ start: it.range.start, end: it.range.end, body: it.newBody })));
        await keepVersion(card, content, storyDate);
        await writeEntry(card.world, card.uid, updated);
        const log = getLog(logInfo.key);
        if (log) {
            log.applied = Math.max(log.applied || 0, logInfo.appliedTo);
            await ctx().saveMetadata();
        }
        block.find('.cu-save').replaceWith(`<div class="cu-ok">Saved ${chosen.length} section${chosen.length === 1 ? '' : 's'}. The previous version is kept under Versions.</div>`);
        block.find('.cu-item input, .cu-item textarea').prop('disabled', true);
        toastr.success(`${card.title} updated.`, 'Card Updater');
    } catch (err) {
        console.error(LOG, err);
        toastr.error(`Saving failed: ${err?.message || err}`, 'Card Updater');
    }
}

// ---------------------------------------------------------------- versions window

async function openVersions() {
    const c = ctx();
    if (!c.chat?.length) return toastr.info('Open a chat first.', 'Card Updater');
    const store = versionStore();
    const keys = Object.keys(store).filter(k => store[k]?.length);
    const root = $('<div class="card-updater-window"><h3>Card versions kept in this chat</h3><div class="cu-list"></div></div>');
    const render = () => {
        if (!keys.length) {
            root.find('.cu-list').html('<div class="cu-muted">No updates saved in this chat yet.</div>');
            return;
        }
        let html = '';
        for (const key of keys) {
            const list = store[key];
            html += `<div class="cu-group">${esc(list[0].title)} <span class="cu-muted">${esc(list[0].world)}</span></div>`;
            list.forEach((v, i) => {
                const when = new Date(v.at).toLocaleString();
                html += `<div class="cu-version"><span>Before the update on ${esc(when)}${v.storyDate ? ` (story: ${esc(v.storyDate)})` : ''}</span>
                    <div class="menu_button cu-restore" data-key="${esc(key)}" data-i="${i}">Restore</div>
                    <details><summary>Show</summary><pre class="cu-pre">${esc(v.content)}</pre></details></div>`;
            });
        }
        root.find('.cu-list').html(html);
        root.find('.cu-restore').on('click', async function () {
            const v = store[this.dataset.key]?.[Number(this.dataset.i)];
            if (!v) return;
            try {
                const current = await readEntry(v.world, v.uid);
                if (current === null) throw new Error('The entry is no longer in the lorebook.');
                await keepVersion({ world: v.world, uid: v.uid, title: v.title }, current, '');
                await writeEntry(v.world, v.uid, v.content);
                toastr.success(`${v.title} restored. The version it replaced is kept too.`, 'Card Updater');
                render();
            } catch (err) {
                toastr.error(`Restore failed: ${err?.message || err}`, 'Card Updater');
            }
        });
    };
    render();
    await new c.Popup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', allowVerticalScrolling: true, leftAlign: true }).show();
}

// ---------------------------------------------------------------- settings panel

function thinkingOptions() {
    return [['default', 'Model default'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]
        .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

function settingsHtml() {
    return `
<div id="card_updater_settings" class="card-updater">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Card Updater</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="cu-row cu-buttons">
        <div id="cu_open" class="menu_button">Update cards…</div>
        <div id="cu_versions" class="menu_button">Versions…</div>
      </div>
      <label for="cu_source">Connection source</label>
      <select id="cu_source" class="text_pole">
        <option value="openai">OpenAI Compatible (direct)</option>
        <option value="profile">Connection Profile</option>
        <option value="chat">The chat's connection</option>
      </select>
      <div class="cu-source" data-for="openai">
        <label for="cu_url">Endpoint URL</label>
        <input id="cu_url" class="text_pole" type="text" placeholder="https://openrouter.ai/api/v1/chat/completions">
        <label for="cu_key">API Key</label>
        <input id="cu_key" class="text_pole" type="password" autocomplete="off">
        <label for="cu_model">Model name</label>
        <input id="cu_model" class="text_pole" type="text" placeholder="z-ai/glm-5.3">
        <div class="cu-grid">
          <label for="cu_max">Max tokens</label><input id="cu_max" class="text_pole" type="number" min="0" step="1000">
          <label for="cu_temp">Temperature</label><input id="cu_temp" class="text_pole" type="number" min="0" max="2" step="0.05">
        </div>
        <div class="cu-grid">
          <label for="cu_think_log" title="Reading the story is listing events, so thinking can stay off. Sent to OpenRouter as its reasoning setting.">Thinking while reading the story</label>
          <select id="cu_think_log" class="text_pole">${thinkingOptions()}</select>
          <label for="cu_think_update" title="Sent to OpenRouter as its reasoning setting.">Thinking while updating the card</label>
          <select id="cu_think_update" class="text_pole">${thinkingOptions()}</select>
        </div>
        <div class="cu-row cu-buttons">
          <div id="cu_copy_sc" class="menu_button">Copy from Summaryception</div>
          <div id="cu_test" class="menu_button">Test connection</div>
        </div>
        <div class="cu-muted">Sends only the card, the story and the update instructions. Local servers need <code>enableCorsProxy: true</code> in config.yaml; cloud APIs like OpenRouter work without it.</div>
      </div>
      <div class="cu-source" data-for="profile">
        <label for="cu_profile">Connection Profile</label>
        <select id="cu_profile" class="text_pole"></select>
        <div class="cu-row cu-buttons"><div id="cu_test_profile" class="menu_button">Test connection</div></div>
      </div>
      <div class="cu-source" data-for="chat">
        <div class="cu-muted">Uses the chat's model and sampler settings, without your preset's prompts.</div>
      </div>
      <div class="cu-grid">
        <label for="cu_first" title="Only for a chat with no Summaryception summary: how many of the newest messages a card's first run reads. 0 reads the whole chat.">First run without a summary: newest messages read (0 = all)</label>
        <input id="cu_first" class="text_pole" type="number" min="0" step="50">
      </div>
      <div id="cu_test_result" class="cu-muted"></div>
    </div>
  </div>
</div>`;
}

function showSource(source) {
    $('#card_updater_settings .cu-source').each(function () {
        $(this).toggle(this.dataset.for === source);
    });
}

function fillDirectFields(s) {
    $('#cu_url').val(s.apiUrl);
    $('#cu_key').val(s.apiKey);
    $('#cu_model').val(s.apiModel);
    $('#cu_max').val(s.maxTokens);
}

function bindSettings() {
    const c = ctx();
    const s = settings();

    if (!s.copiedFromSummaryception && !s.apiUrl) {
        const sc = summaryceptionConnection();
        if (sc) {
            Object.assign(s, { apiUrl: sc.apiUrl, apiKey: sc.apiKey, apiModel: sc.apiModel, maxTokens: sc.maxTokens || s.maxTokens });
            s.copiedFromSummaryception = true;
            save();
        }
    }

    $('#cu_source').val(s.source).on('change', function () {
        s.source = this.value;
        showSource(s.source);
        save();
    });
    showSource(s.source);
    fillDirectFields(s);
    $('#cu_url').on('input', function () { s.apiUrl = this.value.trim(); save(); });
    $('#cu_key').on('input', function () { s.apiKey = this.value.trim(); save(); });
    $('#cu_model').on('input', function () { s.apiModel = this.value.trim(); save(); });
    $('#cu_max').on('input', function () { s.maxTokens = Math.max(0, parseInt(this.value, 10) || 0); save(); });
    $('#cu_think_log').val(s.logThinking).on('change', function () { s.logThinking = this.value; save(); });
    $('#cu_think_update').val(s.updateThinking).on('change', function () { s.updateThinking = this.value; save(); });
    $('#cu_temp').val(s.temperature).on('input', function () { const v = parseFloat(this.value); s.temperature = Number.isFinite(v) ? v : 0.5; save(); });
    $('#cu_first').val(s.firstRunMessages).on('input', function () { s.firstRunMessages = Math.max(0, parseInt(this.value, 10) || 0); save(); });

    $('#cu_copy_sc').on('click', () => {
        const sc = summaryceptionConnection();
        if (!sc) return toastr.info('Summaryception has no OpenAI-compatible connection saved.', 'Card Updater');
        Object.assign(s, { apiUrl: sc.apiUrl, apiKey: sc.apiKey, apiModel: sc.apiModel, maxTokens: sc.maxTokens || s.maxTokens });
        fillDirectFields(s);
        save();
        toastr.success('Copied. Change the model if you want a stronger one for card updates.', 'Card Updater');
    });
    const runTest = async () => {
        $('#cu_test_result').text('Testing…');
        try {
            const reply = await testConnection(s);
            $('#cu_test_result').text(`Connected. Reply: "${reply}"`);
        } catch (err) {
            $('#cu_test_result').text(`Failed: ${err?.message || err}`);
        }
    };
    $('#cu_test, #cu_test_profile').on('click', runTest);

    try {
        c.ConnectionManagerRequestService.handleDropdown('#cu_profile', s.profileId, (profile) => {
            s.profileId = profile?.id || '';
            save();
        });
    } catch (err) {
        $('#cu_profile').replaceWith('<div class="cu-muted">Connection Profiles are not available (the Connection Manager extension is off).</div>');
    }

    $('#cu_open').on('click', () => openUpdater().catch(err => {
        console.error(LOG, err);
        toastr.error(String(err?.message || err), 'Card Updater');
    }));
    $('#cu_versions').on('click', () => openVersions().catch(err => {
        console.error(LOG, err);
        toastr.error(String(err?.message || err), 'Card Updater');
    }));
}

jQuery(() => {
    settings();
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    console.log(LOG, 'loaded');
});
