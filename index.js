// Card Updater for SillyTavern.
// Drafts updates to character cards from what has happened in the chat, as a list of changes to single lines.
// Each change is checked against the story and can be ticked on its own; the previous version is kept in the chat.

import { looksLikeCard, nameVariants, titleCase, mentionsAny, stringHash } from './cardparse.js';
import {
    UPDATABLE, updatableRanges, sectionRanges, rangeBody, applyReplacements, canonPointBody, storyItems, filterForCharacter,
    chunkItems, trackerLines, storyDateFrom, logSystemPrompt, logUserPrompt, parseLog, systemPrompt, userPrompt, parseReply,
    matchRange, lineDiff, checkUpdate, markNewLines, stripNewMarks, lostOriginalLines, tightenSystemPrompt, tightenUserPrompt,
    checkSystemPrompt, checkUserPrompt, parseCheck, findRepeats, lineLabels,
    numberCard, sectionSpans, parseOps, resolveOps, applyOps, normalizeLogLines, opsCheckSystemPrompt, opsCheckUserPrompt,
    parseOpsCheck, fixSystemPrompt, fixUserPrompt, opWarnings, opRepeats, wordDiff,
    storyDates, storyDaysNote, editableRanges, sweepSystemPrompt, sweepUserPrompt, personaEntryLines,
} from './updater.js';
import { send, testConnection, summaryceptionConnection, ModelError, ThinkingRequiredError } from './connection.js';

const MODULE = 'cardUpdater';
const VERSION = '0.7.0'; // keep in step with manifest.json
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
    logThinking: 'medium', // low thinking mixed up who did what
    updateThinking: 'high',
    checkThinking: 'medium',
    updateModel: '', // model for updating and tightening; empty = the same as for reading
    checkDrafts: true,
    fixDrafts: true, // send what the check finds back for fixing
    sweepDrafts: true, // one pass over every line for what is no longer true
    cardLimit: 5000, // tokens; the template's limit for a lead
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
    if (firstLoad) s.settingsVersion = 5;
    if ((s.settingsVersion || 1) < 2) {
        // 0.5 was the first default; GLM's reasoning models loop more easily that low.
        if (s.temperature === 0.5) s.temperature = 0.8;
        s.settingsVersion = 2;
    }
    if (s.settingsVersion < 3) {
        // The model's default thinking ran long on the card update.
        if (s.updateThinking === 'default') s.updateThinking = 'medium';
        s.settingsVersion = 3;
    }
    if (s.settingsVersion < 4) {
        // Low thinking mixed up names in the log; every step gets at least Medium.
        if (['off', 'low', 'default'].includes(s.logThinking)) s.logThinking = 'medium';
        if (['off', 'low', 'default'].includes(s.updateThinking)) s.updateThinking = 'medium';
        s.settingsVersion = 4;
    }
    if (s.settingsVersion < 5) {
        // Updating a card is the hard step; it gets more room to think.
        if (s.updateThinking === 'medium') s.updateThinking = 'high';
        s.settingsVersion = 5;
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
            cards.push({ world, uid: String(uid), title, names, disabled: !!e.disable, tokens: approxTokens(e.content.length) });
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
    if (!md[MODULE].originals) md[MODULE].originals = {};
    if (!md[MODULE].saved) md[MODULE].saved = {};
    return md[MODULE];
}

/**
 * If the card was changed outside Card Updater since it last saved it (by hand, or in another chat), that text
 * becomes the card's original: Tighten then leaves those edits alone. Cards updated before this was tracked
 * count as changed once.
 * @returns {Promise<boolean>} whether the card was found changed
 */
async function syncBaseline(key, current) {
    const st = chatStore();
    const h = String(stringHash(current));
    if (st.saved[key] === h) return false;
    const known = st.saved[key] !== undefined || getOriginal(key) !== null;
    if (known) st.originals[key] = current;
    st.saved[key] = h;
    await ctx().saveMetadata();
    return known;
}

function editedNote(edited) {
    return edited ? '<div class="cu-muted">This card was changed outside Card Updater since its last update, so the current text now counts as its original: Tighten leaves those lines alone.</div>' : '';
}

