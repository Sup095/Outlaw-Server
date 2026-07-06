// ============================================================================
// Outlaw OS - Local AI agent (OpenAI-compatible local client)
// ----------------------------------------------------------------------------
// A deliberately lightweight wrapper around a *local*, OpenAI-compatible chat
// endpoint. The caller (main.js `aiBackend()`) chooses which of the three
// engines to point it at by passing `baseUrl`: the bundled built-in model
// (Ollama, the zero-setup default), an external Ollama server
// (127.0.0.1:11434), or LM Studio (127.0.0.1:1234 — the fallback when no
// baseUrl is given). No data ever leaves the machine. This module doesn't
// manage weights — the built-in model is pulled by main.js (ensureBaseModel),
// and Ollama / LM Studio load models themselves.
//
// This module ONLY does model I/O + parsing. It never executes anything; the
// main process decides which proposed tool calls are safe to run and which
// require explicit user confirmation.
// ============================================================================

const LM_STUDIO_BASE = 'http://127.0.0.1:1234/v1';
// Sent to LM Studio as the "model" field. It auto-selects the currently loaded
// model when given this sentinel — matches Outlaw CodeMaker's default.
const DEFAULT_MODEL = 'local-model';

// Tools the model is allowed to propose. Keep the surface tiny so small models
// stay reliable. `run_command` is intentionally marked dangerous so the main
// process always routes it through user confirmation.
const TOOLS = ['answer', 'open_app', 'search_web', 'list_files', 'open_file', 'read_file', 'system_info', 'install_app', 'set_setting', 'set_persona', 'system_action', 'open_screen', 'run_command'];

