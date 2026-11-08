// Live spectator sound (WebAudio). Starts only after a user click (browser autoplay rules). All sound is derived from the
// snapshot stream by render/audio-core.mjs; nothing here talks to the sim. Positional: distance gain, low-pass and pan from the camera.
import { SoundDirector, shape, limitHoofs, VoiceBook, Tension, musicWeights, ambientWeights, minPriorityForSpeed, hash32, musicSequence, MUSIC_XF, thunderCue, thunderDelay, isDeathCue, packOf, CLASSIC_PACK, VariantPicker, FireControl, fireClass, carpetWeight, carpetId, CARPET_GAIN } from './audio-core.mjs';
import { pruneEvents } from './theme/sound-theme.mjs'; // theme: the files of a theme that are not there are left out, the event goes back to its classic clip

const dbToGain = (d) => Math.pow(10, d / 20);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KEY = 'rts-audio-v1';

export class AudioEngine {
  constructor({ base = 'assets/audio/' } = {}) {
    this.classicBase = base; this.base = base; this.pack = CLASSIC_PACK; this.picker = new VariantPicker(); this.fire = new FireControl(); this.fireOffered = 0; this.fireRate = 0; this.ctx = null; this.man = null; this.bufs = new Map(); this.loading = new Map();
    this.vol = { master: 0.8, music: 0.6, sfx: 0.9, ambient: 0.7, alerts: 0.8 }; this.muted = false;
    try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) { Object.assign(this.vol, s.vol || {}); this.muted = !!s.muted; } } catch { /* storage may be blocked */ }
    this.book = new VoiceBook({ maxVoices: 24, groupMax: 8 }); this.tension = new Tension(); this.dir = null; this.init = null;
    this.view = { x: 48, y: 48, ref: 1, rx: 1, ry: 0 }; this.loops = new Map(); this.layers = new Map(); this.deaths = []; this.fightNear = 0; this.maxTier = 1; this.speed = 1; this.state = 'off'; this.played = {}; this.listeners = new Set(); this.lastSnapT = 0;
    this.classic = {}; this.themed = new Set(); this.failed = new Set(); this.fileClass = new Map(); // theme: the classic entries that a theme event replaced, the ids of the theme events, the theme files that could not be loaded, theme file -> 'music/' | 'ambient/' | ''
  }
  on(fn) { this.listeners.add(fn); } emit() { for (const f of this.listeners) f(this.status()); }
  status() { return { state: this.state, muted: this.muted, vol: { ...this.vol } }; }
  save() { try { localStorage.setItem(KEY, JSON.stringify({ vol: this.vol, muted: this.muted })); } catch { /* ignore */ } }

  // call from a click / key handler
  async unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); this.state = 'on'; this.emit(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { this.state = 'unsupported'; this.emit(); return; }
    this.ctx = new AC({ latencyHint: 'interactive' }); const c = this.ctx;
    this.master = c.createGain(); this.comp = c.createDynamicsCompressor(); // soft safety limiter: a big battle must not clip
    this.comp.threshold.value = -14; this.comp.knee.value = 12; this.comp.ratio.value = 6; this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
    this.master.connect(this.comp); this.comp.connect(c.destination);
    this.bus = {}; for (const b of ['sfx', 'alerts', 'ambient', 'music']) { this.bus[b] = c.createGain(); this.bus[b].connect(this.master); }
    this.applyVolumes(true);
    this.state = 'loading'; this.emit();
    this.man = await (await fetch(this.base + 'manifest.json')).json();
    this.mergeThemeEvents(); // theme: the shot and hit files of the shooters, the event table, the sounds of the types (SoundDirector.soundEvents); a missing one falls back to its classic clip
    this.state = 'on'; this.emit();
    // one-shots in the background, then the ambient beds, then music (largest)
    const ids = Object.keys(this.man.events);
    this.preload(ids.filter((k) => !['ambient', 'music'].includes(this.man.events[k].group))); // beds and music are decoded when first needed
  }
  async preload(ids) { const q = ids.flatMap((id) => this.man.events[id].files); let i = 0; const worker = async () => { while (i < q.length) { const f = q[i++]; await this.load(f); } }; await Promise.all([worker(), worker(), worker(), worker()]); }
  load(file) {
    if (this.bufs.has(file)) return Promise.resolve(this.bufs.get(file));
    if (this.loading.has(file)) return this.loading.get(file);
    const p = fetch(/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(file) ? file : this.base + file).then((r) => r.arrayBuffer()).then((a) => this.ctx.decodeAudioData(a)).then((b) => { this.bufs.set(file, b); return b; }).catch(() => { this.themeFileFailed(file); return null; });
    this.loading.set(file, p); return p;
  }
  // Theme events (SoundDirector.soundEvents) over the manifest events. The classic entries are kept: a theme file that cannot be fetched or decoded is left out, an event without a file
  // is its classic clip again. Called when the manifest is loaded, when the match is attached (whichever comes last) and when a theme file fails.
  mergeThemeEvents() {
    if (!this.man || !this.dir) return;
    const events = this.man.events;
    for (const id of this.themed) { if (this.classic[id]) events[id] = this.classic[id]; else delete events[id]; }
    this.themed = new Set(); this.fileClass = new Map();
    if (this.pack !== CLASSIC_PACK) for (const e of Object.values(events)) for (const f of e.files) if (!/^(music|ambient)\//.test(f) && (e.bus === 'music' || e.group === 'ambient')) this.fileClass.set(f, e.bus === 'music' ? 'music/' : 'ambient/'); // (pack files of the long beds: evicted like the classic ones)
    const add = pruneEvents(this.dir.soundEvents(events, { pack: this.pack !== CLASSIC_PACK }), (f) => !this.failed.has(f));
    for (const [id, e] of Object.entries(add)) {
      if (events[id]) this.classic[id] = events[id];
      events[id] = e; this.themed.add(id);
      for (const f of e.files) this.fileClass.set(f, e.bus === 'music' ? 'music/' : e.group === 'ambient' ? 'ambient/' : '');
    }
  }
  themeFileFailed(file) { if (this.fileClass.has(file) && !this.failed.has(file)) { this.failed.add(file); this.mergeThemeEvents(); } }

  // ---- volumes and mute
  setVolume(name, v) { this.vol[name] = clamp(v, 0, 1); this.applyVolumes(); this.save(); this.emit(); }
  setMuted(m) { this.muted = !!m; this.applyVolumes(); this.save(); this.emit(); }
  toggleMute() { this.setMuted(!this.muted); }
  applyVolumes(now = false) {
    if (!this.ctx) return; const t = this.ctx.currentTime, tc = now ? 0.001 : 0.05;
    this.master.gain.setTargetAtTime(this.muted ? 0 : Math.pow(this.vol.master, 1.6), t, tc);
    for (const b in this.bus) this.bus[b].gain.setTargetAtTime(Math.pow(this.vol[b], 1.6), t, tc);
  }

  // ---- world hooks
  // The sound pack of the skin (render/audio-core.mjs packOf): the manifest of render/assets/<pack>/ is the event table. Chosen here, when the match is attached; a manifest that was loaded before for another pack is loaded again.
  async usePack(pack) {
    if (pack === this.pack) return;
    this.pack = pack; this.base = pack === CLASSIC_PACK ? this.classicBase : this.classicBase.replace(/audio\/?$/, pack + '/');
    this.bufs.clear(); this.loading.clear(); this.failed = new Set(); this.classic = {}; this.themed = new Set();
    for (const L of this.layers.values()) { try { L.src?.stop(); } catch { /* ended */ } L.g?.disconnect(); for (const ch of L.chunks || []) { try { ch.src.stop(); } catch { /* ended */ } } } this.layers.clear();
    if (this.man) { this.man = await (await fetch(this.base + 'manifest.json')).json(); this.mergeThemeEvents(); this.preload(Object.keys(this.man.events).filter((k) => !['ambient', 'music'].includes(this.man.events[k].group))); }
  }
  attach(init, opts = {}) { this.init = init; this.shooters = opts.shooters || null; this.dir = new SoundDirector(init, opts); this.mergeThemeEvents(); this.usePack(packOf(opts.sounds?.theme || opts.shooters?.theme)); }
  setView({ tx, tz, dist, az }) { this.view = { x: tx, y: tz, ref: clamp(dist / 45, 1, 4), rx: Math.cos(az), ry: -Math.sin(az), dist }; }
  onSnap(s) { // call for every new tick
    if (!this.dir || !this.ctx || this.state !== 'on' || !this.man) return;
    this.wxKind = s.wx ? s.wx[0] : 0;
    if (!this.sudden && (s.ev || []).some((e) => e.k === 'ann' && e.a === 'sudden_death')) this.sudden = true; // latch: the world is crumbling
    this.bl = s.buildings; const r = this.dir.feed(s); const now = this.ctx.currentTime;
    this.speed = s.speed || 0; this.maxTier = Math.max(1, ...(s.players || []).map((p) => p.tier || 1));
    if (s.paused || !s.speed) return;
    const minPrio = minPriorityForSpeed(this.speed), V = this.view, R = V.ref * 1.4;
    this.fightNear = r.fighting.filter((f) => Math.hypot(f[0] - V.x, f[1] - V.y) < 24 * V.ref).length;
    for (const tr of r.triggers) if (isDeathCue(tr)) this.deaths.push(now);
    // hoof beats: the snapshot is shown from now on over one snapshot gap (render alpha 0 -> 1), a beat at fraction f of the tick lands f * gap later
    const gap = clamp(now - (this.lastSnapT || now - 0.1), 0.025, 0.5), hoofs = [];
    this.lastSnapT = now;
    for (const tr of r.triggers) { if (tr.hoof) hoofs.push(tr); else this.play(tr, minPrio, s.t); }
    if (hoofs.length) for (const h of limitHoofs(hoofs, this.man.events, V)) this.play(h.tr, minPrio, s.t, { delay: h.tr.f * gap, k: h.k });
    this.syncLoops(r.emitters);
  }
  // one-shot cue from the renderer, timed to what is on screen (a deer falling); not part of the snapshot-derived stream
  cry(id, x, y, ent) { if (!this.ctx || this.state !== 'on' || !this.man || !this.speed) return; this.play({ id, x, y, vol: 0.8, ent }, minPriorityForSpeed(this.speed), ent); }
  // finale (render/app.mjs): a building of the loser falls without a snapshot event of its own, so the app asks for its sound
  collapseAt(name, x, y, size, owner, ent) {
    if (!this.dir || !this.ctx || this.state !== 'on' || !this.man) return;
    this.deaths.push(this.ctx.currentTime);
    this.play({ ...this.dir.collapseCue(name, size), x, y, owner, ent, t: 0, vol: 1, big: true }, 0, ent); // (a theme's collapse sound of that building, else the classic clip)
  }
  // thunder after a lightning flash (render/lightning.mjs): heard everywhere, a clap overhead or a far roll
  thunder(strong, n) { if (!this.ctx || this.state !== 'on' || !this.man || !this.speed) return; this.play(thunderCue(strong, n), 0, n, { delay: thunderDelay(n), k: 1 }); }
  play(tr, minPrio, tick, extra = null) {
    let e = this.man.events[tr.id]; if (!e && tr.alt) { tr = { ...tr, id: tr.alt }; e = this.man.events[tr.id]; }
    if (!e || e.loop) return;
    if (e.priority < minPrio && !tr.big) return;
    const sh = shape(tr, e, this.view, this.view.rx, this.view.ry); if (!sh || sh.gain < 0.012) return;
    const c = this.ctx, now = c.currentTime;
    const fc = fireClass(tr.id) || fireClass(e.theme); // shots and hits: a few single clips (fewer the farther the camera), the rest is the carpet of frame()
    if (fc) { this.fireOffered++; if (!this.fire.admit(fc, now, this.view.ref, (hash32(tick | 0, tr.ent | 0, 77) % 1000) / 1000)) return; }
    const v = this.picker.pick(e, tr.id, [tick, tr.ent, tr.id.length, tr.id.charCodeAt(0) * 31 + tr.id.charCodeAt(tr.id.length - 1)]);
    const buf = this.bufs.get(e.files[v.index]); if (!buf) { this.load(e.files[v.index]); return; }
    const crowd = 1 / Math.sqrt(1 + this.book.crowd(now) / 10), gain = sh.gain * dbToGain(e.gain_db) * crowd * (extra ? extra.k : 1) * v.k, delay = (extra ? extra.delay : 0) + v.delay;
    const adm = this.book.admit(e, tr.id, e.priority, gain, now); if (!adm.ok) return;
    this.picker.commit(tr.id, v.index);
    if (adm.steal?.handle) { try { adm.steal.handle.stop(now + 0.02); adm.steal.handle.g.gain.setTargetAtTime(0, now, 0.01); } catch { /* already ended */ } this.book.drop(adm.steal); }
    const src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = v.rate;
    const g = c.createGain(); g.gain.value = gain; let node = src;
    src.connect(g); node = g;
    if (sh.lp < 17000) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = sh.lp; node.connect(f); node = f; }
    if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = sh.pan; node.connect(p); node = p; }
    node.connect(this.bus[e.bus]); src.start(now + 0.005 + delay);
    const end = now + delay + buf.duration / v.rate, h = { stop: (t) => src.stop(t), g };
    this.played[tr.id] = (this.played[tr.id] || 0) + 1;
    const voice = this.book.commit(e, tr.id, e.priority, gain, now, end, h);
    src.onended = () => this.book.drop(voice);
  }
  // looped emitters (fire, forge, mill, market, caravan, ship wake, shrine hum): nearest few by distance
  syncLoops(em) {
    const V = this.view, c = this.ctx, scored = [];
    for (const m of em) { const e = this.man.events[m.id]; if (!e) continue; const sh = shape({ x: m.x, y: m.y, vol: m.vol ?? 1 }, e, V, V.rx, V.ry); if (sh && sh.gain > 0.02) scored.push({ m, e, sh }); }
    scored.sort((a, b) => b.sh.gain - a.sh.gain); const keep = new Set(scored.slice(0, 6).map((s) => s.m.key));
    for (const [k, l] of this.loops) if (!keep.has(k)) { l.g.gain.setTargetAtTime(0, c.currentTime, 0.2); l.src.stop(c.currentTime + 1); this.loops.delete(k); }
    for (const s of scored.slice(0, 6)) {
      let l = this.loops.get(s.m.key); const gain = s.sh.gain * dbToGain(s.e.gain_db) * 0.8;
      if (!l) { const buf = this.bufs.get(s.e.files[0]); if (!buf) { this.load(s.e.files[0]); continue; } const src = c.createBufferSource(); src.buffer = buf; src.loop = true; const g = c.createGain(); g.gain.value = 0; const f = c.createBiquadFilter(); f.type = 'lowpass'; const p = c.createStereoPanner ? c.createStereoPanner() : null; src.connect(g); g.connect(f); if (p) { f.connect(p); p.connect(this.bus.sfx); } else f.connect(this.bus.sfx); src.start(0, (hash32(...s.m.key.split('').map((x) => x.charCodeAt(0))) % 1000) / 1000 * buf.duration); l = { src, g, f, p }; this.loops.set(s.m.key, l); }
      l.g.gain.setTargetAtTime(gain, c.currentTime, 0.15); l.f.frequency.setTargetAtTime(s.sh.lp, c.currentTime, 0.15); if (l.p) l.p.pan.setTargetAtTime(s.sh.pan, c.currentTime, 0.15);
    }
  }
  // ambience + music: call once per animation frame
  frame(dt) {
    if (!this.ctx || this.state !== 'on' || !this.man) return;
    this._bn = (this._bn || 0) - dt; if (this._bn <= 0 && this.bl) { this._bn = 0.5; this.nearB = this.bl.filter((b) => Math.hypot(b[3] - this.view.x, b[4] - this.view.y) < 20 * this.view.ref).length; }
    const buildingsNear = this.nearB || 0;
    const now = this.ctx.currentTime; this.deaths = this.deaths.filter((t) => now - t < 8);
    const t = Math.max(this.tension.update(this.fightNear, this.deaths.length, dt), this.sudden ? 0.9 : 0), V = this.view; // sudden death keeps the music tense
    const ff = this.speed >= 8 ? 0.55 : 1;
    const amb = this.init ? ambientWeights(this.init, V.x, V.y, { tension: t, buildingsNear, weather: this.wxKind || 0 }) : {};
    const mus = musicWeights(t, this.maxTier);
    this.fireRate += (this.fireOffered / Math.max(dt, 1e-3) - this.fireRate) * (1 - Math.exp(-dt / 0.8)); this.fireOffered = 0; // offered shots + hits per second (smoothed)
    const cid = carpetId(this.man.events), cw = carpetWeight(this.fireRate) * (CARPET_GAIN[cid] ?? 1); if (cw > 0.001) amb[cid] = Math.max(amb[cid] || 0, cw);
    for (const [id, w] of [...Object.entries(amb), ...Object.entries(mus)]) this.layer(id, w * ff * (id.startsWith('music') ? 1 : 1));
  }
  layer(id, w) {
    const e = this.man.events[id]; if (!e) return;
    if (e.bus === 'music' || e.files.length > 1) return this.musicLayer(id, e, w); // several long variants: playlist with crossfades
    const c = this.ctx; let L = this.layers.get(id);
    if (!L) {
      if (w < 0.02) return; const buf = this.bufs.get(e.files[0]); if (!buf) { this.load(e.files[0]); return; }
      const src = c.createBufferSource(); src.buffer = buf; src.loop = true; const g = c.createGain(); g.gain.value = 0; src.connect(g); g.connect(this.bus[e.bus]); src.start(0);
      L = { src, g }; this.layers.set(id, L);
    }
    L.g.gain.setTargetAtTime(w * dbToGain(e.gain_db) * 0.8, c.currentTime, 1.2);
  }
  // music stems are playlists: several long variants of one stem, joined by equal-power crossfades (order by musicSequence)
  musicLayer(id, e, w) {
    const c = this.ctx, now = c.currentTime; let L = this.layers.get(id);
    if (!L) { if (w < 0.03) return; const g = c.createGain(); g.gain.value = 0; g.connect(this.bus[e.bus]); L = { music: true, g, nextAt: 0, seq: 0, chunks: [], active: now }; this.layers.set(id, L); }
    if (w > 0.01) L.active = now;
    if (w < 0.005 && now - L.active > 25) { for (const ch of L.chunks) { try { ch.src.stop(); } catch { /* ended */ } } L.g.disconnect(); this.layers.delete(id); this.evictMusic(); return; } // free the decoded audio of a stem nobody hears
    L.g.gain.setTargetAtTime(w * dbToGain(e.gain_db) * (e.bus === 'music' ? 0.9 : 0.8), now, 1.2);
    L.chunks = L.chunks.filter((ch) => ch.end > now);
    if (w < 0.005 && L.chunks.length === 0 && L.nextAt < now) return;
    while (L.nextAt < now + 8) {
      const order = musicSequence(id, e.files.length, L.seq + 1), file = e.files[order[L.seq]], buf = this.bufs.get(file);
      if (!buf) { this.load(file); break; }
      const start = Math.max(L.nextAt, now + 0.05), xf = Math.min(MUSIC_XF, buf.duration / 4), src = c.createBufferSource(); src.buffer = buf;
      const cg = c.createGain(), curveIn = new Float32Array(48), curveOut = new Float32Array(48);
      for (let i = 0; i < 48; i++) { const f = i / 47; curveIn[i] = Math.sin((f * Math.PI) / 2); curveOut[i] = Math.cos((f * Math.PI) / 2); }
      cg.gain.setValueAtTime(0, start); cg.gain.setValueCurveAtTime(curveIn, start, xf); cg.gain.setValueAtTime(1, start + buf.duration - xf); cg.gain.setValueCurveAtTime(curveOut, start + buf.duration - xf, xf);
      src.connect(cg); cg.connect(L.g); src.start(start); L.chunks.push({ src, end: start + buf.duration, file }); L.nextAt = start + buf.duration - xf; L.seq++;
    }
    this.evictMusic();
  }
  evictMusic() { // keep few decoded long files (music about 45 MB each, ambient about 10 MB): drop the ones no live chunk uses
    const used = new Set(); for (const L of this.layers.values()) if (L.music) for (const ch of L.chunks) used.add(ch.file);
    for (const [prefix, limit] of [['music/', 5], ['ambient/', 8]]) {
      const list = [...this.bufs.keys()].filter((f) => f.startsWith(prefix) || this.fileClass.get(f) === prefix); // (a theme file is a url: its class is known from its event)
      for (const f of list) if (list.length > limit && !used.has(f)) { this.bufs.delete(f); this.loading.delete(f); list.splice(list.indexOf(f), 1); }
    }
  }
  // dev / capture: record what the engine plays (MediaRecorder on the master) for `seconds`; resolves to a Blob (webm/opus)
  record(seconds) {
    return new Promise((resolve) => {
      const d = this.ctx.createMediaStreamDestination(); this.comp.connect(d); const rec = new MediaRecorder(d.stream), parts = [];
      rec.ondataavailable = (e) => parts.push(e.data); rec.onstop = () => { this.comp.disconnect(d); resolve(new Blob(parts, { type: rec.mimeType })); };
      rec.start(); setTimeout(() => rec.stop(), seconds * 1000);
    });
  }
}
