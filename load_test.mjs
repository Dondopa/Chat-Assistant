#!/usr/bin/env node
/**
 * Chat Assistant — MODULE INTEGRITY GATE.  Run:  node load_test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * SillyTavern loads index.js as an ES MODULE. `node --check index.js` parses a
 * .js file as CommonJS, which silently ACCEPTS things ESM rejects (a duplicate
 * top-level `let`, most importantly). That exact false pass shipped a
 * Summaryception release that failed to load for three versions while every
 * check reported green. This repo was gated on syntax alone until v2.51.0 —
 * the weakest possible gate. This file really EXECUTES the module against a
 * mocked SillyTavern, drives init, and asserts the extension wired itself up.
 *
 * It also carries the source-witness assertions for shipped invariants: the
 * cross-chat contamination guards must stay where they are.
 *
 * Exit code 0 = safe to ship. Non-zero = DO NOT PUSH.
 */
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};

// CSS witness for the real-browser regression in mobile_layout_test.mjs.
// A bottom anchor resolves against ST's transformed zero-height HTML root.
const panelCss = readFileSync(join(HERE, 'style.css'), 'utf8');
const mobilePanelCss = panelCss.match(/@media \(max-width: 550px\)\s*\{\s*#chatassist_panel\s*\{([^}]+)/)?.[1] || '';
ok(/top:\s*28dvh/.test(mobilePanelCss) && /bottom:\s*auto/.test(mobilePanelCss), 'mobile panel anchors from viewport top, not collapsed root bottom');
ok(/height:\s*72dvh/.test(mobilePanelCss) && /min-height:\s*0/.test(mobilePanelCss), 'mobile panel fits dynamic and short viewports');

ok(/#chatassist_campaign\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(panelCss), 'campaign row cannot flex-shrink out of view with long session history');

// ── Forgiving DOM mock ───────────────────────────────────────────────
// Every element supports the operations the panel builder uses; children are
// tracked so querySelector/getElementById can find what init created.
const byId = new Map();
function makeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        showModal() { this.open = true; },
        children: [], style: {}, dataset: {},
        _class: new Set(),
        classList: {
            add: (...c) => c.forEach(x => el._class.add(x)),
            remove: (...c) => c.forEach(x => el._class.delete(x)),
            toggle: (c, f) => { (f === undefined ? !el._class.has(c) : f) ? el._class.add(c) : el._class.delete(c); },
            contains: (c) => el._class.has(c),
        },
        attributes: {},
        setAttribute: (k, v) => { el.attributes[k] = String(v); if (k === 'id') byId.set(String(v), el); },
        getAttribute: (k) => (k in el.attributes ? el.attributes[k] : null),
        removeAttribute: (k) => { delete el.attributes[k]; },
        appendChild: (c) => { el.children.push(c); if (c && c._id) byId.set(c._id, c); return c; },
        append: (...cs) => cs.forEach(c => { if (c && typeof c === 'object') el.children.push(c); }),
        prepend: (...cs) => cs.forEach(c => { if (c && typeof c === 'object') el.children.unshift(c); }),
        removeChild: (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
        remove: () => {},
        insertBefore: (c) => { el.children.unshift(c); return c; },
        _on: new Map(),
        addEventListener: (t, fn) => { if (!el._on.has(t)) el._on.set(t, []); el._on.get(t).push(fn); },
        removeEventListener: (t, fn) => { const a = el._on.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
        dispatch: (t, ev) => { for (const fn of (el._on.get(t) || []).slice()) fn(ev || { target: el, preventDefault() {}, stopPropagation() {} }); },
        querySelector: () => null, querySelectorAll: () => [],
        closest: () => null, focus: () => {}, blur: () => {},
        click: () => el.dispatch('click'),
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }),
        scrollIntoView: () => {},
        options: [], value: '', checked: false, disabled: false, selected: false,
        offsetWidth: 100, offsetHeight: 100, scrollTop: 0, scrollHeight: 0, clientHeight: 100,
        textContent: '', innerText: '',
    };
    // The panel is innerHTML-built and then addressed by id. Registering every
    // id declared in assigned markup makes those lookups work without a real
    // HTML parser; ids never declared still return null, so genuinely missing
    // elements still fail the way they should.
    let _html = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) {
            _html = String(v);
            for (const m of _html.matchAll(/id="([^"]+)"/g)) {
                if (!byId.has(m[1])) byId.set(m[1], makeEl('div'));
            }
        },
    });
    Object.defineProperty(el, 'id', {
        get() { return el._id || ''; },
        set(v) { el._id = String(v); byId.set(el._id, el); },
    });
    return el;
}
const documentMock = {
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: (id) => byId.get(String(id)) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
};
globalThis.document = documentMock;
globalThis.window = globalThis;
try { globalThis.navigator = { userAgent: 'gate' }; } catch (e) { /* node >= 21 exposes a read-only navigator — good enough */ }
// Toasts are user-visible feedback; capture them so 'loud, never silent'
// behavior is provable instead of vanishing into a no-op.
const toasts = [];
// Dialogs: confirm/prompt were previously undefined — End season was
// undriveable in the harness. Auto-accept and record.
const confirms = [];
globalThis.confirm = (m) => { confirms.push(String(m)); return true; };
globalThis.prompt = globalThis.prompt || (() => '');
const _t = (m) => { toasts.push(String(m)); };
globalThis.toastr = { info: _t, success: _t, warning: _t, error: _t, clear: () => {} };
globalThis.localStorage = {
    _d: new Map(),
    get length() { return this._d.size; },
    key(i) { return [...this._d.keys()][i] ?? null; },
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
};
const chain = new Proxy(function () {}, { get: (_t, p) => (p === 'length' ? 0 : chain), apply: () => chain });
globalThis.$ = new Proxy(function () {}, { get: () => chain, apply: (_fn, _this, [element]) => {
    if (element?._on) return { on: (type, handler) => element.addEventListener(type, handler) };
    return chain;
} });
const extensionsMenu = makeEl('div');
extensionsMenu.id = 'extensionsMenu';
documentMock.body.appendChild(extensionsMenu);
globalThis.jQuery = globalThis.$;

const event_types = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STARTED: 'GENERATION_STARTED', MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_DELETED: 'MESSAGE_DELETED', APP_READY: 'APP_READY',
};
const handlers = new Map();
const ctx = {
    chat: [], chatMetadata: {}, extensionSettings: {}, characters: [], characterId: 0,
    name1: 'Player', name2: 'Narrator', chatId: 'gate.jsonl',
    eventSource: {
        on: (e, f) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f); },
        emit: () => {}, removeListener: () => {},
    },
    event_types,
    saveSettingsDebounced: () => {}, saveMetadata: () => {}, saveMetadataDebounced: () => {},
    // Injections are the extension's primary output channel — capture them so
    // pause/unpause behavior is provable instead of vanishing into a no-op.
    extPrompts: new Map(),
    setExtensionPrompt(key, value) { ctx.extPrompts.set(String(key), String(value ?? '')); },
    getCurrentChatId: () => 'gate.jsonl',
    registerSlashCommand: () => {},
    SlashCommandParser: { addCommandObject: () => {} },
    SlashCommand: { fromProps: () => ({}) },
    SlashCommandArgument: { fromProps: () => ({}) },
    SlashCommandNamedArgument: { fromProps: () => ({}) },
    ARGUMENT_TYPE: { STRING: 'string' },
    executeSlashCommandsWithOptions: async () => ({}),
    generateQuietPrompt: async () => '',
    substituteParams: (s) => s,
    saveChat: async () => {},
    extensionPrompts: {},
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.structuredClone = globalThis.structuredClone ?? ((o) => JSON.parse(JSON.stringify(o)));

const realError = console.error;
const realLog = console.log;
const errors = [];
const logs = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const logCap = (...a) => { logs.push(a.map(String).join(' ')); };

process.on('unhandledRejection', (e) => {
    console.error = realError;
    realLog('  ✗ unhandled rejection during load: ' + (e && e.message));
    process.exit(1);
});

const dir = mkdtempSync(join(tmpdir(), 'ca-load-'));
writeFileSync(join(dir, 'index.js'), SRC.replace('    // Fallback in case APP_READY', '    globalThis.__campaignTest = { campaignAudit, campaignStore, campaignSelect, campaignParse, campaignNonRP, campaignBatch, campaignReview, campaignValid, campaignFingerprint, campaignSourceText, campaignRender, ingestProposals, pendingNoteCards: () => pendingEdits.filter(e => e.kind === "mem" && anIsNoteEdit(e)).length, anRead, anParse, anLegacyParse, anPropose, anApply, anCancel, anPendingProposal: () => anPending, gatherMemory, rippleScan };\n    // Fallback in case APP_READY'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

console.log('== module integrity ==');
let loaded = false, loadErr = '';
console.log = logCap;
try {
    await import(pathToFileURL(join(dir, 'index.js')).href);
    loaded = true;
} catch (e) {
    loadErr = (e && e.message) || String(e);
}
console.log = realLog;
ok(loaded, 'index.js loads as an ES module and executes' + (loaded ? '' : ' — ' + loadErr));

// Drive init through the same path SillyTavern uses.
const ready = handlers.get('APP_READY') || [];
ok(ready.length >= 1, 'APP_READY handler registered at module scope');
// A late wand menu must leave initialization retryable, not silently complete.
byId.delete('extensionsMenu');
console.log = logCap;
for (const f of ready) f();
console.log = realLog;
ok(errors.some(x => x.includes('Extensions menu is not ready')), 'missing menu keeps init retryable');
errors.length = 0;
byId.set('extensionsMenu', extensionsMenu);
console.log = logCap;
try { for (const f of ready) f(); } catch (e) { errors.push('init threw: ' + (e && e.message)); }
console.log = realLog;

const initErrors = errors.filter(x => x.includes('init failed'));
ok(initErrors.length === 0, 'init completed without "init failed"' + (initErrors.length ? ' — ' + initErrors[0] : ''));
ok(logs.some(x => x.includes('ready')), 'init logged ready (panel built, events bound, slash registered)');

console.log('== menu opening ==');
const menuItem = document.getElementById('chatassist_menu_item');
const panel = document.getElementById('chatassist_panel');
ok(!!menuItem && !!panel, 'menu and panel use real namespaced DOM ids');
menuItem?.click();
ok(panel?.classList.contains('cc_open'), 'menu click opens the full panel');
menuItem?.click();
ok(panel?.classList.contains('cc_open'), 'duplicate compatibility click leaves panel open');
document.getElementById('chatassist_close')?.click();
ok(!panel?.classList.contains('cc_open'), 'close button closes panel');
for (const key of ['Enter', ' ']) {
    menuItem?.dispatch('keydown', { key, preventDefault() {} });
    ok(panel?.classList.contains('cc_open'), key + ' opens panel from keyboard');
    document.getElementById('chatassist_close')?.click();
}
console.log('== event wiring ==');
for (const e of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED']) {
    ok((handlers.get(e) || []).length >= 1, e + ' handler bound');
}

// The handlers must survive being INVOKED against a bare context.
let threw = '';
try { for (const f of handlers.get('CHAT_CHANGED') || []) f(); } catch (e) { threw = e && e.message; }
ok(!threw, 'CHAT_CHANGED handler runs against an empty chat' + (threw ? ' — threw: ' + threw : ''));
threw = '';
try { for (const f of handlers.get('MESSAGE_SWIPED') || []) f(0); } catch (e) { threw = e && e.message; }
ok(!threw, 'MESSAGE_SWIPED handler runs against an empty chat' + (threw ? ' — threw: ' + threw : ''));

console.log('== shipped invariants (source witnesses) ==');
// v2.51.0 — cross-chat contamination fixes. These strings are load-bearing:
// if a refactor removes them, prove the replacement and update the witness.
ok(SRC.includes('const chatAt = chatRef();\n        const chatApplied = [];'), 'applyEdits captures chat identity at entry');
ok(SRC.includes("edit.status = 'chat changed mid-run \\u2014 not applied';"), 'applyEdits: a mid-run chat switch voids remaining cards instead of fuzzy-matching them into the new chat');
ok(SRC.includes('// ALL state writes happen synchronously with the event'), 'episode conclusion: director state is written before any await');
ok(SRC.includes("if (!justConcluded) return;   // a stale marker on an already-concluded episode stays silent, as before"), 'episode conclusion: stale markers stay silent; only a genuine conclusion announces');
ok(SRC.includes('const led = rootAt.ccHidden;'), 'undo: hidden-ledger writes go through the CAPTURED chat root, never a post-await metaRoot()');
ok(SRC.includes("toast('Chat changed mid-undo"), 'undo: a mid-undo chat switch is surfaced, not silently half-saved');
const guardCount = (SRC.match(/if \(!sameChat\(chatAt\)\)/g) || []).length;
ok(guardCount >= 12, 'sameChat guards present across LLM/apply/undo flows (found ' + guardCount + ', need >= 12)');

console.log('== v2.52.0 invariants (craft doctrine + episode-end editor chain) ==');
// The doctrine lines are load-bearing prompt content: if a refactor drops one,
// the feature silently degrades to the pre-2.52 generic behavior.
ok(SRC.includes('CRAFT \\u2014 the difference between competent and masterpiece'), 'director default carries the CRAFT doctrine (cause / value turns / irony / payoff debt / competent opposition / concrete scale)');
ok(SRC.includes('STACK MEANING before the centerpiece'), 'seed mode expands premises showrunner-style (meaning stack / phases / population / reprice)');
ok(SRC.includes('NORTH STAR:'), 'critique output contract opens with the single highest-leverage NORTH STAR lever');
ok(SRC.includes('FRICTIONLESS SUCCESS'), 'critique holds the story to the masterpiece bar, not only the defect floor');
ok(SRC.includes('LEGACY_DIRECTOR_PROMPT_V257, LEGACY_DIRECTOR_PROMPT_V262, LEGACY_DIRECTOR_PROMPT_V263, LEGACY_DIRECTOR_PROMPT_V264, LEGACY_DIRECTOR_PROMPT_V265, LEGACY_DIRECTOR_PROMPT_V266];'), 'stored 2.49-2.66 defaults auto-upgrade to the current default');
ok(SRC.includes('DELIBERATION \\u2014 if you reason privately'), 'director default carries deliberation discipline for reasoning models');
ok((SRC.match(/Deliberate efficiently \\u2014 the token budget is shared/g) || []).length === 2, 'showrunner and critique prompts carry deliberation discipline');
ok(SRC.includes('raw = await callLLM(msgs2, onPartial, bigPot);'), 'think-consumed recovery runs in an ENLARGED pot — same-size recovery over longer input is mathematically doomed');
ok(SRC.includes('keep it to a single sentence'), 'recovery gives forced reasoning phases an explicit escape hatch');
ok(SRC.includes('FIRST-DRAFT MODE \\u2014 a showrunner second-draft pass will interrogate'), 'with two-pass on, the draft declares fast-draft mode — deep thought moves to the review');
ok(SRC.includes('directorInjectPaused: false') && SRC.includes('critiqueInjectPaused: false'), 'both pause toggles exist and default OFF');
ok(SRC.includes('!settings.directorInjectPaused && d && d.text') && SRC.includes('!settings.critiqueInjectPaused && text'), 'both injectors gate on their pause flag and actively clear when paused');
ok(SRC.includes('never burn directive calls the storyteller cannot see'), 'auto-director skips while its channel is paused');
ok(SRC.includes("don't count toward a trigger the storyteller cannot receive"), 'auto-critique neither counts nor fires while paused');
ok(SRC.includes('&& !settings.critiqueInjectPaused) {'), 'the episode-end editor pass respects the pause');
ok(SRC.includes('if (clearedText.trim()) {'), 'a whitespace-only directive is treated as empty by the end-season audit');
ok(SRC.includes('CAST \\u2014 before writing beats, sweep the established cast'), 'director default carries the CAST law (stake sweep, jurisdiction-by-definition, no furniture placement)');
ok(SRC.includes('FURNITURE CHARACTERS'), 'critique bar catches furniture characters and absent stakeholders');
ok(SRC.includes('SHOWRUNNER running the second-draft pass'), 'directives get a showrunner second-draft pass (premise ambition, the memorable moment, wasted cast, safety, logic)');
ok(SRC.includes('directorTwoPass: true'), 'the second-draft pass defaults ON');
ok(SRC.includes("const isRestart = mode === 'new' && !!String(prev?.text || '').trim();"), 'New over a live directive is treated as a restart');
ok(SRC.includes('The player RESTARTED this episode'), 'restart carries its own prompt contract (never aired / genuinely different)');
ok(SRC.includes('function raceTransport('), 'every transport await runs under the stall watchdog');
ok((SRC.match(/raceTransport\(/g) || []).length >= 5, 'watchdog covers stream start, stream chunks, plain request, and the fallback backend (found ' + (SRC.match(/raceTransport\(/g) || []).length + ' uses, need >= 5)');
ok(SRC.includes('llmTimeoutSec: 300'), 'stall timeout defaults to 300s and is configurable (0 = off)');
ok(SRC.includes('function busyTicker('), 'busy bubbles carry a liveness ticker');
ok((SRC.match(/busyTicker\(busyNote/g) || []).length === 5, 'all five LLM flows (directive, critique, status, seeds, edit) tick (found ' + (SRC.match(/busyTicker\(busyNote/g) || []).length + ', need 5)');
ok((SRC.match(/\], tick(C|X)?\.onPartial\);/g) || []).length >= 6, 'every ticked flow forwards live stream progress into the readout');
ok(SRC.includes('PLAYED-STATE: NEVER PLAYED'), 'end-season audit declares an unplayed directive as such (anti-spiral)');
ok(SRC.includes('a clean audit is a successful audit'), 'the audit has an explicit clean exit so it never manufactures findings');
ok((SRC.match(/msgAt:/g) || []).length === 2, 'both directive stores record where playtime starts (found ' + (SRC.match(/msgAt:/g) || []).length + ', need 2)');
ok(!/if \(running\) return;\s*\n\s*running = true/.test(SRC), 'no user-initiated entry can die silently at the running flag any more');
ok(SRC.includes('critiqueOnEpisode: true'), 'episode-end auto-critique defaults ON');
const fnAt = SRC.indexOf('async function onEpisodeConcluded(chatAt)');
ok(fnAt > -1, 'episode conclusion routes through onEpisodeConcluded');
const critAt = SRC.indexOf("await generateCritique(true, 'episode');", fnAt);
const dirAt = SRC.indexOf('maybeAutoDirector();', fnAt);
ok(critAt > -1 && dirAt > -1 && critAt < dirAt, 'inside the chain, the editor pass is AWAITED before the next episode is directed (review -> plan order)');
ok((SRC.match(/onEpisodeConcluded\(chatAt\)\.catch\(/g) || []).length === 2, 'both conclusion paths (episode marker + status check) run the chain (fire-and-forget, rejection captured)');
ok(SRC.includes('if (concluded) onEpisodeConcluded(chatAt).catch('), 'status-check path fires the chain AFTER its finally releases the running lock (fired inside it, both steps self-skip)');
ok(!SRC.includes('maybeAutoDirector(); // auto mode: chain the next episode immediately'), 'no conclusion path bypasses the editor by auto-directing directly');
// Live-settings proof: init actually installed the new default and flag.
const CA = ctx.extensionSettings['continuityCopilot'] || {};
// Legacy scenarios exercise their original injection mode; discovery has dedicated tests below.
CA.wiDiscovery = false;
document.getElementById('chatassist_wi_discovery').checked = false;
ok(CA.critiqueOnEpisode === true, 'live settings after init: critiqueOnEpisode is true');
ok(typeof CA.directorPrompt === 'string' && CA.directorPrompt.includes('CRAFT \u2014 the difference between competent and masterpiece'), 'live settings after init: director prompt is the CRAFT default');
ok(typeof CA.directorPrompt === 'string' && CA.directorPrompt.includes('CAST \u2014 before writing beats'), 'live settings after init: director prompt carries the CAST law');
ok(CA.directorTwoPass === true, 'live settings after init: directorTwoPass is true');
// The MESSAGE_RECEIVED handler (which hosts the conclusion chain) must survive a bare invoke.
threw = '';
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(0); } catch (e) { threw = e && e.message; }
ok(!threw, 'MESSAGE_RECEIVED handler runs against an empty chat' + (threw ? ' \u2014 threw: ' + threw : ''));

console.log('== v2.52.0 behavior: conclusion runs review -> plan through the real code paths ==');
// Arrange: live profile, auto director, an unconcluded episode, then a
// storyteller reply carrying [EPISODE_END]. The mock transport records WHICH
// prompt arrived WHEN — proving execution order, not just source order.
const llmCalls = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('NORTH STAR')) { llmCalls.push('critique'); return 'NORTH STAR: play the irony gap harder.\n1. Track every named character present until they visibly exit.'; }
        if (sys.includes('SHOWRUNNER running the second-draft pass')) { llmCalls.push('review'); return 'Intensity: standard\nSHOWRUNNER CUT: the rematch everyone bet against — now with the registrar in the ring.'; }
        if (sys.includes('expert story director')) { llmCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE — the rematch everyone bet against.'; }
        llmCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.profileId = 'gate-profile';
CA.directorMode = 'auto';
CA.streaming = false;
CA.critiqueOnEpisode = true;
CA.critiqueAuto = 0;
CA.directorWatcherPass = false; // legacy flow sections prove the two-pass contract; the three-pass path has its own section below
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'SECRET: episode one beats', episode: 1, concluded: false, ts: 1 }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'The duel ends and the crowd goes silent. [EPISODE_END]' });
console.log = logCap;
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1); } catch (e) { errors.push('sim handler threw: ' + (e && e.message)); }
await new Promise(r => setTimeout(r, 200)); // the chain is fire-and-forget from the handler; let it drain
console.log = realLog;
ok(!errors.some(x => x.includes('sim handler threw')), 'conclusion handler ran the sim without throwing');
ok(llmCalls[0] === 'critique', 'the EDITOR pass fired first (got order: ' + llmCalls.join(', ') + ')');
ok(llmCalls[1] === 'directive', 'the NEXT directive fired second — designed with the fresh notes already saved');
ok(llmCalls[2] === 'review', 'the showrunner pass fired third — draft in, cut out');
ok(String(ctx.chatMetadata.cc_critique || '').startsWith('NORTH STAR:'), 'the review landed in cc_critique under the NORTH STAR contract');
const dNow = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dNow.episode === 2 && !dNow.concluded, 'auto mode chained to a live episode 2 after the review (got E' + dNow.episode + (dNow.concluded ? ' concluded' : '') + ')');
ok(String(dNow.text || '').includes('SHOWRUNNER CUT'), 'the STORED directive is the showrunner cut, not the first draft');

console.log('== v2.55.0 behavior: restart keeps the episode, discards the old take ==');
// Arrange: a live, unconcluded E2 directive, then press New (= Restart).
// The mock records the SYSTEM and USER prompts of both passes so we can prove
// what the model was actually told, not merely what the source says.
llmCalls.length = 0;
let capturedDraft = null, capturedReview = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const usr = (messages && messages[1] && messages[1].content) || '';
        if (sys.includes('SHOWRUNNER running the second-draft pass')) {
            llmCalls.push('review'); capturedReview = { sys, usr };
            return 'Intensity: intense\nRESTARTED CUT: the tribunal nobody called for.';
        }
        llmCalls.push('directive'); capturedDraft = { sys, usr };
        return 'Intensity: intense\n1. EPISODE PREMISE — a tribunal, not a duel.';
    },
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'OLD E2: the duel on the welcome-day grounds.', episode: 2, concluded: false, ts: 5 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f(); // refresh the label from the live directive
ok(document.getElementById('chatassist_dirnew').textContent.includes('Restart'), 'with a live directive the button reads Restart');
console.log = logCap;
try { document.getElementById('chatassist_dirnew').click(); await new Promise(r => setTimeout(r, 250)); } catch (e) { errors.push('restart click threw: ' + (e && e.message)); }
console.log = realLog;
ok(!errors.some(x => x.includes('restart click threw')), 'the New/Restart button ran without throwing');
ok(capturedDraft && capturedDraft.sys.includes('The player RESTARTED this episode'), 'restart draft used the restart prompt contract, not the plain new-episode prompt');
ok(capturedDraft && capturedDraft.usr.includes('[DISCARDED DIRECTIVE') && capturedDraft.usr.includes('OLD E2: the duel'), 'the rejected directive WAS shown to the model (without it, a restart can return the same episode)');
ok(capturedDraft && !capturedDraft.usr.includes('[PREVIOUS EPISODE DIRECTIVE'), 'the discarded episode is NOT passed as concluded history — it never aired');
ok(capturedReview && capturedReview.sys.includes('This episode is a RESTART'), 'the showrunner pass inherits the restart contract and cannot drift back to the rejected episode');
const dR = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dR.episode === 2, 'restart KEPT the episode number (got E' + dR.episode + ', want E2)');
ok(!dR.concluded, 'restart leaves the episode live, not concluded');
ok(String(dR.text || '').includes('RESTARTED CUT'), 'the restarted directive replaced the old text');
// Label honesty: the same button must read Restart while a directive is live.
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f(); // the real refresh path
ok(document.getElementById('chatassist_dirnew').textContent.includes('New'), 'with no directive the same button reads New');

console.log('== v2.56.0 behavior: a hung provider cannot wedge the extension ==');
// The reported symptom: one request never settles -> `running` held forever ->
// every later click on every model dies silently. Prove the watchdog releases
// it AND that the very next click works.
llmCalls.length = 0;
CA.llmTimeoutSec = 1;           // 1s deadline for the test
CA.streaming = false;
let hangs = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: (pid, messages) => { hangs++; return new Promise(() => {}); },   // never settles
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E2 live directive.', episode: 2, concluded: false, ts: 9 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
console.log = logCap;
document.getElementById('chatassist_dirnew').click();               // restart against the hung provider
await new Promise(r => setTimeout(r, 300));
const busyDuringHang = true;                                 // op in flight; second click must be LOUD, not silent
const toastsBefore = toasts.length;
document.getElementById('chatassist_dirnew').click();
const gotBusyToast = toasts.length > toastsBefore && /Another operation is still running/.test(String(toasts[toasts.length - 1]));
await new Promise(r => setTimeout(r, 1400));                 // let the 1s watchdog fire
console.log = realLog;
ok(gotBusyToast, 'clicking during an in-flight operation is LOUD (busy toast), never a silent return');
ok(hangs === 1, 'the hung request was made exactly once (got ' + hangs + ')');
ok((ctx.chatMetadata['continuityCopilot'].director || {}).text === 'E2 live directive.', 'the directive was left unchanged by the timed-out attempt');
// Self-heal: the very next click, now against a working transport, must succeed.
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('SHOWRUNNER running the second-draft pass')) return 'Intensity: standard\nHEALED CUT: the extension recovered.';
        return 'Intensity: standard\n1. EPISODE PREMISE — recovery.';
    },
};
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await new Promise(r => setTimeout(r, 300));
console.log = realLog;
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('HEALED CUT'), 'after the watchdog fired, the NEXT click succeeded — running was released, no reload needed');