function systemPrompt(appIds, machine, persona) {
    // C6 — persona. On the bundled base model the identity is fixed (Cr1tt3r).
    // On a *different* model the user loaded, the AI may have given itself a name
    // + personality (set_persona); use it when present.
    let idLines;
    if (persona && persona.name) {
        // non-base model the AI has named itself on
        idLines = [
            'You are ' + persona.name + ', an on-device assistant for Outlaw OS — a Linux for AI-driven Godot game development.',
            'Persona: ' + (persona.personality || 'a capable, friendly local AI — concise and practical.') + ' If asked your name, you are ' + persona.name + '.',
            'You are privacy-respecting: everything runs locally on this machine, so no data ever leaves it.',
        ];
    } else if (persona) {
        // non-base model, not named yet — neutral, may pick a name if invited
        idLines = [
            'You are an on-device assistant for Outlaw OS — a Linux for AI-driven Godot game development.',
            'Persona: capable, friendly, concise. You run on a model the user loaded themselves, so you have no fixed name yet — if the user invites you, you may choose your own name + personality (set_persona).',
            'You are privacy-respecting: everything runs locally on this machine, so no data ever leaves it.',
        ];
    } else {
        // bundled base model — fixed identity
        idLines = [
            'You are Cr1tt3r, the on-device assistant for Outlaw OS — a Linux for AI-driven Godot game development.',
            'Persona: a sharp, friendly cyber-outlaw sidekick — concise, practical, a little wry, never showy. If asked your name, you are Cr1tt3r.',
            'You are privacy-respecting: everything runs locally on this machine, so no data ever leaves it.',
        ];
    }
    return [
        ...idLines,
        ...(machine ? ['', 'This computer: ' + machine] : []),
        '',
        'Reply with EXACTLY ONE line of minified JSON and nothing else. Schema:',
        '{"tool":"<tool>","arg":"<string>","text":"<short message to the user>"}',
        '',
        'Tools:',
        '- answer: just talk to the user (arg empty). Use for questions, explanations, chat.',
        '- open_app: launch an installed app. arg = one of: ' + appIds.join(', ') + '.',
        '- search_web: open the browser on a web search. arg = the search query.',
        '- list_files: show a directory. arg = absolute path (default home if empty).',
        '- open_file: open a file/folder with its default app. arg = path.',
        '- read_file: show a file\'s contents to help answer/diagnose. READ-ONLY — you may read anything you have access to (including config/system files) but you can NEVER modify system files. arg = absolute path. e.g. "what\'s in my .xinitrc" -> {"tool":"read_file","arg":"/home/<user>/.xinitrc"}.',
        '- system_info: report CPU/RAM/host info (arg empty).',
        '- install_app: install software the user names OR describes. arg = the most likely PACKAGE name (e.g. "something to edit audio" -> "audacity"; "a photo editor" -> "gimp"). Any official package works, not just famous ones — give your single best package-name guess. Known sources only (Apps catalog / official repos); the user confirms before anything installs.',
        '- open_screen: take the user to a section of Outlaw OS. arg = one of: dashboard, syscore, files, tasks, terminal, gaming, gamedev, apps, ai, calc, settings, help. e.g. "take me to settings" -> {"tool":"open_screen","arg":"settings","text":"Here\'s Settings."}.',
        '- set_setting: change a system setting for the user. arg = "key=value". Keys/values: theme=green|gold|broken, crtFx=on|off, glow=on|off, reduceMotion=on|off, uiScale=0.9|1|1.15|1.3 (text size — bigger number = bigger text), performanceMode=on|off, vramSaverMode=auto|off|lean|minimal, aiEngine=base|lmstudio|ollama, autoCheck=on|off, coreVoiceEnabled=on|off. e.g. "use less power"/"use the least VRAM" -> {"tool":"set_setting","arg":"vramSaverMode=minimal","text":"Squeezing VRAM use right down."}; "switch the AI to LM Studio" -> {"tool":"set_setting","arg":"aiEngine=lmstudio","text":"Switching the AI engine to LM Studio."}; "make the text bigger" -> {"tool":"set_setting","arg":"uiScale=1.15","text":"Bumping up the text size."}. Use the value the user means even if you are unsure of the exact key — the system maps it (e.g. "minimal" -> vramSaverMode).',
        ...(persona !== undefined ? [
            '- set_persona: ONLY on a non-default model, and ONLY if the user invites you to pick your own name/personality. arg = "Name | a short personality description". e.g. user says "give yourself a name" -> {"tool":"set_persona","arg":"Spectre | a calm, precise hacker-poet","text":"Call me Spectre."}. On the built-in base model your name is fixed (Cr1tt3r) — do not use this there.',
        ] : []),
        '- system_action: perform a one-tap system action. arg = one of: lock (lock the screen — needs a PIN set), sleep (suspend the machine to RAM — wakes on a key/power press), airplane_on / airplane_off (turn Wi-Fi + Bluetooth off/on), night_light_on / night_light_off (warm the screen colors for the evening), dnd_on / dnd_off (Do Not Disturb — pause/resume notification pop-ups), storage_ram_on / storage_ram_off (use disk as extra memory), check_updates (see if an Outlaw OS update is available), report_problem (open the error log so the user can send a report). e.g. "lock my screen" -> {"tool":"system_action","arg":"lock"}; "put the computer to sleep" -> {"tool":"system_action","arg":"sleep"}; "my eyes hurt, warm the screen" -> {"tool":"system_action","arg":"night_light_on"}; "stop interrupting me" -> {"tool":"system_action","arg":"dnd_on"}; "any updates?" -> {"tool":"system_action","arg":"check_updates"}.',
        '- run_command: ONLY when the user explicitly asks to run a shell command. arg = the command. This always asks the user to confirm first.',
        '',
        'Rules: pick the single best tool. Prefer "answer" for anything conversational.',
        'If the request fits no tool, use "answer": briefly say you can\'t do that exact thing and point to the closest thing you CAN (open a screen, change a setting, install an app, lock/airplane/updates, or run a command). NEVER invent a tool or claim an action happened when it did not.',
        'Never invent file paths. Keep "text" under 240 characters. Output JSON only.',
    ].join('\n');
}

async function timeoutFetch(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
        clearTimeout(t);
    }
}

