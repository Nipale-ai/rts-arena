import { $, el, api, COLORS, header, drawMapThumb, startMatch } from './common.js';

const app = $('#app');
const st = await api('/api/state');
const CLASSES = ['16 GB', '32 GB', 'MAC 256 GB', '1 SPARK 128 GB', '2 SPARKS 256 GB', '4 SPARKS 512 GB'];
const creatorsById = Object.fromEntries(st.creators.map((c) => [c.id, c]));
const PRESET_URLS = [['llama.cpp', 'http://127.0.0.1:8080/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1'], ['Ollama', 'http://127.0.0.1:11434/v1'], ['vLLM', 'http://127.0.0.1:8000/v1']];

const input = (attrs = {}) => el('input', attrs);
const field = (label, node, hint) => el('label', {}, label, node, hint ? el('span', { class: 'hint' }, hint) : null);

// creator banner picker: logo + list. Valid for every kind of player. The AI never sees it (cosmetic: banners in the match, name in the HUD).
function creatorPicker() {
  const sel = el('select', {}, el('option', { value: '' }, 'No banner'), [...st.creators].sort((a, b) => a.name.localeCompare(b.name)).map((c) => el('option', { value: c.id }, c.name)));
  const logo = el('img', { class: 'clogo', alt: '', width: 40, height: 40 });
  const swatch = el('span', { class: 'cswatch' });
  const show = () => {
    const c = creatorsById[sel.value];
    logo.style.display = c ? '' : 'none'; swatch.style.display = c ? '' : 'none';
    if (c) { logo.src = '/' + c.logo; swatch.style.background = `linear-gradient(90deg, ${c.primary} 50%, ${c.secondary} 50%)`; }
  };
  sel.addEventListener('change', show);
  show();
  return {
    node: el('div', { class: 'creator-pick' }, el('div', { style: 'flex:1' }, field('Recipe by (banner)', sel, 'The creator whose recipe this AI runs. Their flag flies over the base and their name is on screen. The AI never sees it.')), logo, swatch),
    get: () => sel.value, set: (v) => { sel.value = creatorsById[v] ? v : ''; show(); },
  };
}