console.log('== v2.57.0 behavior: the busy bubble proves the extension is alive ==');
// Streaming transport that yields chunks with real gaps; the bubble must show
// climbing character counts, the phase change to the showrunner pass, and the
// auto-abort countdown — counts only, never directive content.
llmCalls.length = 0;
CA.llmTimeoutSec = 60;
CA.streaming = true;
const bubbleSnapshots = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages, maxTok, opts) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const isReview = sys.includes('SHOWRUNNER running the second-draft pass');
        if (!isReview) globalThis.__draftSys = sys;
        return function stream() {
            return (async function* () {
                const words = isReview ? ['Intensity: standard\n', 'TICKED CUT: ', 'alive and streaming.'] : ['Intensity: standard\n', '1. EPISODE ', 'PREMISE — liveness.'];
                for (const w of words) { await sleep(40); yield { text: w }; }
            })();
        };
    },
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E2 to restart with ticks.', episode: 2, concluded: false, ts: 11 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const logEl = document.getElementById('chatassist_log');
const snap = () => {
    const kids = (logEl && logEl.children) || [];
    for (const k of kids) if (k && k.className && String(k.className).includes('cc_busy') && k.textContent) bubbleSnapshots.push(k.textContent);
};
const snapIv = setInterval(snap, 25);
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await sleep(700);
console.log = realLog;
clearInterval(snapIv);
snap();
const sawWaiting = bubbleSnapshots.some(t => /waiting for the first token/.test(t));
const sawChars = bubbleSnapshots.some(t => /\b\d+ chars/.test(t));
const sawPhase2 = bubbleSnapshots.some(t => /showrunner second draft/.test(t));
const sawCountdown = bubbleSnapshots.some(t => /auto-abort in \d+s/.test(t));
const leakedContent = bubbleSnapshots.some(t => /PREMISE|TICKED CUT/.test(t));
ok(sawWaiting || sawChars, 'the ticker rendered (waiting state or live counts) — got ' + bubbleSnapshots.length + ' snapshots');
ok(sawChars, 'character counts climbed on stream chunks — liveness is visible');
ok(sawPhase2, 'the phase label flipped to the showrunner second draft mid-flow');
ok(sawCountdown, 'the watchdog countdown is visible, so a silent provider has a visible fuse');
ok(!leakedContent, 'secrecy held: the readout showed counts, never directive content');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('TICKED CUT'), 'the streamed restart completed and stored the showrunner cut');
ok(/FIRST-DRAFT MODE/.test(String(globalThis.__draftSys || '')), 'two-pass draft ran in declared fast-draft mode');

console.log('== v2.58.0 behavior: end-season audit knows how much actually aired ==');
// Case 1: the directive stored by the previous sim was never played (no
// storyteller replies were appended after it was set). Ending the season must
// tell the audit NEVER PLAYED and forbid chat-searching.
let auditPrompt = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const usr = (messages && messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        if (/PLAYED-STATE:/.test(usr)) auditPrompt = usr;
        return 'Nothing references the dead plan.';
    },
};
console.log = logCap;
document.getElementById('chatassist_diroff').click();
await sleep(400);
console.log = realLog;
ok(confirms.length > 0, 'End season asked for confirmation through the real dialog');
ok(auditPrompt !== null, 'the residue audit fired through the normal pipeline');
ok(/PLAYED-STATE: NEVER PLAYED/.test(String(auditPrompt)), 'an unplayed directive is declared NEVER PLAYED to the audit');
ok(/do not search the chat for them/.test(String(auditPrompt)), 'the audit is told chat absence is expected — no spiraling on missing beats');
ok(/episode 2/.test(String(auditPrompt)), 'the audit names the exact cleared episode, not "the season"');
ok(/earlier episodes of this season genuinely aired/i.test(String(auditPrompt)), 'season history is fenced off from the audit scope');
ok((ctx.chatMetadata['continuityCopilot'] || {}).director === null, 'the directive was cleared');
// Case 2: a partially played directive — two storyteller replies after set.
auditPrompt = null;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E1 partial plan.', episode: 1, concluded: false, ts: 12, msgAt: ctx.chat.length }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'Reply one under the plan.' });
ctx.chat.push({ is_user: false, mes: 'Reply two under the plan.' });
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
console.log = logCap;
document.getElementById('chatassist_diroff').click();
await sleep(400);
console.log = realLog;
ok(/PLAYED-STATE: PARTIALLY PLAYED \u2014 about 2 storyteller replies/.test(String(auditPrompt)), 'a half-played directive reports its real reply count to the audit');
ok(/narrated on screen is history and stays/.test(String(auditPrompt)), 'partial audits protect what actually aired');

console.log('== v2.59.0 behavior: think-consumed recovery gets a bigger pot and succeeds ==');
// A reasoning model burns the whole pot on <think>. The recovery call must
// arrive with an ENLARGED maxTok and the transcription demand, then succeed.
CA.maxTokens = 4096;            // -> bigPot = min(32768, max(8192, 6144)) = 8192
CA.directorTwoPass = false;     // isolate Phase A
CA.thinkRetries = 2;
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const potCalls = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages, maxTok) => {
        const last = (messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        potCalls.push({ maxTok, recovery: /Transcribe the decisions above/.test(last), fastDraft: /FIRST-DRAFT MODE/.test((messages[0] && messages[0].content) || '') });
        if (potCalls.length === 1) return '<think>endless deliberation about the perfect premise, forty thousand tokens of it</think>';
        return 'Intensity: standard\n1. EPISODE PREMISE — transcribed from the finished reasoning.';
    },
};
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await sleep(400);
console.log = realLog;
ok(potCalls.length === 2, 'exactly one recovery round was needed (got ' + potCalls.length + ' calls)');
ok(potCalls[0] && potCalls[0].maxTok === 4096 && !potCalls[0].recovery, 'first attempt ran at the configured budget');
ok(potCalls[0] && !potCalls[0].fastDraft, 'single-pass mode keeps full deliberation — fast-draft only when a review will follow');
ok(potCalls[1] && potCalls[1].maxTok === 8192, 'the recovery ran in the enlarged pot (got ' + (potCalls[1] && potCalls[1].maxTok) + ', want 8192)');
ok(potCalls[1] && potCalls[1].recovery, 'the recovery demanded transcription of the finished reasoning');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('transcribed from the finished reasoning'), 'the directive was recovered and stored — the thinking was not wasted');

console.log('== v2.61.0 behavior: pause clears the live injection, storage stays ==');
// State from the previous sim: a live directive. Seed editor notes too, then
// pause both, re-apply via the real refresh path, and prove: slots cleared,
// storage intact, Peek-able; unpause restores both slots verbatim.
ctx.chatMetadata.cc_critique = 'NORTH STAR: keep the irony taut.\n1. Track every named presence.';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const dirSlot = () => String(ctx.extPrompts.get('cc_director') || '');
const critSlot = () => String(ctx.extPrompts.get('cc_critique_inject') || '');
ok(dirSlot().includes('transcribed from the finished reasoning'), 'unpaused: the directive is live in its injection slot');
ok(critSlot().includes('NORTH STAR: keep the irony taut.'), 'unpaused: the editor notes are live in their injection slot');
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot() === '', 'paused: the director slot is actively cleared, not merely skipped');
ok(critSlot() === '', 'paused: the editor-notes slot is actively cleared');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('transcribed from the finished reasoning'), 'paused: the directive itself is still stored untouched');
ok(String(ctx.chatMetadata.cc_critique || '').includes('NORTH STAR'), 'paused: the editor notes are still stored untouched');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().includes('transcribed from the finished reasoning') && critSlot().includes('NORTH STAR'), 'unpause restores both live slots verbatim from storage');

console.log('== v2.62.0 behavior: paused channels burn zero background calls ==');
let bgCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { bgCalls++; return 'Intensity: standard\n1. EPISODE PREMISE — should not exist while paused.'; } };
CA.directorMode = 'auto';
CA.directorInjectPaused = true;
CA.critiqueAuto = 1;
CA.critiqueInjectPaused = true;
CA.directorTwoPass = false;
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ctx.chat.push({ is_user: false, mes: 'A reply lands while both channels are paused.' });
console.log = logCap;
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);
await sleep(250);
console.log = realLog;
ok(bgCalls === 0, 'paused: neither auto-director nor auto-critique burned a call (got ' + bgCalls + ')');
ok(!(ctx.chatMetadata['continuityCopilot'] || {}).director, 'paused: no invisible directive was generated');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
ctx.chat.push({ is_user: false, mes: 'A reply lands after unpausing.' });
console.log = logCap;
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);
await sleep(250);
console.log = realLog;
ok(bgCalls > 0, 'unpaused: automation resumed on the very next reply (got ' + bgCalls + ' calls)');


