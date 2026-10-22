// Card Updater: sending the drafting request.
// Three ways: an OpenAI-compatible endpoint called directly (like Summaryception), a Connection Profile,
// or the chat's own connection. None of them sends your chat preset's prompts.

function ctx() {
    return SillyTavern.getContext();
}

/** Turns a base URL into a chat completions URL: ".../v1" → ".../v1/chat/completions". */
export function completionsUrl(url) {
    let u = String(url ?? '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (u.endsWith('/chat/completions')) return u;
    if (u.endsWith('/v1')) return `${u}/chat/completions`;
    if (u.includes('/chat/completions')) return u;
    return `${u}/v1/chat/completions`;
}

export function isLocalUrl(url) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(String(url));
}

/** An error with the end of the model's thinking attached, so the window can show what it was doing. */
export class ModelError extends Error {
    constructor(message, { reasoningTail = '', retryable = false } = {}) {
        super(message);
        this.reasoningTail = reasoningTail;
        this.retryable = retryable;
    }
}

/** The endpoint refused to turn thinking off for this model. */
export class ThinkingRequiredError extends Error {}

/**
 * True when the end of the text is repeating itself: its last stretch already appears at least three times
 * in the stretch before it. A model caught in a loop writes the same paragraph over and over.
 */
export function isLooping(text, { tail = 300, window = 40000, repeats = 3 } = {}) {
    const t = String(text ?? '');
    if (t.length < tail * (repeats + 2)) return false;
    const end = t.slice(-tail);
    const before = t.slice(Math.max(0, t.length - window), t.length - tail);
    let count = 0;
    let at = before.indexOf(end);
    while (at !== -1) {
        count++;
        if (count >= repeats) return true;
        at = before.indexOf(end, at + 1);
    }
    return false;
}

/**
 * Reads a streamed (SSE) chat completion. Stops early when the thinking or the reply starts repeating itself.
 * @returns {Promise<{content: string, reasoningChars: number, reasoningTail: string, finishReason: string}>} the reply without reasoning
 */
export async function readStream(response, onProgress) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let reasoning = '';
    let reasoningChars = 0;
    let finishReason = '';
    let buffer = '';
    let nextCheck = 6000;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const data = t.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
                    const choice = parsed.choices?.[0] || {};
                    if (choice.finish_reason) finishReason = String(choice.finish_reason);
                    const delta = choice.delta || {};
                    if (delta.content) content += delta.content;
                    const r = delta.reasoning || delta.reasoning_content;
                    if (r) {
                        reasoningChars += String(r).length;
                        reasoning = (reasoning + String(r)).slice(-60000);
                    }
                    if (onProgress) onProgress({ contentChars: content.length, reasoningChars });
                } catch (err) {
                    if (err instanceof SyntaxError) continue;
                    throw err;
                }
                if (reasoningChars + content.length >= nextCheck) {
                    nextCheck += 3000;
                    if (isLooping(reasoning) || isLooping(content)) {
                        reader.cancel().catch(() => {});
                        throw new ModelError(`The model got stuck repeating itself after ${reasoningChars.toLocaleString()} characters of thinking, so it was stopped.`, { reasoningTail: reasoning.slice(-3000), retryable: true });
                    }
                }
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch { /* already cancelled */ }
    }
    return { content, reasoningChars, reasoningTail: reasoning.slice(-3000), finishReason };
}

/** The OpenRouter `reasoning` field for a thinking setting, or null to leave it to the model. */
export function reasoningField(level) {
    switch (level) {
        case 'off': return { enabled: false };
        case 'low':
        case 'medium':
        case 'high': return { effort: level };
        default: return null;
    }
}