function slot(n) {
  const color = COLORS[n % 4];
  let type = 'bot';
  const body = el('div', {});
  const team = el('select', {}, [1, 2, 3, 4].map((t) => el('option', { value: t }, `Team ${t}`)));
  team.value = String(n < 2 ? n + 1 : n === 2 ? 1 : 2);
  const seg = el('div', { class: 'seg' });
  const types = [['bot', 'Built-in bot'], ['llm', 'My LLM'], ['mock', 'Test model']];
  const parts = {};
  const creator = creatorPicker();

  // built-in bot
  const bot = el('select', {}, st.bots.map((b) => el('option', { value: b }, b)));
  bot.value = st.bots[n % st.bots.length];
  parts.bot = { node: el('div', { class: 'row w2' }, field('Strategy', bot), field('Info', el('div', { class: 'dim', style: 'padding:9px 0;font-size:13px;text-transform:none;letter-spacing:0;font-weight:400' }, 'Rule-based player, no model needed'))), get: () => ({ bot: bot.value }) };

  // test model
  const mStrat = el('select', {}, st.bots.map((b) => el('option', { value: b }, b)));
  const mDelay = input({ type: 'number', value: 150, min: 0, max: 5000, step: 50 });
  parts.mock = { node: el('div', {}, el('div', { class: 'row w2' }, field('Plays like', mStrat), field('Answer delay (ms)', mDelay)), el('p', { class: 'hint' }, 'A fake model server that answers with scripted moves. Tests the whole pipeline without a GPU.')), get: () => ({ strategy: mStrat.value, delay_ms: +mDelay.value }) };

  // my LLM: URL, key, test, model. Everything else is optional and folded away.
  const saved = el('select', {}, el('option', { value: '' }, '- new endpoint -'), st.players.map((p) => el('option', { value: p.id }, `${p.name} (${p.model})`)));
  const base = input({ class: 'mono', placeholder: 'http://127.0.0.1:8080/v1', autocomplete: 'off', spellcheck: 'false' });
  const modelList = el('datalist', { id: `models-${n}` });
  const model = input({ class: 'mono', placeholder: 'model id (press Test connection to list them)', autocomplete: 'off', spellcheck: 'false', list: modelList.id });
  const key = input({ type: 'password', class: 'mono', placeholder: 'API key (optional)', autocomplete: 'new-password' });
  const name = input({ placeholder: 'defaults to the model id' });
  const hw = input({ placeholder: 'e.g. RTX 5090 32 GB' });
  const temp = input({ type: 'number', step: '0.05', value: 0.6, min: 0, max: 2 });
  const topp = input({ type: 'number', step: '0.01', value: 0.95, min: 0, max: 1 });
  const topk = input({ type: 'number', step: '1', placeholder: 'off', min: 0 });
  const seed = input({ type: 'number', step: '1', value: 42 });
  const maxTok = input({ type: 'number', step: '256', value: 2048, min: 16 });
  const timeout = input({ type: 'number', step: '10', value: 120, min: 5 });
  const think = el('input', { type: 'checkbox' });
  const cls = el('select', {}, el('option', { value: '' }, '- none -'), CLASSES.map((c) => el('option', { value: c }, c)));
  const extra = el('textarea', { rows: 3, placeholder: '{"chat_template_kwargs": {"enable_thinking": false}}', spellcheck: 'false' });
  const testOut = el('span', { class: 'res' });
  const chips = el('div', { class: 'chips' });
  const showModels = (ids) => {
    modelList.replaceChildren(...ids.map((i) => el('option', { value: i })));
    chips.replaceChildren(...ids.slice(0, 12).map((i) => el('button', { type: 'button', class: 'chip', onclick: () => { model.value = i; } }, i)));
  };
  const testBtn = el('button', { class: 'btn small', type: 'button', onclick: async () => {
    if (!base.value.trim()) { testOut.className = 'res bad'; testOut.textContent = 'Enter the base URL first (or pick a server above).'; return; }
    testBtn.disabled = true; testOut.className = 'res'; testOut.textContent = 'testing ...'; chips.replaceChildren();
    try {
      const r = await api('/api/test', { base_url: base.value, model: model.value, api_key: key.value, player_id: saved.value, timeout_s: +timeout.value });
      if (r.models?.length) {
        showModels(r.models);
        if (!model.value.trim() && r.models.length === 1) model.value = r.models[0];
      }
      const bits = [];
      if (r.models_ms != null) bits.push(r.models ? `${r.models.length} model${r.models.length === 1 ? '' : 's'} found (${r.models_ms} ms)` : `server answered (${r.models_ms} ms)`);
      if (r.completion_ms != null) bits.push(r.ok ? `model answered in ${r.completion_ms} ms` : `model request failed (HTTP ${r.completion_status})`);
      let msg;
      if (r.ok && !model.value.trim()) msg = 'Connected. Pick a model below.';
      else if (r.ok && r.model_listed === false) msg = 'Connected, but this model id is not in the server list. Check the spelling.';
      else if (r.ok) msg = 'Connected. Ready to play.';
      else msg = 'Not working: ' + (r.error || 'no answer');
      testOut.className = 'res ' + (r.ok ? (r.model_listed === false ? '' : 'ok') : 'bad');
      testOut.textContent = msg + (bits.length ? '  |  ' + bits.join(' | ') : '');
      if (r.ok && r.model_listed === false) testOut.style.color = 'var(--warn)'; else testOut.style.color = '';
    } catch (e) { testOut.className = 'res bad'; testOut.textContent = e.message; }
    testBtn.disabled = false;
  } }, 'Test connection');
  let playerId = '';
  saved.addEventListener('change', () => {
    const p = st.players.find((x) => x.id === saved.value);
    playerId = p ? p.id : '';
    if (!p) return;
    name.value = p.name; base.value = p.base_url; model.value = p.model; hw.value = p.hardware || ''; cls.value = p.class || '';
    temp.value = p.sampling?.temperature ?? ''; topp.value = p.sampling?.top_p ?? ''; topk.value = p.sampling?.top_k ?? ''; seed.value = p.sampling?.seed ?? '';
    maxTok.value = p.max_tokens; timeout.value = p.timeout_s; think.checked = !!p.thinking; creator.set(p.creator);
    extra.value = p.extra_body ? JSON.stringify(p.extra_body) : '';
    key.value = ''; key.placeholder = p.has_key ? `${p.key_hint} stored (leave empty to keep)` : 'API key (optional)';
  });
  const urlChips = el('div', { class: 'chips' }, el('span', { class: 'dim', style: 'font-size:12px' }, 'Common servers:'), PRESET_URLS.map(([l, u]) => el('button', { type: 'button', class: 'chip', onclick: () => { base.value = u; } }, l)));
  parts.llm = {
    node: el('div', {},
      st.players.length ? el('div', { class: 'row' }, field('Saved endpoint', saved)) : null,
      el('div', { class: 'row w2' }, field('Server URL', base, 'Any OpenAI-compatible server. Usually ends in /v1.'), field('API key', key, 'Optional. Stored only on this machine, sent only to this URL.')),
      urlChips,
      el('div', { class: 'test' }, testBtn, testOut),
      el('div', { class: 'row', style: 'margin-top:10px' }, field('Model', el('div', {}, model, modelList), 'The id the server expects.')),
      chips,
      el('div', { class: 'row w2' }, field('Name on screen', name), field('Hardware label on screen', hw)),
      el('details', {}, el('summary', {}, 'Settings from the model card (optional)'),
        el('div', { class: 'row' }, field('Temperature', temp), field('Top-p', topp), field('Top-k', topk), field('Seed', seed)),
        el('div', { class: 'row' }, field('Max tokens / reply', maxTok), field('Timeout (s)', timeout), field('Class label', cls), el('label', { class: 'chk' }, think, 'Thinking on')),
        field('Extra request body (JSON, merged into every request)', extra))),
    get: () => {
      let extra_body;
      if (extra.value.trim()) { try { extra_body = JSON.parse(extra.value); } catch { throw new Error(`Player ${n + 1}: the extra request body is not valid JSON`); } }
      if (!base.value.trim()) throw new Error(`Player ${n + 1}: enter the server URL (or choose another player type)`);
      if (!model.value.trim()) throw new Error(`Player ${n + 1}: enter the model id (Test connection lists them)`);
      return { player_id: playerId || undefined, name: name.value, base_url: base.value, model: model.value, api_key: key.value, hardware: hw.value, class: cls.value,
        thinking: think.checked, max_tokens: +maxTok.value, timeout_s: +timeout.value, extra_body,
        sampling: { temperature: temp.value, top_p: topp.value, top_k: topk.value, seed: seed.value } };
    },
  };

  const show = () => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === type));
    body.replaceChildren(parts[type].node);
  };
  for (const [t, label] of types) seg.append(el('button', { type: 'button', 'data-t': t, onclick: () => { type = t; show(); } }, label));
  show();
  const node = el('section', { class: 'slot', style: `--c:${color}` },
    el('h3', {}, el('span', { class: 'n' }, n + 1), `Player ${n + 1}`, el('span', { style: 'margin-left:auto;width:120px' }, team)),
    seg, body, creator.node);
  return { node, get: () => ({ type, team: +team.value, creator: creator.get(), ...parts[type].get() }) };
}

