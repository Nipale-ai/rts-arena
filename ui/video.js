// "Make video" dialog: options -> progress -> result (player + download). Shared by the lobby and the replay page.
// Plain DOM, no dependencies. All text English. Talks to /api/matches/<id>/video and /api/settings/video.
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
async function call(path, body) {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.data = j; throw e; }
  return j;
}
if (!document.querySelector('link[href="/ui/video.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/video.css' }));
const fmtEta = (s) => (s == null ? '' : s < 90 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s left` : `about ${Math.round(s / 60)} min left`);
const FORMATS = [['yt', 'YouTube 16:9'], ['x', 'X 4:5'], ['both', 'Both']];
const LENGTHS = [['highlight', 'Highlight (1-2 min)'], ['story5', 'Story (5 min)'], ['full', 'Full match']];
const STAGES = { check: 'Checking', script: 'Writing the script', voices: 'Recording voices', render: 'Rendering', finish: 'Finishing', done: 'Done', queued: 'Waiting' };

export function openVideoDialog(matchId, { title = 'Make video', onChange = () => {} } = {}) {
  const back = el('div', { class: 'vd-back' });
  const box = el('div', { class: 'vd', role: 'dialog', 'aria-label': 'Make video' });
  back.append(box);
  document.body.append(back);
  let justCancelled = false; // this dialog just cancelled the job: show "Cancelled" instead of the form
  let timer = null, closed = false, opts = { format: 'yt', length: 'highlight', voices: 'on', llm: 'template' };
  const fill = (...kids) => box.replaceChildren(...kids.flat().filter((x) => x != null && x !== false)); // replaceChildren would print "null"
  const close = () => { closed = true; clearInterval(timer); back.remove(); onChange(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(e) { if (closed) return document.removeEventListener('keydown', esc); if (e.key === 'Escape') close(); });

  const seg = (list, key) => {
    const wrap = el('div', { class: 'vseg' });
    for (const [v, label] of list) wrap.append(el('button', { type: 'button', class: opts[key] === v ? 'on' : '', onclick: () => { opts[key] = v; [...wrap.children].forEach((b) => b.classList.toggle('on', b === wrap.querySelector(`[data-v="${v}"]`))); } , 'data-v': v }, label));
    return wrap;
  };

  async function showForm(err) {
    clearInterval(timer);
    let players = [], settings = null, tts = null;
    try { [settings, players] = await Promise.all([call('/api/settings/video'), call('/api/state').then((s) => s.players)]); } catch (e) { err = err || e.message; }
    if (settings) {
      const l = settings.script_llm;
      opts.llm = l.mode === 'player' && players.some((p) => p.id === l.player_id) ? 'p:' + l.player_id : l.mode === 'custom' ? 'custom' : 'template';
      opts.voices = settings.tts.voices_default === false ? 'off' : 'on';
    }
    const llmSel = el('select', { onchange: () => { opts.llm = llmSel.value; } },
      el('option', { value: 'template' }, 'Built-in template (no LLM needed)'),
      settings?.script_llm.mode === 'custom' ? el('option', { value: 'custom' }, `Settings: ${settings.script_llm.model}`) : null,
      players.map((p) => el('option', { value: 'p:' + p.id }, `${p.name} (${p.model})`)));
    llmSel.value = opts.llm;
    const voiceChk = el('input', { type: 'checkbox', onchange: () => { opts.voices = voiceChk.checked ? 'on' : 'off'; } });
    voiceChk.checked = opts.voices === 'on';
    const ttsHint = el('p', { class: 'vhint' }, 'Checking the voice server ...');
    call('/api/settings/video/test-tts', {}).then((r) => {
      const refs = Object.values(r.voice_references || {}).filter((x) => x !== 'ok');
      ttsHint.textContent = r.ok && !refs.length ? 'Voice server found.' : r.ok ? 'Voice server found, but a voice reference is missing (see Settings).' : 'No voice server found: the video will have captions only.';
      ttsHint.className = 'vhint' + (r.ok && !refs.length ? '' : ' bad');
    }).catch(() => { ttsHint.textContent = ''; });
    const go = el('button', { class: 'vbtn primary', type: 'button', onclick: async () => {
      go.disabled = true;
      const llm = opts.llm === 'template' ? 'template' : opts.llm === 'custom' ? undefined : { player_id: opts.llm.slice(2) };
      try { await call(`/api/matches/${matchId}/video`, { format: opts.format, length: opts.length, voices: opts.voices, ...(llm === undefined ? {} : { llm }) }); onChange(); poll(); }
      catch (e) { go.disabled = false; showForm(e.message); }
    } }, 'Make video');
    fill(el('h3', {}, title), el('p', { class: 'vsub' }, 'Script, voices, camera and sound are made after the match. This takes a few minutes.'),
      err ? el('div', { class: 'verr' }, err) : null,
      el('label', {}, 'Format', seg(FORMATS, 'format')), el('label', {}, 'Length', seg(LENGTHS, 'length')),
      el('label', {}, 'Script written by', llmSel),
      el('label', { class: 'vchk' }, voiceChk, 'Voices'), ttsHint,
      el('div', { class: 'vrow' }, el('a', { class: 'vbtn', href: '/settings', style: 'margin-right:auto' }, 'Settings'), el('button', { class: 'vbtn', type: 'button', onclick: close }, 'Close'), go));
  }

  function showProgress(job) {
    const active = job.status === 'queued' || job.status === 'running';
    const log = el('div', { class: 'vlog' }, (job.log || []).join('\n') || '(no output yet)');
    fill(el('h3', {}, active ? 'Making your video' : title),
      el('div', { class: 'vstage' }, el('span', {}, job.status === 'queued' ? (job.queue_position > 1 ? `In the queue (${job.queue_position})` : 'Waiting for its turn') : STAGES[job.stage] || job.stage), el('span', {}, `${job.percent}%${job.eta_s != null ? ' · ' + fmtEta(job.eta_s) : ''}`)),
      el('div', { class: 'vbar' }, el('i', { style: `width:${job.percent}%` })),
      el('p', { class: 'vhint' }, job.message || ''),
      (job.warnings || []).map((w) => el('div', { class: 'vwarn' }, w)),
      el('details', {}, el('summary', {}, 'Details'), log),
      el('div', { class: 'vrow' }, el('button', { class: 'vbtn', type: 'button', onclick: close }, 'Close (keeps running)'),
        el('button', { class: 'vbtn danger', type: 'button', onclick: async () => { justCancelled = true; await call(`/api/matches/${matchId}/video/cancel`, {}).catch(() => {}); poll(); } }, 'Cancel')));
    log.scrollTop = log.scrollHeight;
  }

  function showDone(job) {
    const vids = job.outputs.filter((o) => o.kind === 'video');
    let cur = vids[0];
    const player = el('video', { controls: true, preload: 'metadata', src: cur.url, playsinline: true });
    const files = el('div', { class: 'vfiles' });
    const pick = el('div', { class: 'vpick' });
    const renderFiles = () => {
      files.replaceChildren(...job.outputs.map((o) => el('a', { class: 'vbtn' + (o === cur ? ' primary' : ''), href: o.url + '?download=1', download: o.file }, `Download ${o.label}`)));
      [...pick.children].forEach((b, i) => b.classList.toggle('on', vids[i] === cur));
    };
    if (vids.length > 1) vids.forEach((v) => pick.append(el('button', { type: 'button', onclick: () => { cur = v; player.src = v.url; renderFiles(); } }, v.label)));
    renderFiles();
    fill(el('h3', {}, 'Your video is ready'), vids.length > 1 ? pick : null, player,
      (job.warnings || []).map((w) => el('div', { class: 'vwarn' }, w)), files,
      el('div', { class: 'vrow' }, el('button', { class: 'vbtn', type: 'button', onclick: () => showForm() }, 'Make another'), el('button', { class: 'vbtn primary', type: 'button', onclick: close }, 'Close')));
  }

  function showFailed(job) {
    fill(el('h3', {}, job.status === 'cancelled' ? 'Cancelled' : 'The video could not be made'),
      job.error ? el('div', { class: 'verr' }, job.error) : null, (job.warnings || []).map((w) => el('div', { class: 'vwarn' }, w)),
      el('details', {}, el('summary', {}, 'Details'), el('div', { class: 'vlog' }, (job.log || []).join('\n') || '(no output)')),
      el('div', { class: 'vrow' }, el('button', { class: 'vbtn', type: 'button', onclick: close }, 'Close'), el('button', { class: 'vbtn primary', type: 'button', onclick: () => showForm() }, 'Try again')));
  }

  async function poll() {
    clearInterval(timer);
    let r;
    try { r = await call(`/api/matches/${matchId}/video`); } catch (e) { return showForm(e.message); }
    const job = r.job;
    const draw = (j) => (j.status === 'done' ? showDone(j) : j.status === 'failed' || j.status === 'cancelled' ? showFailed(j) : showProgress(j));
    if (!job || (job.status === 'cancelled' && !justCancelled)) return showForm();
    // a finished earlier video is shown when the dialog opens; "Make another" leads to the form
    draw(job);
    if (job.status === 'queued' || job.status === 'running') {
      timer = setInterval(async () => {
        if (closed) return clearInterval(timer);
        try { const x = (await call(`/api/matches/${matchId}/video`)).job; if (x) { draw(x); if (x.status !== 'queued' && x.status !== 'running') { clearInterval(timer); onChange(); } } } catch { /* retry on the next tick */ }
      }, 1500);
    }
  }
  poll();
  return { close };
}