async function sendDirect(s, system, user, { signal, onProgress, maxTokens, reasoning, model } = {}) {
    const endpoint = completionsUrl(s.apiUrl);
    if (!endpoint) throw new Error('Set the endpoint URL in Card Updater settings.');
    const modelName = String(model || s.apiModel || '').trim();
    if (!modelName) throw new Error('Set the model name in Card Updater settings.');
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    const body = {
        model: modelName,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: Number.isFinite(Number(s.temperature)) ? Number(s.temperature) : 0.8,
        stream: true,
    };
    const thinking = reasoningField(reasoning);
    if (thinking) body.reasoning = thinking;
    const limit = Number(maxTokens ?? s.maxTokens) || 0;
    if (limit > 0) body.max_tokens = limit;

    let response;
    if (isLocalUrl(endpoint)) {
        // Local servers usually need SillyTavern's CORS proxy (enableCorsProxy: true in config.yaml).
        try {
            response = await fetch(`/proxy/${endpoint}`, { method: 'POST', headers: { ...ctx().getRequestHeaders(), ...headers }, body: JSON.stringify(body), signal });
        } catch (proxyErr) {
            if (signal?.aborted) throw proxyErr;
            response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
        }
    } else {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) throw new Error('The endpoint answered 401 Unauthorized. Check the API key.');
        if (response.status === 400 && thinking?.enabled === false && /reasoning[\s\S]{0,80}(mandatory|required|cannot be disabled)/i.test(text)) {
            throw new ThinkingRequiredError(`${modelName} can't have thinking turned off.`);
        }
        throw new Error(`The endpoint answered ${response.status}: ${text.slice(0, 300)}`);
    }
    const { content, reasoningChars, reasoningTail, finishReason } = await readStream(response, onProgress);
    if (!content.trim()) {
        if (finishReason === 'length') {
            throw new ModelError(`The model used all ${limit || 'its'} max tokens thinking (${reasoningChars.toLocaleString()} characters) before writing anything.`, { reasoningTail, retryable: true });
        }
        throw new ModelError(`The model sent back an empty reply${reasoningChars ? ` after ${reasoningChars.toLocaleString()} characters of thinking` : ''}.`, { reasoningTail, retryable: true });
    }
    if (finishReason === 'length') {
        throw new ModelError('The reply was cut off at Max tokens before it was finished.', { reasoningTail, retryable: true });
    }
    return content;
}

async function sendProfile(s, system, user, { signal, maxTokens } = {}) {
    const c = ctx();
    if (!s.profileId) throw new Error('Pick a Connection Profile in Card Updater settings.');
    const res = await c.ConnectionManagerRequestService.sendRequest(
        s.profileId,
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        Number(maxTokens ?? s.maxTokens) || 16000,
        { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
    );
    const content = typeof res === 'string' ? res : res?.content;
    if (!content || !String(content).trim()) throw new Error('The profile sent back an empty reply.');
    return String(content);
}

async function sendChat(s, system, user, { maxTokens } = {}) {
    const c = ctx();
    const content = await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: Number(maxTokens ?? s.maxTokens) || 16000, trimNames: false });
    if (!content || !String(content).trim()) throw new Error('The chat connection sent back an empty reply.');
    return String(content);
}

/**
 * Sends one drafting request with the connection set in the settings.
 * @param {object} s settings
 * @param {string} system
 * @param {string} user
 * @param {{signal?: AbortSignal, onProgress?: Function, maxTokens?: number}} [opts]
 */
export async function send(s, system, user, opts = {}) {
    switch (s.source) {
        case 'profile':
            return sendProfile(s, system, user, opts);
        case 'chat':
            return sendChat(s, system, user, opts);
        default:
            return sendDirect(s, system, user, opts);
    }
}

export async function testConnection(s) {
    const reply = await send(s, 'You are a connection test.', 'Reply with exactly: CONNECTION_OK', { maxTokens: s.source === 'openai' ? 2000 : 200, reasoning: 'off' });
    return reply.trim().slice(0, 100);
}

/** Summaryception's saved OpenAI-compatible connection, if it has one. */
export function summaryceptionConnection() {
    const sc = ctx().extensionSettings?.summaryception;
    if (!sc || !sc.openaiUrl) return null;
    return { apiUrl: sc.openaiUrl, apiKey: sc.openaiKey || '', apiModel: sc.openaiModel || '', maxTokens: Number(sc.openaiMaxTokens) || 0 };
}