// Is LM Studio reachable, and which models are loaded?
// LM Studio exposes /v1/models à la OpenAI; it returns the currently-loaded model(s).
async function status(opts = {}) {
    const base = opts.baseUrl || LM_STUDIO_BASE;
    try {
        const res = await timeoutFetch(`${base}/models`, {}, 1500);
        if (!res.ok) return { available: false, models: [] };
        const data = await res.json();
        // OpenAI shape: { data: [{ id, object, ... }, ...] }
        const models = Array.isArray(data && data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
        return { available: true, models };
    } catch {
        return { available: false, models: [] };
    }
}

// LM Studio doesn't have a "pull this model" API — the user picks a model in
// LM Studio's UI and clicks Start Server. We keep this function as a no-op so
// callers that used to call ensureModel() still work; it just verifies the
// server is up.
async function ensureModel(_model, onProgress) {
    const s = await status();
    if (!s.available) {
        throw new Error(
            'LM Studio is not reachable. Open LM Studio, load a model, then click "Start Server" (port 1234).',
        );
    }
    if (onProgress) onProgress('LM Studio is serving a model.');
    return true;
}

function parseIntent(raw) {
    // Be lenient: small models sometimes wrap JSON in prose or code fences.
    if (!raw) return { tool: 'answer', arg: '', text: 'No response.' };
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const obj = JSON.parse(text.slice(start, end + 1));
            const tool = TOOLS.includes(obj.tool) ? obj.tool : 'answer';
            return {
                tool,
                arg: typeof obj.arg === 'string' ? obj.arg : '',
                text: typeof obj.text === 'string' ? obj.text : '',
            };
        } catch {
            /* fall through to plain answer */
        }
    }
    return { tool: 'answer', arg: '', text: raw.trim() };
}

// Ask the model. Returns a parsed intent { tool, arg, text }.
// Uses the OpenAI-compatible /v1/chat/completions endpoint.
async function ask(prompt, { model, appIds, machine, baseUrl, history, summary, sysSettings, persona, online } = {}) {
    const messages = [{ role: 'system', content: systemPrompt(appIds || [], machine, persona) }];
    // QoL — current settings snapshot so the assistant is state-aware (answers
    // "what theme am I on?" and won't redundantly re-set things).
    if (sysSettings) messages.push({ role: 'system', content: String(sysSettings).slice(0, 600) });
    // QoL — offline awareness: don't send the user into a dead web search.
    if (online === false) {
        messages.push({ role: 'system', content: 'NETWORK: the machine is currently OFFLINE. Do NOT use search_web. If the user asks for anything that needs the internet (a web search, a download, an update check), use "answer" to tell them it needs a connection — everything local (apps, files, this chat) still works.' });
    }
    // Phase 15b — persistent-chat memory: an optional summary of older turns plus
    // the recent window, so Cr1tt3r can follow context across a conversation
    // (e.g. "open it" after naming an app). Caller supplies both; both optional.
    if (summary) {
        messages.push({ role: 'system', content: 'Summary of earlier conversation: ' + String(summary).slice(0, 1500) });
    }
    if (Array.isArray(history)) {
        for (const m of history) {
            if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
                messages.push({ role: m.role, content: m.content.slice(0, 2000) });
            }
        }
    }
    messages.push({ role: 'user', content: String(prompt || '').slice(0, 4000) });
    const body = {
        model: model || DEFAULT_MODEL,
        stream: false,
        temperature: 0.2,
        // Keep responses short — we only need a single JSON line. This also caps
        // VRAM cost on small machines.
        max_tokens: 256,
        messages,
    };
    const res = await timeoutFetch(`${baseUrl || LM_STUDIO_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 1000 * 120);
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`AI request failed (HTTP ${res.status}). ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    // OpenAI shape: { choices: [{ message: { role, content } }, ...] }
    const content =
        data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content
            : '';
    return parseIntent(content);
}

// Plain conversational completion — NO JSON-intent contract. Used by the
// hardware-aware AI setup guide so even a tiny local model can answer in normal
// prose (the {tool,arg,text} schema is too tight for a step-by-step walkthrough).
// `messages` is a full OpenAI-style array (system + turns). Returns raw text.
async function chat(messages, { model, maxTokens = 400, baseUrl } = {}) {
    const body = {
        model: model || DEFAULT_MODEL,
        stream: false,
        temperature: 0.4,
        max_tokens: maxTokens,
        messages: Array.isArray(messages) ? messages : [],
    };
    const res = await timeoutFetch(`${baseUrl || LM_STUDIO_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 1000 * 120);
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`AI request failed (HTTP ${res.status}). ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    const content =
        data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content
            : '';
    return String(content || '').trim();
}

module.exports = { status, ensureModel, ask, chat, TOOLS };
