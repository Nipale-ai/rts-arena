// Settings: where the "Make video" button gets its script LLM and its voices.
import { $, el, api, header } from './common.js';

const app = $('#app');
const [cfg, st] = await Promise.all([api('/api/settings/video'), api('/api/state')]);
const field = (label, node, hint) => el('label', {}, label, node, hint ? el('span', { class: 'hint' }, hint) : null);
const input = (a = {}) => el('input', a);

// ---- script LLM
const mode = el('select', {}, el('option', { value: 'template' }, 'Built-in template (no LLM, always works)'), el('option', { value: 'player' }, 'One of my saved LLM players'), el('option', { value: 'custom' }, 'Another OpenAI-compatible server'));
mode.value = cfg.script_llm.mode;
const player = el('select', {}, st.players.map((p) => el('option', { value: p.id }, `${p.name} (${p.model})`)));
if (cfg.script_llm.player_id) player.value = cfg.script_llm.player_id;
const base = input({ class: 'mono', placeholder: 'http://127.0.0.1:8080/v1', value: cfg.script_llm.base_url, autocomplete: 'off', spellcheck: 'false' });
const model = input({ class: 'mono', placeholder: 'model id', value: cfg.script_llm.model, autocomplete: 'off', spellcheck: 'false' });
const lkey = input({ type: 'password', class: 'mono', placeholder: cfg.script_llm.has_key ? `saved key ${cfg.script_llm.key_hint} (leave empty to keep)` : 'API key (optional)', autocomplete: 'new-password' });
const llmOut = el('span', { class: 'res' });
const pPlayer = el('div', { class: 'row w2' }, field('Saved player', player, 'Its server, model and key are used. The key never leaves your machine except to that server.'));
const pCustom = el('div', {}, el('div', { class: 'row w2' }, field('Server URL', base), field('Model id', model)), el('div', { class: 'row w2' }, field('API key', lkey)));
const showMode = () => { pPlayer.style.display = mode.value === 'player' ? '' : 'none'; pCustom.style.display = mode.value === 'custom' ? '' : 'none'; };
mode.addEventListener('change', showMode); showMode();
const testLlm = el('button', { class: 'btn small', type: 'button', onclick: async () => {
  llmOut.className = 'res'; llmOut.textContent = 'testing ...';
  try {
    const pl = mode.value === 'player' ? st.players.find((p) => p.id === player.value) : null;
    if (mode.value === 'template') { llmOut.className = 'res ok'; llmOut.textContent = 'Nothing to test: the template needs no server.'; return; }
    const r = await api('/api/test', pl ? { player_id: pl.id, base_url: pl.base_url, model: pl.model } : { base_url: base.value, model: model.value, api_key: lkey.value });
    llmOut.className = 'res ' + (r.ok ? 'ok' : 'bad'); llmOut.textContent = r.ok ? `OK${r.completion_ms ? ` (${r.completion_ms} ms)` : ''}` : r.error || 'failed';
  } catch (e) { llmOut.className = 'res bad'; llmOut.textContent = e.message; }
} }, 'Test connection');

// ---- voices
const turl = input({ class: 'mono', placeholder: cfg.default_tts_url, value: cfg.tts.url, autocomplete: 'off', spellcheck: 'false' });
const tkey = input({ type: 'password', class: 'mono', placeholder: cfg.tts.has_key ? `saved key ${cfg.tts.key_hint} (leave empty to keep)` : 'API key (optional)', autocomplete: 'new-password' });
const vdef = el('input', { type: 'checkbox' }); vdef.checked = cfg.tts.voices_default !== false;
const vdirs = {};
for (const [n, label] of [['caster_a', 'Dex Harlan (play-by-play), caster_a'], ['caster_b', 'Juno Quill (analyst), caster_b']]) vdirs[n] = field(`Voice reference: ${label}`, input({ class: 'mono', placeholder: cfg.default_voice_dirs[n] || 'folder with referenz.wav and transkript.txt', value: cfg.tts.voices[n] || '', autocomplete: 'off', spellcheck: 'false' }), 'A folder with referenz.wav and transkript.txt. Empty = the default shown, if there is one (env RTS_VOICES_DIR); without a folder the video has captions only.');
const ttsOut = el('span', { class: 'res' });
const testTts = el('button', { class: 'btn small', type: 'button', onclick: async () => {
  ttsOut.className = 'res'; ttsOut.textContent = 'testing ...';
  try {
    const voices = Object.fromEntries(Object.entries(vdirs).map(([n, f]) => [n, f.querySelector('input').value.trim()]).filter(([, v]) => v));
    const r = await api('/api/settings/video/test-tts', { url: turl.value.trim(), voices });
    const bad = Object.entries(r.voice_references).filter(([, v]) => v !== 'ok');
    ttsOut.className = 'res ' + (r.ok && !bad.length ? 'ok' : 'bad');
    ttsOut.textContent = (r.ok ? 'Server found. ' : r.error + '. ') + (bad.length ? bad.map(([n, v]) => `${n}: ${v}`).join(' | ') : 'Voice references found.');
  } catch (e) { ttsOut.className = 'res bad'; ttsOut.textContent = e.message; }
} }, 'Test server');

const workers = input({ type: 'number', min: 1, max: 32, step: 1, value: cfg.render?.workers ?? 8 });
const saveOut = el('span', { class: 'res' });
const save = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
  saveOut.className = 'res'; saveOut.textContent = 'saving ...';
  try {
    const voices = Object.fromEntries(Object.entries(vdirs).map(([n, f]) => [n, f.querySelector('input').value.trim()]));
    await api('/api/settings/video', { script_llm: { mode: mode.value, player_id: player.value, base_url: base.value, model: model.value, api_key: lkey.value }, render: { workers: +workers.value || 8 }, tts: { url: turl.value, api_key: tkey.value, voices_default: vdef.checked, voices } });
    saveOut.className = 'res ok'; saveOut.textContent = 'Saved.'; lkey.value = ''; tkey.value = '';
  } catch (e) { saveOut.className = 'res bad'; saveOut.textContent = e.message; }
} }, 'Save');

app.append(header(), el('h1', {}, 'Settings'),
  el('p', { class: 'sub' }, 'The "Make video" button on finished matches uses these. Nothing runs live: the script and the voices are made after the match.'),
  el('h2', {}, 'Script writer'),
  el('div', { class: 'panel' }, field('Who writes the commentary script', mode, 'The facts come from the match log and every line is checked against them. If the LLM is down or fails, the built-in template writes the script instead.'), pPlayer, pCustom, el('div', { class: 'test' }, testLlm, llmOut)),
  el('h2', {}, 'Voices (text to speech)'),
  el('div', { class: 'panel' }, el('div', { class: 'row w2' }, field('TTS server URL (Fish Audio Drama 3)', turl, 'Without a reachable server the video is made with captions only.'), field('API key', tkey)),
    el('div', { class: 'row w2' }, vdirs.caster_a, vdirs.caster_b), el('label', { class: 'chk' }, vdef, 'Voices on by default'), el('div', { class: 'test' }, testTts, ttsOut)),
  el('h2', {}, 'Rendering'),
  el('div', { class: 'panel' }, el('div', { class: 'row w2' }, field('Parallel render workers (story cut)', workers, 'Each worker is its own headless Chrome. 8 is about 7 times faster than 1 on a big Mac; use fewer on a small machine. Highlight and full cuts render in one process.'))),
  el('div', { class: 'playbar' }, el('span', { class: 'dim' }, 'Keys are stored on this machine only and are never shown again.'), el('div', { class: 'test' }, saveOut, save)));