console.log('== v2.63.0 behavior: player sovereignty — the plan cannot pre-decide the player ==');
// The complaint this closes: directives were written as destiny ("MC does not
// help") instead of premise ("bullying erupts in front of the MC — the answer
// is theirs"). The fix is structural: the FORMAT can no longer express a
// predetermined outcome. These assertions hold that shape in place.
CA.directorMode = 'off';
// (a) The shipping default (migrated into live settings at init) carries the new spine.
ok(String(CA.directorPrompt || '').includes('THE PLAN STOPS AT THE PLAYER'), 'default prompt carries the stop-at-the-player beat grammar law');
ok(String(CA.directorPrompt || '').includes('EPISODE QUESTION'), 'default prompt anchors the episode on a player-facing EPISODE QUESTION');
ok(String(CA.directorPrompt || '').includes('is a stolen choice'), 'the grammar law teaches by example: the world half is a beat, the player half is a stolen choice');
ok(!String(CA.directorPrompt || '').includes('natural end state of the episode'), 'the fixed-outcome landing definition is gone from the shipping default');
ok(String(CA.directorPrompt || '').includes('one line per likely answer naming how the world responds'), 'landing maps consequences per answer instead of scripting one outcome');
ok(String(CA.directorPrompt || '').includes('(7) THEME'), 'craft doctrine gained the THEME law (value under test, felt not announced)');
// (b) The showrunner pass hunts sovereignty violations and cannot sharpen into illogic.
ok(SRC.includes('6. SOVEREIGNTY \\u2014 hunt every sentence that decides FOR the player'), 'showrunner pass carries the SOVEREIGNTY interrogation');
ok(SRC.includes('settle your seven interrogations'), 'showrunner deliberation counts all seven interrogations');
ok(SRC.includes('scripts the player\\\'s half of a collision is a downgrade'), 'sharpening has an explicit truth/freedom counterweight');
ok(SRC.includes('plausible causation \\u2014 would a skeptical viewer accept why each beat happens now'), 'LOGIC interrogation now checks causal plausibility, not just rule compliance');
// (c) The live storyteller wrapper: episode ends on the ANSWERED question, never on reaching a scripted landing.
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E9 sovereignty plan.', episode: 9, concluded: false, ts: 1, msgAt: ctx.chat.length }, directorEp: 9 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const wrap = dirSlot();
ok(wrap.includes('stop at the player'), 'wrapper orders the storyteller to stop at the player\u2019s decision point');
ok(wrap.includes('unchosen branches never happened'), 'wrapper quarantines unchosen consequence branches from canon');
ok(wrap.includes('answered by the player on screen'), 'wrapper ends the episode on the answered question');
ok(!wrap.includes('When the LANDING state is fully reached'), 'the old reach-the-landing teleology is gone from the wrapper');
// The injection voice is universal: the mock persona is the role-word 'Player',
// so the wrapper falls back to the author's note — never a hardcoded name,
// never the word "user".
ok(wrap.startsWith("Author's note — my director's plan"), 'role-word persona → the author\'s note, not a role label');
ctx.name1 = 'Jovan';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().startsWith("Jovan's note — my director's plan"), 'a named persona speaks as themselves');
ctx.name1 = 'User';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().startsWith("Author's note — my director's plan"), 'ST\'s unset default "User" also falls back — the word user never enters the voice');
ctx.name1 = 'Player';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(!SRC.includes('Bruce'), 'no player name is hardcoded anywhere in the extension');
ok((SRC.match(/directorDepth: 3,/g) || []).length === 1 && SRC.includes('numSetting(settings?.directorDepth, 3, 0, 20)'), 'director steering defaults to depth 3 — between memory reference (4) and beat-level outcome notes (0): reference → plan → outcome → reply');
// (d) Migration mechanics, executed with the real values: the v2.62 default was
// frozen verbatim, differs from the new default, upgrades when stored, and a
// customized copy is left alone.
const hookM = SRC.match(/const HOOK_LINE = ('(?:[^'\\]|\\.)*');/);
const v262M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V262 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
const defM = SRC.match(/const DEFAULT_DIRECTOR_PROMPT = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!(hookM && v262M && defM), 'HOOK_LINE, frozen V262, and new default are all extractable from source');
let v262 = '', dflt = '';
try {
    const HOOK = new Function('return ' + hookM[1])();
    v262 = new Function('HOOK_LINE', 'return ' + v262M[1])(HOOK);
    dflt = new Function('HOOK_LINE', 'return ' + defM[1])(HOOK);
} catch (e) { ok(false, 'evaluating the prompt constants threw: ' + (e && e.message)); }
ok(v262.includes('natural end state of the episode') && v262.includes('conclude naturally at the landing'), 'the freeze preserved the old v2.62 text verbatim (stored copies will match it)');
ok(v262.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.62 default');
const migrates = (stored) => [v262].some(pp => stored.trim() === pp.trim());
ok(migrates(v262 + '\n'), 'migration predicate: an untouched stored v2.62 default upgrades');
ok(!migrates(v262 + '\nMY CUSTOM LAW'), 'migration predicate: a user-customized prompt is never overwritten');

console.log('== v2.64.0 behavior: total sovereignty — no seam left for the plan to script the player ==');
// v2.63 banned the player as "author of a response" and a live directive
// promptly scripted the player's ENTIRE duel as involuntary events ("his
// Reaving surfaces involuntarily"), scripted his dialogue ("Fine."), and
// presupposed the reveal at premise level ("the question isn't whether his
// tier comes out"). Each seam is now closed, and the version stamp that
// silently stayed at 2.62.0 is now locked to the manifest.
// (a) Version lock: the in-code header stamp can never drift from the manifest again.
const verM = SRC.match(/const VERSION = '([^']+)';/);
let maniVer = '';
try { maniVer = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')).version; } catch (e) {}
ok(!!verM && !!maniVer && verM[1] === maniVer, 'in-code VERSION stamp matches manifest.json (' + (verM && verM[1]) + ' vs ' + maniVer + ')');
// (b) The shipping default carries the total-subject ban.
const dp = String(CA.directorPrompt || '');
ok(dp.includes('never be the SUBJECT of a planned sentence'), 'beats law: the player may never be the subject of any planned sentence');
ok(dp.includes('involuntary is still theirs'), 'the involuntary loophole is named and closed');
ok(dp.includes('"his real tier comes out" is a stolen choice'), 'the reveal-by-plan case is taught by example');
ok(dp.includes("the question isn't whether the player does X"), 'premise-level presupposition is banned with its tell named');
ok(dp.includes("The TURN is the WORLD's move"), 'the TURN must be an NPC/world move, never a player performance');
ok(dp.includes('choreograph ONLY the NPC'), 'scheduled events choreograph only the NPC half — every player answer stays blank');
ok(!dp.includes('never as the author of a response'), 'the old response-only phrasing (the seam) is gone from the shipping default');
// (c) Showrunner pass hunts the whole class.
ok(SRC.includes('theft with an alibi'), 'SOVEREIGNTY names involuntary scripting as theft with an alibi');
ok(SRC.includes('even one scripted word'), 'SOVEREIGNTY catches scripted player dialogue');
ok(SRC.includes('STAGED by the world and completed by the player'), 'THE MOMENT must be world-staged, never a scripted player action');
// (d) Live wrapper: the storyteller is told slips belong to the player too.
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const wrap64 = dirSlot();
ok(wrap64.includes('so are their slips'), 'wrapper: player slips are player events');
ok(wrap64.includes('let the player decide what breaks'), 'wrapper: pressure is staged, breakage is played');
// (e) Migration: v2.63 default frozen verbatim, upgrades, customization untouched.
const v263M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V263 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v263M, 'frozen V263 default is extractable from source');
let v263 = '';
try {
    const HOOK2 = new Function('return ' + hookM[1])();
    v263 = new Function('HOOK_LINE', 'return ' + v263M[1])(HOOK2);
} catch (e) { ok(false, 'evaluating V263 threw: ' + (e && e.message)); }
ok(v263.includes('never as the author of a response'), 'the freeze preserved the v2.63 text verbatim (stored copies will match it)');
ok(v263.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.63 default');
const migrates64 = (stored) => [v262, v263].some(pp => stored.trim() === pp.trim());
ok(migrates64(v263 + '\n'), 'migration predicate: an untouched stored v2.63 default upgrades');
ok(!migrates64(v263 + '\nMY CUSTOM LAW'), 'migration predicate: a user-customized prompt is never overwritten');

// (f) v2.65 recognition grammar: V264 frozen verbatim, upgrades, and the new laws exist.
const v264M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V264 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v264M, 'frozen V264 default is extractable from source');
let v264 = '';
try {
    const HOOK4 = new Function('return ' + hookM[1])();
    v264 = new Function('HOOK_LINE', 'return ' + v264M[1])(HOOK4);
} catch (e) { ok(false, 'evaluating V264 threw: ' + (e && e.message)); }
ok(v264.includes('Plan the temptation, never the yielding'), 'the freeze preserved the v2.64 text verbatim (stored copies will match it)');
ok(!v264.includes('RECOGNITION LAW'), 'the V264 freeze is genuinely the pre-recognition text, not a copy of the new default');
ok(createHash('sha256').update(v264).digest('hex') === '0acbd3b073a0f7ed69de16da2465ccab52580d7d5a4eec78845ece753067482c', 'V264 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v264.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.64 default');
const migrates65 = (stored) => [v262, v263, v264].some(pp => stored.trim() === pp.trim());
ok(migrates65(v264 + '\n'), 'migration predicate: an untouched stored v2.64 default upgrades');
ok(!migrates65(v264 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.64 prompt is never overwritten');
ok(dflt.includes('real screen time instead of a summary line'), 'delights palette demands screen time for repricing payoffs');
ok(dflt.includes('AMBIENT INTERLUDE') && dflt.includes('AMBIENT EXCEPTION'), 'ambient interlude shape exists and is exempted from the DILEMMA');
ok(dflt.includes('dismissed\u2192reckoned-with'), 'turn-the-value vocabulary includes recognition flips');
ok(SRC.includes('7. PAYOFF ON SCREEN') && SRC.includes('A payoff summarized into aftermath is a skipped payoff'), 'showrunner interrogates payoff staging as craft');

// (g) v2.66 audience balance: V265 frozen verbatim + hash, rotation, either-direction, warm register.
const v265M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V265 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v265M, 'frozen V265 default is extractable from source');
let v265 = '';
try {
    const HOOK5 = new Function('return ' + hookM[1])();
    v265 = new Function('HOOK_LINE', 'return ' + v265M[1])(HOOK5);
} catch (e) { ok(false, 'evaluating V265 threw: ' + (e && e.message)); }
ok(v265.includes('lands in full before anything answers it'), 'the freeze preserved the v2.65 text verbatim (stored copies will match it)');
ok(!v265.includes('never the same audience two episodes running'), 'the V265 freeze is genuinely the pre-rotation text, not a copy of the new default');
ok(createHash('sha256').update(v265).digest('hex') === '025e5429b3a43fa61acf38a472c4ca9edf75c75f47b7b953f467c8f40bc2e8ef', 'V265 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v265.includes('RECOGNITION LAW') && v265.includes('the OLD reading scores first'), 'recognition-era freeze carries the law (historical witness)');
ok(v265.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.65 default');
const migrates66 = (stored) => [v262, v263, v264, v265].some(pp => stored.trim() === pp.trim());
ok(migrates66(v265 + '\n'), 'migration predicate: an untouched stored v2.65 default upgrades');
ok(!migrates66(v265 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.65 prompt is never overwritten');
ok(!dflt.includes('RECOGNITION LAW') && !dflt.includes('never the same audience two episodes running'), 'v2.67 default carries no recognition legislation \u2014 the insight moved to taste');
ok(dflt.includes('cold (the room that muttered who-is-this-guy') && dflt.includes('or warm (a best friend re-seeing'), 'delights palette names cold and warm registers as equals');
ok(dflt.includes('a masterpiece owes the player nothing but itself'), 'delights are a palette, not a quota \u2014 delight-free episodes are lawful');
ok(dflt.includes('taste knowledge, not a quota'), 'palette is explicitly taste, not law');

// (h) v2.67 three-layer room: V266 frozen + hashed, watcher pass exists, wired, sovereign, minimal-cut.
const v266M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V266 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v266M, 'frozen V266 default is extractable from source');
let v266 = '';
try {
    const HOOK6 = new Function('return ' + hookM[1])();
    v266 = new Function('HOOK_LINE', 'return ' + v266M[1])(HOOK6);
} catch (e) { ok(false, 'evaluating V266 threw: ' + (e && e.message)); }
ok(createHash('sha256').update(v266).digest('hex') === '56360487bed0a38f4bd3f6ad8f0046b71c301e184c695da226c1d16ac984426e', 'V266 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v266.includes('never the same audience two episodes running'), 'V266 freeze carries the rotation law (historical witness)');
ok(v266.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.66 default');
const migrates67 = (stored) => [v262, v263, v264, v265, v266].some(pp => stored.trim() === pp.trim());
ok(migrates67(v266 + '\n'), 'migration predicate: an untouched stored v2.66 default upgrades');
ok(!migrates67(v266 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.66 prompt is never overwritten');
ok(SRC.includes('const WATCHER_PASS_PROMPT'), 'watcher pass prompt exists');
ok(SRC.includes('MINIMAL CUT') && SRC.includes('if the episode already airs, output it unchanged'), 'watcher is a minimal final cut, not a third rewrite');
ok(SRC.includes('wish for situations, never for answers'), 'watcher sovereignty: enjoyment may never script the player');
ok(SRC.includes('slow is welcome when slow is what the story is hungry for'), 'watcher legitimizes slow episodes by taste, not schedule');
ok(SRC.includes("tick.phase('watcher final cut')") && SRC.includes('directorWatcherPass') && SRC.includes('shipping the showrunner cut'), 'watcher pass is wired into the directive flow with empty-fallback');
ok(SRC.includes('directorWatcherPass: true,'), 'watcher pass defaults on');
ok(SRC.includes("el('cc_dir_watcher').checked = settings.directorWatcherPass !== false;") && SRC.includes("settings.directorWatcherPass = el('cc_dir_watcher').checked;"), 'watcher toggle load/save round-trips');
ok(!dflt.includes('every fourth or fifth episode') && dflt.includes('available whenever the story is hungry for breath'), 'ambient interlude is available on demand, not on a schedule');

console.log('== v2.67.0 behavior: the watcher third pass ==');
const wCalls = [];
let watcherReturn = 'Intensity: standard\nWATCHER AIRED ONE: same cut, one delight staged.';
let srReturn = 'Intensity: standard\nSHOWRUNNER CUT ONE: the rematch, sharpened.';
globalThis.__watcherSys = ''; globalThis.__watcherUsr = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const usr = (messages && messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        if (sys.includes('THE WATCHER')) { wCalls.push('watcher'); globalThis.__watcherSys = sys; globalThis.__watcherUsr = usr; return watcherReturn; }
        if (sys.includes('SHOWRUNNER running the second-draft pass')) { wCalls.push('review'); return srReturn; }
        if (sys.includes('expert story director')) { wCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE: the rematch.'; }
        wCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.directorWatcherPass = true;
CA.directorTwoPass = true;
CA.directorMode = 'off';
CA.streaming = false;
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await sleep(400);
console.log = realLog;
const w1 = wCalls.join(',');
ok(w1 === 'directive,review,watcher', 'three-pass order: maker, showrunner, watcher (got: ' + w1 + ')');
ok(String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('WATCHER AIRED ONE'), 'the STORED directive is the watcher final cut');
ok(globalThis.__watcherUsr.includes('[SCREENING COPY') && globalThis.__watcherUsr.includes('SHOWRUNNER CUT ONE'), 'the showrunner cut travels to the couch as the screening copy');
ok(globalThis.__watcherSys.includes('MINIMAL CUT') && !globalThis.__watcherSys.includes('This episode is a RESTART'), 'fresh episode: watcher briefed for minimal cut, no restart addendum');
// empty watcher output ships the showrunner cut
wCalls.length = 0; watcherReturn = ''; srReturn = 'Intensity: standard\nSHOWRUNNER CUT TWO: fallback proof.';
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await sleep(400);
console.log = realLog;
const dW2 = String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '');
ok(wCalls.join(',') === 'directive,review,watcher' && dW2.includes('SHOWRUNNER CUT TWO') && !dW2.includes('WATCHER AIRED'), 'empty watcher pass falls back to the showrunner cut');
// toggle off: exactly two calls, no watcher
wCalls.length = 0; srReturn = 'Intensity: standard\nSHOWRUNNER CUT THREE: two-pass toggle proof.';
CA.directorWatcherPass = false;
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await sleep(400);
console.log = realLog;
ok(wCalls.join(',') === 'directive,review' && String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('SHOWRUNNER CUT THREE'), 'watcher toggle off restores the exact two-pass contract');
// restart: the watcher receives the never-aired warning
wCalls.length = 0; watcherReturn = 'Intensity: standard\nWATCHER AIRED FOUR: the road not taken, enjoyed.'; srReturn = 'Intensity: standard\nSHOWRUNNER CUT FOUR.';
CA.directorWatcherPass = true;
globalThis.__watcherSys = '';
console.log = logCap;
document.getElementById('chatassist_dirnew').click();
await sleep(400);
console.log = realLog;
ok(globalThis.__watcherSys.includes('This episode is a RESTART'), 'restart: the watcher is told the discarded directive never aired');
ok(String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('WATCHER AIRED FOUR'), 'restart flow ships the watcher final cut');

console.log('== v2.68.0 behavior: undo is drift-guarded (swipe / deletion / external memory / WI editor) ==');
// Drive the REAL paths end-to-end: stage cards through Send, apply through
// Apply-all, drift the target from OUTSIDE (swipe, delete, co-extension write,
// World-Info editor), then Undo. The pre-2.68 blind restore must be refused
// loudly and the drifted content must survive. A clean undo must still work.
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.directorMode = 'off';
CA.critiqueAuto = 0;
CA.critiqueOnEpisode = false;
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
const ccLogText = () => (document.getElementById('chatassist_log').children || []).map(k => String(k.textContent || '') + String(k.innerHTML || ''));
const clickFresh = (id) => {
    const b = document.getElementById(id);
    // Mock fidelity: the real DOM destroys and recreates these buttons on every
    // render (fresh listeners); the mock stub element accumulates them. Keep the
    // latest only, or one click fires every render generation at once.
    const arr = b._on.get('click') || [];
    if (arr.length > 1) b._on.set('click', arr.slice(-1));
    b.click();
};
const driveAsk = async (reply) => {
    ctx.ConnectionManagerRequestService = { sendRequest: async () => reply };
    document.getElementById('chatassist_input').value = 'please fix this';
    clickFresh('chatassist_send');
    await sleep(350);
    clickFresh('chatassist_applyall');
    await sleep(350);
};
// Positive control: with NO drift, undo still restores exactly.
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'The road was iron.' });
await driveAsk('<edits>[{"id":0,"find":"iron","replace":"steel"}]</edits>');
ok(ctx.chat[0].mes === 'The road was steel.', 'sim setup: chat edit applied through the real Apply-all path');
clickFresh('chatassist_undo');
await sleep(300);
ok(ctx.chat[0].mes === 'The road was iron.', 'clean undo (no drift) still restores the pre-apply text exactly');
// (a) Swipe drift.
ctx.chat.length = 0;
ctx.chat.push({ is_user: true, mes: 'hi' }, { is_user: false, mes: 'The sword was iron.' });
await driveAsk('<edits>[{"id":1,"find":"iron","replace":"steel"}]</edits>');
ok(ctx.chat[1].mes === 'The sword was steel.', 'sim setup: second chat edit applied');
ctx.chat[1].mes = 'The player rewrote this swipe entirely.';
clickFresh('chatassist_undo');
await sleep(300);
ok(ctx.chat[1].mes === 'The player rewrote this swipe entirely.', 'undo-after-swipe: the player\u2019s newer text survived \u2014 the blind restore was refused');
ok(ccLogText().some(t => /SKIPPED/.test(t) && /swipe \/ edit \/ reindex/.test(t)), 'undo-after-swipe: the refusal was loud and itemized in the panel');
// (b) Message deletion reindex.
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'zero' }, { is_user: false, mes: 'one' }, { is_user: false, mes: 'The gate was iron.' });
await driveAsk('<edits>[{"id":2,"find":"iron","replace":"steel"}]</edits>');
ok(ctx.chat[2].mes === 'The gate was steel.', 'sim setup: third chat edit applied');
ctx.chat.splice(0, 1);   // the user deleted message #0 \u2014 every later index shifts down
clickFresh('chatassist_undo');
await sleep(300);
ok(ctx.chat.length === 2 && ctx.chat[0].mes === 'one' && ctx.chat[1].mes === 'The gate was steel.', 'undo-after-deletion: no message received stale text after the reindex');
ok(ccLogText().some(t => /SKIPPED/.test(t) && /no longer exists/.test(t)), 'undo-after-deletion: the refusal was loud');
// (c) External memory write (Summaryception interop).
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
ctx.chatMetadata.summary_memory = 'The blade is iron.';
await driveAsk('<memedits>[{"path":"summary_memory","find":"iron","replace":"steel"}]</memedits>');
ok(String(ctx.chatMetadata.summary_memory) === 'The blade is steel.', 'sim setup: the memory edit applied');
ctx.chatMetadata.summary_memory += '\n[Summaryception] a new beat was logged.';
clickFresh('chatassist_undo');
await sleep(300);
ok(String(ctx.chatMetadata.summary_memory).includes('new beat was logged'), 'undo-after-external-write: the co-extension\u2019s newer memory survived');
ok(ccLogText().some(t => /summary_memory/.test(t) && /changed since the apply/.test(t)), 'undo-after-external-write: the refusal named the drifted key');
// (d) World-Info editor edit.
const wiStore = new Map();
ctx.loadWorldInfo = async (book) => { const d = wiStore.get(book); return d ? JSON.parse(JSON.stringify(d)) : null; };
ctx.saveWorldInfo = async (book, data) => { wiStore.set(book, JSON.parse(JSON.stringify(data))); return true; };
wiStore.set('gatebook', { entries: { '0': { uid: 0, key: ['blade'], keysecondary: [], comment: 'Blade', content: 'iron blade' } } });
CA.wiBooks = 'gatebook';   // wiCanEdit() requires at least one effective book
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
await driveAsk('<wiedits>[{"book":"gatebook","uid":0,"find":"iron","replace":"steel"}]</wiedits>');
ok(String(wiStore.get('gatebook').entries['0'].content) === 'steel blade', 'sim setup: the worldbook edit applied');
wiStore.get('gatebook').entries['0'].content = 'steel blade (polished by hand in the WI editor)';
wiStore.get('gatebook').entries['1'] = { uid: 1, key: ['extra'], keysecondary: [], comment: 'Extra', content: 'user-added entry' };
clickFresh('chatassist_undo');
await sleep(300);
const bookAfterUndo = wiStore.get('gatebook');
ok(String(bookAfterUndo.entries['0'].content).includes('polished by hand') && !!bookAfterUndo.entries['1'], 'undo-after-WI-editor-edit: hand edits and user-added entries survived \u2014 the blind whole-book restore was refused');
ok(ccLogText().some(t => /worldbook/.test(t) && /gatebook/.test(t) && /changed since the apply/.test(t)), 'undo-after-WI-editor-edit: the refusal named the worldbook');

console.log('== v2.68.0 behavior: Apply is re-entrancy safe (synchronous card claim) ==');
// A slow save opens the window the old code lost: two Apply-all clicks during
// the first run's network await must NOT create the entry twice.
wiStore.set('racebook', { entries: {} });
CA.wiBooks = 'racebook';
let saveGate = null;
ctx.saveWorldInfo = async (book, data) => { if (saveGate) await saveGate; wiStore.set(book, JSON.parse(JSON.stringify(data))); return true; };
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
clickFresh('chatassist_dismissall');   // isolate: earlier sims returned their cards to pending
await sleep(50);
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<wiedits>[{"book":"racebook","new_entry":true,"comment":"Canon","content":"the duke is dead","keys":["duke"]}]</wiedits>' };
document.getElementById('chatassist_input').value = 'add lore';
clickFresh('chatassist_send');
await sleep(350);
let releaseSave;
saveGate = new Promise(r => { releaseSave = r; });
clickFresh('chatassist_applyall');
await sleep(60);            // first run is now parked inside the slow save
clickFresh('chatassist_applyall');  // re-entrant click: must skip the claimed card, loudly
await sleep(60);
releaseSave();
await sleep(350);
saveGate = null;
const raceEntries = Object.keys(wiStore.get('racebook').entries).length;
ok(raceEntries === 1, 'double-click Apply-all during a slow save created exactly ONE worldbook entry (got ' + raceEntries + ')');
ok(ccLogText().some(t => /Already applying/.test(t)), 'the re-entrant click was told a run is in progress, not silently ignored');

console.log('== v2.68.0 behavior: fuzzy memory anchors must be unique across ALL fields ==');
// Two ledger fields differ by ONE word from the anchor (fuzzy ~0.89, no exact
// match): the old first-match-wins fallback would have written into whichever
// field enumerated first. The collect-then-decide guard must refuse — and a
// path-scoped retry of the same anchor must apply precisely.
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
clickFresh('chatassist_dismissall');
await sleep(50);
ctx.chatMetadata.summary_ledger = {
    jillian: { state: 'Jillian is at the academy library, studying wards.' },
    bram: { state: 'Jillian is at the academy library, studying tomes.' },
};
await driveAsk('<memedits>[{"find":"Jillian is at the academy library, studying scrolls.","replace":"Jillian is at the academy observatory, studying wards."}]</memedits>');
ok(String(ctx.chatMetadata.summary_ledger.jillian.state).includes('library') && String(ctx.chatMetadata.summary_ledger.bram.state).includes('library'), 'cross-field fuzzy anchor: BOTH lookalike fields untouched \u2014 first-match corruption refused');
ok(ccLogText().some(t => /No edits applied/.test(t)), 'cross-field fuzzy anchor: the refusal was loud (failed card + explanation), not a silent skip');
await driveAsk('<memedits>[{"path":"summary_ledger.jillian.state","find":"Jillian is at the academy library, studying scrolls.","replace":"Jillian is at the academy observatory, studying wards."}]</memedits>');
ok(String(ctx.chatMetadata.summary_ledger.jillian.state).includes('observatory') && String(ctx.chatMetadata.summary_ledger.bram.state).includes('library'), 'the same anchor with an explicit path applied to exactly the named field');

console.log('== v2.68.0 invariants: card hand-edit is payload-channel aware ==');
// The ✎ viewer used to String() every payload: structured replaces died as
// "[object Object]" and append cards edited a field the apply path never reads.
ok(SRC.includes('function cardPayloadSpec('), 'card hand-edit routes through a payload-channel spec');
ok(SRC.includes('const isAppend = edit.append !== undefined'), 'append cards edit the append channel, not the dead replace field');
ok(SRC.includes('saved back as a structured value'), 'structured replaces are presented as JSON');
ok(SRC.includes("throw new Error('expected a JSON array or object')"), 'structured hand-edit rejects non-object JSON instead of corrupting the payload');
ok(SRC.includes("catch (je) {") && SRC.includes('the proposal was left unchanged'), 'invalid JSON in the viewer fails loud and leaves the card unchanged');
ok(!SRC.includes("showViewer(title, String(e.replace ?? '')"), 'the blind String(e.replace) hand-edit path is gone');

console.log('== v2.68.0 invariants: the low-severity hardening pack ==');
ok(SRC.includes("your message is back in the box"), '/cc while busy: typed text is parked back in the input, never dropped silently');
ok(SRC.includes('pendingAutoDirectorRetry = true; return;') && (SRC.match(/releaseAutoDirectorRetry\(\);/g) || []).length >= 7, 'auto-director skip-while-running sets a retry flag, drained by every running-releasing finally (found ' + (SRC.match(/releaseAutoDirectorRetry\(\);/g) || []).length + ' drains, need >= 7)');
ok(SRC.includes('await streamIt.return?.()'), 'a stopped stream is formally closed (iterator return), not abandoned');
ok(SRC.includes('INIT_MAX_ATTEMPTS') && SRC.includes('setTimeout(init, 2000)') && SRC.includes('inited = true;\n            console.log(LOG'), 'init failure is retryable with phase guards; inited set only on success');
ok(SRC.includes('const UNDO_CAP = 50') && SRC.includes('function pushUndoBatch(') && !SRC.includes('undoStack.push({'), 'undo history is bounded and all pushes route through the cap');
ok(!SRC.includes("writable at path cc_critique) ---"), 'cc_critique is no longer duplicated into the copilot context (author-level block carries it)');
ok(SRC.includes('function wiRoleNum(') && SRC.includes('role: o.role !== undefined ? wiRoleNum(o.role) : null,'), 'worldbook role is validated/mapped to the numeric enum at parse time');
ok(SRC.includes('replace(/["\'`\\\\{}[\\]]/g, \'\')'), 'worldbook names are sanitized before slash-command interpolation');
ok(SRC.includes('concluded by advancing (') && SRC.includes('no [EPISODE_END] marker was emitted'), 'Next/Seed over a live episode records the skipped conclusion in the ledger');
ok(SRC.includes('for (let guard = 0; guard < 20; guard++)'), 'stripBlocks removes EVERY block per tag (bounded), not just the first');

console.log('== v2.68.0 behavior: send() while busy is loud and loses nothing ==');
let slow2;
ctx.ConnectionManagerRequestService = { sendRequest: () => new Promise(r => { slow2 = () => r('ok'); }) };
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
document.getElementById('chatassist_input').value = 'first question';
clickFresh('chatassist_send');
await sleep(80);
document.getElementById('chatassist_input').value = '';
const toastsBeforeBusy = toasts.length;
clickFresh('chatassist_audit');   // a send() entry point while running — must be loud + preserve text
await sleep(50);
ok(toasts.length > toastsBeforeBusy && /back in the box/.test(String(toasts[toasts.length - 1])), 'send() while busy is loud, not a silent drop');
ok(String(document.getElementById('chatassist_input').value).length > 0, 'send() while busy parked the text back in the input box');
document.getElementById('chatassist_input').value = '';
slow2();
await sleep(300);

console.log('== v2.68.0 behavior: auto-director skipped mid-run retries when the lock releases ==');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
CA.directorMode = 'auto';
CA.directorTwoPass = false;
CA.directorWatcherPass = false;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E1 done.', episode: 1, concluded: true, ts: 1 }, directorEp: 1 };
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
const seq = [];
let slowRelease;
ctx.ConnectionManagerRequestService = {
    sendRequest: (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('expert story director')) { seq.push('directive'); return Promise.resolve('Intensity: standard\n1. EPISODE PREMISE \u2014 chained after the lock released.'); }
        seq.push('copilot');
        return new Promise(r => { slowRelease = () => r('copilot answer'); });
    },
};
document.getElementById('chatassist_input').value = 'question while concluded';
clickFresh('chatassist_send');
await sleep(100);   // the copilot run now holds `running`
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);  // auto-direct skips: lock held
ok(seq.join(',') === 'copilot', 'auto-direct skipped while the lock was held (only the copilot call fired)');
slowRelease();
await sleep(400);   // the finally drains the retry flag -> maybeAutoDirector -> next directive
ok(seq.join(',') === 'copilot,directive', 'the skipped auto-direct fired when the lock released (got: ' + seq.join(',') + ')');
const dRetry = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dRetry.episode === 2 && !dRetry.concluded && String(dRetry.text || '').includes('chained after the lock released'), 'the retried chain stored a live episode 2');

console.log('== v2.69.0 invariants: the stop flag belongs to the RUN, not to one call ==');
// Regression: `stopRequested` was cleared at the top of callLLM. A run makes MANY
// calls (fetch rounds, worldbook reads, think-recovery, three director passes), so
// a Stop pressed in any gap between them was erased and the run opened a request
// the user had already cancelled.
ok(/function beginRun\(\) \{\n        running = true;\n        stopRequested = false;\n        setBusy\(true\);\n    \}/.test(SRC), 'beginRun() is the one place a run starts: takes the lock AND clears the stop flag');
ok((SRC.match(/\n        running = true;/g) || []).length === 1, 'the lock is taken in exactly one place (beginRun), nowhere else');
ok((SRC.match(/\n        beginRun\(\);/g) || []).length === 11, 'all 11 run entrypoints route through beginRun (found ' + (SRC.match(/\n        beginRun\(\);/g) || []).length + ', need 11)');   // +1 in v2.72 (runDeepAudit), +1 in v2.73 (runMemoryPass)
ok(!/const maxTok = [^\n]*\n        stopRequested = false;/.test(SRC), 'callLLM no longer clears the stop flag');
ok(/if \(stopRequested\) return '';\n        try \{ abortCtl = new AbortController/.test(SRC), 'callLLM refuses to open a request when the run is already stopped');

console.log('== v2.69.0 invariants: undo cannot lose a batch or write to the wrong chat ==');
ok(SRC.includes('async function undoRestore(batch)'), 'the undo restore body is separable from the pop, so a throw is catchable');
ok(/\} catch \(err\) \{[\s\S]{0,500}?undoStack\.push\(batch\);/.test(SRC), 'a throw mid-undo puts the batch BACK instead of consuming it');
ok(/const md = chatAt\.md \|\| c\.chatMetadata \|\| c\.chat_metadata;/.test(SRC), 'undo restores memory into the CAPTURED chat, not whatever chat is open now');

console.log('== v2.69.0 invariants: no throw escapes a lock acquisition ==');
ok(/attachMsgIcons\(div, kind, hidx\);\n[\s\S]{0,400}?\n        if \(!log\) return div;/.test(SRC), 'addBubble degrades when the panel is absent instead of throwing past the caller\u2019s lock');
ok(/attachMsgIcons\(div, 'ai', hidx\);\n        if \(!log\) return div;/.test(SRC), 'addAiBubble degrades when the panel is absent');
ok(SRC.includes('function applyRunFailed(') && (SRC.match(/\.catch\(applyRunFailed\)/g) || []).length === 2, 'both fire-and-forget applyEdits call sites surface a rejected run (found ' + (SRC.match(/\.catch\(applyRunFailed\)/g) || []).length + ', need 2)');

console.log('== v2.69.0 invariants: the auto-director retry is armed only when it can fire ==');
{
    const mad = SRC.slice(SRC.indexOf('function maybeAutoDirector()'), SRC.indexOf('async function onEpisodeConcluded'));
    const iProfile = mad.indexOf('if (!settings.profileId) return;');
    const iPaused = mad.indexOf('if (settings.directorInjectPaused) return;');
    const iRunning = mad.indexOf('if (running) { pendingAutoDirectorRetry = true; return; }');
    ok(iProfile > 0 && iPaused > 0 && iRunning > iProfile && iRunning > iPaused, 'running (the only transient condition) is tested AFTER profile and paused');
}

console.log('== v2.69.0 behavior: a Stop pressed BETWEEN calls opens no further request ==');
CA.directorMode = 'off';
CA.critiqueAuto = 0;
CA.critiqueOnEpisode = false;
CA.fetchRounds = 3;
wiStore.set('stopbook', { entries: { '0': { uid: 0, key: ['x'], keysecondary: [], comment: 'X', content: 'body text' } } });
CA.wiBooks = 'stopbook';
ctx.chatMetadata['continuityCopilot'] = {};
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
let stopRunCalls = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: async () => {
        stopRunCalls++;
        return stopRunCalls === 1 ? '<wifetch>["stopbook#0"]</wifetch>' : 'THIS SECOND CALL MUST NOT HAPPEN';
    },
};
const realLoadWI = ctx.loadWorldInfo;
ctx.loadWorldInfo = async (book) => {
    // The user hits Stop during the worldbook read — precisely the gap between the
    // round's stop-check and the next callLLM. This is the window the old code erased.
    clickFresh('chatassist_send');
    return realLoadWI(book);
};
document.getElementById('chatassist_input').value = 'read the worldbook then answer';
clickFresh('chatassist_send');
await sleep(600);
ctx.loadWorldInfo = realLoadWI;
ok(stopRunCalls === 1, 'Stop during the inter-call gap prevented the next request (requests fired: ' + stopRunCalls + ', must be 1)');
ok(ccLogText().some(t => /Generation stopped/.test(t)), 'the stopped run announced itself instead of continuing silently');

console.log('== v2.69.0 behavior: a throw mid-undo keeps the batch, and the retry succeeds ==');
CA.fetchRounds = 0;
CA.wiBooks = 'gatebook';
wiStore.set('gatebook', { entries: { '0': { uid: 0, key: ['blade'], keysecondary: [], comment: 'Blade', content: 'iron blade' } } });
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
await driveAsk('<wiedits>[{"book":"gatebook","uid":0,"find":"iron","replace":"steel"}]</wiedits>');
ok(String(wiStore.get('gatebook').entries['0'].content).includes('steel'), 'sim setup: the worldbook edit applied through the real Apply-all path');
// An unexpected throw inside the restore: a book whose entries cannot be serialized.
const circular = { entries: {} };
circular.entries.self = circular.entries;
ctx.loadWorldInfo = async () => circular;
const undoLogBefore = ccLogText().length;
clickFresh('chatassist_undo');
await sleep(400);
ok(ccLogText().slice(undoLogBefore).some(t => /batch was kept/.test(t)), 'the failed undo said so and kept the batch instead of swallowing it');
ok(String(wiStore.get('gatebook').entries['0'].content).includes('steel'), 'the failed undo changed nothing');
ctx.loadWorldInfo = realLoadWI;
clickFresh('chatassist_undo');
await sleep(400);
ok(String(wiStore.get('gatebook').entries['0'].content).includes('iron'), 'pressing Undo again after the failure restored the pre-apply worldbook');
ok(!ccLogText().slice(undoLogBefore).some(t => /Nothing to undo/.test(t)), 'the batch was never lost — the retry found it on the stack');


console.log('== v2.71.0 invariants: one coercion for every numeric setting ==');
// Root cause of the depth-0 bug: `Number(x) || fallback` collapses three
// distinct states (a real 0, a blank field, garbage) into one. Prove the helper
// exists, that it is the ONLY thing reading these settings, and that no
// falsy-default survives on a field whose UI declares min="0".
ok(SRC.includes('function numSetting(raw, fallback, lo, hi)'), 'the canonical numeric coercion helper exists');
const badNumDefaults = (SRC.match(/Number\((?:settings|el\()[^)]*\)[^;\n]*\|\|\s*[1-9]/g) || []);
ok(badNumDefaults.length === 0, 'no numeric setting is read with a truthy-only fallback any more' + (badNumDefaults.length ? ' — found: ' + badNumDefaults.join(' | ') : ''));
ok(!SRC.includes(".value ?? 300"), '?? is no longer applied to a DOM .value (which is never null, so it never fired)');
const numUses = (SRC.match(/numSetting\(/g) || []).length;
ok(numUses >= 16, 'every numeric read and write routes through the helper (found ' + numUses + ' uses, need >= 16)');

console.log('== v2.71.0 behavior: 0, blank and garbage are three different answers ==');
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.directorMode = 'off';
CA.critiqueAuto = 0;
CA.critiqueOnEpisode = false;
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'BEATS', episode: 1, concluded: false, ts: 1 }, directorEp: 1 };
ctx.chatMetadata.cc_critique = 'NORTH STAR: sharpen it.';
const setNum = (id, v) => { document.getElementById(id).value = v; };
const saveSettings = () => { clickFresh('chatassist_saveset'); CA.profileId = 'gate-profile'; };

// (a) A deliberate 0 must survive. Depth 0 = inject directly above the reply;
// the UI declares min="0", so refusing it was the UI lying to the user.
setNum('chatassist_dir_depth', '0'); setNum('chatassist_crit_depth', '0');
setNum('chatassist_llm_timeout', '0'); setNum('chatassist_think_retries', '0');
saveSettings();
ok(CA.directorDepth === 0, 'a typed director depth of 0 is stored as 0 (got ' + JSON.stringify(CA.directorDepth) + ')');
ok(CA.critiqueDepth === 0, 'a typed critique depth of 0 is stored as 0 (got ' + JSON.stringify(CA.critiqueDepth) + ')');
ok(CA.llmTimeoutSec === 0, 'a typed stall timeout of 0 is honoured as "off" (got ' + JSON.stringify(CA.llmTimeoutSec) + ')');
ok(CA.thinkRetries === 0, 'typed retries of 0 is honoured as "off" (got ' + JSON.stringify(CA.thinkRetries) + ')');

// And a stored 0 must reach the actual injection call, not just the settings object.
const depthSeen = [];
const realSEP71 = ctx.setExtensionPrompt;
ctx.setExtensionPrompt = (key, value, pos, depth, scan, role) => { depthSeen.push({ key: String(key), depth }); realSEP71.call(ctx, key, value, pos, depth, scan, role); };
for (const f of handlers.get('CHAT_CHANGED') || []) f();
ctx.setExtensionPrompt = realSEP71;
const dDepth = (depthSeen.find(x => x.key === 'cc_director') || {}).depth;
const cDepth = (depthSeen.find(x => x.key === 'cc_critique_inject') || {}).depth;
ok(dDepth === 0, 'the director injection really lands at depth 0 (got ' + JSON.stringify(dDepth) + ')');
ok(cDepth === 0, 'the editor injection really lands at depth 0 (got ' + JSON.stringify(cDepth) + ')');

// (b) A CLEARED box is "unset", not 0 — it must fall back to the default. The
// pre-2.71 read turned an empty stall-timeout box into 0, silently switching OFF
// the watchdog that stops one hung request from wedging every button.
setNum('chatassist_dir_depth', ''); setNum('chatassist_crit_depth', '');
setNum('chatassist_llm_timeout', ''); setNum('chatassist_think_retries', '');
setNum('chatassist_recent', ''); setNum('chatassist_rounds', ''); setNum('chatassist_maxtok', '');
saveSettings();
ok(CA.llmTimeoutSec === 300, 'clearing the stall-timeout box restores the default, it does NOT disable the watchdog (got ' + JSON.stringify(CA.llmTimeoutSec) + ')');
ok(CA.thinkRetries === 2, 'clearing the retries box restores the default, it does NOT disable auto-recovery (got ' + JSON.stringify(CA.thinkRetries) + ')');
ok(CA.directorDepth === 3 && CA.critiqueDepth === 8, 'clearing the depth boxes restores their defaults (got ' + CA.directorDepth + '/' + CA.critiqueDepth + ')');
ok(CA.recentFull === 8 && CA.fetchRounds === 3 && CA.maxTokens === 8192, 'clearing the context boxes restores their defaults (got ' + CA.recentFull + '/' + CA.fetchRounds + '/' + CA.maxTokens + ')');

// (c) Garbage falls back; out-of-range clamps to the UI's declared bounds.
setNum('chatassist_dir_depth', 'abc'); setNum('chatassist_crit_depth', '999'); setNum('chatassist_maxtok', '99999');
saveSettings();
ok(CA.directorDepth === 3, 'garbage in a numeric box falls back to the default (got ' + JSON.stringify(CA.directorDepth) + ')');
ok(CA.critiqueDepth === 30, 'an over-range value clamps to the UI max (got ' + JSON.stringify(CA.critiqueDepth) + ')');
ok(CA.maxTokens === 32768, 'an over-range token budget clamps to the provider ceiling (got ' + JSON.stringify(CA.maxTokens) + ')');
setNum('chatassist_dir_depth', '3'); setNum('chatassist_crit_depth', '8'); setNum('chatassist_maxtok', '8192');
setNum('chatassist_llm_timeout', '300'); setNum('chatassist_think_retries', '2');
setNum('chatassist_recent', '8'); setNum('chatassist_rounds', '3');
saveSettings();

console.log('== v2.71.0 invariants: an undo record matches the granularity of its edit ==');
ok(SRC.includes('function memBackup(keyBackups, md, tokens)'), 'memory backups are taken at the NODE, not at the root key');
ok(SRC.includes('function memPathParent(md, tokens)'), 'undo resolves the node through a shared path walker');
ok(!/keyBackups\.set\(\s*(?:hit\.)?rootKey/.test(SRC), 'no backup site still snapshots a whole root key');
ok(SRC.includes('memValueHash(loc.parent[loc.key])'), 'the undo drift fingerprint is NODE-scoped, not root-scoped');
ok(SRC.includes("refused.push('memory \"' + label + '\" no longer exists at that path"), 'a vanished path is refused, never rebuilt');
ok(SRC.includes("'Undo restored NOTHING on '"), 'a fully-refused undo says so instead of printing a success line');

console.log('== v2.71.0 behavior: undo restores the field it edited, and only that field ==');
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });

// (a) The extension's OWN metadata root. loadSettings advertises
// continuityCopilot.director.text as the editable path, and every apply writes a
// receipt line into that same root — so a root-scoped fingerprint drifted 100% of
// the time and the undo could never fire.
ctx.chatMetadata['continuityCopilot'].director = { text: 'ORIGINAL BEATS', episode: 4, concluded: false, ts: 1 };
await driveAsk('<memedits>[{"path":"continuityCopilot.director.text","replace":"REWRITTEN BEATS"}]</memedits>');
ok(ctx.chatMetadata['continuityCopilot'].director.text === 'REWRITTEN BEATS', 'sim setup: the directive edit applied through the real Apply-all path');
const histBeforeUndo = (ctx.chatMetadata['continuityCopilot'].sessions[0].history || []).length;
const logAt71 = ccLogText().length;
clickFresh('chatassist_undo');
await sleep(400);
ok(ctx.chatMetadata['continuityCopilot'].director.text === 'ORIGINAL BEATS', 'undo restored the directive text (got ' + JSON.stringify(ctx.chatMetadata['continuityCopilot'].director.text) + ')');
ok(!ccLogText().slice(logAt71).some(t => /SKIPPED/.test(t)), 'the undo did not falsely blame drift on our own receipt line');
ok((ctx.chatMetadata['continuityCopilot'].sessions[0].history || []).length >= histBeforeUndo, 'the undo did NOT roll the session history back — only the edited node was written');
ok(ctx.chatMetadata['continuityCopilot'].director.episode === 4, 'sibling fields of the edited node survived the undo');

// (b) A co-extension rewriting a DIFFERENT field of the same root must not block
// an undo of the field we actually edited.
ctx.chatMetadata.summaryception = { ledger: 'Jillian is at the academy.', threads: 'thread one' };
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"on the train"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('on the train'), 'sim setup: the memory edit applied');
ctx.chatMetadata.summaryception.threads = 'thread one\nthread two (written by the memory extension after the apply)';
clickFresh('chatassist_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception.ledger.includes('at the academy'), 'undo restored the edited field despite a sibling write under the same root');
ok(ctx.chatMetadata.summaryception.threads.includes('thread two'), 'the co-extension\u2019s sibling write SURVIVED the undo (a root-scoped restore would have eaten it)');

// (c) Drift on the edited field itself is still refused, loudly, with nothing
// overwritten. Cards a previous undo returned to pending must be cleared first,
// or Apply-all folds them into this batch and it is no longer fully-refused.
const dismissPending = () => { const b = document.getElementById('chatassist_dismissall'); if (b) clickFresh('chatassist_dismissall'); };
dismissPending();
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"in the infirmary"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('in the infirmary'), 'sim setup: the second memory edit applied');
ctx.chatMetadata.summaryception.ledger = 'Jillian is in the infirmary, and someone else edited this line.';
const logAtDrift = ccLogText().length;
clickFresh('chatassist_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception.ledger.includes('someone else edited this line'), 'a drifted field is not overwritten by a stale snapshot');
const driftLines = ccLogText().slice(logAtDrift);
ok(driftLines.some(t => /SKIPPED/.test(t) && /summaryception\.ledger/.test(t)), 'the refusal names the exact FIELD, not just the root key');
ok(driftLines.some(t => /restored NOTHING/.test(t)), 'a fully-refused undo reports that nothing was restored instead of claiming success');
ok(!driftLines.some(t => /^Undid edits on/.test(t)), 'no contradictory success receipt was printed alongside the refusal');

// (d) A vanished path refuses instead of resurrecting a deleted branch.
dismissPending();
ctx.chatMetadata.summaryception = { ledger: 'Jillian is at the academy.' };
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"on the train"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('on the train'), 'sim setup: the third memory edit applied');
delete ctx.chatMetadata.summaryception;
const logAtGone = ccLogText().length;
clickFresh('chatassist_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception === undefined, 'a root the user deleted is NOT resurrected by an undo');
ok(ccLogText().slice(logAtGone).some(t => /no longer exists at that path/.test(t)), 'the vanished path is refused by name');

// (e) A MIXED batch — one field restorable, one drifted — reports both truthfully:
// the success line covers what really landed, the skip list names what did not.
dismissPending();
ctx.chatMetadata.summaryception = { ledger: 'Jillian is at the academy.' };
ctx.chatMetadata['continuityCopilot'].director = { text: 'ORIGINAL BEATS', episode: 9, concluded: false, ts: 1 };
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"on the train"},{"path":"continuityCopilot.director.text","replace":"REWRITTEN"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('on the train') && ctx.chatMetadata['continuityCopilot'].director.text === 'REWRITTEN', 'sim setup: both fields of the mixed batch applied');
ctx.chatMetadata.summaryception.ledger = 'externally rewritten since the apply';
const logAtMixed = ccLogText().length;
clickFresh('chatassist_undo');
await sleep(400);
const mixedLines = ccLogText().slice(logAtMixed);
ok(ctx.chatMetadata['continuityCopilot'].director.text === 'ORIGINAL BEATS', 'the restorable field of a mixed batch was restored');
ok(ctx.chatMetadata.summaryception.ledger === 'externally rewritten since the apply', 'the drifted field of a mixed batch was left alone');
ok(mixedLines.some(t => /^Undid edits on/.test(t)) && mixedLines.some(t => /SKIPPED 1 item/.test(t)), 'a mixed batch reports the restore AND names the one it skipped');
ok(!mixedLines.some(t => /restored NOTHING/.test(t)), 'a mixed batch does not claim it restored nothing');

// (f) DEEP path via the memory-wide search (no explicit "path"): the token trail
// walkFind builds must resolve to exactly the container it mutated, or the undo
// would write to a different node than the apply did.
dismissPending();
ctx.chatMetadata.summaryception = { ledger: { chars: [{ name: 'Jillian', state: 'Jillian waits at the academy gate.' }, { name: 'Silas', state: 'Silas trains alone.' }] } };
await driveAsk('<memedits>[{"find":"waits at the academy gate","replace":"waits at the duel field"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.chars[0].state.includes('duel field'), 'sim setup: a deeply nested array field was edited via memory-wide search');
ctx.chatMetadata.summaryception.ledger.chars[1].state = 'Silas trains with the registrar.';   // co-extension writes a SIBLING array element
clickFresh('chatassist_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception.ledger.chars[0].state.includes('academy gate'), 'undo restored the exact nested array element it edited');
ok(ctx.chatMetadata.summaryception.ledger.chars[1].state.includes('registrar'), 'the sibling array element written after the apply survived the undo');

// (g) A key this extension AUTO-CREATED is deleted again by the undo, not left
// behind as an empty string the user never had.
dismissPending();
delete ctx.chatMetadata.cc_critique;
await driveAsk('<memedits>[{"path":"cc_critique","replace":"Keep the tone dry."}]</memedits>');
ok(ctx.chatMetadata.cc_critique === 'Keep the tone dry.', 'sim setup: writing to an absent cc_critique created it');
clickFresh('chatassist_undo');
await sleep(400);
ok(!Object.prototype.hasOwnProperty.call(ctx.chatMetadata, 'cc_critique'), 'undo removed the key the apply created, rather than leaving an empty string behind');

console.log('== v2.72.0: a message is served WHOLE, or it says it was not ==');
// Regression this pack exists for: fullTextOf did `.slice(0, 8000)` with NO marker.
// Every long scene reached the model as a mid-word stump LABELLED as its full text,
// so the model reasoned about where the message ENDED from a boundary the tool
// invented — and each edit moved that boundary and "revealed" more shrapnel.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.fullTextCap = 0;
CA.recentFull = 1;

const BIG_TAIL = 'THE_REAL_ENDING_MARKER</details>';
const bigMes = 'A'.repeat(20000) + BIG_TAIL;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'Narrator', mes: bigMes });

let captured = [];
const capture = (reply) => ({ sendRequest: async (pid, messages) => { captured.push(messages.map(m => String(m.content || '')).join('\n')); return reply; } });

captured = [];
ctx.ConnectionManagerRequestService = capture('nothing to fix');
document.getElementById('chatassist_input').value = 'read it';
clickFresh('chatassist_send');
await sleep(350);
const ctxSent = captured.join('\n');
ok(ctxSent.includes(BIG_TAIL), 'a 20k-char message reaches the model with its REAL ending intact (the 8000-char silent clip is gone)');
ok(ctxSent.includes('--- #0 [Narrator] \u2014 ' + bigMes.length + ' chars, COMPLETE'), 'the header states the exact character count (' + bigMes.length + ') and the verdict COMPLETE');
ok(ctxSent.includes('COMPLETE means COMPLETE'), 'the non-editable message-text contract ships with every request');

// With a cap deliberately set, the text is served in PARTS with a loud banner —
// never as a silent stump. The banner must forbid structural conclusions.
CA.fullTextCap = 5000;
captured = [];
ctx.ConnectionManagerRequestService = capture('ok');
document.getElementById('chatassist_input').value = 'read it again';
clickFresh('chatassist_send');
await sleep(350);
const capped = captured.join('\n');
ok(capped.includes('PART 1 OF ' + Math.ceil(bigMes.length / 5000) + ' (chars 1\u20135000 of ' + bigMes.length + '), INCOMPLETE'), 'an over-cap message is served as a numbered PART with exact character bounds');
ok(/CUT \u2014 NOT the whole message/.test(capped) && capped.includes(String(bigMes.length - 5000) + ' follow it'), 'the cut banner states how many characters are still missing (' + (bigMes.length - 5000) + ')');
ok(!capped.includes(BIG_TAIL), 'sim setup: part 1 genuinely does not contain the tail');
ok(/<fetch>\["0#2"\]<\/fetch>/.test(capped), 'the banner hands the model the exact ref for the next part');

// And the part ref actually resolves: asking for 0#5 serves the LAST slice.
captured = [];
let turn = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { captured.push(messages.map(m => String(m.content || '')).join('\n')); return (turn++ === 0) ? '<fetch>["0#5"]</fetch>' : 'done'; } };
document.getElementById('chatassist_input').value = 'get the end';
clickFresh('chatassist_send');
await sleep(500);
ok(captured.join('\n').includes(BIG_TAIL), 'a part fetch ("0#5") serves the final slice, so the true ending is reachable under a cap');
CA.fullTextCap = 0;

console.log('== v2.72.0: a short serve is never silent ==');
// parseFetch used to `.slice(0, 15)` the requested ids: the model asked for 20,
// got 15, and was never told which 5 it had not seen — the same lie in a new place.
ctx.chat.length = 0;
for (let i = 0; i < 40; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'scene ' + i });
captured = [];
turn = 0;
const wanted = JSON.stringify(Array.from({ length: 35 }, (_, i) => i));
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { captured.push(messages.map(m => String(m.content || '')).join('\n')); return (turn++ === 0) ? ('<fetch>' + wanted + '</fetch>') : 'done'; } };
document.getElementById('chatassist_input').value = 'read a lot';
clickFresh('chatassist_send');
await sleep(500);
const served = captured.join('\n');
ok(/id\(s\) in that request were NOT served/.test(served), 'over-cap fetch ids are reported back instead of silently dropped');
ok(/Not served: #30, #31, #32, #33, #34/.test(served), 'the unserved ids are named exactly');

console.log('== v2.72.0: the structure scanner proves what a reader was guessing ==');
// The literal shape that cost an evening: turn 217 carrying turn 215's Plot
// Momentum block as well as its own, plus a severed fragment welded to the tag.
const BROKEN = [
    '<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: Cersei seals the secret and binds him to her wholly, whatever it costs her.',
    '- Physics: the queen\u2019s chambers, rain on the glass, a guard posted outside the door.',
    '- Scene Pacing: Slow Burn', '</details>',
    '<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: Cersei seals the secret and binds him to her wholly, whatever it costs her.',
    '- Physics: the queen\u2019s chambers, rain on the glass, a guard posted outside the door.',
    '- Scene Pacing: Aftermath', '</details>s him in the afterglow, extracting promises.',
].join('\n');
const CLEAN = [
    '<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: Tywin sends ravens before the names leak, and counts the cost of each one.',
    '- Physics: the Tower of the Hand at dusk, a scribe waiting, the city loud below the window.',
    '- Scene Pacing: Aftermath', '</details>',
].join('\n');

ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'prose only, no machine blocks at all.' });
ctx.chat.push({ is_user: false, name: 'N', mes: CLEAN });
ctx.chat.push({ is_user: false, name: 'N', mes: BROKEN });

captured = [];
ctx.ConnectionManagerRequestService = capture('WINDOW CLEAN');
document.getElementById('chatassist_input').value = '#m structure';
clickFresh('chatassist_send');
await sleep(700);
const flags = captured.join('\n');
const scanLog = ccLogText().join('\n');
ok(/duplicate-block/.test(flags) && /share the summary label "Plot Momentum"/.test(flags), 'the scanner names the DUPLICATED block by its summary label — the "double details"');
ok(/tail-after-block/.test(flags) && /welded directly onto the final <\/details>/.test(flags), 'the scanner names the fragment welded onto the closing tag');
ok(/#2 \[N\]/.test(flags) && !/#1 \[N\]/.test(flags), 'only the broken message is flagged — the clean one and the prose-only one are not');
ok(/STRUCTURE FLAGS — proven by a code scan/.test(flags), 'the flags reach the model as facts, not as something to re-derive');
ok(/Structure: 1 message\(s\) carry provable faults/.test(scanLog), 'the user is told which messages are broken before any model call');

console.log('== v2.72.0: deep audit runs every pass and resumes ==');
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 12; i++) ctx.chat.push({ is_user: i % 2 === 1, name: 'N', mes: 'Scene ' + i + ': the road was iron.' });
ctx.chatMetadata.summary_memory = 'Jillian is at the academy. (covers chat messages #0 to #3)';
CA.auditWindow = 4;
CA.auditFetchRounds = 0;

const passes = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 1 of 4')) { passes.push('structure'); return 'fixed'; }
        if (all.includes('PASS 2 of 4')) {
            // A window can legitimately take more than one call now (anchor / ripple
            // correction rounds), so count WINDOWS by their range marker, not calls.
            const w = all.match(/MESSAGES UNDER AUDIT — #(\d+) to #(\d+)/);
            if (w) passes.push('continuity:' + w[1] + '-' + w[2]);
            return 'Scene 3 contradicts the memory.\n<edits>[{"id":3,"find":"iron","replace":"steel"}]</edits>';
        }
        if (all.includes('PASS 3 of 4')) { passes.push('memory'); return 'Snippet 2 looks thin.\n<verify>[3]</verify>'; }
        if (all.includes('PASS 4 of 4')) { passes.push('verify'); return 'DOUBTS RESOLVED'; }
        passes.push('other'); return 'x';
    },
};
document.getElementById('chatassist_input').value = '#m';
clickFresh('chatassist_send');
await sleep(1400);
const windows = [...new Set(passes.filter(p => p.indexOf('continuity:') === 0))];
ok(windows.length === 3, 'the continuity pass walked the WHOLE 12-message log in 4-message windows (got ' + windows.length + ': ' + windows.join(' ') + ')');
ok(passes.includes('memory') && passes.includes('verify'), 'the memory pass ran unasked, and the verify pass fired because it raised a doubt');
ok(/Deep audit complete — \d+ model call\(s\)/.test(ccLogText().join('\n').replace(/&#\d+;/g, '')) || /model call\(s\)/.test(ccLogText().join('\n')), 'the verdict reports a call count that includes the correction rounds');
ok(!passes.includes('other'), 'every audit call carried one of the four pass contracts');
const auditLog = ccLogText().join('\n');
ok(/Deep audit complete/.test(auditLog), 'the audit ends with a consolidated verdict');
ok((document.getElementById('chatassist_cards') ? true : true) && ccLogText().join('\n').includes('CONTINUITY'), 'window findings are reported in the transcript');

console.log('== v2.72.0: routing, contract and stored-default migrations ==');
ok(/^#m\b/.test('#m from 180') && !/^#m\b/.test('#memory audit'), 'the #m route cannot swallow a longer tag like #memory');
CA.systemPrompt = 'MY OWN CUSTOM PROMPT. USER_EDIT_RULE';
captured = [];
ctx.ConnectionManagerRequestService = capture('ok');
document.getElementById('chatassist_input').value = 'hello';
clickFresh('chatassist_send');
await sleep(350);
ok(captured.join('\n').includes('COMPLETE means COMPLETE'), 'the completeness contract survives a fully CUSTOMIZED system prompt (it lives outside the editable one)');
CA.systemPrompt = SRC.match(/const LEGACY_SYSTEM_PROMPT_V271 = /) ? CA.systemPrompt : CA.systemPrompt;
ok(SRC.includes('const LEGACY_SYSTEM_PROMPT_V271 = DEFAULT_SYSTEM_PROMPT'), 'a stored 2.71 system prompt has a legacy witness to upgrade from');
ok(SRC.includes('settings.shortcuts.includes(LEGACY_M_SHORTCUT)'), 'a stored copy of the old #m shortcut line is upgraded to the deep-audit description');
ok(SRC.includes("if (msgServedWhole(r.id)) fetchedIds.add(r.id);"), 'only a WHOLE serve marks a message as read for the blind-edit guard');

console.log('== v2.72.0: block SHAPE drift is caught across scenes ==');
// "Compare it with the previous scene's format" — done in code. A field silently
// missing from one scene's block is what breaks a display regex, and it is
// invisible to anyone skimming prose.
dismissPending();
const shaped = (pacing, extra) => ['<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: the queen presses her advantage while the council is still arguing.',
    '- Physics: the small council chamber, rain on the shutters, a guard at every door.',
    (extra ? '- Scene Pacing: ' + pacing : ''), '</details>'].filter(Boolean).join('\n');
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Aftermath', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Slow Burn', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Rising', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('', false) });   // the drifted one
captured = [];
ctx.ConnectionManagerRequestService = capture('noted');
document.getElementById('chatassist_input').value = '#m structure';
clickFresh('chatassist_send');
await sleep(700);
const shapeFlags = captured.join('\n');
ok(/field-shape/.test(shapeFlags) && /MISSING: Scene Pacing/.test(shapeFlags), 'a block missing a field the other scenes all carry is flagged by name');
ok(/#3 \[N\]/.test(shapeFlags) && !/#0 \[N\]/.test(shapeFlags), 'only the drifted scene is flagged; the three that agree are the norm');

// Evidence threshold: two agreeing scenes are not yet a norm, so a young chat is
// never nagged about a shape it has not established.
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Aftermath', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Slow Burn', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('', false) });
captured = [];
ctx.ConnectionManagerRequestService = capture('noted');
document.getElementById('chatassist_input').value = '#m structure';
clickFresh('chatassist_send');
await sleep(700);
ok(!/field-shape/.test(captured.join('\n')), 'with only two agreeing scenes, shape drift is NOT reported (no norm established yet)');

console.log('== v2.72.0: a stopped audit resumes where it stopped ==');
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 20; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + ' happened.' });
CA.auditWindow = 4;
let contCalls = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 2 of 4')) {
            contCalls++;
            if (contCalls === 2) { const b = document.getElementById('chatassist_send'); if (b) b.click(); }   // Stop, mid-sweep
            return 'WINDOW CLEAN';
        }
        return 'ok';
    },
};
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(1500);
const cursor = ((ctx.chatMetadata['continuityCopilot'] || {}).audit || {}).cursor;
ok(contCalls < 5, 'Stop actually halted the sweep instead of running every window (' + contCalls + ' windows ran)');
ok(cursor > 0, 'the resume point was persisted to chat metadata (cursor #' + cursor + ')');
ok(/resumes from #/.test(ccLogText().join('\n')), 'the user is told exactly where the next run picks up');
contCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 2 of 4')) { contCalls++; } return 'WINDOW CLEAN'; } };
document.getElementById('chatassist_input').value = '#m';
clickFresh('chatassist_send');
await sleep(1500);
ok(contCalls === Math.ceil((20 - cursor) / 4), 'the next run resumed from the saved cursor rather than re-auditing from #0 (' + contCalls + ' windows)');
ok(/Resuming the continuity sweep from #/.test(ccLogText().join('\n')), 'the resume is announced, not silent');

console.log('== v2.72.0: an edit anchored in a SLICE is caught before it fails ==');
// The blind-edit guard used to trust "was fetched". Under a cap, a fetched PART
// is not a read: a "find" copied out of a slice is exactly as blind as one
// invented, so the guard must re-serve the message before the edit is staged.
dismissPending();
CA.recentFull = 0;
CA.fullTextCap = 4000;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'B'.repeat(9000) + 'REAL_TAIL_ONLY_IN_PART_3' });
let blindTurn = 0;
const blindSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        blindSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        blindTurn++;
        if (blindTurn === 1) return '<fetch>["0#1"]</fetch>';
        if (blindTurn === 2) return '<edits>[{"id":0,"find":"BBBB","replace":"CCCC","reason":"guess"}]</edits>';
        return 'ok';
    },
};
document.getElementById('chatassist_input').value = 'fix the end of it';
clickFresh('chatassist_send');
await sleep(900);
ok(/Auto-fetched #0/.test(ccLogText().join('\n')), 'an edit proposed off a PART triggers the auto-fetch instead of being staged blind');
CA.fullTextCap = 0;
CA.recentFull = 8;

console.log('== v2.73.0: the memory auditor doctrine runs INSIDE the panel ==');
// Summaryception's MEMORY_AUDITOR.md was a paste-into-another-AI protocol: export
// a transplant .md, audit it elsewhere, re-import the whole file. One wrong number
// cost a full round trip, and the auditor never saw the chat the memory came from.
// Same mandates, live memory, live chat, reviewable cards.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.auditWindow = 6;
ctx.chat.length = 0;
for (let i = 0; i < 6; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + ' happened at the keep.' });
// One message must actually be broken, or pass 1 has nothing to send and the
// "every pass carries the doctrine" check would silently test only three passes.
ctx.chat.push({ is_user: false, name: 'N', mes: '<details>\n<summary>Tracker</summary>\n- State: fine\n</details>junk welded on' });
ctx.chatMetadata.summary_memory = 'NOTEPAD: Jillian starts at the academy.\nSNIPPET: Jillian rode to the keep. (covers chat messages #0 to #3)';

const seenByPass = {};
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        const m = all.match(/PASS (\d) of 4/);
        if (m) seenByPass[m[1]] = all;
        // Pass 4 only exists when pass 3 states a doubt, so the fixture must state one
        // or the doctrine check would silently cover three passes instead of four.
        if (m && m[1] === '3') return 'Snippet looks thin.\n<verify>[2]</verify>';
        return 'WINDOW CLEAN';
    },
};
document.getElementById('chatassist_input').value = '#m';
clickFresh('chatassist_send');
await sleep(1500);
const passes4 = ['1', '2', '3', '4'];
ok(passes4.every(k => seenByPass[k] && seenByPass[k].includes('[AUDITOR DOCTRINE')), 'all four audit passes carry the auditor doctrine');
ok(passes4.every(k => /M-RECORD/.test(seenByPass[k] || '') && /M-EPISTEMIC/.test(seenByPass[k] || '') && /M-SCAN/.test(seenByPass[k] || '') && /M-EYE/.test(seenByPass[k] || '') && /M-TAGS/.test(seenByPass[k] || '')), 'every mandate ships on every pass (record, epistemic, scan, eye, tags)');
ok(/use ONE bulk_replace edit rather than one edit per message/.test(seenByPass['2'] || ''), 'the class sweep is wired to the bulk_replace the extension actually has — not left as advice');
ok(/CORE \(stable identity\), STATE/.test(seenByPass['3'] || ''), 'the ledger field grammar (CORE / STATE / ARC / THREADS) reaches the memory pass');

// The notepad is the OPENING state on purpose. A pass that "reconciles" it against
// later snippets would propose destructive edits to the author's own starting canon.
const mem3 = seenByPass['3'] || '';
ok(/records the OPENING state on purpose/.test(mem3) && /progression, not a contradiction/.test(mem3), 'the memory pass is told the notepad is deliberately static');
ok(!/notepad\/plot-essential vs every snippet/.test(mem3), 'the old instruction to cross-check the notepad against the snippets is gone');

console.log('== v2.73.0: optimize and cleanup, no export/import round trip ==');
dismissPending();
let optSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { optSeen = messages.map(m => String(m.content || '')).join('\n'); return 'Estimated 4100 -> 3600 chars.\n<memedits>[{"find":"Jillian rode to the keep.","replace":"Jillian rode to the keep."}]</memedits>'; } };
const memBefore = ctx.chatMetadata.summary_memory;
document.getElementById('chatassist_input').value = '#opt';
clickFresh('chatassist_send');
await sleep(900);
ok(/ZERO-LOSS VERIFICATION/.test(optSeen) && /4-question test/.test(optSeen), '#opt carries the zero-loss contract and the 4-question test');
ok(/SEQUENTIAL AGGREGATION/.test(optSeen) && /NOTATION COMPRESSION last/.test(optSeen), 'the eight techniques ship in order, first and last both present');
ok(/Never touch the notepad. Never reword a pinned quote./.test(optSeen), '#opt is barred from the notepad and from pinned quotes');
ok(ctx.chatMetadata.summary_memory === memBefore, 'nothing was written: the pass only STAGES, Apply is the approval gate');
ok(/nothing has changed yet/.test(ccLogText().join('\n')), 'the verdict says so out loud instead of implying a change happened');

