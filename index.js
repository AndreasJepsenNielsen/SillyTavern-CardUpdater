// Card Updater for SillyTavern.
// Drafts updates to character cards from what has happened in the chat. You review every section
// before anything is saved, and the previous version is kept in the chat so it can be restored.

import { looksLikeCard, nameVariants, titleCase, mentionsAny } from './cardparse.js';
import {
    UPDATABLE, updatableRanges, sectionRanges, rangeBody, applyReplacements, canonPointBody, gatherStory,
    systemPrompt, userPrompt, parseReply, matchRange, lineDiff, checkUpdate,
} from './updater.js';
import { send, testConnection, summaryceptionConnection } from './connection.js';

const MODULE = 'cardUpdater';
const LOG = '[Card Updater]';
const MAX_VERSIONS = 5;

const DEFAULTS = Object.freeze({
    source: 'openai', // 'openai' (direct endpoint) | 'profile' | 'chat'
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    maxTokens: 32000,
    temperature: 0.5,
    profileId: '',
    fallbackMessages: 60,
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
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = typeof v === 'object' ? structuredClone(v) : v;
    }
    for (const [k] of UPDATABLE) if (s.sections[k] === undefined) s.sections[k] = true;
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

// ---------------------------------------------------------------- versions kept in the chat

function versionStore() {
    const md = ctx().chatMetadata;
    if (!md[MODULE] || typeof md[MODULE] !== 'object') md[MODULE] = { versions: {} };
    if (!md[MODULE].versions) md[MODULE].versions = {};
    return md[MODULE].versions;
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
    const story = gatherStory(c.chat, c.chatMetadata?.summaryception, { userName: c.name1, fallbackMessages: Number(s.fallbackMessages) || 60 });
    const storyText = [story.summary, story.recent, story.state].join('\n');

    const root = $(`<div class="card-updater-window">
        <h3>Update character cards</h3>
        <div class="cu-muted">Reads ${story.hasSummary ? 'the Summaryception summary, the chat after it' : `the last ${Number(s.fallbackMessages) || 60} messages (no Summaryception summary in this chat)`} and the latest trackers${story.storyDate ? `. Story date: <b>${esc(story.storyDate)}</b>` : ''}.</div>
        <div class="cu-row"><label>Lorebook</label><select class="text_pole cu-world"></select></div>
        <div class="cu-row cu-buttons"><div class="menu_button cu-select-story">Select everyone in the story</div><div class="menu_button cu-select-none">Clear</div></div>
        <div class="cu-cards"></div>
        <div class="cu-label">Sections to update</div>
        <div class="cu-chips">${sectionChips(s)}</div>
        <div class="cu-row cu-buttons"><div class="menu_button cu-draft">Draft updates</div><div class="menu_button cu-stop" style="display:none">Stop after this card</div></div>
        <div class="cu-status cu-muted"></div>
        <div class="cu-results"></div>
    </div>`);

    const worldSel = root.find('.cu-world');
    worldSel.append(`<option value="__active__">Active lorebooks for this chat (${active.length})</option>`);
    for (const w of allWorlds) worldSel.append(`<option value="${esc(w)}">${esc(w)}</option>`);

    let cards = [];
    const renderCards = async () => {
        const v = String(worldSel.val());
        const worlds = v === '__active__' ? active : [v];
        root.find('.cu-cards').html('<div class="cu-muted">Loading…</div>');
        cards = await loadCards(worlds);
        if (!cards.length) {
            root.find('.cu-cards').html('<div class="cu-muted">No character cards found. Cards are entries with all-caps sections like SPEECH AND VOICE and PERSONALITY.</div>');
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
                const seen = card.mentions ? `in ${card.mentions} line${card.mentions === 1 ? '' : 's'} of the story` : 'not in the story';
                html += `<label class="checkbox_label cu-card"><input type="checkbox" data-card="${i}"><span>${esc(card.title)}</span><span class="cu-muted">${seen}${card.disabled ? ' · disabled entry' : ''}</span></label>`;
            }
        }
        root.find('.cu-cards').html(html);
    };
    worldSel.on('change', renderCards);
    await renderCards();

    root.find('.cu-select-story').on('click', () => {
        root.find('[data-card]').each(function () {
            const card = cards[Number(this.dataset.card)];
            this.checked = !!card && card.mentions > 0;
        });
    });
    root.find('.cu-select-none').on('click', () => root.find('[data-card]').prop('checked', false));
    root.find('[data-section]').on('change', function () {
        s.sections[this.dataset.section] = this.checked;
        save();
    });

    let running = false;
    let stopAfter = false;
    let abort = null;
    root.find('.cu-stop').on('click', () => {
        stopAfter = true;
        root.find('.cu-status').text('Stopping after this card…');
    });
    root.find('.cu-draft').on('click', async () => {
        if (running) return;
        const chosen = root.find('[data-card]:checked').toArray().map(el => cards[Number(el.dataset.card)]).filter(Boolean);
        const kinds = UPDATABLE.filter(([k]) => s.sections[k]).map(([k]) => k);
        if (!chosen.length) return toastr.info('Tick at least one card.', 'Card Updater');
        if (!kinds.length) return toastr.info('Tick at least one section.', 'Card Updater');
        if (!story.summary && !story.recent) return toastr.info('There is no story to read yet.', 'Card Updater');
        running = true;
        stopAfter = false;
        root.find('.cu-draft').addClass('disabled');
        root.find('.cu-stop').show();
        for (let i = 0; i < chosen.length; i++) {
            if (stopAfter) break;
            const card = chosen[i];
            abort = new AbortController();
            const block = $('<div class="cu-result"></div>').appendTo(root.find('.cu-results'));
            await draftCard(card, kinds, story, s, block, root.find('.cu-status'), abort.signal, `${i + 1}/${chosen.length}`);
        }
        running = false;
        root.find('.cu-draft').removeClass('disabled');
        root.find('.cu-stop').hide();
        root.find('.cu-status').text(stopAfter ? 'Stopped.' : 'Done drafting. Review each card below and save what you want to keep.');
    });

    const popup = new c.Popup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', allowVerticalScrolling: true, leftAlign: true });
    await popup.show();
    if (abort) abort.abort();
}