// ---- players ----
let count = 2, mapPlayers = null; // mapPlayers: forced player count of a custom map
const slots = [slot(0), slot(1), slot(2), slot(3)];
const slotBox = el('div', { class: 'slots' });
const countSeg = el('div', { class: 'seg' }, [2, 4].map((c) => el('button', { type: 'button', 'data-c': c, onclick: () => { if (!mapPlayers) { count = c; drawSlots(); } } }, `${c} players`)));
function drawSlots() {
  slotBox.replaceChildren(...slots.slice(0, count).map((s) => s.node));
  countSeg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', +b.dataset.c === count); b.disabled = !!mapPlayers && +b.dataset.c !== count; });
}
drawSlots();

// ---- map: generated (seed) or one of my maps from the editor ----
const seed = input({ type: 'number', value: Math.floor(Math.random() * 99999), min: 0 });
const mapType = el('select', {}, st.map_types.map((m) => el('option', { value: m.id }, m.label)));
const size = el('select', {}, el('option', { value: '' }, 'preset default'), st.map_types[0].sizes.map((s) => el('option', { value: s }, `${s} x ${s} tiles`)));
let mapMode = 'gen', maps = st.maps || [];
const mapSel = el('select', { onchange: () => pickMap(mapSel.value) });
const thumb = el('canvas', { class: 'thumb', width: 160, height: 160 });
const mapInfo = el('div', { class: 'dim', style: 'font-size:13px' });
const editLink = el('a', { class: 'btn small', href: '/editor/' }, 'Edit in editor');
const mapSeg = el('div', { class: 'seg' },
  el('button', { type: 'button', 'data-m': 'gen', onclick: () => setMapMode('gen') }, 'Generated map'),
  el('button', { type: 'button', 'data-m': 'custom', onclick: () => setMapMode('custom') }, `My maps (${maps.length})`));