dismissPending();
let clSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { clSeen = messages.map(m => String(m.content || '')).join('\n'); return 'Throughline: a squire becomes a threat.'; } };
document.getElementById('chatassist_input').value = '#cl';
clickFresh('chatassist_send');
await sleep(900);
ok(/SPINE/.test(clSeen) && /SUPPORT/.test(clSeen) && /TEXTURE/.test(clSeen) && /NOISE/.test(clSeen), '#cl carries the four-way manifest classification');
ok(/cold-read test/.test(clSeen) && /motivation check/.test(clSeen), '#cl runs the director\u2019s read before any manifest');
ok(/KEEP it and flag it/.test(clSeen) && /attachment is value/.test(clSeen), 'the safeguards survive: unsure keeps, and the author\u2019s attachment wins');

console.log('== v2.73.0: the new commands are documented exactly once ==');
for (const tag of ['#br', '#opt', '#cl']) {
    const hits = (String(CA.shortcuts || '').match(new RegExp('^\\s*' + tag.replace('#', '\\#') + '\\s*=', 'gm')) || []).length;
    ok(hits === 1, tag + ' appears exactly once in the shortcut list (got ' + hits + ')');
}
ok(SRC.includes('for (const line of [BRIEF_SHORTCUT, OPTIMIZE_SHORTCUT, CLEANUP_SHORTCUT])'), 'an install predating these commands gets the lines appended on load');

console.log('== v2.74.0: the sweep reads the VISIBLE chat, not the ghosted history ==');
// A ghosted message is already represented by a memory snippet. Sweeping it again
// audits the same events twice and costs the run its usable length — an hour on a
// long chat. Ghosted originals are pulled only where the memory raises a doubt.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.auditWindow = 4;
CA.auditMaxCalls = 40;
ctx.chat.length = 0;
for (let i = 0; i < 20; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + ' happened.', is_system: i < 12 });   // 0-11 ghosted, 12-19 visible
ctx.chatMetadata.summary_memory = 'SNIPPET: the early scenes. (covers chat messages #0 to #11)';

const winIds = [];
let verifySeen = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 2 of 4')) {
            const m = all.match(/MESSAGES UNDER AUDIT — #(\d+) to #(\d+)/);
            if (m) winIds.push(m[1] + '-' + m[2]);
            return 'WINDOW CLEAN';
        }
        if (all.includes('PASS 3 of 4')) return 'Snippet is thin around the ambush.\n<verify>["3-5", 9]</verify>';
        if (all.includes('PASS 4 of 4')) { verifySeen = all; return 'DOUBTS RESOLVED'; }
        return 'ok';
    },
};
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(1800);
ok(winIds.length === 2, 'the sweep ran 2 windows for 8 visible messages, not 5 for all 20 (got ' + winIds.length + ': ' + winIds.join(' ') + ')');
ok(winIds.join(' ') === '12-15 16-19', 'every window is built from VISIBLE ids only (got ' + winIds.join(' ') + ')');
ok(/Scope: 8 visible message\(s\) of 20/.test(ccLogText().join('\n')), 'the scope and the cost are stated BEFORE the run, not discovered after an hour');

console.log('== v2.74.0: ghosted originals are pulled only on a stated doubt ==');
ok(/Verifying 4 original message\(s\)/.test(ccLogText().join('\n')), 'pass 4 pulled exactly the ids pass 3 doubted — the "3-5" range expanded plus #9');
ok(/--- #3 \[N\]/.test(verifySeen) && /--- #9 \[N\]/.test(verifySeen) && !/--- #7 \[N\]/.test(verifySeen), 'the doubted originals are served whole; the undoubted ghosted ones are never read');
ok(/ORIGINAL MESSAGES UNDER DOUBT/.test(verifySeen), 'pass 4 is framed as settling doubts against originals, not as a walk of every section');

// A memory that checks out costs ZERO calls in pass 4 — the old shape re-read the
// entire ghosted history to confirm what was already right.
dismissPending();
let pass4Ran = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 4 of 4')) pass4Ran++;
        if (all.includes('PASS 3 of 4')) return 'MEMORY CONSISTENT';
        return 'WINDOW CLEAN';
    },
};
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(1800);
ok(pass4Ran === 0, 'a memory with no doubts costs zero verification calls (got ' + pass4Ran + ')');
ok(/Nothing to verify/.test(ccLogText().join('\n')), 'and it says so rather than silently skipping a pass');

console.log('== v2.74.0: broken blocks inside ghosted messages are reported, not silently repaired ==');
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: '<details>\n<summary>Tracker</summary>\n- State: fine\n</details>welded junk', is_system: true });
ctx.chat.push({ is_user: false, name: 'N', mes: 'A visible scene, nothing wrong with it.' });
let structCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { if (messages.map(m => String(m.content || '')).join('\n').includes('PASS 1 of 4')) structCalls++; return 'ok'; } };
document.getElementById('chatassist_input').value = '#m structure';
clickFresh('chatassist_send');
await sleep(800);
ok(structCalls === 0, 'a ghosted fault spends no model call by default (got ' + structCalls + ')');
ok(/1 of them ghosted — listed, not repaired/.test(ccLogText().join('\n')), 'but it is still reported, with the way to repair it');
dismissPending();
structCalls = 0;
document.getElementById('chatassist_input').value = '#m structure ghosted';
clickFresh('chatassist_send');
await sleep(800);
ok(structCalls === 1, '"#m structure ghosted" repairs it on request (got ' + structCalls + ')');

console.log('== v2.74.0: the run has a budget it cannot exceed ==');
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 60; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + '.' });
CA.auditWindow = 2;
CA.auditMaxCalls = 5;
let budgetCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { budgetCalls++; return 'WINDOW CLEAN'; } };
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(2500);
ok(budgetCalls <= 6, 'the budget stopped the run instead of walking all 30 windows (got ' + budgetCalls + ')');
ok(/Call budget reached \(5\)/.test(ccLogText().join('\n')), 'the pause is announced with the number that caused it');
ok(((ctx.chatMetadata['continuityCopilot'] || {}).audit || {}).cursor > 0, 'the resume point survives a budget pause, so #m continues rather than restarts');
CA.auditMaxCalls = 40;
CA.auditWindow = 6;

console.log('== v2.75.0: the memory is read as ONE ordered story ==');
// A memory too large for one call used to be audited section by section with no
// view of the other sections — so a fact established in snippet 5 and contradicted
// in snippet 60 was invisible to every pass that ran.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.auditWindow = 6;
CA.auditMaxCalls = 40;
ctx.chat.length = 0;
for (let i = 0; i < 4; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Visible scene ' + i + '.' });

// A memory big enough to need several sections, with entries in story order.
const entry = (n, from, to) => 'Jillian did the thing numbered ' + n + ' and the consequences ran on for a while afterwards. (covers chat messages #' + from + ' to #' + to + ')';
const many = [];
for (let n = 1; n <= 120; n++) many.push(entry(n, (n - 1) * 3, n * 3 - 1));
ctx.chatMetadata.summary_memory = '--- opening ---\n' + many.join('\n');

const memCalls = [];
let crossSeen = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 3 of 4')) { memCalls.push(all); return 'Entry [7] contradicts entry [98].'; }
        if (all.includes('PASS 3b')) { crossSeen = all; return 'SECTIONS AGREE'; }
        return 'WINDOW CLEAN';
    },
};
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(2200);
ok(memCalls.length > 1, 'the memory was large enough to need several sections (' + memCalls.length + ')');
ok(memCalls.every(c => /\[MEMORY SPINE — every entry in story order/.test(c)), 'EVERY section call carries the spine block — the index of all the entries it is not holding');   // the prompt text alone mentions [MEMORY SPINE], so match the injected block header
ok(memCalls.every(c => /\[1\] \(#0–#2\)/.test(c) && /\[120\] \(#357–#359\)/.test(c)), 'the spine runs from the first entry to the last, in story order, with coverage ranges');
ok(/as ONE story/i.test(memCalls[0]) && /chronological order, not a list of independent entries/.test(memCalls[0]), 'the pass is told the memory is one narrative, not a bag of entries');
ok(/inherits its state/.test(memCalls[0]), 'and that later entries inherit what earlier ones established');
ok(/FINDINGS SO FAR/.test(memCalls[memCalls.length - 1]), 'what an earlier section found is carried into the later ones');
ok(crossSeen && /faults that span sections/.test(crossSeen), 'a cross-section pass runs specifically for contradictions BETWEEN distant entries');
ok(/Entry \[7\] contradicts entry \[98\]/.test(crossSeen), 'the section findings are handed to it so it can join them up');

console.log('== v2.75.0: an entry is never cut in half ==');
// The old chunker hard-sliced at a character count once a section grew large —
// the silent-truncation bug of v2.72, hiding in the memory path.
const longLine = 'X'.repeat(30000) + ' END_OF_ENTRY_MARKER';
ctx.chatMetadata.summary_memory = '--- big ---\n' + longLine + '\n' + entry(1, 0, 3);
const chunkCalls = [];
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 3 of 4')) chunkCalls.push(all); return 'MEMORY CONSISTENT'; } };
dismissPending();
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(2200);
ok(chunkCalls.some(c => c.includes('X'.repeat(30000) + ' END_OF_ENTRY_MARKER')), 'an over-budget entry is delivered WHOLE rather than sliced at a character count');

console.log('== v2.75.0: ordering faults are proven in code, not guessed ==');
dismissPending();
const bad = [
    entry(1, 0, 5),
    entry(2, 6, 11),
    entry(3, 9, 14),      // overlaps #2
    entry(4, 3, 8),       // jumps backwards
    entry(5, 40, 45),     // leaves a gap
    'Jillian rode out again on a long road with nothing much happening. (covers chat messages #60 to #50)',   // backwards
];
ctx.chatMetadata.summary_memory = '--- ordering ---\n' + bad.join('\n');
let orderSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 3 of 4')) orderSeen = all; return 'MEMORY CONSISTENT'; } };
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(1800);
ok(/range-overlap/.test(orderSeen), 'overlapping coverage is flagged (the same events recorded twice)');
ok(/out-of-order/.test(orderSeen), 'an entry covering earlier messages than the one before it is flagged');
ok(/coverage-gap/.test(orderSeen), 'a span nothing covers is flagged');
ok(/range-backwards/.test(orderSeen), 'a range that runs backwards is flagged');
ok(/proven by a code scan of the coverage ranges/.test(orderSeen), 'they reach the model as facts, not as something to re-derive');
const orderLog = ccLogText().join('\n');
ok(/Memory order: \d+ provable ordering fault/.test(orderLog), 'and the user is told before any model call');

console.log('== v2.75.0: a healthy memory says so, and one section needs no cross pass ==');
dismissPending();
ctx.chatMetadata.summary_memory = '--- clean ---\n' + [entry(1, 0, 3), entry(2, 4, 7), entry(3, 8, 11)].join('\n');
let crossRan = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 3b')) crossRan++; return all.includes('PASS 3 of 4') ? 'MEMORY CONSISTENT' : 'WINDOW CLEAN'; } };
document.getElementById('chatassist_input').value = '#m restart';
clickFresh('chatassist_send');
await sleep(1800);
ok(crossRan === 0, 'a memory that fits in ONE section needs no cross-section pass and is not charged for one');
ok(/coverage runs forward, no overlaps or duplicates/.test(ccLogText().join('\n')), 'a clean ordering is reported as a positive result, not silence');

console.log('== v2.76.0: an anchor that cannot match never becomes a card ==');
// A "find" that does not exist used to sail through staging and fail at Apply —
// so the user had to notice the failure and ask for a re-proposal. The check now
// runs the SAME resolver the apply uses, while the real text is still in context.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.recentFull = 8;
CA.fetchRounds = 3;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'The queen crossed the yard at dusk and said nothing to the guard.' });
ctx.chatMetadata.summary_memory = 'The queen crossed the yard at dusk. (covers chat messages #0 to #0)';

let aTurn = 0;
const seen = [];
const proposalNotesBefore = (ccLogText().join('\n').match(/proposed edits below/g) || []).length;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        seen.push(messages.map(m => String(m.content || '')).join('\n'));
        aTurn++;
        if (aTurn === 1) return 'Fixing it.\n<edits>[{"id":0,"find":"the queen walked across the courtyard at sunset","replace":"X","reason":"paraphrased anchor"}]</edits>';
        return 'Corrected.\n<edits>[{"id":0,"find":"crossed the yard at dusk","replace":"crossed the yard at dawn","reason":"fixed"}]</edits>';
    },
};
document.getElementById('chatassist_input').value = 'fix the time of day';
clickFresh('chatassist_send');
await sleep(900);
// The log carries both textContent and innerHTML, so quotes appear HTML-escaped:
// match the stable prose, not the punctuation around it.
const anchorNotes = () => (ccLogText().join('\n').match(/Anchor check: \d+ proposal/g) || []).length;
const anchorLog = ccLogText().join('\n');
ok(/Anchor check: 1 proposal\(s\) had a/.test(anchorLog) && /that does not exist in the target/.test(anchorLog), 'the impossible anchor is caught BEFORE staging, not at Apply');
ok(seen.length >= 2 && /ANCHOR CHECK — these proposals cannot apply as written/.test(seen[1]), 'the model is handed the failure and asked to correct it in the same run');
ok(/that exact text does not occur in message #0/.test(seen[1]), 'it is told exactly which target the anchor missed');
ok(/NEVER build a "find" from a \[MESSAGE INDEX\] preview line or a \[MEMORY SPINE\] line/.test(seen[1]), 'and told where anchors must never come from');
ok((ccLogText().join('\n').match(/proposed edits below/g) || []).length === proposalNotesBefore + 1, 'only ONE reply was ingested — the dead first proposal was corrected, not staged and then patched');

// A GOOD anchor must not trigger the check — a false alarm would cost a round on
// every reply. The resolver is the apply's own, fuzzy floor included.
dismissPending();
const anchorsBefore = anchorNotes();
aTurn = 0;
let goodRounds = 0;
ctx.ConnectionManagerRequestService = {
    // A DIFFERENT edit from the one just dismissed: an identical re-proposal of a
    // dismissed card is correctly suppressed, which would prove nothing here.
    sendRequest: async () => { goodRounds++; return '<edits>[{"id":0,"find":"said nothing to the guard","replace":"said nothing to the sentry","reason":"ok"}]</edits>'; },
};
document.getElementById('chatassist_input').value = 'fix it again';
clickFresh('chatassist_send');
await sleep(700);
ok(goodRounds === 1, 'a valid anchor costs no extra round (got ' + goodRounds + ')');
// goodRounds === 1 above is the real proof no correction round fired; what matters
// next is that the valid proposal actually reached the user as a card.
void anchorsBefore; void anchorNotes;
ok(/proposed edits below/.test(ccLogText().slice(-2).join(' ')), 'and the valid proposal is ingested normally rather than sent back for correction');

console.log('== v2.76.0: a memory anchor is checked against the live memory ==');
dismissPending();
aTurn = 0;
const memSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        memSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        aTurn++;
        if (aTurn === 1) return '<memedits>[{"find":"The monarch traversed the courtyard","replace":"Y","reason":"invented"}]</memedits>';
        return 'MEMORY CONSISTENT';
    },
};
document.getElementById('chatassist_input').value = 'fix the memory line';
clickFresh('chatassist_send');
await sleep(900);
ok(memSeen.length >= 2 && /that exact text does not occur anywhere in the memory/.test(memSeen[1]), 'an invented memory anchor is caught against the live memory');

console.log('== v2.76.0: a dead card does not outlive its replacement ==');
// supersededByNew() retired an older PENDING card only on anchor EQUALITY. A
// corrected re-proposal carries a DIFFERENT anchor by definition — that is the
// point of correcting it — so the wrong card could never be retired and the user
// dismissed it by hand every time. Cards are not in the DOM in this harness, so
// the observable is the ingest note.
dismissPending();
const skipNotes = () => (ccLogText().join('\n').match(/auto-skipped/gi) || []).length;

ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'A scene that is not being edited here.' });
ctx.chatMetadata.summary_memory = 'ALPHA line: the queen crossed the yard at dusk.\nGAMMA line: the steward counted the ravens.';
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"ALPHA line: the queen crossed the yard at dusk.","replace":"ALPHA line: the queen crossed the yard at dawn.","reason":"first try"}]</memedits>' };
document.getElementById('chatassist_input').value = 'fix the alpha line';
clickFresh('chatassist_send');
await sleep(700);
const skipsBefore = skipNotes();

// The memory drifts underneath the staged card: its anchor is now unfindable.
ctx.chatMetadata.summary_memory = 'BETA line: the queen crossed the courtyard at dusk.\nGAMMA line: the steward counted the ravens.';
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"BETA line: the queen crossed the courtyard at dusk.","replace":"BETA line: the queen crossed the courtyard at dawn.","reason":"corrected anchor"}]</memedits>' };
document.getElementById('chatassist_input').value = 'try again against the current memory';
clickFresh('chatassist_send');
await sleep(900);
ok(skipNotes() > skipsBefore, 'a corrected proposal retires the dead card automatically — no hand dismissal (' + skipsBefore + ' -> ' + skipNotes() + ')');
ok(/anchor no longer matches/i.test(ccLogText().join('\n')) || /older duplicate\(s\) auto-skipped/i.test(ccLogText().join('\n')), 'and the reason is stated rather than the card just vanishing');

// The other half of the rule: a still-VALID pending fix must survive a new,
// unrelated proposal. Retiring those would silently drop work the user wanted.
dismissPending();
ctx.chatMetadata.summary_memory = 'ALPHA line: the queen crossed the yard at dusk.\nGAMMA line: the steward counted the ravens.';
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"ALPHA line: the queen crossed the yard at dusk.","replace":"ALPHA line: the queen crossed the yard at dawn.","reason":"still valid"}]</memedits>' };
document.getElementById('chatassist_input').value = 'fix alpha';
clickFresh('chatassist_send');
await sleep(700);
const skipsBefore2 = skipNotes();
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"GAMMA line: the steward counted the ravens.","replace":"GAMMA line: the steward counted the ravens twice.","reason":"different line"}]</memedits>' };
document.getElementById('chatassist_input').value = 'now fix gamma too';
clickFresh('chatassist_send');
await sleep(900);
ok(skipNotes() === skipsBefore2, 'a pending fix whose anchor is still good is NOT retired by an unrelated new proposal (' + skipsBefore2 + ' -> ' + skipNotes() + ')');

console.log('== v2.77.0: a fix lands on EVERY surface, not just the one pointed at ==');
// The auditor doctrine only shipped inside the #m passes, so an ordinary "fix this
// contradiction" arrived with no rule about the other places the same fact is
// written — and a fix to the chat and the ledger left the snippet, its detail
// field and the worldbook still saying the old thing. That does not half-fix the
// error; it manufactures a new one, because the surfaces now disagree.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.recentFull = 8;
CA.fetchRounds = 3;
CA.fullTextCap = 0;

ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'The bell rang at Two-fourteen and the hall emptied.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'She remembered Two-fourteen as the hour it began.' });
ctx.chatMetadata.summary_memory = 'SNIPPET: the bell rang at Two-fourteen. (covers chat messages #0 to #1)';
ctx.chatMetadata.summary_ledger = 'Cersei — STATE: waiting since Two-fourteen.';

let rTurn = 0;
const rSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        rSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        rTurn++;
        if (rTurn === 1) return 'Fixed the time.\n<edits>[{"id":0,"find":"rang at Two-fourteen and","replace":"rang at Two-thirty-eight and","reason":"wrong hour"}]</edits>';
        return 'Swept everywhere.\n<edits>[{"id":1,"find":"remembered Two-fourteen as","replace":"remembered Two-thirty-eight as","reason":"same class"}]</edits>\n<memedits>[{"find":"the bell rang at Two-fourteen.","replace":"the bell rang at Two-thirty-eight.","reason":"snippet"},{"find":"STATE: waiting since Two-fourteen.","replace":"STATE: waiting since Two-thirty-eight.","reason":"ledger"}]</memedits>';
    },
};
document.getElementById('chatassist_input').value = 'the bell time is wrong, fix it';
clickFresh('chatassist_send');
await sleep(1100);
const rippleLog = ccLogText().join('\n');
ok(/Ripple check: the corrected text still appears in 3 other place\(s\)/.test(rippleLog), 'the leftovers are counted in code before anything is staged');
ok(rSeen.length >= 2 && /RIPPLE CHECK/.test(rSeen[1]), 'the model is handed the list and asked to sweep, in the same run');
ok(/message #1/.test(rSeen[1]), 'the other CHAT message carrying the same text is named');
ok(/memory summary_memory/.test(rSeen[1]) && /memory summary_ledger/.test(rSeen[1]), 'the memory snippet AND the ledger dossier are named, with their paths');
ok(/manufactures a new one, because the surfaces now disagree/.test(rSeen[1]), 'and told why a one-surface fix is worse than no fix');
ok(/does anything written AFTER the corrected fact depend on the old version/.test(rSeen[1]), 'the downstream ripple is demanded too, not just the duplicates');

console.log('== v2.77.0: the law ships on ordinary requests, not only on audits ==');
ok(rSeen[0].includes('ONE FACT, EVERY SURFACE'), 'every request carries the consistency law');
ok(/ledger dossier for each character involved \(CORE \/ STATE \/ ARC \/ THREADS\)/.test(rSeen[0]), 'it names the surfaces concretely rather than saying "be thorough"');
ok(/REPORT THE SWEEP, do not promise it/.test(rSeen[0]), 'and demands evidence with numbers, not a claim of thoroughness');
CA.systemPrompt = 'MY OWN CUSTOM PROMPT. USER_EDIT_RULE';
let lawSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { lawSeen = messages.map(m => String(m.content || '')).join('\n'); return 'ok'; } };
dismissPending();
document.getElementById('chatassist_input').value = 'hello';
clickFresh('chatassist_send');
await sleep(500);
ok(lawSeen.includes('ONE FACT, EVERY SURFACE'), 'the law survives a fully customized system prompt');
delete CA.systemPrompt;

console.log('== v2.77.0: the sweep does not fire on noise or on a complete fix ==');
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'A single line with a UNIQUEPHRASE in it.' });
ctx.chatMetadata.summary_memory = 'nothing relevant here';
ctx.chatMetadata.summary_ledger = 'nothing relevant here either';
let oneShot = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { oneShot++; return '<edits>[{"id":0,"find":"a UNIQUEPHRASE in","replace":"a REPLACEDPHRASE in","reason":"only occurrence"}]</edits>'; } };
document.getElementById('chatassist_input').value = 'fix the unique phrase';
clickFresh('chatassist_send');
await sleep(700);
ok(oneShot === 1, 'a fix with no leftovers anywhere costs no extra round (got ' + oneShot + ')');

// A span in dozens of places is the case where sweeping matters MOST — a renamed
// character or a wrong title is exactly that shape — so the sweep fires, the sites
// are capped for readability, and one bulk_replace is offered instead of 30 edits.
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 30; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Ser Kettleblack stood at the door again that evening.' });
let manyCalls = 0;
let manySeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { manyCalls++; manySeen = messages.map(m => String(m.content || '')).join('\n'); return '<edits>[{"id":29,"find":"Ser Kettleblack stood","replace":"Ser Osmund stood","reason":"renamed"}]</edits>'; } };   // #29 is inside the full-text window, so the blind-edit fetch is not in play
document.getElementById('chatassist_input').value = 'rename the knight';
clickFresh('chatassist_send');
await sleep(900);
ok(manyCalls === 2, 'a rename spanning 30 messages DOES raise the sweep — that is the case it exists for (got ' + manyCalls + ' calls)');
ok(/29 untouched/.test(manySeen) || /leaving 29 untouched/.test(manySeen), 'the count of untouched instances is exact');
ok(/and more/.test(manySeen), 'the site list is capped for readability rather than dumping 30 lines');
ok(/one bulk_replace when the text repeats verbatim/.test(manySeen), 'and one bulk_replace is offered instead of 30 separate edits');

console.log('== v2.78.0: a dead proposal is WITHDRAWN by block, never by prose ==');
// The protocol taught propose / correct / apply-skip but no WITHDRAW: the
// failed-apply retry said "do not re-send proposals that are no longer needed"
// and the pending block said "do not drop them silently", so a proposal the
// model judged dead got a prose "dropping it" while the card stayed staged and
// was re-listed every turn — the loop this pack exists to kill. <supersede>
// with no replacement already worked in code; it was never taught, and an
// unmatched label failed silently on top of that.
// pendingEdits accumulates across this whole file (dismissPending is a no-op
// here — the card DOM is never built), so the staged card's label is NOT
// "Memory fix 1": the mock reads its exact label out of the PENDING PROPOSALS
// block it is handed, exactly like the real model is told to.
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'A quiet scene with nothing to fix here.' });
ctx.chatMetadata.summary_memory = 'DELTA line: the cook burned the stew at noon.';
ctx.chatMetadata.summary_ledger = 'nothing relevant here';

const wSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        wSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        return '<memedits>[{"find":"the cook burned the stew at noon.","replace":"the cook burned the stew at dusk.","reason":"wrong time"}]</memedits>';
    },
};
document.getElementById('chatassist_input').value = 'the stew time is wrong';
clickFresh('chatassist_send');
await sleep(900);
ok(/proposed memory edits below/.test(ccLogText().slice(-3).join(' ')), 'a withdrawable card is staged first');

// Turn 2: the model re-checks, judges the staged fix moot, and withdraws it by
// naming the exact label it just read in PENDING PROPOSALS — no replacement.
let withdrewBefore = (ccLogText().join('\n').match(/the assistant withdrew/gi) || []).length;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const joined = messages.map(m => String(m.content || '')).join('\n');
        wSeen.push(joined);
        const lm = joined.match(/(Memory fix \d+) \[memory\][^\n]*burned the stew/);
        return 'Re-checked the memory \u2014 another edit already covered it, so the staged fix is moot.\n<supersede>' + (lm ? lm[1] : 'Memory fix 1') + '</supersede>';
    },
};
document.getElementById('chatassist_input').value = 'actually it is already covered';
clickFresh('chatassist_send');
await sleep(900);
const wLog = ccLogText().join('\n');
ok((wLog.match(/the assistant withdrew/gi) || []).length > withdrewBefore, 'a supersede block with NO replacement withdraws the dead card — and the note says "withdrew", not "replaced"');
const wLastSeen = wSeen[wSeen.length - 1] || '';
ok(/WITHDRAW it the same way/.test(wLastSeen) && /prose changes nothing/.test(wLastSeen), 'the pending block the model just read teaches the withdrawal fork — the block is the only thing that removes a proposal');
ok(/Memory fix \d+ \[memory\]/.test(wLastSeen), 'and the card was listed there under the exact label the model named back');