/** The card as it was before its first update in this chat, for telling original lines from lines added in play. */
function getOriginal(key) {
    const st = chatStore();
    if (typeof st.originals[key] === 'string') return st.originals[key];
    const versions = st.versions[key];
    return versions?.length ? versions[versions.length - 1].content : null;
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
    const st = chatStore();
    if (typeof st.originals[key] !== 'string') st.originals[key] = getOriginal(key) ?? content;
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

function planText(card, plan, relog = false) {
    const parts = [];
    if (plan.chunks.length) {
        const from = plan.since === null ? 'the whole story' : `the story after message #${plan.since}`;
        parts.push(`reads ${from}: ${plan.chunks.length} part${plan.chunks.length === 1 ? '' : 's'}, about ${approxTokens(plan.readChars).toLocaleString()} tokens`);
    } else {
        parts.push(plan.since === null ? 'nothing in the story names them' : `nothing new since message #${plan.since}`);
    }
    if (relog && plan.log) parts.push(`updates from all ${plan.log.lines.length} logged lines`);
    else if (plan.pending) parts.push(`${plan.pending} logged line${plan.pending === 1 ? '' : 's'} not in the card yet`);
    if (plan.log) parts.push(`log has ${plan.log.lines.length} line${plan.log.lines.length === 1 ? '' : 's'}`);
    return `${card.title}: ${parts.join(' · ')}`;
}

/** Sends once, and once more if the model got stuck or ran out of tokens. */
async function sendWithRetry(s, system, user, opts) {
    // Models that can't think "off" (remembered per model) get Low instead.
    const modelName = opts.model || s.apiModel;
    if (opts.reasoning === 'off' && s.thinkingRequired?.[modelName]) opts = { ...opts, reasoning: 'low' };
    try {
        return await send(s, system, user, opts);
    } catch (err) {
        if (err instanceof ThinkingRequiredError) {
            s.thinkingRequired = { ...(s.thinkingRequired || {}), [modelName]: true };
            save();
            toastr.info(`${modelName} can't have thinking off, so Low is used for it.`, 'Card Updater');
            return sendWithRetry(s, system, user, { ...opts, reasoning: 'low' });
        }
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
        <h3>Update character cards <span class="cu-muted">v${VERSION}</span></h3>
        <div class="cu-muted">First the story is read in parts and turned into a short log of what happened to each character; then the card is updated from that log. Logs are kept in this chat, so next time only the new part of the story is read.${hasSummary ? ' Uses the Summaryception summary where the chat has been summarised.' : ''}${storyDate ? ` Story date: <b>${esc(storyDate)}</b>.` : ''}</div>
        <div class="cu-row"><label>Lorebook</label><select class="text_pole cu-world"></select></div>
        <div class="cu-row cu-buttons"><div class="menu_button cu-select-story">Select everyone in the story</div><div class="menu_button cu-select-none">Clear</div></div>
        <div class="cu-cards"></div>
        <div class="cu-label">Sections to update</div>
        <div class="cu-chips">${sectionChips(s)}</div>
        <label class="checkbox_label cu-rebuild"><input type="checkbox" class="cu-rebuild-box"><span>Rebuild the ticked cards' logs from the start of the story</span></label>
        <label class="checkbox_label cu-relog" title="For a card you restored or edited by hand: the update uses every line of its log, also the ones already marked as done. The story isn't read again."><input type="checkbox" class="cu-relog-box"><span>Update from the ticked cards' whole log again (the story isn't read again)</span></label>
        <label class="checkbox_label cu-original" title="Tighten may also condense lines from the card as it was before its first update: repeats, and old backstory down to one line per period. Those changes come flagged and unticked."><input type="checkbox" class="cu-original-box"><span>Tighten: also condense the original card (repeats and old backstory)</span></label>
        <div class="cu-plan cu-muted"></div>
        <div class="cu-row cu-buttons"><div class="menu_button cu-draft">Draft updates</div><div class="menu_button cu-tighten" title="Cut repeats and shorten lines that updates added. Lines from the original card are left alone.">Tighten ticked cards</div><div class="menu_button cu-stop" style="display:none">Stop after this card</div></div>
        <div class="cu-status cu-muted"></div>
        <div class="cu-results"></div>
    </div>`);

    const worldSel = root.find('.cu-world');
    worldSel.append(`<option value="__active__">Active lorebooks for this chat (${active.length})</option>`);
    for (const w of allWorlds) worldSel.append(`<option value="${esc(w)}">${esc(w)}</option>`);

    let cards = [];
    const chosenCards = () => root.find('[data-card]:checked').toArray().map(el => cards[Number(el.dataset.card)]).filter(Boolean);
    const rebuild = () => root.find('.cu-rebuild-box').prop('checked');
    const relog = () => root.find('.cu-relog-box').prop('checked');
    const renderPlan = () => {
        const chosen = chosenCards();
        if (!chosen.length) {
            root.find('.cu-plan').html('');
            return;
        }
        root.find('.cu-plan').html(chosen.map(card => `<div>${esc(planText(card, planCard(card, rebuild()), relog()))}</div>`).join(''));
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
                html += `<label class="checkbox_label cu-card"><input type="checkbox" data-card="${i}"><span>${esc(card.title)}</span><span class="cu-muted">≈${card.tokens.toLocaleString()} tokens${card.tokens > (Number(s.cardLimit) || Infinity) ? ' (over the limit)' : ''} · ${seen}${logged}${card.disabled ? ' · disabled entry' : ''}</span></label>`;
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
    root.find('.cu-rebuild-box, .cu-relog-box').on('change', renderPlan);
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
    const runAll = async (tighten) => {
        if (running) return;
        const chosen = chosenCards();
        const kinds = UPDATABLE.filter(([k]) => s.sections[k]).map(([k]) => k);
        if (!chosen.length) return toastr.info('Tick at least one card.', 'Card Updater');
        if (!kinds.length) return toastr.info('Tick at least one section.', 'Card Updater');
        running = true;
        stopAfter = false;
        root.find('.cu-draft, .cu-tighten').addClass('disabled');
        root.find('.cu-stop').show();
        const doRebuild = rebuild();
        const doRelog = relog();
        for (let i = 0; i < chosen.length; i++) {
            if (stopAfter || abort.signal.aborted) break;
            const block = $('<div class="cu-result"></div>').appendTo(root.find('.cu-results'));
            const counter = `${i + 1}/${chosen.length}`;
            if (tighten) await runTighten(chosen[i], kinds, s, block, root.find('.cu-status'), abort.signal, counter, root.find('.cu-original-box').prop('checked'));
            else await runCard(chosen[i], kinds, doRebuild, s, block, root.find('.cu-status'), abort.signal, counter, doRelog);
        }
        running = false;
        root.find('.cu-draft, .cu-tighten').removeClass('disabled');
        root.find('.cu-stop').hide();
        root.find('.cu-rebuild-box, .cu-relog-box').prop('checked', false);
        renderPlan();
        root.find('.cu-status').text(stopAfter ? 'Stopped.' : 'Done. Review each card below and save what you want to keep.');
    };
    root.find('.cu-draft').on('click', () => runAll(false));
    root.find('.cu-tighten').on('click', () => runAll(true));

    const popup = new c.Popup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', allowVerticalScrolling: true, leftAlign: true });
    await popup.show();
    abort.abort();
}

function cardHead(card, extra = '') {
    return `<div class="cu-card-title">${esc(card.title)} <span class="cu-muted">${esc(card.world)}${extra ? ` · ${esc(extra)}` : ''}</span></div>`;
}

async function runCard(card, kinds, rebuild, s, block, status, signal, counter, relog = false) {
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
    const edited = await syncBaseline(`${card.world}|${card.uid}`, content);

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

    const newLines = relog ? log.lines.slice() : log.lines.slice(log.applied || 0);
    if (!newLines.length) {
        block.html(`${cardHead(card, elapsed())}<div class="cu-muted">Nothing new involving ${esc(card.title)} since the last update.</div>`);
        return;
    }

    // Step 2: the model lists changes to single lines of the numbered card.
    const dates = storyDates(c.chat);
    const job = {
        card, content, ranges, dates,
        days: storyDaysNote(dates),
        numbered: numberCard(content),
        sections: sectionSpans(content, ranges),
        log: normalizeLogLines(newLines, dates),
        trackers: trackerLines(c.chat, card.names),
        storyDate: storyDateFrom(c.chat),
        tokens: approxTokens(content.length),
        limit: Number(s.cardLimit) || 0,
    };
    const progress = what => ({ contentChars, reasoningChars }) => status.text(`${card.title} (${counter}): ${what}… ${elapsed()} · thinking ${reasoningChars.toLocaleString()} chars · writing ${contentChars.toLocaleString()} chars`);
    status.text(`${card.title} (${counter}): updating the card from ${job.log.length} log lines…`);
    let reply;
    try {
        reply = await sendWithRetry(s, systemPrompt(c.name1), userPrompt({
            card: job.numbered, title: card.title, sections: job.sections, log: job.log,
            trackers: job.trackers, storyDate: job.storyDate, tokens: job.tokens, limit: job.limit, days: job.days,
        }), {
            signal,
            reasoning: s.updateThinking,
            model: s.updateModel,
            onProgress: progress('updating the card'),
            onRetry: () => status.text(`${card.title} (${counter}): the model got stuck, trying once more…`),
        });
    } catch (err) {
        console.error(LOG, err);
        block.html(`${cardHead(card, elapsed())}${errorHtml('Updating the card failed', err, signal)}<div class="cu-muted">The log is saved, so the next run goes straight to this step.</div>${logDetails(newLines)}`);
        return;
    }
    const parsed = parseOps(reply);
    let ops = resolveOps(content, parsed.ops.map((o, k) => ({ ...o, id: k + 1, source: 'update' })), ranges, { dates });
    const raws = [['Model reply', reply]];

    // Step 2b: every line of the card against what is true now; a change for each line that no longer is.
    let sweep = { ran: false };
    if (s.sweepDrafts && (ops.length || parsed.now.length)) {
        status.text(`${card.title} (${counter}): looking for lines that are no longer true…`);
        try {
            const sweepReply = await sendWithRetry(s, sweepSystemPrompt(c.name1), sweepUserPrompt({
                card: job.numbered, title: card.title, sections: job.sections, now: parsed.now, log: job.log,
                trackers: job.trackers, storyDate: job.storyDate, ops: ops.filter(o => !o.invalid),
                tokens: job.tokens, limit: job.limit, days: job.days,
            }), {
                signal,
                reasoning: s.updateThinking,
                model: s.updateModel,
                onProgress: progress('looking for lines that are no longer true'),
                onRetry: () => status.text(`${card.title} (${counter}): the model got stuck, trying once more…`),
            });
            raws.push(['Reply for lines no longer true', sweepReply]);
            const found = parseOps(sweepReply);
            const first = ops.length;
            ops = resolveOps(content, [...ops, ...found.ops.map((o, k) => ({ ...o, id: first + k + 1, source: 'sweep' }))], ranges, { dates });
            sweep = { ran: true, changes: found.ops.length };
        } catch (err) {
            if (signal?.aborted) {
                block.html(`${cardHead(card, elapsed())}<div class="cu-warn">Cancelled.</div>`);
                return;
            }
            console.error(LOG, err);
            sweep = { ran: true, failed: err?.message || String(err) };
        }
    }

    // Step 3: check the changes against the log and the card, fix what the check finds, check the fixes.
    let result;
    try {
        result = await checkAndFix(job, ops, { s, status, counter, signal, elapsed, progress });
    } catch (err) {
        block.html(`${cardHead(card, elapsed())}${errorHtml('Checking failed', err, signal)}`);
        return;
    }
    result.raws.unshift(...raws);
    result.sweep = sweep;
    renderOpsReview(job, result, parsed, block, { took: elapsed, logInfo: { key: plan.key, appliedTo: log.lines.length, newLines }, edited });
}

/**
 * The check pass over a list of changes, then the fix step for what it found, then a check of the fixes.
 * @returns {Promise<{ops: object[], dropped: object[], stale: object[], general: object[], check: object, fix: object, recheck: object, conflicts: string[], raws: [string, string][]}>}
 */
async function checkAndFix(job, firstOps, { s, status, counter, signal, elapsed, progress }) {
    const c = ctx();
    const title = job.card.title;
    const out = { ops: firstOps, dropped: [], stale: [], general: [], check: { ran: false }, fix: { ran: false }, recheck: { ran: false }, conflicts: [], raws: [] };
    const live = firstOps.filter(op => !op.invalid);
    if (!s.checkDrafts || !live.length) return out;
    const say = what => status?.text(`${title} (${counter}): ${what}… ${elapsed()}`);

    say('checking the changes');
    let found;
    try {
        const reply = await sendWithRetry(s, opsCheckSystemPrompt(c.name1), opsCheckUserPrompt({ card: job.numbered, title, ops: live, log: job.log, trackers: job.trackers }), {
            signal, reasoning: s.checkThinking, onProgress: progress('checking the changes'),
        });
        out.raws.push(['Check reply', reply]);
        found = parseOpsCheck(reply);
        out.check = found ? { ran: true, problems: found.problems.length, staleFound: found.stale.length } : { ran: true, failed: 'The check reply could not be read.' };
    } catch (err) {
        if (signal?.aborted) throw err;
        console.error(LOG, err);
        out.check = { ran: true, failed: err?.message || String(err) };
        return out;
    }
    if (!found) return out;
    for (const p of found.problems) {
        const op = live.find(o => o.id === p.id);
        if (op) (op.found ||= []).push({ kind: p.kind, text: p.text });
        else out.general.push(p);
    }
    const lines = job.content.split(/\r?\n/);
    const labels = lineLabels(job.content);
    const allowed = new Set();
    for (const r of job.ranges) for (let i = r.start + 1; i < r.end; i++) allowed.add(i);
    const editable = new Set();
    for (const r of editableRanges(job.content)) for (let i = r.start + 1; i < r.end; i++) editable.add(i);
    const touched = new Set(live.filter(o => o.type !== 'add').map(o => o.index));
    const staleSeen = new Set();
    out.stale = found.stale
        .filter(x => x.line >= 1 && x.line <= lines.length && lines[x.line - 1].trim() && !touched.has(x.line - 1) && !staleSeen.has(x.line) && staleSeen.add(x.line))
        .map(x => ({ line: x.line, text: x.text, label: labels[x.line - 1], quote: lines[x.line - 1].trim(), allowed: allowed.has(x.line - 1), editable: editable.has(x.line - 1) }));
    out.check.staleFound = out.stale.length;

    // Changes that couldn't be placed (quoted words not in the line, no such line) can be fixed too.
    const broken = firstOps.filter(o => o.invalid && /not in line|has no line|is blank/.test(o.invalid));
    for (const op of broken) op.found = [{ kind: 'placement', text: op.invalid }];
    const flagged = [...live.filter(op => op.found?.length), ...broken];
    const fixable = out.stale.filter(x => x.editable);
    if (!s.fixDrafts || (!flagged.length && !fixable.length)) return out;

    say(`fixing ${[flagged.length ? `${flagged.length} change${flagged.length === 1 ? '' : 's'}` : '', fixable.length ? `${fixable.length} stale line${fixable.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}`);
    let fixReply;
    try {
        fixReply = await sendWithRetry(s, fixSystemPrompt(c.name1), fixUserPrompt({
            card: job.numbered, title, sections: job.sections, log: job.log, trackers: job.trackers, storyDate: job.storyDate,
            ops: [...live, ...broken].sort((a, b) => a.id - b.id), problems: flagged.flatMap(op => op.found.map(f => ({ id: op.id, ...f }))), stale: fixable,
            tokens: job.tokens, limit: job.limit, days: job.days,
        }), { signal, reasoning: s.updateThinking, model: s.updateModel, onProgress: progress('fixing what the check found') });
        out.raws.push(['Fix reply', fixReply]);
    } catch (err) {
        if (signal?.aborted) throw err;
        console.error(LOG, err);
        out.fix = { ran: true, failed: err?.message || String(err) };
        return out;
    }
    const fx = parseOps(fixReply);
    out.conflicts.push(...fx.conflicts);
    const summary = { ran: true, fixed: 0, dropped: 0, kept: 0, staleFixed: 0 };
    let ops = [...firstOps];
    for (const d of fx.drops) {
        const op = ops.find(o => o.id === d.ref && !o.dropped);
        if (!op) continue;
        op.dropped = d.reason || 'Dropped after the check.';
        summary.dropped++;
    }
    for (const k of fx.keeps) {
        const op = ops.find(o => o.id === k.ref && !o.dropped);
        if (!op || !op.found?.length) continue;
        op.disputed = k.reason || 'The updater says the change is right as it is.';
        summary.kept++;
    }
    let nextId = Math.max(0, ...ops.map(o => o.id)) + 1;
    const revisedIds = new Set();
    for (const raw of fx.ops) {
        const target = raw.ref !== null ? ops.find(o => o.id === raw.ref) : null;
        if (target) {
            if (target.dropped || revisedIds.has(target.id)) continue;
            const next = { ...raw, id: target.id, source: target.source, fixed: true, firstFound: target.found || [], firstText: target.type === 'remove' ? '' : target.result.join('\n'), firstType: target.type };
            delete next.ref;
            ops[ops.indexOf(target)] = next;
            revisedIds.add(target.id);
            summary.fixed++;
        } else if (raw.ref === null) {
            const id = nextId++;
            ops.push({ ...raw, id, source: 'stale', staleFor: raw.stale ?? (raw.type === 'add' ? null : raw.line) });
            revisedIds.add(id);
            summary.staleFixed++;
        }
    }
    out.fix = summary;
    out.dropped = ops.filter(o => o.dropped);
    // Place every change again together, so two changes to one line are caught.
    ops = resolveOps(job.content, ops.filter(o => !o.dropped), job.ranges, { dates: job.dates });
    out.ops = ops;
    for (const x of out.stale) {
        const by = ops.find(o => !o.invalid && o.source === 'stale' && (o.staleFor === x.line || (o.type !== 'add' && o.index === x.line - 1)));
        if (by) x.fixedBy = by.id;
    }

    const recheck = ops.filter(o => revisedIds.has(o.id) && !o.invalid);
    if (!recheck.length) return out;
    say('checking the fixes');
    try {
        const reply = await sendWithRetry(s, opsCheckSystemPrompt(c.name1, { stale: false }), opsCheckUserPrompt({
            card: job.numbered, title, ops: ops.filter(o => !o.invalid), log: job.log, trackers: job.trackers, only: recheck,
        }), { signal, reasoning: s.checkThinking, onProgress: progress('checking the fixes') });
        out.raws.push(['Check reply for the fixes', reply]);
        const again = parseOpsCheck(reply);
        if (!again) {
            out.recheck = { ran: true, failed: 'The check reply could not be read.' };
            return out;
        }
        let n = 0;
        for (const p of again.problems) {
            const op = recheck.find(o => o.id === p.id);
            if (!op) continue;
            (op.found ||= []).push({ kind: p.kind, text: p.text });
            n++;
        }
        out.recheck = { ran: true, problems: n, checked: recheck.length };
    } catch (err) {
        if (signal?.aborted) throw err;
        console.error(LOG, err);
        out.recheck = { ran: true, failed: err?.message || String(err) };
    }
    return out;
}

const TYPE_TEXT = { edit: 'Change', add: 'Add', remove: 'Remove' };

/** The changed words of an edit, with long unchanged stretches shortened. */
function wordDiffHtml(oldLine, newLine) {
    const parts = wordDiff(oldLine, newLine);
    const shorten = (t) => {
        const w = t.split(/(\s+)/);
        const count = w.filter(x => x.trim()).length;
        if (count <= 24) return esc(t);
        const keep = (arr, n, fromEnd) => {
            const out = [];
            let seen = 0;
            const seq = fromEnd ? [...arr].reverse() : arr;
            for (const x of seq) {
                out.push(x);
                if (x.trim() && ++seen >= n) break;
            }
            return (fromEnd ? out.reverse() : out).join('');
        };
        return `${esc(keep(w, 9, false))}<span class="cu-skip"> … </span>${esc(keep(w, 9, true))}`;
    };
    const oldHtml = parts.filter(p => p.type !== 'add').map(p => (p.type === 'del' ? `<span class="cu-wdel">${esc(p.text)}</span>` : shorten(p.text))).join('');
    const newHtml = parts.filter(p => p.type !== 'del').map(p => (p.type === 'add' ? `<span class="cu-wadd">${esc(p.text)}</span>` : shorten(p.text))).join('');
    return `<div class="cu-line-old">− ${oldHtml}</div><div class="cu-line-new">+ ${newHtml}</div>`;
}

function opDiffHtml(op) {
    if (op.type === 'remove') return `<div class="cu-del">− ${esc(String(op.oldLine ?? '').trim())}</div>`;
    if (op.type === 'add') {
        const anchor = String(op.oldLine ?? '').trim();
        return `<div class="cu-muted">after: ${esc(anchor.length > 90 ? `${anchor.slice(0, 90)}…` : anchor)}</div>${op.result.map(l => `<div class="cu-add">+ ${esc(l)}</div>`).join('')}`;
    }
    return wordDiffHtml(op.oldLine, op.result.join('\n'));
}

function opHead(op) {
    if (op.kind === 'canon') return 'Canon point';
    const where = op.type === 'add' ? `after line ${op.line}` : `line ${op.line}`;
    return `${TYPE_TEXT[op.type]} ${where}`;
}

const FOUND_TEXT = { lost: 'Lost', unsupported: 'Not in the log', wrong: 'Wrong', twice: 'Said twice', passing: 'Passing state', placement: 'Could not be placed' };

function renderOpsReview(job, result, parsed, block, { took, logInfo, edited }) {
    const { card, content } = job;
    const tookText = () => (typeof took === 'function' ? took() : took);
    const personaNames = nameVariants(ctx().name1 || '');
    const ignoreNames = [...(card.names || []), ...personaNames];
    const items = result.ops.filter(op => op.invalid !== 'It leaves the line as it is.').map((op) => {
        const w = opWarnings(op, { personaNames });
        const problems = (op.found || []).length > 0;
        return { op, baseWarnings: w.warnings, accept: !op.invalid && !w.untick && !problems };
    });
    items.sort((a, b) => (a.op.index ?? 1e9) - (b.op.index ?? 1e9) || (a.op.type === 'add') - (b.op.type === 'add') || a.op.id - b.op.id);

    // The canon point says how far the card has been updated.
    const canon = sectionRanges(content).find(r => r.kind === 'canon' && !r.inline);
    const lines = content.split(/\r?\n/);
    if (canon && job.storyDate) {
        let i = canon.start + 1;
        while (i < canon.end && !lines[i].trim()) i++;
        if (i < canon.end) {
            const next = canonPointBody(lines[i], job.storyDate);
            if (next !== lines[i].trim() && !result.ops.some(o => !o.invalid && o.type !== 'add' && o.index === i)) {
                items.push({ op: { id: 'canon', type: 'edit', kind: 'canon', label: canon.title, index: i, line: i + 1, oldLine: lines[i], result: [lines[i].match(/^\s*/)[0] + next], reason: `Marks the card as updated to ${job.storyDate}.`, find: null }, baseWarnings: [], accept: true });
            }
        }
    }

    const stale = result.stale.filter(x => !x.fixedBy);
    const outdated = [
        ...stale.map(x => `line ${x.line} (${x.label}): ${x.text}${x.allowed ? '' : ' — not in the sections you ticked'}`),
        ...(parsed.conflicts || []), ...(result.conflicts || []),
    ];
    const outdatedHtml = outdated.length
        ? `<div class="cu-conflicts"><div class="cu-warn"><b>Lines that may no longer be true</b> (no change below covers them; fix them in the lorebook if they are right):</div>${outdated.map(x => `<div class="cu-warn">• ${esc(x)}</div>`).join('')}</div>`
        : '';

    const checkLine = (() => {
        const ch = result.check;
        if (!ch.ran) return '';
        if (ch.failed) return `<div class="cu-warn">The check failed (${esc(ch.failed)}), so read every change carefully.</div>`;
        const parts = [];
        parts.push(ch.problems ? `${ch.problems} problem${ch.problems === 1 ? '' : 's'} in the changes` : 'no problems in the changes');
        if (ch.staleFound) parts.push(`${ch.staleFound} line${ch.staleFound === 1 ? '' : 's'} on the card no longer true`);
        let text = `Check: ${parts.join(', ')}.`;
        const fx = result.fix;
        if (fx.failed) text += ` Fixing failed (${fx.failed}).`;
        else if (fx.ran) {
            const did = [];
            if (fx.fixed) did.push(`${fx.fixed} fixed`);
            if (fx.dropped) did.push(`${fx.dropped} dropped`);
            if (fx.kept) did.push(`${fx.kept} kept as they were`);
            if (fx.staleFixed) did.push(`${fx.staleFixed} outdated line${fx.staleFixed === 1 ? '' : 's'} changed`);
            if (did.length) text += ` Fix: ${did.join(', ')}.`;
        }
        const rc = result.recheck;
        if (rc.failed) text += ` Checking the fixes failed (${rc.failed}).`;
        else if (rc.ran) text += rc.problems ? ` Still ${rc.problems} problem${rc.problems === 1 ? '' : 's'} after the fix.` : ' The fixes check out.';
        const flaggedLeft = items.some(it => (it.op.found || []).length);
        if (flaggedLeft) text += ' Changes with a problem come unticked.';
        const bad = !!(ch.problems || ch.staleFound) && (flaggedLeft || stale.length);
        return `<div class="${bad ? 'cu-warn' : 'cu-ok'}">${esc(text)}</div>${result.general.map(p => `<div class="cu-warn">${esc(FOUND_TEXT[p.kind] || p.kind)}: ${esc(p.text.slice(0, 300))}</div>`).join('')}`;
    })();

    const raws = result.raws.map(([label, text]) => `<details><summary>${esc(label)}</summary><pre class="cu-pre">${esc(text)}</pre></details>`).join('');
    const dropped = result.dropped.length
        ? `<details><summary>Dropped after the check (${result.dropped.length})</summary>${result.dropped.map(op => `<div class="cu-dropped"><div><b>${esc(opHead(op))}</b> <span class="cu-muted">${esc(op.label || '')}</span></div>${(op.found || []).map(f => `<div class="cu-warn">${esc(FOUND_TEXT[f.kind])}: ${esc(f.text)}</div>`).join('')}<div class="cu-muted">${esc(op.dropped)}</div>${op.result?.length ? `<div class="cu-diff"><div class="cu-add">${esc(op.result.join('\n'))}</div></div>` : ''}</div>`).join('')}</details>`
        : '';
    const nowList = (parsed.now || []).length ? `<details><summary>What is true now, according to the update (${parsed.now.length})</summary><pre class="cu-pre">${esc(parsed.now.join('\n'))}</pre></details>` : '';
    const tail = `${dropped}${nowList}${logInfo ? logDetails(logInfo.newLines) : ''}${raws}`;
    const sw = result.sweep || { ran: false };
    const sweepLine = !sw.ran ? ''
        : sw.failed ? `<div class="cu-warn">The pass for lines that are no longer true failed (${esc(sw.failed)}), so look over the card yourself.</div>`
            : `<div class="cu-muted">Lines no longer true: ${sw.changes ? `${sw.changes} change${sw.changes === 1 ? '' : 's'} found.` : 'none found.'}</div>`;
    const head = cardHead(card, tookText()) + editedNote(edited) + sweepLine + checkLine + outdatedHtml;
    const real = items.filter(it => it.op.kind !== 'canon');

    const markDone = async () => {
        const log = logInfo ? getLog(logInfo.key) : null;
        if (log) log.applied = Math.max(log.applied || 0, logInfo.appliedTo);
        await ctx().saveMetadata();
    };
    if (!real.length) {
        let why = 'No usable changes in the reply.';
        if (parsed.none) why = 'Nothing in the log changes this card.';
        else if (parsed.ops.length) why = 'No changes left after the check.';
        block.html(`${head}<div class="cu-muted">${why}</div><div class="cu-row cu-buttons"><div class="menu_button cu-mark">Mark these log lines as done</div></div>${tail}`);
        block.find('.cu-mark').on('click', async () => {
            await markDone();
            block.find('.cu-mark').replaceWith('<div class="cu-ok">Done. Next time only newer lines are used.</div>');
        });
        return;
    }

    const chosen = () => items.filter(it => it.accept && !it.op.invalid).map(it => it.op);
    const sizeLine = () => {
        const limit = Number(settings().cardLimit) || 0;
        const a = approxTokens(content.length);
        const b = approxTokens(applyOps(content, chosen()).length);
        return `<div class="cu-muted">Card size: ≈${a.toLocaleString()} → ≈${b.toLocaleString()} tokens with the ticked changes${limit ? ` (limit ${limit.toLocaleString()})` : ''}.</div>`;
    };
    const render = () => {
        const after = applyOps(content, chosen());
        let html = `${head}<div class="cu-size">${sizeLine()}</div>`;
        let group = null;
        items.forEach((it, i) => {
            const op = it.op;
            if (op.label !== group) {
                group = op.label;
                html += `<div class="cu-group">${esc(group || (Number.isInteger(op.index) ? 'top of the card' : 'could not be placed'))}</div>`;
            }
            const warnings = [];
            for (const f of (op.found || []).filter(x => x.text !== op.invalid)) warnings.push(`${it.editedAfterCheck ? '(checked before your edit) ' : ''}${FOUND_TEXT[f.kind] || f.kind}: ${f.text.slice(0, 300)}`);
            if (op.disputed) warnings.push(`The updater disagrees with the check: ${op.disputed.slice(0, 300)}`);
            warnings.push(...it.baseWarnings);
            if (op.kind !== 'canon') for (const r of opRepeats(op, after, ignoreNames)) warnings.push(`Much like ${r.where}: "${r.excerpt.slice(0, 160)}${r.excerpt.length > 160 ? '…' : ''}"`);
            const notes = [];
            if (op.fixed && op.firstFound?.length) notes.push(`Fixed after the check (${op.firstFound.map(f => FOUND_TEXT[f.kind] || f.kind).join(', ').toLowerCase()}).`);
            if (op.source === 'stale') notes.push('Added after the check found the line no longer true.');
            if (op.source === 'sweep') notes.push('Found by the pass for lines that are no longer true.');
            html += `<div class="cu-item${op.invalid ? ' cu-invalid' : ''}">
                <label class="checkbox_label"><input type="checkbox" data-accept="${i}"${it.accept ? ' checked' : ''}${op.invalid ? ' disabled' : ''}><b>${esc(opHead(op))}</b></label>
                ${op.reason ? `<div class="cu-muted">${esc(op.reason)}</div>` : ''}
                ${notes.map(n => `<div class="cu-muted">${esc(n)}</div>`).join('')}
                ${warnings.map(w => `<div class="cu-warn">${esc(w)}</div>`).join('')}
                <div class="cu-diff">${op.invalid && !op.result?.length && op.type !== 'remove' ? `<div class="cu-add">${esc(op.text || '')}</div>` : opDiffHtml(op)}</div>
                ${op.type !== 'remove' && !op.invalid ? `<details><summary>Edit before saving</summary><textarea class="text_pole cu-edit" data-edit="${i}" rows="${Math.min(10, 2 + Math.ceil(op.result.join('\n').length / 90))}">${esc(op.result.join('\n'))}</textarea></details>` : ''}
            </div>`;
        });
        html += `<div class="cu-row cu-buttons"><div class="menu_button cu-save">Save ticked changes</div><div class="menu_button cu-mark" title="Saves nothing; next time the update starts after these log lines.">Mark log lines as done without saving</div></div>${tail}`;
        block.html(html);
        block.find('[data-accept]').on('change', function () {
            items[Number(this.dataset.accept)].accept = this.checked;
            render();
        });
        block.find('[data-edit]').on('change', function () {
            const it = items[Number(this.dataset.edit)];
            const value = this.value.replace(/\s+$/, '');
            if (!value.trim()) return;
            it.op.result = value.split('\n');
            if (it.op.found?.length) it.editedAfterCheck = true;
            const w = opWarnings({ ...it.op, find: null }, { personaNames });
            it.baseWarnings = w.warnings;
            render();
        });
        block.find('.cu-save').on('click', () => saveOps(card, content, items, job.storyDate, block, logInfo));
        block.find('.cu-mark').on('click', async () => {
            await markDone();
            block.find('.cu-mark').replaceWith('<div class="cu-ok">Log lines marked as done. Nothing was saved.</div>');
        });
    };
    render();
}

async function saveOps(card, content, items, storyDate, block, logInfo) {
    const chosen = items.filter(it => it.accept && !it.op.invalid).map(it => it.op);
    if (!chosen.some(op => op.kind !== 'canon')) {
        toastr.info('Tick at least one change to save.', 'Card Updater');
        return;
    }
    try {
        const current = await readEntry(card.world, card.uid);
        if (current !== content) {
            toastr.warning(`${card.title} was changed since it was drafted. Draft it again.`, 'Card Updater');
            return;
        }
        const updated = applyOps(content, chosen);
        await keepVersion(card, content, storyDate);
        await writeEntry(card.world, card.uid, updated);
        chatStore().saved[`${card.world}|${card.uid}`] = String(stringHash(updated));
        const log = logInfo ? getLog(logInfo.key) : null;
        if (log) log.applied = Math.max(log.applied || 0, logInfo.appliedTo);
        await ctx().saveMetadata();
        const n = chosen.filter(op => op.kind !== 'canon').length;
        block.find('.cu-save').replaceWith(`<div class="cu-ok">Saved ${n} change${n === 1 ? '' : 's'}. The previous version is kept under Versions.</div>`);
        block.find('.cu-mark').remove();
        block.find('.cu-item input, .cu-item textarea').prop('disabled', true);
        toastr.success(`${card.title} updated.`, 'Card Updater');
    } catch (err) {
        console.error(LOG, err);
        toastr.error(`Saving failed: ${err?.message || err}`, 'Card Updater');
    }
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

async function runTighten(card, kinds, s, block, status, signal, counter, includeOriginal = false) {
    const c = ctx();
    const started = Date.now();
    const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`;
    const content = await readEntry(card.world, card.uid);
    if (content === null) {
        block.html(`${cardHead(card)}<div class="cu-warn">Entry not found.</div>`);
        return;
    }
    const key = `${card.world}|${card.uid}`;
    const edited = await syncBaseline(key, content);
    const original = getOriginal(key);
    const ranges = updatableRanges(content, new Set(kinds));
    if (original === null && !includeOriginal) {
        block.html(`${cardHead(card)}<div class="cu-muted">This card hasn't been updated in this chat, so there are no added lines to tighten. Tick "also condense the original card" to tighten it anyway.</div>`);
        return;
    }
    const persona = personaEntryLines(content, nameVariants(c.name1 || ''));
    const exempt = new Set([...persona].map(i => content.split(/\r?\n/)[i].trim()));
    const marked = markNewLines(content, original, ranges, { also: persona });
    if (!marked.newLines && !includeOriginal) {
        block.html(`${cardHead(card)}${editedNote(edited)}<div class="cu-muted">The ticked sections have no lines added by updates, so there is nothing to tighten. Tick "also condense the original card" to tighten it anyway.</div>`);
        return;
    }
    const tokens = approxTokens(content.length);
    const tick = setInterval(() => status.text(`${card.title} (${counter}): tightening ${marked.newLines} added lines… ${elapsed()}`), 1000);
    status.text(`${card.title} (${counter}): tightening ${marked.newLines} added lines…`);
    let reply;
    try {
        reply = await sendWithRetry(s, tightenSystemPrompt(c.name1, { original: includeOriginal }), tightenUserPrompt({
            card: marked.text, title: card.title, sections: ranges.map(r => r.title), tokens, limit: Number(s.cardLimit) || 0,
            days: storyDaysNote(storyDates(c.chat)),
        }), {
            signal,
            reasoning: s.updateThinking,
            model: s.updateModel,
            onProgress: ({ contentChars, reasoningChars }) => status.text(`${card.title} (${counter}): tightening… ${elapsed()} · thinking ${reasoningChars.toLocaleString()} chars · writing ${contentChars.toLocaleString()} chars`),
            onRetry: () => status.text(`${card.title} (${counter}): the model got stuck, trying once more…`),
        });
    } catch (err) {
        clearInterval(tick);
        console.error(LOG, err);
        block.html(`${cardHead(card, elapsed())}${errorHtml('Tightening failed', err, signal)}`);
        return;
    }
    clearInterval(tick);
    const parsed = parseReply(reply);
    for (const u of parsed.updates) u.text = stripNewMarks(u.text);
    await renderReview(card, content, ranges, parsed, '', block, elapsed, reply, null, { tighten: true, original: original ?? content, exempt, edited, status, counter, signal, s });
}

/** Runs the check pass over the proposed sections and attaches what it finds to them. */
async function checkDraft(card, content, items, logLines, opts) {
    const { s, status, counter, signal } = opts;
    if (!s?.checkDrafts || !items.length) return { ran: false };
    const c = ctx();
    status?.text(`${card.title} (${counter}): checking the draft…`);
    try {
        const reply = await sendWithRetry(s, checkSystemPrompt(c.name1, { tighten: !!opts.tighten }), checkUserPrompt({
            card: content, title: card.title, items, log: logLines,
        }), { signal, reasoning: s.checkThinking });
        const found = parseCheck(reply);
        if (found === null) return { ran: true, failed: 'The check reply could not be read.', raw: reply };
        const general = [];
        for (const f of found) {
            const target = items.find(it => it.title.toUpperCase() === f.section.toUpperCase())
                || items.find(it => f.section && it.title.toUpperCase().includes(f.section.toUpperCase()));
            if (target) (target.found ||= []).push(f);
            else general.push(f);
        }
        return { ran: true, general, raw: reply };
    } catch (err) {
        if (signal?.aborted) throw err;
        console.error(LOG, err);
        return { ran: true, failed: err?.message || String(err) };
    }
}

const FOUND_LABEL = { lost: 'Lost', unsupported: 'Not in the log', wrong: 'Wrong', twice: 'Said twice' };

async function renderReview(card, content, ranges, parsed, storyDate, block, took, rawReply, logInfo, opts = {}) {
    const tookText = () => (typeof took === 'function' ? took() : took);
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

    const conflicts = (parsed.conflicts || []).length
        ? `<div class="cu-conflicts"><div class="cu-warn"><b>Lines that may no longer be true</b> (fix these yourself, in the lorebook):</div>${parsed.conflicts.map(x => `<div class="cu-warn">• ${esc(x)}</div>`).join('')}</div>`
        : '';
    let head = cardHead(card, tookText()) + editedNote(opts.edited) + conflicts;
    const tail = `${logInfo ? logDetails(logInfo.newLines) : ''}<details><summary>Model reply</summary><pre class="cu-pre">${esc(rawReply)}</pre></details>`;
    if (!items.length && opts.tighten) {
        block.html(`${head}<div class="cu-muted">${parsed.none ? 'Nothing to cut.' : 'No usable changes in the reply.'}${unplaced.length ? ` Could not place: ${esc(unplaced.join(', '))}.` : ''}</div>${tail}`);
        return;
    }
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

    // Tighten may only touch lines added in play; a change to an original line is flagged and left unticked.
    if (opts.tighten) {
        for (const it of items) {
            it.lost = lostOriginalLines(it.oldBody, it.newBody, opts.original, { exempt: opts.exempt });
            if (it.lost.length) it.accept = false;
        }
    }

    // A second look: what went missing, what isn't backed by the log, what is now said twice.
    let check = { ran: false };
    try {
        check = await checkDraft(card, content, items, logInfo?.newLines || [], opts);
    } catch {
        block.html(`${cardHead(card)}<div class="cu-warn">Cancelled.</div>`);
        return;
    }
    for (const it of items) {
        if ((it.found || []).some(f => f.kind !== 'twice')) it.accept = false;
    }
    const names = [...(card.names || []), ...(ctx().name1 ? [ctx().name1] : [])];
    const computeRepeats = () => {
        if (opts.tighten) return;
        const newCard = applyReplacements(content, items.map(it => ({ start: it.range.start, end: it.range.end, body: it.newBody })));
        for (const it of items) {
            const added = lineDiff(it.oldBody, it.newBody).filter(d => d.type === 'add' && d.line.trim()).map(d => d.line);
            it.repeats = findRepeats(newCard, added, names);
        }
    };
    computeRepeats();
    head = cardHead(card, tookText()) + editedNote(opts.edited) + conflicts;

    const canon = opts.tighten ? null : sectionRanges(content).find(r => r.kind === 'canon' && !r.inline);
    let canonItem = null;
    if (canon && storyDate) {
        const oldBody = rangeBody(lines, canon);
        const newBody = canonPointBody(oldBody, storyDate);
        if (newBody !== oldBody) canonItem = { range: canon, kind: 'canon', title: canon.title, reason: `Marks the card as updated to ${storyDate}.`, oldBody, newBody, accept: true };
    }
    const all = canonItem ? [...items, canonItem] : items;

    const sizeLine = () => {
        const chosen = all.filter(it => it.accept);
        const after = chosen.length ? applyReplacements(content, chosen.map(it => ({ start: it.range.start, end: it.range.end, body: it.newBody }))) : content;
        const limit = Number(settings().cardLimit) || 0;
        const a = approxTokens(content.length);
        const b = approxTokens(after.length);
        return `<div class="cu-muted">Card size: ≈${a.toLocaleString()} → ≈${b.toLocaleString()} tokens with the ticked sections${limit ? ` (limit ${limit.toLocaleString()})` : ''}.</div>`;
    };
    const checkLine = !check.ran ? ''
        : check.failed ? `<div class="cu-warn">The check pass failed (${esc(check.failed)}), so read every section carefully.</div>`
            : (() => {
                const n = items.reduce((a, it) => a + (it.found || []).length, 0) + (check.general || []).length;
                const general = (check.general || []).map(f => `<div class="cu-warn">${esc(FOUND_LABEL[f.kind])}${f.section ? ` (${esc(f.section)})` : ''}: ${esc(f.text.slice(0, 300))}</div>`).join('');
                return `<div class="${n ? 'cu-warn' : 'cu-ok'}">Check pass: ${n ? `${n} problem${n === 1 ? '' : 's'} found. Sections with something lost, unsupported or wrong come unticked.` : 'no problems found.'}</div>${general}`;
            })();
    const checkTail = check.raw ? `<details><summary>Check reply</summary><pre class="cu-pre">${esc(check.raw)}</pre></details>` : '';
    const render = () => {
        let html = `${head}${checkLine}<div class="cu-size">${sizeLine()}</div>`;
        if (unplaced.length) html += `<div class="cu-warn">Could not place: ${esc(unplaced.join(', '))}.</div>`;
        all.forEach((it, i) => {
            const warnings = it.kind === 'canon' ? [] : checkUpdate(it.kind, it.oldBody, it.newBody);
            if (it.lost?.length) warnings.unshift(`Changes ${it.lost.length} line${it.lost.length === 1 ? '' : 's'} from the original card, which Tighten should leave alone: "${it.lost[0].slice(0, 80)}${it.lost[0].length > 80 ? '…' : ''}"`);
            for (const f of it.found || []) warnings.unshift(`${it.editedAfterCheck ? '(checked before your edit) ' : ''}${FOUND_LABEL[f.kind]}: ${f.text.slice(0, 300)}`);
            for (const r of it.repeats || []) warnings.push(`Much like a line in ${r.where}: "${r.other.slice(0, 120)}${r.other.length > 120 ? '…' : ''}"`);
            html += `<div class="cu-item">
                <label class="checkbox_label"><input type="checkbox" data-accept="${i}"${it.accept ? ' checked' : ''}><b>${esc(it.title)}</b></label>
                ${it.reason ? `<div class="cu-muted">${esc(it.reason)}</div>` : ''}
                ${warnings.map(w => `<div class="cu-warn">${esc(w)}</div>`).join('')}
                <div class="cu-diff">${diffHtml(it.oldBody, it.newBody)}</div>
                <details><summary>Edit before saving</summary><textarea class="text_pole cu-edit" data-edit="${i}" rows="10">${esc(it.newBody)}</textarea></details>
            </div>`;
        });
        html += `<div class="cu-row cu-buttons"><div class="menu_button cu-save">Save ticked sections</div></div>${tail}${checkTail}`;
        block.html(html);
        block.find('[data-accept]').on('change', function () {
            all[Number(this.dataset.accept)].accept = this.checked;
            block.find('.cu-size').html(sizeLine());
        });
        block.find('[data-edit]').on('change', function () {
            const it = all[Number(this.dataset.edit)];
            it.newBody = this.value.replace(/\s+$/, '');
            if (it.found?.length) it.editedAfterCheck = true;
            if (opts.tighten) it.lost = lostOriginalLines(it.oldBody, it.newBody, opts.original, { exempt: opts.exempt });
            computeRepeats();
            render();
        });
        block.find('.cu-save').on('click', () => saveReview(card, content, all, storyDate, block, logInfo));
    };
    render();
}

async function saveReview(card, content, items, storyDate, block, logInfo) {
    const chosen = items.filter(it => it.accept);
    if (!chosen.length || chosen.every(it => it.kind === 'canon')) {
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
        chatStore().saved[`${card.world}|${card.uid}`] = String(stringHash(updated));
        await ctx().saveMetadata();
        const log = logInfo ? getLog(logInfo.key) : null;
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
                chatStore().saved[this.dataset.key] = String(stringHash(v.content));
                await ctx().saveMetadata();
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
      <b>Card Updater <span class="cu-muted">v${VERSION}</span></b>
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
          <label for="cu_think_check" title="The check pass looks for lost facts, unsupported lines and repeats.">Thinking while checking a draft</label>
          <select id="cu_think_check" class="text_pole">${thinkingOptions()}</select>
        </div>
        <label for="cu_update_model">Model for updating and tightening (empty = same as above)</label>
        <input id="cu_update_model" class="text_pole" type="text" placeholder="z-ai/glm-5.3">
        <label class="checkbox_label"><input type="checkbox" id="cu_check"><span>Check each draft (one more request per card)</span></label>
        <label class="checkbox_label" title="After the update, the updating model goes through every line of the card against what is true now and writes a change for each line that no longer is. Changes in sections you didn't tick come unticked."><input type="checkbox" id="cu_sweep"><span>Look for lines that are no longer true (one more request per card)</span></label>
        <label class="checkbox_label" title="Changes the check flags, and lines it finds no longer true, go back to the updating model once, and the fixes are checked again."><input type="checkbox" id="cu_fix"><span>Fix what the check finds (up to two more requests)</span></label>
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
        <label for="cu_limit" title="Updates are told to keep cards under this, and the window shows each card's size against it. 5000 is the template's limit for a lead.">Card size limit (tokens, 0 = none)</label>
        <input id="cu_limit" class="text_pole" type="number" min="0" step="500">
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
    $('#cu_think_check').val(s.checkThinking).on('change', function () { s.checkThinking = this.value; save(); });
    $('#cu_update_model').val(s.updateModel).on('input', function () { s.updateModel = this.value.trim(); save(); });
    $('#cu_check').prop('checked', !!s.checkDrafts).on('change', function () { s.checkDrafts = !!this.checked; save(); });
    $('#cu_fix').prop('checked', !!s.fixDrafts).on('change', function () { s.fixDrafts = !!this.checked; save(); });
    $('#cu_sweep').prop('checked', !!s.sweepDrafts).on('change', function () { s.sweepDrafts = !!this.checked; save(); });
    $('#cu_temp').val(s.temperature).on('input', function () { const v = parseFloat(this.value); s.temperature = Number.isFinite(v) ? v : 0.5; save(); });
    $('#cu_limit').val(s.cardLimit).on('input', function () { s.cardLimit = Math.max(0, parseInt(this.value, 10) || 0); save(); });
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