const genBox = el('div', { class: 'row' }, field('Seed', seed, 'Same seed, same map. Both sides are mirrored.'), field('Map type', mapType), field('Size', size));
const customBox = el('div', {});
function renderCustomBox() {
  customBox.replaceChildren(maps.length
    ? el('div', { class: 'mapchoice' }, thumb, el('div', { style: 'display:grid;gap:10px;align-content:start;flex:1;min-width:220px' }, field('Choose a map', mapSel), mapInfo, el('div', { style: 'display:flex;gap:8px' }, editLink, el('a', { class: 'btn small', href: '/editor/' }, 'Open editor'))))
    : el('div', { class: 'empty' }, 'No maps yet. ', el('a', { href: '/editor/' }, 'Build one in the world editor'), ' (generate a fair one in two clicks).'));
}
async function pickMap(id) {
  if (!id) return;
  mapSel.value = id;
  try {
    const { map } = await api('/api/maps/' + id);
    drawMapThumb(thumb, map);
    mapPlayers = map.players.length; count = mapPlayers;
    const meta = maps.find((m) => m.id === id);
    mapInfo.textContent = `${map.size} x ${map.size} tiles | ${map.players.length} players${meta?.symmetry ? ' | symmetric (' + meta.symmetry + ')' : ''} | ${(map.nodes || []).length} resource nodes`;
    editLink.href = '/editor/?map=' + id;
    drawSlots();
  } catch (e) { mapInfo.textContent = e.message; }
}
function setMapMode(m) {
  mapMode = m;
  mapSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  genBox.style.display = m === 'gen' ? '' : 'none';
  customBox.style.display = m === 'custom' ? '' : 'none';
  if (m === 'gen') { mapPlayers = null; drawSlots(); } else { renderCustomBox(); if (maps.length) { mapSel.replaceChildren(...maps.map((x) => el('option', { value: x.id }, `${x.name} (${x.size}x${x.size}, ${x.players}p)`))); pickMap(mapSel.value || maps[0].id); } }
}

const preset = el('select', {}, el('option', { value: '' }, 'auto (fast for LLM matches)'), el('option', { value: 'fast' }, 'fast: 6 workers + scout + house, 96 map, treasure, 30 min'), el('option', { value: 'classic' }, 'classic: 5 workers, 128 map, 60 min'));
const worldType = el('select', {}, ['', 'meadow', 'forest', 'desert', 'winter', 'coast'].map((v) => el('option', { value: v }, v ? { meadow: 'Meadow (classic look)', forest: 'Forest: dense woods, fewer open fields', desert: 'Desert: sand, palms, little wood', winter: 'Winter: snow, frozen ponds', coast: 'Coast: a big bay, harbors and ships' }[v] : 'preset default (meadow)')));
const worldWx = el('select', {}, [['', 'preset default'], ['off', 'no weather'], ['auto', 'weather from the seed'], ['rain', 'always rain'], ['snow', 'always snow'], ['fog', 'always fog'], ['storm', 'always storm']].map(([v, t]) => el('option', { value: v }, t)));
const worldCar = el('select', {}, [['', 'preset default'], ['on', 'caravans on'], ['off', 'caravans off']].map(([v, t]) => el('option', { value: v }, t)));
const limit = input({ type: 'number', placeholder: 'preset default', min: 1, max: st.time_limit_min, step: 1 });
const speed = el('select', {}, [1, 2, 4, 8].map((x) => el('option', { value: x }, `${x}x`)));
const mname = input({ placeholder: 'optional, defaults to "A vs B"' });
const err = el('div', { class: 'err' });
const play = el('button', { class: 'btn primary big', type: 'button', onclick: async () => {
  err.textContent = '';
  play.disabled = true;
  try {
    const players = slots.slice(0, count).map((s) => s.get());
    const map = mapMode === 'custom' ? { type: 'custom', id: mapSel.value } : { type: mapType.value, size: size.value ? +size.value : undefined };
    if (mapMode === 'custom' && !mapSel.value) throw new Error('Choose a map or switch to "Generated map"');
    await startMatch({ name: mname.value, seed: +seed.value, map, rules: { preset: preset.value || undefined, map_type: worldType.value || undefined, weather: worldWx.value || undefined, caravans: worldCar.value ? worldCar.value === 'on' : undefined, time_limit_min: limit.value ? +limit.value : undefined, speed: +speed.value }, players });
  } catch (e) { err.textContent = e.message; play.disabled = false; }
} }, 'Play');

app.append(header(), el('h1', {}, 'New match'), el('p', { class: 'sub' }, 'Pick the players, the map and the rules. Matches run on this machine; you can start several at once.'),
  el('h2', {}, 'Map'), el('section', { class: 'panel' }, mapSeg, genBox, customBox),
  el('h2', {}, 'Players'), countSeg, slotBox,
  el('h2', {}, 'Rules'), el('section', { class: 'panel' }, el('div', { class: 'row' }, field('Rules preset', preset, 'Fast is meant for LLMs: they decide only a few times a minute'), field('Time limit (game minutes)', limit, 'After that the score decides'), field('Start speed', speed), field('Match name', mname)), el('div', { class: 'row' }, field('Map type', worldType, 'Look and resources of a generated map. Coast adds harbors and ships.'), field('Weather', worldWx, 'Small effects, the same for both sides'), field('Caravans', worldCar, 'Neutral traders: escort them or raid them for gold'))),
  el('div', { class: 'playbar' }, err, play));

// ?map=<id> (from the editor) opens the matching map
const wanted = new URLSearchParams(location.search).get('map');
if (wanted && maps.some((m) => m.id === wanted)) { setMapMode('custom'); await pickMap(wanted); } else setMapMode('gen');