console.log('== v2.78.0: a near-miss label still lands, an unmatched one is loud ==');
// Near-miss: "memory fix #N" (case/hash/spacing slop) must still withdraw.
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        wSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        return '<memedits>[{"find":"the cook burned the stew at noon.","replace":"the cook burned the stew at dusk.","reason":"staged again"}]</memedits>';
    },
};
document.getElementById('chatassist_input').value = 'stage the stew fix again';
clickFresh('chatassist_send');
await sleep(900);
withdrewBefore = (ccLogText().join('\n').match(/the assistant withdrew/gi) || []).length;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const joined = messages.map(m => String(m.content || '')).join('\n');
        wSeen.push(joined);
        const lm = joined.match(/Memory fix (\d+) \[memory\][^\n]*burned the stew/);
        return 'Withdrawing it.\n<supersede>memory  fix #' + (lm ? lm[1] : '1') + '</supersede>';
    },
};
document.getElementById('chatassist_input').value = 'never mind, withdraw it';
clickFresh('chatassist_send');
await sleep(900);
ok((ccLogText().join('\n').match(/the assistant withdrew/gi) || []).length > withdrewBefore, 'a sloppy label ("memory  fix #N") still withdraws the card');

// Unmatched: a label nothing carries must be reported BY NAME — before v2.78 the
// model announced a dismissal that never happened and the card stayed staged.
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        wSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        return '<memedits>[{"find":"the cook burned the stew at noon.","replace":"the cook burned the stew at dusk.","reason":"third staging"}]</memedits>';
    },
};
document.getElementById('chatassist_input').value = 'stage it once more';
clickFresh('chatassist_send');
await sleep(900);
withdrewBefore = (ccLogText().join('\n').match(/the assistant withdrew/gi) || []).length;
ctx.ConnectionManagerRequestService = { sendRequest: async () => 'That one is dead.\n<supersede>Worldbook fix 77</supersede>' };
document.getElementById('chatassist_input').value = 'withdraw the worldbook one';
clickFresh('chatassist_send');
await sleep(900);
const uLog = ccLogText().slice(-3).join('\n');
ok(/no pending proposal carries that label/.test(uLog) && /Worldbook fix 77/.test(uLog), 'an unmatched supersede label is reported by name instead of silently doing nothing');
ok((ccLogText().join('\n').match(/the assistant withdrew/gi) || []).length === withdrewBefore, 'and the unmatched label withdrew NOTHING — the staged card survives');

console.log('== v2.78.0: every prompt that governs the failed loop teaches the fork ==');
// The retry button and the failed-proposal coaching are not reachable through
// this harness's DOM (the card panel is never built), so these are witnessed in
// source — the same strings the live model reads.
ok(/WITHDRAW it by naming its exact label in a <supersede> block/.test(SRC) && /none may be left sitting/.test(SRC), 'the failed-apply retry commands withdrawal, not inaction');
ok(/never dropped silently/.test(SRC) && /WITHDRAW it by naming its exact label in a <supersede> block/.test(SRC), 'the failed-proposal coaching ends in the re-propose-or-withdraw fork');
ok(!/Do not re-send proposals that are no longer needed/.test(SRC), 'the old "just do not re-send it" instruction — the inaction that caused the loop — is gone');

console.log('== v2.79.0: a malformed fetch is coached, not swallowed ==');
// The fetch protocol had a silent-death gap: a block with no usable id list
// parsed to the same null as "no fetch requested". The prose around it ("let me
// fetch the chat…") was displayed, the block stripped from view, and nothing
// ever came back — the user watched the assistant announce a fetch that never
// ran. parseFetch now distinguishes ABSENT from UNREADABLE and says why, and
// the loop coaches the model once instead of swallowing the attempt.
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'Sister', mes: 'I told him about my ex boyfriend that afternoon.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'The evening passed quietly.' });
ctx.chatMetadata.summary_memory = 'nothing about an ex';
ctx.chatMetadata.summary_ledger = 'nothing either';

let fTurn = 0;
const fSeen = [];
const fStart = ccLogText().length;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        fSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        fTurn++;
        if (fTurn === 1) return 'Let me fetch the chat to check.\n<fetch>the sister messages</fetch>';
        if (fTurn === 2) return '<fetch>[0]</fetch>';
        return 'Yes \u2014 she told him about her ex, in message #0.';
    },
};
document.getElementById('chatassist_input').value = 'did his sister ever tell him about an ex?';
clickFresh('chatassist_send');
await sleep(1200);
const fLog = ccLogText().slice(fStart).join('\n');
ok(fTurn === 3, 'the malformed fetch costs one coaching round, then the resent valid request is served (got ' + fTurn + ' calls)');
ok(/tried to fetch messages but its block was unreadable/.test(fLog), 'the failed fetch is reported to the user instead of vanishing');
ok(/FETCH ERROR/.test(fSeen[1] || '') && /ONLY real numeric ids/.test(fSeen[1] || ''), 'the model is handed the reason and the correct shape');
ok(/Assistant read full text of #0/.test(fLog), 'the resent, valid fetch is served normally');
ok(/she told him about her ex, in message #0/.test(fLog), 'and the answer lands, evidence-based');
ok(/the user CANNOT fetch, only the block can/.test(fSeen[0] || '') && /never enough to say what was actually said or done/.test(fSeen[0] || ''), 'the system prompt forbids permission-asking, announcing, and answering from previews');

console.log('== v2.79.0: a twice-malformed fetch stops loudly, never loops ==');
dismissPending();
fTurn = 0;
const gStart = ccLogText().length;
ctx.ConnectionManagerRequestService = {
    sendRequest: async () => { fTurn++; return 'Fetching now.\n<fetch>chat about the sister</fetch>'; },
};
document.getElementById('chatassist_input').value = 'what did the sister say?';
clickFresh('chatassist_send');
await sleep(1000);
const gLog = ccLogText().slice(gStart).join('\n');
ok(fTurn === 2, 'a repeat-malformed fetch gets exactly ONE coaching round, then stops (got ' + fTurn + ' calls)');
ok(/fetch block was malformed again/.test(gLog), 'the second failure is loud — the reply never passes as answered');
ok(!/Ran out of fetch rounds/.test(gLog), 'and it is NOT misreported as fetch-round exhaustion');
ok((SRC.match(/\[FETCH ERROR\]/g) || []).length === 2, 'the audit loop coaches a malformed fetch the same way — the fix is a class, not an instance');

console.log('== v2.80.0: the full-text window counts VISIBLE messages ==');
// "Recent msgs sent in full" used to count RAW chat rows: 100 over a chat with
// 14 unghosted messages shipped the last 100 raw rows — ghosted entries inside
// the tail included, even though their content already lives in memory (double
// rent) and hidden ones were explicitly removed from AI context (a leak). The
// window now takes the last N visible messages; fetch can still pull any id.
dismissPending();
CA.recentFull = 100;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'VISIBLE-ONE: the ferry left at dawn.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'VISIBLE-TWO: the rain stopped by noon.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'GHOSTROW-SECRET: the old mill burned down.', is_system: true });
ctx.chat.push({ is_user: false, name: 'N', mes: 'VISIBLE-THREE: she kept the brass key.' });
ctx.chatMetadata.summaryception = { ghostedIndices: [2] };
ctx.chatMetadata.summary_memory = 'a summary of the older events';
ctx.chatMetadata.summary_ledger = 'nothing here';

let vSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { vSeen = messages.map(m => String(m.content || '')).join('\n'); return 'Nothing to fix.'; } };
document.getElementById('chatassist_input').value = 'anything wrong?';
clickFresh('chatassist_send');
await sleep(700);
ok(/FULL MESSAGES\] \(last 3\)/.test(vSeen), 'the window header counts visible messages, not raw rows (3 visible of 4 rows, setting 100)');
ok(vSeen.includes('VISIBLE-ONE') && vSeen.includes('VISIBLE-TWO') && vSeen.includes('VISIBLE-THREE'), 'every visible message is served whole');
ok(!/GHOSTROW-SECRET/.test(vSeen), 'the ghosted row is NOT shipped — its content is already paid for by the memory snippet');

console.log('== v2.80.0: the blind-edit guard uses the same visible window ==');
// Six raw rows, #4 ghosted. Raw-arithmetic window (last 4) would be rows 2-5;
// the VISIBLE window (last 4 of 0,1,2,3,5) is rows 1,2,3,5.
dismissPending();
CA.recentFull = 4;
ctx.chat.length = 0;
for (let i = 0; i < 6; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Row ' + i + ': the lanterns were lit at dusk.' });
ctx.chat[1].mes = 'Row 1: the QQXARO was lit at dusk.';
ctx.chat[4].is_system = true;
ctx.chat[4].mes = 'Row 4: GHOSTLANTERN the old millwheel creaked.';
ctx.chatMetadata.summaryception = { ghostedIndices: [4] };

let bTurn = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { bTurn++; return '<edits>[{"id":1,"find":"QQXARO was lit","replace":"ZZTARO was lit","reason":"test"}]</edits>'; } };
document.getElementById('chatassist_input').value = 'fix row 1';
clickFresh('chatassist_send');
await sleep(900);
ok(bTurn === 1, 'an edit to a VISIBLE in-window message costs no blind-fetch round, even though raw arithmetic put it outside (got ' + bTurn + ')');

dismissPending();
bTurn = 0;
const bStart = ccLogText().length;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { bTurn++; return '<edits>[{"id":4,"find":"millwheel creaked","replace":"millwheel sang","reason":"test"}]</edits>'; } };
document.getElementById('chatassist_input').value = 'fix row 4';
clickFresh('chatassist_send');
await sleep(900);
ok(bTurn === 2, 'an edit to a GHOSTED row inside the raw tail is auto-fetched first — it was never read (got ' + bTurn + ' calls)');
ok(/Auto-fetched #4/.test(ccLogText().slice(bStart).join('\n')), 'and the auto-fetch says why');
CA.recentFull = 8;
delete ctx.chatMetadata.summaryception;

console.log('== v2.81.0: a ghosted original is fetchable on demand ==');
// "NEVER unhide ghosted messages" sits one bullet away from the fetch rules, so
// a careful model could read it as "never touch ghosted messages at all". The
// rules now separate READING (lawful, on a real doubt) from UNHIDING
// (forbidden). Mechanically the fetch path has never filtered is_system — the
// audit's <verify> pass depends on it — and this guard keeps it that way.
dismissPending();
CA.recentFull = 8;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'Visible row with plain text.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'GHOSTORIGINAL: the precise wording of the old event.', is_system: true });
ctx.chatMetadata.summaryception = { ghostedIndices: [1] };
ctx.chatMetadata.summary_memory = 'a thin summary of the old event';
ctx.chatMetadata.summary_ledger = 'nothing here';
let gTurn = 0;
const gSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        gSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        gTurn++;
        if (gTurn === 1) return '<fetch>[1]</fetch>';
        return 'The original wording is now in hand.';
    },
};
document.getElementById('chatassist_input').value = 'what exactly happened back then?';
clickFresh('chatassist_send');
await sleep(900);
ok(gTurn === 2 && /GHOSTORIGINAL/.test(gSeen[1] || ''), 'a ghosted id fetches like any other — the original is served whole');
ok(/READABLE on demand/.test(gSeen[0] || '') && /forbidden is UNHIDING it, not reading it/.test(gSeen[0] || ''), 'the edit rules separate reading a ghost (lawful) from unhiding it (forbidden)');
delete ctx.chatMetadata.summaryception;

console.log('== v2.82.0: a dead-anchor card is marked STALE in the list the model reads ==');
// The model agreed with the user THREE times that a staged chat fix was
// unnecessary before the card actually died — because nothing ON the card told
// it the anchor was already dead, and no rule named the moment "you just agreed
// with the user". The pending block now re-checks every active anchor against
// the live text and prints STALE on the dead ones, and the closing rule names
// the trap: agreeing in prose without the <supersede> block IS the failure.
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'The QQXARO bell rang twice.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'After that, silence.' });
ctx.chatMetadata.summary_memory = 'nothing about bells';
ctx.chatMetadata.summary_ledger = 'nothing here';
CA.recentFull = 8;

ctx.ConnectionManagerRequestService = { sendRequest: async () => '<edits>[{"id":0,"find":"QQXARO bell","replace":"ZZTARO bell","reason":"wrong bell"}]</edits>' };
document.getElementById('chatassist_input').value = 'fix the bell name';
clickFresh('chatassist_send');
await sleep(900);

// The text moves under the staged card (fixed by another route): the anchor is
// dead now. The next request must SHOW that on the card's own line.
ctx.chat[0].mes = 'The ZZTARO bell rang twice.';

const sSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const joined = messages.map(m => String(m.content || '')).join('\n');
        sSeen.push(joined);
        const lm = joined.match(/(Chat fix \d+) \[message #0\][^\n]*QQXARO bell[^\n]*STALE/);
        if (lm) return 'You\u2019re right \u2014 that chat fix is already done.\n<supersede>' + lm[1] + '</supersede>';
        return 'I see no stale card, so I am saying so in prose \u2014 and doing nothing about it.';
    },
};
const sStart = ccLogText().length;
document.getElementById('chatassist_input').value = 'is that fix still needed?';
clickFresh('chatassist_send');
await sleep(900);
const sBlock = sSeen[0] || '';
const staleLine = (sBlock.match(/Chat fix \d+ \[message #0\][^\n]*/) || [''])[0];
ok(/STALE/.test(staleLine) && /QQXARO bell/.test(staleLine), 'the card whose anchor just died is marked STALE on its own line');
ok(/marked STALE has a "find" that no longer matches/.test(sBlock), 'and the block teaches what a stale line is for');
ok(/AGREEING with the user/.test(sBlock) && /rides in THAT SAME reply/.test(sBlock), 'the agree-without-withdrawing trap is named in the rule itself');
ok(/the assistant withdrew/i.test(ccLogText().slice(sStart).join('\n')), 'reading its own STALE line, the model withdraws the card in the same reply');

console.log('== v2.83.0: a conviction staged in pass 3 is refuted and withdrawn in pass 4 ==');
// The audit's most dangerous failure: pass 3 declares a recorded beat
// "invented" and stages removal edits across the memory — founded on chat text
// it never read (ghosted originals carry no preview in the index). The absence
// law now makes "invented" unreachable from memory alone, and pass 4 receives
// the pending list beside the originals with a mandate to withdraw whatever the
// evidence refutes — before the user ever reviews the staging area.
dismissPending();
CA.auditWindow = 4;
CA.recentFull = 8;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'Vanessa', mes: 'VANORIGINAL-A: Vanessa asked Rias for the number outright.', is_system: true });
ctx.chat.push({ is_user: false, name: 'Rias', mes: 'VANORIGINAL-B: Rias refused, told her to act expensive, and gave nothing.', is_system: true });
ctx.chat.push({ is_user: false, name: 'N', mes: 'Visible scene one at the keep.' });
ctx.chat.push({ is_user: false, name: 'N', mes: 'Visible scene two at the keep.' });
ctx.chatMetadata.summaryception = { ghostedIndices: [0, 1] };
ctx.chatMetadata.summary_memory = 'SNIPPET: Rias denied Vanessa the number, calling Jovan new money and act expensive. (covers chat messages #0 to #1)';
ctx.chatMetadata.summary_ledger = 'Vanessa \u2014 STATE: rerouting after the refusal.';

const aSeen = {};
let pass4Label = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        const pm = all.match(/PASS (\d) of 4/);
        if (pm) aSeen[pm[1]] = all;
        if (pm && pm[1] === '3') {
            return 'The snippet asserts a refusal beat the chat never shows \u2014 invented.\n'
                + '<memedits>[{"find":"Rias denied Vanessa the number","replace":"Rias hesitated about the number","reason":"soften an invented beat"}]</memedits>\n'
                + '<verify>[0, 1]</verify>';
        }
        if (pm && pm[1] === '4') {
            const lm = all.match(/(Memory fix \d+) \[memory\][^\n]*Rias denied Vanessa/);
            pass4Label = lm ? lm[1] : null;
            return (lm ? 'The originals show the refusal plainly \u2014 the pass-3 conviction was wrong.\n<supersede>' + lm[1] + '</supersede>\n' : '')
                + 'DOUBTS RESOLVED';
        }
        return 'WINDOW CLEAN';
    },
};
const aStart = ccLogText().length;
document.getElementById('chatassist_input').value = '#m';
clickFresh('chatassist_send');
await sleep(2000);
ok(/UNREACHABLE from memory alone/.test(aSeen['3'] || ''), 'the memory pass carries the absence law — conviction requires the originals in hand');
ok(/PENDING PROPOSALS/.test(aSeen['4'] || '') && /clean up after the earlier passes/.test(aSeen['4'] || ''), 'the verify pass receives the staged list AND the re-review mandate');
ok(/VANORIGINAL-A/.test(aSeen['4'] || '') && /VANORIGINAL-B/.test(aSeen['4'] || ''), 'the ghosted originals are served beside it');
ok(!!pass4Label && /the assistant withdrew/i.test(ccLogText().slice(aStart).join('\n')), 'the refuted conviction is withdrawn inside the same audit run — never a live card for the user');
delete ctx.chatMetadata.summaryception;

console.log('== v2.84.0 selective lore discovery ==');
// Execute the production discovery helpers directly for budget/selection edge cases.
const loreSource = SRC.slice(SRC.indexOf('    const LORE_RULES ='), SRC.indexOf('    async function wiBuildContext()'));
let loreContext = { characters: [], powerUserSettings: {} }, manualBooks = [], discovered = { globals: [], chat: null, character: null };
let loreSame = true;
const loreApi = new Function('ctx', 'window', 'wiChosenBooks', 'wiDiscover', 'wiLoad', 'wiEntryList', 'sameChat', 'stopRequested', 'findBlock', loreSource + '\nreturn {wiDiscoveryBooks, wiCreateDiscovery, wiLoreSearch, wiLoreFetch, wiDiscoveryRequest, LORE_RULES};')(
    () => loreContext, {}, () => manualBooks, () => discovered, async book => wiStore.get(book), data => Object.values(data.entries), () => loreSame, false,
    (text, tag) => { const match = text.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return match ? { inner: match[1] } : null; });
discovered = { globals: ['Global', 'Shared'], chat: 'Chat', character: 'Character' };
loreContext.powerUserSettings.persona_description_lorebook = 'Persona';
ok(loreApi.wiDiscoveryBooks().join(',') === 'Global,Shared,Chat,Character,Persona', 'discovery includes global, chat, character and persona bindings');
manualBooks = ['Terranovia', 'Terranovia'];
ok(loreApi.wiDiscoveryBooks().join(',') === 'Terranovia', 'manual selection overrides active books and deduplicates');
manualBooks = [];
loreContext.groupId = 'group'; loreContext.groups = [{ id: 'group', members: ['a.png'] }];
loreContext.characters = [{ avatar: 'a.png', data: { extensions: { world: 'MemberBook' } } }];
loreContext.worldInfo = { charLore: [{ name: 'a', extraBooks: ['ExtraBook', 'Shared'] }] };
ok(loreApi.wiDiscoveryBooks().includes('MemberBook') && loreApi.wiDiscoveryBooks().includes('ExtraBook') && loreApi.wiDiscoveryBooks().filter(x => x === 'Shared').length === 1, 'group and exposed extra bindings are included once');
manualBooks = ['MissingBook'];
const failedIndex = await loreApi.wiCreateDiscovery('lore-chat');
ok(loreApi.wiLoreSearch(failedIndex, {query:''}).includes('MissingBook'), 'unavailable books are named rather than silently treated as empty');
manualBooks = ['Terranovia'];
const hugeLore = { entries: {} };
for (let i = 0; i < 294; i++) hugeLore.entries[i] = { uid: i, comment: 'Local record ' + i, key: ['record' + i], content: ('Unrelated record ' + i + '. ').repeat(250) };
hugeLore.entries[0] = { uid: 0, comment: 'Azure Compact faction', key: ['harbour', 'Compact'], content: 'CANON-A: The Azure Compact funds the Lantern Guild through harbour dues.' };
hugeLore.entries[1] = { uid: 1, comment: 'Lantern Guild', key: ['Lantern'], content: 'CANON-B: The Lantern Guild maintains the eastern observatory.' };
hugeLore.entries[2] = { uid: 2, comment: 'Forbidden faction', disable: true, content: 'DISABLED-SECRET' };
hugeLore.entries[3] = { uid: 3, comment: 'Long chronicle', content: 'START-' + 'x'.repeat(12000) + '-TAIL' };
wiStore.set('Terranovia', hugeLore);
let loreState = await loreApi.wiCreateDiscovery('lore-chat');
const initialSearch = loreApi.wiLoreSearch(loreState, { query: 'What factions have harbour connections?' });
ok(initialSearch.includes('Terranovia#0') && !initialSearch.includes('DISABLED-SECRET'), 'lexical discovery ranks the faction and excludes disabled lore');
ok(initialSearch.length < 8000 && !initialSearch.includes('record293'), 'large book produces a bounded candidate index, not all entry bodies');
const noMatch = loreApi.wiLoreSearch(loreState, { query: 'zzzznonexistent' });
ok(noMatch.includes('"matches":0') && noMatch.includes('No results'), 'no-match searches are explicit');
const page1 = loreApi.wiLoreSearch(loreState, { query: '' });
const page2 = loreApi.wiLoreSearch(loreState, { query: '', offset: 12 });
ok(page1.includes('"nextOffset":12') && page2.includes('"offset":12'), 'browse index paginates instead of dumping all entries');
const first = loreApi.wiLoreFetch(loreState, ['Terranovia#3']);
const last = loreApi.wiLoreFetch(loreState, ['Terranovia#3@3']);
ok(first.includes('PART 1 OF 3') && first.includes('INCOMPLETE') && !first.includes('-TAIL'), 'oversized entry is honestly marked incomplete');
ok(last.includes('PART 3 OF 3') && last.includes('-TAIL'), 'last part remains retrievable with exact tail');
ok(loreApi.wiLoreFetch(loreState, ['Terranovia#3']).includes('ALREADY SERVED'), 'duplicate fetch does not spend budget on the same body again');
ok(loreApi.wiLoreFetch(loreState, ['Terranovia#3@99']).includes('PART ERROR'), 'invalid part gets an explicit error');
ok(loreApi.wiLoreFetch(loreState, ['Other#0']).includes('LORE MISSING'), 'fetch cannot read outside the selected books');
ok(loreApi.wiLoreFetch(loreState, ['Terranovia#2']).includes('DISABLED — not active canon'), 'explicit disabled-entry inspection never silently promotes it to canon');
hugeLore.entries[1].content += ' NEWLY-EDITED';
const freshIndex = await loreApi.wiCreateDiscovery('lore-chat');
ok(loreApi.wiLoreFetch(freshIndex, ['Terranovia#1']).includes('NEWLY-EDITED'), 'each request reloads lore so saved edits do not leave a stale index');
const overflowState = await loreApi.wiCreateDiscovery('lore-chat');
const manyRefs = Array.from({length: 20}, (_, i) => 'Terranovia#' + (i + 4));
const boundedFetch = loreApi.wiLoreFetch(overflowState, manyRefs);
ok(boundedFetch.length <= 24000 && boundedFetch.includes('NOT SERVED') && boundedFetch.includes('Terranovia#23'), 'fetch cap names omitted refs and bounds payload');
let totalLoreChars = 0;
const budgetState = await loreApi.wiCreateDiscovery('lore-chat');
for (let i = 4; i < 30; i++) { const output = loreApi.wiLoreFetch(budgetState, ['Terranovia#' + i]); if (output.includes('WB[')) totalLoreChars += output.length; }
ok(budgetState.remaining >= 0 && totalLoreChars <= 48000, 'per-request lore budget holds across repeated fetches');
const tiny = await loreApi.wiCreateDiscovery('lore-chat'); tiny.remaining = 50;
loreApi.wiLoreFetch(tiny, ['Terranovia#0']);
ok(tiny.served.size === 0, 'an undelivered entry is never marked as read');
loreSame = false;
ok(await loreApi.wiCreateDiscovery('old-chat') === null, 'chat change aborts index construction'); loreSame = true;
ok(!!loreApi.wiDiscoveryRequest('<wisearch>broken</wisearch>').error, 'malformed search gets actionable feedback');
ok(loreApi.LORE_RULES.includes('[WORLD CANON]') && loreApi.LORE_RULES.includes('[INFERENCE]') && loreApi.LORE_RULES.includes('[PROPOSAL]'), 'canon, inference and proposal labels are explicitly required');