async function draftCard(card, kinds, story, s, block, status, signal, counter) {
    const c = ctx();
    const content = await readEntry(card.world, card.uid);
    if (content === null) {
        block.html(`<div class="cu-card-title">${esc(card.title)}</div><div class="cu-warn">Entry not found.</div>`);
        return;
    }
    const ranges = updatableRanges(content, new Set(kinds));
    if (!ranges.length) {
        block.html(`<div class="cu-card-title">${esc(card.title)}</div><div class="cu-muted">This card has none of the ticked sections.</div>`);
        return;
    }
    const started = Date.now();
    const tick = setInterval(() => status.text(`Drafting ${card.title} (${counter})… ${Math.round((Date.now() - started) / 1000)} s`), 1000);
    status.text(`Drafting ${card.title} (${counter})…`);
    let reply;
    try {
        reply = await send(s, systemPrompt(c.name1), userPrompt({ card: content, title: card.title, sections: ranges.map(r => r.title), story, userName: c.name1 }), {
            signal,
            onProgress: ({ contentChars, reasoningChars }) => status.text(`Drafting ${card.title} (${counter})… ${Math.round((Date.now() - started) / 1000)} s · thinking ${reasoningChars.toLocaleString()} chars · writing ${contentChars.toLocaleString()} chars`),
        });
    } catch (err) {
        clearInterval(tick);
        console.error(LOG, err);
        block.html(`<div class="cu-card-title">${esc(card.title)}</div><div class="cu-warn">Drafting failed: ${esc(err?.message || err)}</div>`);
        return;
    }
    clearInterval(tick);
    const secs = Math.round((Date.now() - started) / 1000);
    const parsed = parseReply(reply);
    renderReview(card, content, ranges, parsed, story.storyDate || parsed.storyDate, block, secs, reply);
}

function diffHtml(oldBody, newBody) {
    return lineDiff(oldBody, newBody).map((d) => {
        const cls = d.type === 'add' ? 'cu-add' : d.type === 'del' ? 'cu-del' : 'cu-same';
        const mark = d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ';
        return `<div class="${cls}">${esc(mark + d.line)}</div>`;
    }).join('');
}

function renderReview(card, content, ranges, parsed, storyDate, block, secs, rawReply) {
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

    const head = `<div class="cu-card-title">${esc(card.title)} <span class="cu-muted">${esc(card.world)} · ${secs} s</span></div>`;
    if (!items.length) {
        const why = parsed.none ? 'Nothing in the story changes this card.' : 'No usable changes in the reply.';
        block.html(`${head}<div class="cu-muted">${why}${unplaced.length ? ` Could not place: ${esc(unplaced.join(', '))}.` : ''}</div>
            <details><summary>Model reply</summary><pre class="cu-pre">${esc(rawReply)}</pre></details>`);
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
        html += `<div class="cu-row cu-buttons"><div class="menu_button cu-save">Save ticked sections</div></div>
            <details><summary>Model reply</summary><pre class="cu-pre">${esc(rawReply)}</pre></details>`;
        block.html(html);
        block.find('[data-accept]').on('change', function () { all[Number(this.dataset.accept)].accept = this.checked; });
        block.find('[data-edit]').on('change', function () {
            all[Number(this.dataset.edit)].newBody = this.value.replace(/\s+$/, '');
            render();
        });
        block.find('.cu-save').on('click', () => saveReview(card, content, all, storyDate, block));
    };
    render();
}

async function saveReview(card, content, items, storyDate, block) {
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
        block.find('.cu-save').replaceWith(`<div class="cu-ok">Saved ${chosen.length} section${chosen.length === 1 ? '' : 's'}. The previous version is kept under Versions.</div>`);
        block.find('input, textarea').prop('disabled', true);
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
        <label for="cu_fallback" title="Used when the chat has no Summaryception summary">Messages read without a summary</label>
        <input id="cu_fallback" class="text_pole" type="number" min="10" max="400" step="10">
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
    $('#cu_temp').val(s.temperature).on('input', function () { const v = parseFloat(this.value); s.temperature = Number.isFinite(v) ? v : 0.5; save(); });
    $('#cu_fallback').val(s.fallbackMessages).on('input', function () { s.fallbackMessages = Math.max(10, parseInt(this.value, 10) || 60); save(); });

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