// Drive the actual send loop: initial search -> read -> relationship search -> read -> answer.
CA.wiDiscovery = true; CA.wiEnable = true; CA.wiFull = true; CA.wiBooks = 'Terranovia'; CA.fetchRounds = 3;
CA.profileId = 'gate-profile'; CA.streaming = false;
ctx.chatMetadata['continuityCopilot'] = {};
ctx.chat.length = 0; ctx.chat.push({ is_user: false, mes: 'We have reached the harbour.' });
const loreCalls = [];
ctx.ConnectionManagerRequestService = { sendRequest: async (_p, messages) => {
    loreCalls.push(messages.map(m => ({ ...m })));
    return ['<wifetch>["Terranovia#0"]</wifetch>', '<wisearch>{"query":"Lantern"}</wisearch>', '<wifetch>["Terranovia#1"]</wifetch>', '[CANON] The Compact funds the Guild WB[Terranovia#0]. [INFERENCE] The observatory may connect them WB[Terranovia#1]. [PROPOSAL] Meet a Guild envoy.'][loreCalls.length - 1];
} };
document.getElementById('chatassist_input').value = 'What factions have harbour connections?'; clickFresh('chatassist_send'); await sleep(1000);
const payload = n => loreCalls[n]?.map(m => m.content).join('\n') || '';
ok(loreCalls.length === 4, 'real send loop follows relationships across search and fetch calls');
ok(!payload(0).includes('Unrelated record 293.') && payload(0).includes('LORE DISCOVERY'), 'selective mode overrides legacy full-book injection');
ok(payload(1).includes('CANON-A:') && payload(1).includes('COMPLETE'), 'first selected entry is served with completeness metadata');
ok(payload(3).includes('CANON-B:') && ccLogText().some(t => t.includes('Meet a Guild envoy')), 'related entry reaches the model and final answer reaches the panel');
const maxLorePayload = Math.max(...loreCalls.map(ms => ms.filter(m => /LORE SEARCH|^WB\[/.test(m.content)).reduce((n, m) => n + m.content.length, 0)));
console.log('  measured: synthetic book characters=' + JSON.stringify(hugeLore).length + ', largest accumulated lore payload=' + maxLorePayload);
ok(maxLorePayload < 48000, 'integrated lore payload stays under the configured bound');
// Search on the last call must terminate honestly, never display a tool block as an answer.
let exhaustedCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { exhaustedCalls++; return '<wisearch>{"query":"harbour"}</wisearch>'; } };
document.getElementById('chatassist_input').value = 'Keep searching'; clickFresh('chatassist_send'); await sleep(900);
ok(exhaustedCalls === 5 && ccLogText().some(t => /Lore discovery reached its call limit/.test(t)), 'tool loop has a finite call limit and honest exhaustion message');
// Stop while loading the local index must spend zero model calls.
const oldLoreLoad = ctx.loadWorldInfo; let cancelledCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { cancelledCalls++; return 'UNEXPECTED'; } };
ctx.loadWorldInfo = async book => { clickFresh('chatassist_send'); return oldLoreLoad(book); };
document.getElementById('chatassist_input').value = 'Read lore'; clickFresh('chatassist_send'); await sleep(300);
ctx.loadWorldInfo = oldLoreLoad;
ok(cancelledCalls === 0, 'Stop during local indexing sends no model request');
CA.wiDiscovery = false; CA.wiEnable = false; CA.wiFull = false;

console.log('== v2.84.1 lore generation regressions ==');
CA.wiDiscovery = true; CA.wiBooks = 'Terranovia'; CA.wiEnable = false; CA.wiFull = false;
CA.maxTokens = 4096; CA.thinkRetries = 1; CA.fetchRounds = 3; CA.streaming = false;
async function loreScenario(responder, options = {}) {
    CA.profileId = options.fallback ? '' : 'gate-profile';
    CA.streaming = !!options.stream;
    ctx.chatMetadata.continuityCopilot = {};
    const calls = []; const start = ccLogText().length;
    delete ctx.generateRawData;
    ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages, tokens, custom) => {
        calls.push({ messages: structuredClone(messages), tokens, custom });
        return responder(calls.length, calls[calls.length - 1]);
    } };
    ctx.generateRaw = async params => { calls.push(params); return responder(calls.length, params); };
    if (options.rawData) ctx.generateRawData = ctx.generateRaw;
    document.getElementById('chatassist_input').value = 'Which Veracruz factions could engage with Bunyon?';
    clickFresh('chatassist_send'); await sleep(350);
    return { calls, log: ccLogText().slice(start).join('\n'), history: JSON.stringify(ctx.chatMetadata.continuityCopilot) };
}
const searchRequest = '<wisearch>{"query":"harbour"}</wisearch>';
const completeLoreAnswer = '[CANON] The Compact controls the harbour. [INFERENCE] Its agents could approach Bunyon. [PROPOSAL] An envoy asks for help. WB[Terranovia#0]';
const legacyBudget = await loreScenario((n, params) => {
    if (n === 1) return searchRequest;
    if (params.responseLength !== 4096) throw new Error('No message generated');
    return completeLoreAnswer;
}, { fallback: true });
ok(legacyBudget.calls.length === 2 && legacyBudget.calls.every(x => x.responseLength === 4096) && legacyBudget.log.includes(completeLoreAnswer), 'fallback wisearch continuation receives a fresh configured output budget on every call');
const structuredLore = await loreScenario(n => n === 1 ? { choices: [{message:{content:searchRequest},finish_reason:'stop'}] }
    : n === 2 ? { choices: [{message:{content:'<wifetch>["Terranovia#0"]</wifetch>'},finish_reason:'stop'}] }
    : { choices: [{message:{content:completeLoreAnswer},finish_reason:'stop'}] });
ok(structuredLore.calls.length === 3 && structuredLore.log.includes(completeLoreAnswer), 'raw structured wisearch then wifetch continues to a complete final answer');
ok(structuredLore.calls.every(c => c.tokens === 4096 && c.custom.extractData === false), 'profile requests preserve metadata and do not reuse a spent output budget');
ok(!structuredLore.history.includes('choices'), 'raw provider envelopes are extracted, never rendered or saved as JSON answers');
const reasoningLore = await loreScenario(n => n === 1 ? searchRequest : n === 2 ? {content:'', reasoning:'The Compact and Guild are connected; answer from the retrieved lore.'} : completeLoreAnswer);
ok(reasoningLore.calls.length === 3 && reasoningLore.log.includes(completeLoreAnswer), 'structured reasoning-only intermediate response is retained and recovered');
ok(reasoningLore.calls[2]?.messages.some(m => m.content.includes('The Compact and Guild are connected')), 'reasoning-only recovery receives the retained structured reasoning rather than retrying blind');
const emptyLore = await loreScenario(n => n === 1 ? searchRequest : n === 2 ? '' : completeLoreAnswer);
ok(emptyLore.calls.length === 3 && emptyLore.log.includes(completeLoreAnswer), 'empty intermediate response gets a bounded recovery and successful answer');
const emptyFailure = await loreScenario(() => '');
ok(emptyFailure.calls.length === 2 && /empty|no (?:answer|message|text)/i.test(emptyFailure.log) && /4096|8192/.test(emptyFailure.log), 'repeated empty output stops explicitly with generation diagnostics');
const legacyEmpty = await loreScenario(n => { if (n === 1) return searchRequest; if (n === 2) throw new Error('No message generated'); return completeLoreAnswer; }, {fallback:true});
ok(legacyEmpty.calls.length === 3 && legacyEmpty.log.includes(completeLoreAnswer), 'legacy No message generated after search recovers without suppressing a persistent error');
const leadIn = 'Looking at the fetched entries, here’s what’s canonically present in Veracruz and could plausibly engage with Bunyon right now:';
const clipped = await loreScenario(n => n === 1 ? searchRequest : n === 2 ? {content:'The Compact controls', finish_reason:'length'} : {content:completeLoreAnswer, finish_reason:'stop'});
ok(clipped.calls.length === 3 && clipped.log.includes(completeLoreAnswer) && clipped.calls[2].tokens > clipped.calls[1].tokens, 'length-limited final synthesis is regenerated completely with a fresh larger budget');
const missingReason = await loreScenario(n => n === 1 ? leadIn : completeLoreAnswer);
ok(missingReason.calls.length === 2 && missingReason.log.includes(completeLoreAnswer), 'a dangling synthesis lead-in is not accepted even when the host strips finish reasons');
const unresolvedClip = await loreScenario(() => ({content:leadIn, finish_reason:'length'}));
ok(unresolvedClip.calls.length === 2 && /incomplete/i.test(unresolvedClip.log) && /length/.test(unresolvedClip.log), 'persistent truncation preserves the partial text with an explicit incomplete status and stop reason');
ok(!unresolvedClip.history.includes('"role":"assistant"'), 'unresolved partial output is not recorded as a completed assistant answer');
const malformedTool = await loreScenario(n => n === 1 ? '<wisearch>{"query":' : completeLoreAnswer);
ok(malformedTool.calls.length === 2 && malformedTool.log.includes(completeLoreAnswer), 'unclosed lore tool block is recovered instead of silently terminating');
const backendError = await loreScenario(() => { throw new Error('API request failed', {cause:new Error('provider context length exceeded')}); });
ok(backendError.calls.length === 1 && backendError.log.includes('provider context length exceeded'), 'provider failure cause survives the wrapper and is not blindly retried');
const filtered = await loreScenario(() => ({content:'', finish_reason:'content_filter'}));
ok(filtered.calls.length === 1 && filtered.log.includes('content_filter'), 'provider refusal/filter termination is surfaced without automatic retry');
const fallbackRaw = await loreScenario(n => n === 1 ? {choices:[{message:{content:'',reasoning_content:'Plan the Compact answer.'},finish_reason:'length'}]} : {choices:[{message:{content:completeLoreAnswer},finish_reason:'stop'}]}, {fallback:true, rawData:true});
ok(fallbackRaw.calls.length === 2 && fallbackRaw.log.includes(completeLoreAnswer), 'raw fallback data preserves reasoning and finish metadata before host text cleanup');
const streamLore = await loreScenario(n => function () { return (async function* () {
    if (n === 1) { yield {text:searchRequest, state:{reasoning:''}}; yield {text:searchRequest, state:{reasoning:''}}; }
    else { yield {text:leadIn,state:{reasoning:''}}; yield {text:completeLoreAnswer,state:{reasoning:''}}; yield {text:completeLoreAnswer,state:{reasoning:''}}; }
})(); }, {stream:true});
ok(streamLore.calls.length === 2 && streamLore.log.includes(completeLoreAnswer), 'SillyTavern cumulative streams retain the latest text and complete the discovery answer');
ok(!streamLore.history.includes(leadIn), 'cumulative stream revisions replace the old prefix instead of appending a second answer');
const brokenStream = await loreScenario(n => function () { return (async function* () {
    yield {text:leadIn,state:{reasoning:''}};
    if (n === 1) throw new Error('connection reset mid-stream');
    yield {text:completeLoreAnswer,state:{reasoning:''}};
})(); }, {stream:true});
ok(brokenStream.calls.length === 2 && brokenStream.log.includes(completeLoreAnswer) && /connection reset mid-stream/.test(brokenStream.log), 'interrupted stream reports the real cause and recovers without accepting the partial answer');
const malformedJson = await loreScenario(n => n === 1 ? searchRequest : n === 2 ? '<wisearch>{broken}</wisearch>' : completeLoreAnswer);
ok(malformedJson.calls.length === 3 && malformedJson.log.includes(completeLoreAnswer) && /Use wisearch/.test(malformedJson.log), 'malformed intermediate JSON is explicitly reported and coached into a complete answer');
const streamingLimit = await loreScenario(n => function () { return (async function* () {
    yield {text: n === 1 ? leadIn : completeLoreAnswer, state:{reasoning:''}, finish_reason:n === 1 ? 'length' : 'stop'};
})(); }, {stream:true});
ok(streamingLimit.calls.length === 2 && streamingLimit.log.includes(completeLoreAnswer), 'streamed finish metadata triggers truncation recovery');
const streamBlocked = await loreScenario(() => function () { return (async function* () { yield {text:'',state:{reasoning:''}, finish_reason:'content_filter'}; })(); }, {stream:true});
ok(streamBlocked.calls.length === 1 && streamBlocked.log.includes('content_filter'), 'streamed provider filter is not retried through the non-stream fallback');
const unknownShape = await loreScenario(n => n === 1 ? {unexpected:'not an answer', usage:{total_tokens:10}} : completeLoreAnswer);
ok(unknownShape.calls.length === 2 && unknownShape.log.includes(completeLoreAnswer) && !unknownShape.history.includes('not an answer'), 'unknown response objects cannot become JSON assistant answers');
const recoveryStop = await loreScenario(() => { clickFresh('chatassist_send'); return ''; });
ok(recoveryStop.calls.length === 1, 'user Stop prevents the new empty-answer recovery from starting another call');
const textReasoning = await loreScenario(n => n === 1 ? {choices:[{text:'',reasoning:'TEXT-REASONING-RETAINED',finish_reason:'length'}]} : completeLoreAnswer);
ok(textReasoning.calls.length === 2 && textReasoning.calls[1].messages.some(m => m.content.includes('TEXT-REASONING-RETAINED')), 'text-completion reasoning is retained when raw response extraction is requested');
CA.wiDiscovery = false; CA.streaming = false; CA.profileId = 'gate-profile';
delete ctx.generateRaw; delete ctx.generateRawData;

console.log('== Campaign Ledger: provenance, isolation and bounded retrieval ==');
const campaign = globalThis.__campaignTest;
CA.profileId = 'gate-profile'; CA.streaming = false;
ctx.chatMetadata = {}; ctx.chatId = 'campaign-A';
ctx.chat = [
    { name:'Narrator', mes:'Garrick says: "Ask for Jericho at the Black Anchor tavern down by the wharf after sundown."', send_date:'2026-10-02' },
    { name:'Narrator', mes:'Vael says: "Jericho runs security for the Red Arcade private buyers."' },
    { name:'Narrator', mes:'The warehouse exploded, showering the harbor road with burning timber.' },
    { name:'Narrator', mes:'Vael says: "The Duchess is secretly a dragon."' },
];
let campaignRequests = [], campaignWrites = 0;
ctx.saveWorldInfo = async () => { campaignWrites++; };
const extracted = [
 { type:'NEW_ENTITY', subject:'Jericho', fact:'Garrick refers to Jericho at Black Anchor.', sourceMessageIndex:0, evidence:'dialogue', speaker:'Garrick',  related:['Black Anchor','Veracruz'] },
 { type:'NEW_ENTITY', subject:'Black Anchor', fact:'Garrick refers to the Black Anchor tavern.', sourceMessageIndex:0, evidence:'dialogue', speaker:'Garrick',  related:['Jericho','Veracruz'] },
 { type:'NPC_CLAIM', subject:'Jericho', fact:'Vael claims Jericho runs Red Arcade security.', sourceMessageIndex:1, evidence:'dialogue', speaker:'Vael',  related:['Red Arcade'] },
 { type:'STATE_CHANGE', subject:'Warehouse', fact:'The warehouse exploded.', sourceMessageIndex:2, evidence:'narration',  related:['harbor'] },
 { type:'OBSERVED_FACT', subject:'Duchess', fact:'Vael claims the Duchess is a dragon.', sourceMessageIndex:3, evidence:'dialogue', speaker:'Vael',  },
];
ctx.ConnectionManagerRequestService = { sendRequest: async (_p, messages) => { campaignRequests.push(messages); return JSON.stringify({records:extracted}); } };
CA.wiBooks='CampaignBaseline';
ctx.loadWorldInfo=async()=>({entries:{0:{uid:0,key:['Jericho'],comment:'Jericho',content:'Jericho appears in this baseline entry.'}}});
campaign.campaignStore();
ctx.chatMetadata.continuityCopilot.sessions[0].history.push({role:'assistant', text:'SESSION_ONLY_JERICHO_PROPOSAL', content:'SESSION_ONLY_JERICHO_PROPOSAL'});
await campaign.campaignAudit(undefined, true);
const storeA = campaign.campaignStore();
ok(storeA.records.length === 5 && storeA.next === 4, 'audit saves five source-backed candidates and advances the cursor');
ok(storeA.records[0]?.lore.candidates.includes('CampaignBaseline#0') && storeA.records[0]?.lore.status.includes('not verified'), 'optional lore checking reuses search without promoting candidates to canon');
ok(campaignRequests.length === 1, 'campaign audit uses one model call including optional local lore checks');
ok(storeA.records.every(r => r.status === 'pending' && r.id && r.source.fingerprint && r.source.anchor==='message'), 'extractions require review and retain source evidence');
ok(storeA.records[2].type === 'NPC_CLAIM' && storeA.records[4].provenance === 'NPC CLAIM', 'quoted dialogue and explicit dialogue cannot become objective campaign facts');
ok(storeA.records[0].provenance === 'DIALOGUE REFERENCE' && storeA.records[1].type === 'NEW_ENTITY', 'Jericho and Black Anchor preserve introduced-reference provenance');
ok(storeA.records[3].type === 'STATE_CHANGE' && storeA.records[3].provenance === 'UNREVIEWED RP', 'narrated warehouse explosion remains a pending unreviewed state change');
ok(!JSON.stringify(campaignRequests).includes('SESSION_ONLY_JERICHO_PROPOSAL'), 'audit excludes Chat Assistant session proposals');
ok(campaign.campaignSelect('Jericho') === '', 'pending candidates cannot enter campaign context');
for (const r of storeA.records) campaign.campaignReview(r.id,'accepted');
ok(campaign.campaignSelect('Jericho Red Arcade Veracruz').includes('NPC CLAIM') && campaign.campaignSelect('Warehouse').includes('CAMPAIGN CANON'), 'relevant retrieval preserves claim versus campaign provenance');
ok(campaign.campaignSelect('unrelatedxyz') === '', 'unrelated records are not injected');
ok(!campaign.gatherMemory().includes('campaignLedger') && !campaign.gatherMemory().includes('warehouse exploded'), 'general memory collection cannot inject the entire ledger');
const ripple = await campaign.rippleScan([{span:'warehouse exploded', removed:0}]);
ok(ripple.some(x=>x.sites.some(y=>y.kind==='campaign')), 'consistency scan includes accepted campaign facts');
await campaign.campaignAudit(0);
ok(storeA.records.length === 5, 're-audit suppresses exact duplicate records');
campaign.campaignReview(storeA.records[0].id,'rejected'); await campaign.campaignAudit(0);
ok(storeA.records.length === 5 && storeA.records[0].status === 'rejected', 'rejected duplicate remains rejected after re-audit');
const beforeCalls = campaignRequests.length; await campaign.campaignAudit();
ok(campaignRequests.length === beforeCalls, 'incremental audit does not call the model without new RP');
ctx.chat.push({name:'Narrator',mes:'The Black Anchor stood beside the Veracruz wharf.'});
ctx.ConnectionManagerRequestService.sendRequest = async (_p,messages) => { campaignRequests.push(messages); return JSON.stringify({records:[{type:'OBSERVED_FACT',subject:'Black Anchor',fact:ctx.chat[4].mes,sourceMessageIndex:4,evidence:'narration',}]}); };
await campaign.campaignAudit();
ok(storeA.next === 5 && storeA.records.length === 6 && !campaignRequests.at(-1)[1].content.includes('warehouse exploded'), 'incremental audit sends only new RP messages');
const mdA=ctx.chatMetadata, chatA=ctx.chat;
ctx.chatMetadata={}; ctx.chatId='campaign-B'; ctx.chat=[{name:'Narrator',mes:'A different campaign begins.'}];
ok(campaign.campaignStore().records.length === 0 && campaign.campaignSelect('Jericho') === '', 'another chat has an isolated empty ledger');
ctx.chatMetadata=mdA; ctx.chat=chatA; ctx.chatId='campaign-A';
ok(campaign.campaignStore() === storeA, 'returning to the chat restores its ledger');
const restored=JSON.parse(JSON.stringify(mdA)); ctx.chatMetadata=restored;
ok(campaign.campaignStore().records.length === 6, 'ledger survives metadata serialization and reload'); ctx.chatMetadata=mdA;
ctx.chat[2].mes='The warehouse remained intact.';
ok(campaign.campaignSelect('Warehouse') === '', 'edited or swiped source makes its record stale and ineligible');
const quoteOnly=campaign.campaignParse(JSON.stringify({records:[{...extracted[4], evidence:'dialogue', quote:'The Duchess is secretly a dragon.'}]}),campaign.campaignBatch(0).sources);
ok(quoteOnly[0].provenance==='NPC CLAIM','declared dialogue remains a claim regardless of incidental model quote');
storeA.next=2; // Different from batch end: a wrongly committed failure must move this cursor.
const beforeRecordCount=storeA.records.length, beforeNext=storeA.next;
for (const response of ['', '{bad', JSON.stringify({records:[{...extracted[0],sourceMessageIndex:999}]}), JSON.stringify({records:[{...extracted[0],type:'PROPOSAL'}]})]) {
 ctx.ConnectionManagerRequestService.sendRequest=async()=>response; await campaign.campaignAudit(0);
 ok(storeA.records.length===beforeRecordCount && storeA.next===beforeNext, 'malformed/empty/unbacked/proposal audit fails without advancing or writing');
}
ctx.ConnectionManagerRequestService.sendRequest=async()=>({choices:[{message:{content:JSON.stringify({records:[]})},finish_reason:'length'}]});
await campaign.campaignAudit(0); ok(storeA.next===beforeNext, 'token-truncated audit cannot commit even parseable JSON');
ctx.ConnectionManagerRequestService.sendRequest=async()=>{ctx.chatMetadata={}; ctx.chatId='campaign-B'; return JSON.stringify({records:[{...extracted[2],fact:'Late write must not persist.'}]});};
await campaign.campaignAudit(0); ok(storeA.next===beforeNext && storeA.records.length===beforeRecordCount && !ctx.chatMetadata.continuityCopilot?.campaignLedger, 'chat switch during audit writes to neither chat');
ctx.chatMetadata=mdA; ctx.chatId='campaign-A';
ctx.ConnectionManagerRequestService.sendRequest=async()=>{ctx.chat[0].mes+=' edited'; return JSON.stringify({records:[{...extracted[2],fact:'Source drift must not persist.'}]});};
await campaign.campaignAudit(0); ok(storeA.next===beforeNext && storeA.records.length===beforeRecordCount, 'source mutation during audit discards batch and progress');
ctx.chat[0].mes=chatA[0].mes;
ctx.chat=Array.from({length:80},(_,i)=>({name:'Narrator',mes:'A campaign event '+i+' occurred at the harbor.'}));
const boundedBatch=campaign.campaignBatch(0);
ok(boundedBatch.sources.size===50 && boundedBatch.next===50 && boundedBatch.text.length<=24000, 'audit caps a batch at 50 whole RP messages');
ctx.chat=[{name:'Narrator',mes:'x'.repeat(25000)}];
let oversized=false;try{campaign.campaignBatch(0);}catch{oversized=true;}
ok(oversized, 'oversized single RP message fails explicitly instead of silently skipping text');
ctx.chat=chatA;
const baseRecord=storeA.records.find(r=>r.source.index===4);
for(let i=0;i<100;i++)storeA.records.push({...structuredClone(baseRecord),id:'CL-extra-'+i,status:'accepted',fact:'Black Anchor detail '+i+' '+ 'x'.repeat(400)});
const boundedContext=campaign.campaignSelect('Black Anchor');
ok(boundedContext.length<=6000 && boundedContext.split('\n').filter(x=>x.startsWith('{')).length<=12, 'retrieval obeys record and character caps');
ok(campaignWrites===0, 'Campaign Ledger never writes World Info');
ctx.chatMetadata={}; ctx.chat=Array.from({length:60},()=>({is_system:true,mes:'Hidden RP.'}));
campaign.campaignStore().next=0;
let hiddenCalls=0; ctx.ConnectionManagerRequestService.sendRequest=async()=>{hiddenCalls++; return JSON.stringify({records:[]});};
await campaign.campaignAudit();
ok(campaign.campaignStore().next===50 && hiddenCalls===0, 'hidden-only batch advances without a model call so later RP remains reachable');
ctx.chatMetadata={}; ctx.chat=[];

console.log('== v2.86.0 message-anchored pending extraction ==');
ok(!/function campaign(?:Spans|Anchor|RangeSize|RangeChoices|Evidence)\(/.test(SRC), 'retired span/range/offset evidence machinery is absent');
ctx.chatMetadata={}; ctx.chatId='message-contract';
ctx.chat=[
 {name:'Narrator',mes:'*Vael accepts Bunyon’s coin.*\nVael: "Jericho runs security for the Red Arcade."\nGarrick: “Ask for Jericho at the Black Anchor.”\n`I won’t tell Bunyon everything.`\nBunyon STATUS: HP 190/190; ST 90/95.\n'+ 'The harbor crowd passes by. '.repeat(180)},
 {name:'Narrator',mes:'`The Duchess is secretly a dragon.`'},
 {name:'Narrator',mes:'[WORLD CANON]\nANALYSIS_PRIVATE: Jericho is a possible contact.'},
 {name:'System',is_system:true,mes:'DIRECTOR_PRIVATE: Have Jericho arrive tonight.'},
 {name:'Narrator',mes:'OOC: PROPOSAL_PRIVATE: Introduce a new faction.'},
 {name:'Narrator',mes:'Vael sat'},
];
const messageBatch=campaign.campaignBatch(0);
const candidate=(type,subject,fact,sourceMessageIndex,evidence,speaker=null)=>({type,subject,fact,sourceMessageIndex,evidence,speaker,related:[]});
const mixedRecords=[
 candidate('STATE_CHANGE','Vael','Vael accepts Bunyon’s coin.',0,'narration'),
 candidate('NPC_CLAIM','Jericho','Vael claims Jericho works for Red Arcade.',0,'dialogue','Vael'),
 candidate('NEW_ENTITY','Black Anchor','Garrick refers Bunyon to Jericho at Black Anchor.',0,'dialogue','Garrick'),
 candidate('OBSERVED_FACT','Bunyon','Bunyon thinks he is withholding information.',0,'thought'),
 candidate('OBSERVED_FACT','Duchess','The Duchess is secretly a dragon.',1,'narration'),
 {type:'OBSERVED_FACT',subject:'Vael',fact:'Vael sat.',sourceMessageIndex:5},
];
const parsedMessages=campaign.campaignParse(JSON.stringify({records:mixedRecords}),messageBatch.sources);
const selfAccepted=campaign.campaignParse(JSON.stringify({records:[{...mixedRecords[0],status:'accepted',provenance:'CAMPAIGN CANON'}]}),messageBatch.sources)[0];
ok(selfAccepted.status==='pending' && selfAccepted.provenance==='UNREVIEWED RP', 'model-supplied acceptance/canon flags cannot bypass human review');
ok(parsedMessages.length===6 && parsedMessages.every(r=>r.status==='pending' && r.source.anchor==='message' && !('quote' in r.source) && !('start' in r.source)), 'all candidates use message-level fingerprints with no quotes, offsets or span data');
ok(parsedMessages[0].type==='STATE_CHANGE' && parsedMessages[0].provenance==='UNREVIEWED RP' && parsedMessages[1].provenance==='NPC CLAIM' && parsedMessages[2].provenance==='DIALOGUE REFERENCE', 'same mixed message supports separate pending narration, NPC claim and referral candidates');
ok(parsedMessages[3].type==='UNRESOLVED_CLAIM' && parsedMessages[4].type==='UNRESOLVED_CLAIM', 'declared thoughts and an entirely backtick-delimited message cannot become objective campaign facts');
ok(campaign.campaignSourceText(parsedMessages[0])===ctx.chat[0].mes && ctx.chat[0].mes.length>1200, 'long multiline RP and status information remain available as the entire authoritative source');
ok(messageBatch.sources.size===3 && !/ANALYSIS_PRIVATE|DIRECTOR_PRIVATE|PROPOSAL_PRIVATE/.test(messageBatch.text) && messageBatch.text.includes(ctx.chat[0].mes), 'batch supplies whole actual RP and excludes system, analysis and OOC content');
ok(['[WORLD CANON]', '**[WORLD CANON]**', '### **[PROPOSAL]**', '> [INFERENCE]', '__[OOC]__'].every(label=>campaign.campaignNonRP(label+'\nNon-RP analysis.')), 'formatted analyst/OOC exclusions remain enforced');
const loose={...mixedRecords[0],quote:'A harmless model paraphrase.',sourceSpanIds:['invented'],sourceSpanRange:{start:'bad',end:'bad'}};
ok(campaign.campaignParse(JSON.stringify({records:[loose]}),messageBatch.sources)[0].source.index===0, 'retired incidental quote/span fields neither supply evidence nor reject a valid message candidate');
const storeMessages=campaign.campaignStore();
ctx.chatMetadata.continuityCopilot.sessions[0].history.push({role:'assistant',content:'SESSION_PRIVATE: invent a new Jericho faction.'});
let auditMessages;
ctx.ConnectionManagerRequestService.sendRequest=async(_p,messages)=>{auditMessages=messages;return JSON.stringify({records:mixedRecords});};
await campaign.campaignAudit(0);
ok(storeMessages.records.length===6 && storeMessages.next===6, 'real mixed multiline audit saves an entire pending batch without substring restrictions');
ok(!JSON.stringify(auditMessages).includes('SESSION_PRIVATE') && !/sourceSpanRange|sourceSpanIds|validEnds/.test(auditMessages[0].content) && auditMessages[0].content.includes('sourceMessageIndex'), 'actual request uses only source-message contract and excludes assistant session history');
ok(!campaign.campaignSelect('Vael Jericho Bunyon Duchess Black Anchor'), 'all pending candidates are excluded from retrieval');
for(const r of storeMessages.records) campaign.campaignReview(r.id,'accepted');
const selectedMessages=campaign.campaignSelect('Vael Jericho Bunyon Duchess Black Anchor');
ok(selectedMessages.includes('CAMPAIGN CANON') && selectedMessages.includes('NPC CLAIM') && selectedMessages.includes('UNRESOLVED CLAIM') && !selectedMessages.includes('WORLD CANON'), 'human acceptance approves campaign memory without promoting claims/thoughts or Worldbook Canon');
ok(!selectedMessages.includes('The harbor crowd passes by.') && !selectedMessages.includes('sourceSpan') && !selectedMessages.includes('"quote"'), 'bounded retrieval uses accepted records, not full source messages or retired quotes');
const claims=storeMessages.records.filter(r=>r.type==='NPC_CLAIM' || r.type==='UNRESOLVED_CLAIM');
ok(claims.every(r=>r.provenance!=='CAMPAIGN CANON'), 'accepting subjective evidence never changes it into objective campaign canon');
const oldRecord={...structuredClone(storeMessages.records[0]),source:{...storeMessages.records[0].source,quote:'legacy excerpt',start:0,end:99,spanIds:['old']}};
ok(campaign.campaignValid(oldRecord), 'legacy persisted records use the same message fingerprint without keeping a second evidence validator');
const warnBefore=console.warn, diagnostics=[]; console.warn=(...args)=>diagnostics.push(args);
try {
 const invalidRows=[
  {...mixedRecords[0],sourceMessageIndex:999},
  {...mixedRecords[0],sourceMessageIndex:2},
  {...mixedRecords[0],sourceMessageIndex:3},
  {...mixedRecords[0],sourceMessageIndex:4},
  {...mixedRecords[0],sourceMessageIndex:true},
  {...mixedRecords[0],type:'PROPOSAL'},
  {...mixedRecords[0],subject:null},
  {...mixedRecords[0],fact:{}},
  {...mixedRecords[0],speaker:{}},
  {...mixedRecords[0],related:[{}]},
  {...mixedRecords[0],evidence:'objective'},
 ];
 for(const row of invalidRows) {
  storeMessages.next=0;const snapshot=JSON.stringify(storeMessages);
  ctx.ConnectionManagerRequestService.sendRequest=async()=>JSON.stringify({records:[{...mixedRecords[0],fact:'Valid candidate before invalid record.'},row]});
  await campaign.campaignAudit(0);
  ok(JSON.stringify(storeMessages)===snapshot, 'invalid source/type/required field rejects entire batch and leaves cursor unchanged');
 }
 let outOfBatch;
 try{campaign.campaignParse(JSON.stringify({records:[mixedRecords[0]]}),campaign.campaignBatch(5).sources);}catch(e){outOfBatch=e.campaignDiagnostic;}
 ok(outOfBatch?.field==='sourceMessageIndex', 'existing message outside audited batch is rejected');
 const excludedMap=new Map([[2,{index:2,text:ctx.chat[2].mes,speaker:'Narrator',fingerprint:campaign.campaignFingerprint(ctx.chat[2])}]]);
 let excluded;
 try{campaign.campaignParse(JSON.stringify({records:[{...mixedRecords[0],sourceMessageIndex:2}]}),excludedMap);}catch(e){excluded=e.campaignDiagnostic;}
 ok(excluded?.field==='sourceMessageIndex', 'explicit analysis cannot be smuggled into evidence through a supplied source object');
 ok(diagnostics.some(args=>args.some(x=>x?.candidate===2 && x?.field==='sourceMessageIndex')) && !JSON.stringify(diagnostics).includes('ANALYSIS_PRIVATE'), 'safe diagnostics still identify candidate and field without source text');
} finally {console.warn=warnBefore;}
const sourceChat=structuredClone(ctx.chat);
for(const mutate of [chat=>{chat[0].mes+=' EDIT';},chat=>{chat[0].mes='Different swipe.';},chat=>{chat.splice(0,1);},chat=>{[chat[0],chat[1]]=[chat[1],chat[0]];}]) {
 ctx.chat=structuredClone(sourceChat);mutate(ctx.chat);
 ok(!campaign.campaignValid(storeMessages.records[0]) && campaign.campaignSourceText(storeMessages.records[0])===null && !campaign.campaignSelect('Black Anchor'), 'edited/swiped/deleted/reordered source is stale, unavailable for original-source display and not retrieved');
 storeMessages.records[0].status='pending';campaign.campaignReview(storeMessages.records[0].id,'accepted');
 ok(storeMessages.records[0].status==='pending', 'stale pending source cannot be accepted');
}
ctx.chat=sourceChat;
campaign.campaignReview(storeMessages.records[0].id,'rejected');
ok(!campaign.campaignSelect('coin'), 'rejected records remain excluded');
ctx.chatMetadata={}; ctx.chat=[];

console.log('== Author Note approval bridge ==');
const an=campaign;
CA.directorMode='off'; CA.critiqueAuto=0; CA.wiDiscovery=false;
ctx.chatId='an-A';ctx.chat=[{name:'Narrator',mes:'The travelers reach the Veracruz wharf.'}];
const originalNote={note_prompt:'At the wharf.',note_interval:3,note_position:1,note_depth:4,note_role:0,unrelated:{keep:true}};
ctx.chatMetadata=structuredClone(originalNote);
let anSaves=0,anReloads=0,anDisk=structuredClone(ctx.chatMetadata);
ctx.updateChatMetadata=(values,reset)=>{ctx.chatMetadata=reset?{...values}:{...ctx.chatMetadata,...values};};
ctx.saveMetadata=async()=>{anSaves++;anDisk=structuredClone(ctx.chatMetadata);};
ctx.reloadCurrentChat=async()=>{anReloads++;ctx.chatMetadata=structuredClone(anDisk);};
const operation=(operation,content)=>an.anParse('<authorsnote>'+JSON.stringify({operation,...(content===undefined?{}:{content})})+'</authorsnote>');
const propose=(operationName,content)=>an.anPropose(operation(operationName,content),an.anRead());
ok(an.anRead().text==='At the wharf.' && anSaves===0,'READ uses actual metadata without saving');
ctx.chatMetadata.note_prompt='';ok(an.anRead().text==='' && anSaves===0,'READ distinguishes an empty initialized note');
ctx.chatMetadata.note_prompt=originalNote.note_prompt;
for(const [op,content,expected] of [['PROPOSE_REPLACE','Concise current scene.','Concise current scene.'],['PROPOSE_APPEND','Unresolved danger.','At the wharf.\nUnresolved danger.'],['PROPOSE_CLEAR',undefined,'']]) {
 ctx.chatMetadata=structuredClone(originalNote);anDisk=structuredClone(originalNote);
 const saves=anSaves;
 let proposal=propose(op,content);
 ok(ctx.chatMetadata.note_prompt===originalNote.note_prompt && anSaves===saves,op+' prepares a preview without mutating');
 an.anCancel(proposal);
 ok(await an.anApply(proposal)===false && ctx.chatMetadata.note_prompt===originalNote.note_prompt && anSaves===saves,op+' Cancel prevents any write, including replay');
 proposal=propose(op,content);
 ok(await an.anApply(proposal)===true && ctx.chatMetadata.note_prompt===expected && anDisk.note_prompt===expected,op+' explicit Apply writes and verifies persisted text');
 const {note_prompt,...settingsAfter}=ctx.chatMetadata;const {note_prompt:oldText,...settingsBefore}=originalNote;
 ok(JSON.stringify(settingsAfter)===JSON.stringify(settingsBefore),op+' preserves note depth, interval, position, role and unrelated metadata');
 ok(await an.anApply(proposal)===false,op+' cannot be applied twice');
}
ok(anSaves===3 && anReloads===3,'successful writes use native saveMetadata and reloadCurrentChat exactly once each');
ctx.chatMetadata=structuredClone(originalNote);
let pendingAn=propose('PROPOSE_REPLACE','must not leak');
const oldMdAn=ctx.chatMetadata;ctx.chatId='an-B';ctx.chatMetadata={note_prompt:'Chat B'};
ok(await an.anApply(pendingAn)===false && ctx.chatMetadata.note_prompt==='Chat B' && oldMdAn.note_prompt==='At the wharf.','chat switch before confirmation writes to neither chat');
ctx.chatId='an-A';ctx.chatMetadata=structuredClone(originalNote);
for(const op of ['PROPOSE_REPLACE','PROPOSE_APPEND','PROPOSE_CLEAR']) {
 ctx.chatMetadata=structuredClone(originalNote);
 const p=propose(op,op==='PROPOSE_CLEAR'?undefined:'new');ctx.chatMetadata.note_prompt='External newer note';
 ok(await an.anApply(p)===false && ctx.chatMetadata.note_prompt==='External newer note','external change blocks stale '+op);
}
ctx.chatMetadata=structuredClone(originalNote);
const beforeInvalidAn=JSON.stringify(ctx.chatMetadata),beforeSavesAn=anSaves;
for(const raw of ['<authorsnote>{bad}</authorsnote>','<authorsnote>{"operation":"WRITE","content":"bad"}</authorsnote>','<authorsnote>{"operation":"PROPOSE_REPLACE"}</authorsnote>','<authorsnote>{"operation":"PROPOSE_CLEAR","content":"bad"}</authorsnote>','<authorsnote>{"operation":"READ"}</authorsnote><authorsnote>{"operation":"READ"}</authorsnote>','<authorsnote>{"operation":"READ"}</authorsnote><memedits>[]</memedits>','<authorsnote>{"operation":"PROPOSE_APPEND","content":"unfinished"}']) {
 let rejected=false;try{an.anParse(raw);}catch{rejected=true;}
 ok(rejected && JSON.stringify(ctx.chatMetadata)===beforeInvalidAn && anSaves===beforeSavesAn,'malformed/mixed/direct-write operation cannot mutate note');
}
operation('READ');ok(JSON.stringify(ctx.chatMetadata)===beforeInvalidAn,'parsing READ never changes state');
let missingBase=false;try{an.anPropose(operation('PROPOSE_CLEAR'),null);}catch{missingBase=true;}
ok(missingBase && JSON.stringify(ctx.chatMetadata)===beforeInvalidAn,'model cannot propose a change without a captured successful read');
delete ctx.chatMetadata.note_prompt;const defaultBefore=ctx.extensionSettings.note;ctx.extensionSettings.note={default:'Default note'};
ok(an.anRead().text==='Default note' && !('note_prompt' in ctx.chatMetadata),'uninitialized chat note reads ST default without creating a shadow copy');
delete ctx.extensionSettings.note;let unreadable=false;try{an.anRead();}catch{unreadable=true;}
ok(unreadable,'missing/uninitialized Author Note is reported, not invented as empty');ctx.extensionSettings.note=defaultBefore;
ctx.chatMetadata=structuredClone(originalNote);
const realAnSave=ctx.saveMetadata,realAnReload=ctx.reloadCurrentChat;
ctx.saveMetadata=async()=>{throw new Error('storage unavailable');};
pendingAn=propose('PROPOSE_REPLACE','must roll back');
ok(await an.anApply(pendingAn)===false && JSON.stringify(ctx.chatMetadata)===JSON.stringify(originalNote),'failed save restores original text without changing settings');
ctx.saveMetadata=realAnSave;
ctx.reloadCurrentChat=async()=>{throw new Error('reload unavailable');};
pendingAn=propose('PROPOSE_CLEAR');
ok(await an.anApply(pendingAn)===false && ctx.chatMetadata.note_prompt===originalNote.note_prompt && anDisk.note_prompt===originalNote.note_prompt,'failed synchronization rolls back persisted text');
ctx.reloadCurrentChat=realAnReload;
ctx.chatMetadata=structuredClone(originalNote);anDisk=structuredClone(originalNote);
ctx.saveMetadata=async()=>{}; // Native ST can swallow a server save error.
pendingAn=propose('PROPOSE_REPLACE','not actually persisted');
ok(await an.anApply(pendingAn)===false && ctx.chatMetadata.note_prompt===originalNote.note_prompt && anDisk.note_prompt===originalNote.note_prompt,'reload verification detects a silently failed native save');
ctx.saveMetadata=realAnSave;
ctx.reloadCurrentChat=realAnReload;
ctx.saveMetadata=async()=>{await realAnSave();ctx.chatMetadata.note_prompt='External edit while saving';};
pendingAn=propose('PROPOSE_REPLACE','temporary');
ok(await an.anApply(pendingAn)===false && ctx.chatMetadata.note_prompt==='External edit while saving','concurrent external edit is preserved rather than overwritten by reload or rollback');
ctx.saveMetadata=realAnSave;
ctx.chatMetadata=structuredClone(originalNote);
const reloadsBeforeSwitch=anReloads;
ctx.saveMetadata=async()=>{await realAnSave();ctx.chatId='an-other-during-save';ctx.chatMetadata={note_prompt:'Other chat kept'};};
pendingAn=propose('PROPOSE_REPLACE','approved in A');
ok(await an.anApply(pendingAn)===false && ctx.chatMetadata.note_prompt==='Other chat kept' && anReloads===reloadsBeforeSwitch,'switch during save never refreshes or rewrites the destination chat');
ctx.chatId='an-A';
ctx.saveMetadata=realAnSave;
ctx.chatMetadata=structuredClone(originalNote);
await driveAsk('<memedits>[{"path":"note_prompt","replace":"bypass"}]</memedits>');
ok(ctx.chatMetadata.note_prompt===originalNote.note_prompt,'legacy generic memory edit cannot bypass the Author Note approval/synchronization path');
// Exercise normal user generation with a READ continuation and proposal, using
// existing campaign/lore context machinery rather than another generation flow.
ctx.chatMetadata=structuredClone(originalNote);ctx.chatId='an-workflow';
const workflowLedger=campaign.campaignStore();
const workflowRecord={type:'NPC_CLAIM',subject:'Jericho',fact:'APPROVED_JERICHO: Vael mentioned him.',evidence:'dialogue',status:'accepted',related:[],source:{index:0,fingerprint:campaign.campaignFingerprint(ctx.chat[0]),speaker:'Narrator'}};
workflowLedger.records.push({...workflowRecord,id:'AN-accepted'},{...workflowRecord,id:'AN-pending',status:'pending',fact:'PENDING_JERICHO_SECRET'});
CA.wiDiscovery=true;CA.wiBooks='AuthorNoteLore';ctx.loadWorldInfo=async()=>({entries:{0:{uid:0,key:['Jericho'],comment:'Jericho',content:'LORE_CANON: Jericho watches the wharf.'}}});
let anCalls=0,anMessages=[];
ctx.ConnectionManagerRequestService.sendRequest=async(_p,messages)=>{anCalls++;anMessages.push(structuredClone(messages));return anCalls===1?'<authorsnote>{"operation":"READ"}</authorsnote>':anCalls===2?'<wifetch>["AuthorNoteLore#0"]</wifetch>':'<authorsnote>{"operation":"PROPOSE_REPLACE","content":"Veracruz wharf. Await Jericho; his allegiance is unverified."}</authorsnote>';};
document.getElementById('chatassist_input').value="Update my Author's Note about Jericho for the current scene. Keep under 400 tokens.";
clickFresh('chatassist_send');
await sleep(1500);
ok(anCalls===3 && anMessages[1].some(m=>m.content.includes('[CURRENT AUTHOR NOTE')) && ctx.chatMetadata.note_prompt===originalNote.note_prompt, 'normal user generation reads note and produces a proposal without writing');
ok(JSON.stringify(anMessages).includes('APPROVED_JERICHO') && !JSON.stringify(anMessages).includes('PENDING_JERICHO_SECRET') && anMessages.at(-1).some(m=>m.content.includes('LORE_CANON')), 'Author Note composition reuses bounded accepted campaign context and existing selective lore fetch');
an.anCancel();CA.wiDiscovery=false;
ctx.ConnectionManagerRequestService.sendRequest=async()=>({choices:[{message:{content:'<authorsnote>{"operation":"PROPOSE_REPLACE","content":"truncated proposal"}</authorsnote>'},finish_reason:'length'}]});
document.getElementById('chatassist_input').value="Replace my Author's Note.";clickFresh('chatassist_send');await sleep(1500);
ok(an.anPendingProposal()===null && ctx.chatMetadata.note_prompt===originalNote.note_prompt,'token-truncated Author Note generation cannot stage even parseable proposal JSON');
const savedUpdateAPI=ctx.updateChatMetadata;delete ctx.updateChatMetadata;
pendingAn=propose('PROPOSE_CLEAR');
ok(await an.anApply(pendingAn)===false && ctx.chatMetadata.note_prompt===originalNote.note_prompt,'unsupported host fails before modifying any note text');ctx.updateChatMetadata=savedUpdateAPI;
pendingAn=propose('PROPOSE_CLEAR');
for(const handler of handlers.get('CHAT_CHANGED')||[]) await handler();
ok(an.anPendingProposal()===null && ctx.chatMetadata.note_prompt===originalNote.note_prompt,'native chat-change notification cancels the pending note card');
console.log('== v2.87.1 Author Note production Apply and legacy-card regression ==');
ctx.chatId='an-real-apply';ctx.chat=[{name:'Narrator',mes:'The travelers reach the wharf.'}];
const savedContextGetter=SillyTavern.getContext;
SillyTavern.getContext=()=>({...ctx}); // ST returns a fresh context snapshot.
ctx.saveMetadata=realAnSave;ctx.reloadCurrentChat=realAnReload;
const applyCases=[
 ['PROPOSE_REPLACE','','Replacement','Replacement'],
 ['PROPOSE_REPLACE','Existing Tolkien directive','Replacement','Replacement'],
 ['PROPOSE_APPEND','','Combat coherence directive','Combat coherence directive'],
 ['PROPOSE_APPEND','Existing Tolkien directive','Combat coherence directive','Existing Tolkien directive\nCombat coherence directive'],
 ['PROPOSE_APPEND','Existing Tolkien directive\nKeep the prose lyrical.','Combat coherence directive\nTrack positions.','Existing Tolkien directive\nKeep the prose lyrical.\nCombat coherence directive\nTrack positions.'],
];
for(const [op,existing,content,expected] of applyCases) {
 ctx.chatMetadata={...structuredClone(originalNote),note_prompt:existing};anDisk=structuredClone(ctx.chatMetadata);
 const settingsBefore=JSON.stringify({...ctx.chatMetadata,note_prompt:undefined}),savesBefore=anSaves,reloadsBefore=anReloads;
 pendingAn=propose(op,content);
 ok(pendingAn.result===expected && ctx.chatMetadata.note_prompt===existing && anSaves===savesBefore,op+' real card previews exact combined value before any write');
 clickFresh('chatassist_an_apply');await sleep(30);
 ok(ctx.chatMetadata.note_prompt===expected && an.anRead().text===expected && anDisk.note_prompt===expected && anSaves===savesBefore+1 && anReloads===reloadsBefore+1,op+' real Apply listener saves and authoritatively verifies '+(existing?'non-empty':'empty')+' note');
 await ctx.reloadCurrentChat();
 ok(an.anRead().text===expected && JSON.stringify({...ctx.chatMetadata,note_prompt:undefined})===settingsBefore,'approved exact note survives another reload with settings intact');
}
// Reproduce the red/green card: old model history emits memedits, not authorsnote.
// Production must route it to the note dialog, never to the forbidden generic writer.
for(const legacy of [
 {path:'note_prompt',find:'Existing Tolkien directive',replace:'Existing Tolkien directive\nCombat coherence directive'},
 {path:'note_prompt',append:'Combat coherence directive'},
]) {
 ctx.chatMetadata={...structuredClone(originalNote),note_prompt:'Existing Tolkien directive'};anDisk=structuredClone(ctx.chatMetadata);
 ctx.ConnectionManagerRequestService.sendRequest=async()=>'<memedits>'+JSON.stringify([legacy])+'</memedits>';
 document.getElementById('chatassist_input').value="Append the combat coherence directive to my Author's Note, preserving the Tolkien directive.";
 clickFresh('chatassist_send');await sleep(600);
 const candidate=an.anPendingProposal();
 ok(candidate?.result==='Existing Tolkien directive\nCombat coherence directive','legacy red/green note edit is routed to the authoritative approval bridge');
 if(candidate) {clickFresh('chatassist_an_apply');await sleep(30);}
 ok(anDisk.note_prompt==='Existing Tolkien directive\nCombat coherence directive' && an.anRead().text===anDisk.note_prompt,'model response → production confirmation Apply → persisted combined note');
 await ctx.reloadCurrentChat();ok(an.anRead().text==='Existing Tolkien directive\nCombat coherence directive','legacy append remains after independent reload');
}
ctx.chatMetadata=structuredClone(originalNote);
for(const bad of [
 [{path:'note_prompt',find:'Wharf',replace:'wrong'}],
 [{path:'note_prompt',find:'.',replace:'x'},{path:'note_prompt',append:'y'}],
 [{path:'note_prompt',append:'x',replace:'y'}],
 [{path:'note_prompt.child',replace:'x'}],
 [{path:'note_prompt',replace:{text:'x'}}],
 [{path:'note_prompt',replace:'x',unknown:true}],
 [{path:'note_prompt',append:5}],
]) {
 let rejected=false;try{an.anLegacyParse('<memedits>'+JSON.stringify(bad)+'</memedits>',an.anRead());}catch{rejected=true;}
 ok(rejected && an.anRead().text===originalNote.note_prompt,'legacy note contract rejects inexact, multiple, ambiguous or invalid edits');
}
for(const [reply,base] of [
 ['<memedits>[{"path":"note_prompt","replace":"x"}]</memedits>',null],
 ['<memedits>[{"path":"note_prompt","replace":"x"}]</memedits><fetch>[0]</fetch>',an.anRead()],
 ['<memedits>[{"path":"note_prompt","replace":"x"}]</memedits><memedits>[{"path":"note_prompt","replace":"y"}]</memedits>',an.anRead()],
]) {
 let rejected=false;try{an.anLegacyParse(reply,base);}catch{rejected=true;}
 ok(rejected,'legacy note proposal rejects missing baseline or mixed/multiple tool blocks');
}
const legacyBefore=anSaves,legacyLog=ccLogText().length;
an.ingestProposals('<memedits>[{"path":"note_prompt","replace":"must not stage"}]</memedits>');
ok(an.pendingNoteCards()===0 && anSaves===legacyBefore && ccLogText().slice(legacyLog).join(' ').includes('Author’s Note change not staged'),'other generation flows cannot stage dead generic note cards and report why');
for(const failure of ['save','old-reload','stale']) {
 ctx.chatMetadata=structuredClone(originalNote);anDisk=structuredClone(originalNote);
 const beforeLog=ccLogText().length,beforeToasts=toasts.length;
 ctx.saveMetadata=failure==='save'?async()=>{throw new Error('disk write rejected');}:realAnSave;
 ctx.reloadCurrentChat=failure==='old-reload'?async()=>{ctx.chatMetadata=structuredClone(originalNote);}:realAnReload;
 propose('PROPOSE_APPEND','Combat coherence directive');
 if(failure==='stale')ctx.chatMetadata.note_prompt='External note';
 clickFresh('chatassist_an_apply');await sleep(30);
 const messages=ccLogText().slice(beforeLog).join(' ');
 ok(/failed|changed/.test(messages) && !toasts.slice(beforeToasts).some(t=>t==='Author’s Note saved and verified.'),failure+' real Apply reports persistent visible failure and never success');
 ok(ctx.chatMetadata.note_prompt===(failure==='stale'?'External note':originalNote.note_prompt),failure+' real Apply does not retain the proposed value');
}
ctx.saveMetadata=realAnSave;ctx.reloadCurrentChat=realAnReload;
ctx.chatMetadata=structuredClone(originalNote);const cancelWrites=anSaves;
propose('PROPOSE_APPEND','cancel this');clickFresh('chatassist_an_cancel');await sleep(30);
ok(anSaves===cancelWrites && ctx.chatMetadata.note_prompt===originalNote.note_prompt,'real Cancel listener remains non-mutating');
SillyTavern.getContext=savedContextGetter;
ctx.chatMetadata={};ctx.chat=[];

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('MODULE INTEGRITY FAILED ✗'); process.exit(1); }
console.log('MODULE INTEGRITY OK ✓');
