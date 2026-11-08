// Intent markers in the 3D scene (so the live view, the replay and the broadcast video all show them):
// attack / defend arrows with a floating label, scout label, rally lines, building ghosts, worker task icons.
// Input is the `mk` list of a snapshot (see sim/intent.mjs markersOf): [key, kind, owner, x, z, x2, z2, n, label] in tile coordinates.
// Markers fade in and out by themselves; the server already caps them at about 6 per side.
// What the picture may show: under a player's fog of war only that player's markers (a task icon of the enemy would give away units it cannot see),
// on the whole map none (the labels of the show layer name the armies there).
import { displayName } from './theme/display-name.mjs';

// The label of a building ghost comes out of sim/intent.mjs as the classic words ("town center": the sim's nice(), and sim/ is frozen, so its text cannot change).
// The picture speaks the active theme: the label is turned back into the id of the building and asked again. Classic gives the same string; a label that is no building
// (anything else the sim may write) goes through the old formula of display-name.mjs and stays what it was.
export const ghostLabel = (label) => { const id = String(label).replace(/ /g, '_'); return displayName('building', id, 'classic') === label ? displayName('building', id) : label; };
// the text a marker carries in words (arrows and ghosts; the workers carry an icon)
export const pillText = (kind, label, n) => (kind === 'ghost' ? label : ['attack', 'defend', 'scout'].includes(kind) ? (n > 1 ? `${label} ${n}` : label) : null);
export const shownMarkers = (mk, fogP = 0, off = false) => (off ? [] : fogP ? mk.filter((m) => m[2] === fogP) : mk);
export function makeMarkers({ THREE, scene, hAt, color }) {
  const root = new THREE.Group();
  root.renderOrder = 900;
  scene.add(root);
  const items = new Map();
  const texCache = new Map();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const canvasTex = (key, w, h, draw) => {
    let t = texCache.get(key);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    if (texCache.size > 120) { for (const [k, v] of texCache) { v.dispose(); texCache.delete(k); break; } }
    texCache.set(key, t);
    return t;
  };

  const pill = (text, col, n) => canvasTex(`pill|${text}|${col}|${n}`, 256, 64, (g, w, h) => {
    g.font = '700 30px Inter, system-ui, sans-serif';
    const label = n > 1 ? `${text}  ${n}` : text;
    const tw = Math.min(w - 16, g.measureText(label).width + 36);
    g.fillStyle = 'rgba(10,14,20,0.82)';
    g.strokeStyle = col; g.lineWidth = 4;
    const x = (w - tw) / 2, y = 8, hh = h - 16, r = hh / 2;
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + tw, y, x + tw, y + hh, r); g.arcTo(x + tw, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + tw, y, r); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, w / 2, h / 2 + 1);
  });

  const ICONS = {
    axe: (g) => { g.beginPath(); g.moveTo(22, 46); g.lineTo(40, 18); g.stroke(); g.beginPath(); g.moveTo(34, 20); g.quadraticCurveTo(48, 14, 50, 28); g.lineTo(40, 30); g.closePath(); g.fill(); },
    pick: (g) => { g.beginPath(); g.moveTo(24, 48); g.lineTo(38, 20); g.stroke(); g.beginPath(); g.moveTo(18, 26); g.quadraticCurveTo(36, 8, 54, 26); g.stroke(); },
    // food (sim/intent.mjs calls the icon 'basket'): an ear of wheat. The old basket with a round handle read as a padlock at video size.
    basket: (g) => {
      g.beginPath(); g.moveTo(30, 50); g.lineTo(34, 16); g.stroke();
      for (let k = 0; k < 4; k++) { const y = 44 - k * 8, x = 31 + (44 - y) * 0.11; g.beginPath(); g.ellipse(x - 6, y - 3, 6.5, 3.2, -0.65, 0, Math.PI * 2); g.fill(); g.beginPath(); g.ellipse(x + 6, y - 3, 6.5, 3.2, 0.65, 0, Math.PI * 2); g.fill(); }
      g.beginPath(); g.ellipse(34.5, 13, 3.2, 6.5, 0.1, 0, Math.PI * 2); g.fill();
    },
    hammer: (g) => { g.beginPath(); g.moveTo(24, 48); g.lineTo(40, 24); g.stroke(); g.fillRect(31, 14, 20, 11); },
  };
  const badge = (icon, col, n) => canvasTex(`badge|${icon}|${col}|${n}`, 96, 96, (g, w, h) => {
    g.fillStyle = 'rgba(10,14,20,0.85)'; g.beginPath(); g.arc(w / 2, h / 2, 40, 0, Math.PI * 2); g.fill();
    g.strokeStyle = col; g.lineWidth = 5; g.stroke();
    g.save(); g.translate(8, 6); g.scale(1.25, 1.25); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 4; g.lineCap = 'round';
    (ICONS[icon] || ICONS.axe)(g); g.restore();
    g.font = '800 28px Inter, system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    g.strokeStyle = '#0a0e14'; g.lineWidth = 6; g.strokeText(String(n), w - 6, h - 8); g.fillStyle = '#fff'; g.fillText(String(n), w - 6, h - 8);
  });

  let textOff = false;
  const dashTex = (col) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 16;
    const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 3, 40, 10);
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  };

  const planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const headGeo = (() => { const s = new THREE.Shape(); s.moveTo(0.5, 0); s.lineTo(-0.5, 0.55); s.lineTo(-0.25, 0); s.lineTo(-0.5, -0.55); s.closePath(); return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2); })();
  const mat = (map, col) => new THREE.MeshBasicMaterial({ map: map || null, color: map ? 0xffffff : col, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const sprite = () => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false })); s.renderOrder = 960; return s; };

  function make(m) {
    const [key, kind, owner] = m;
    const col = color(owner);
    const it = { key, kind, owner, col, alpha: 0, target: 1, g: new THREE.Group(), x: m[3], z: m[4], x2: m[5], z2: m[6], tex: null };
    if (kind === 'attack' || kind === 'defend' || kind === 'scout' || kind === 'rally') {
      it.tex = dashTex(col);
      it.rib = new THREE.Mesh(planeGeo, mat(it.tex, col)); it.rib.renderOrder = 920;
      it.head = new THREE.Mesh(headGeo, mat(null, col)); it.head.renderOrder = 921;
      it.g.add(it.rib, it.head);
    }
    if (kind === 'ghost') {
      it.box = new THREE.Mesh(planeGeo, mat(canvasTex(`ghost|${col}`, 64, 64, (g, w, h) => { g.strokeStyle = col; g.lineWidth = 6; g.setLineDash([10, 7]); g.strokeRect(5, 5, w - 10, h - 10); g.fillStyle = col + '33'; g.fillRect(5, 5, w - 10, h - 10); }), col));
      it.box.renderOrder = 915;
      it.g.add(it.box);
    }
    it.spr = sprite();
    it.g.add(it.spr);
    root.add(it.g);
    return it;
  }

  function setSprite(it, tex, w, h) {
    if (it.spr.material.map !== tex) { it.spr.material.map = tex; it.spr.material.needsUpdate = true; }
    it.spr.scale.set(w, h, 1);
  }

  function layout(it, m, dt, time) {
    const k = Math.min(1, dt * 7);
    it.x += (m[3] - it.x) * k; it.z += (m[4] - it.z) * k; it.x2 += (m[5] - it.x2) * k; it.z2 += (m[6] - it.z2) * k;
    const kind = it.kind, label = kind === 'ghost' ? ghostLabel(m[8]) : m[8], n = m[7], col = it.col;
    it.label = label; it.n = n;
    if (it.rib) {
      const dx = it.x2 - it.x, dz = it.z2 - it.z, len = Math.hypot(dx, dz), a = -Math.atan2(dz, dx);
      const y = hAt(it.x, it.z) + 0.3;
      const head = kind === 'rally' ? 0.55 : 1.0, w = kind === 'rally' ? 0.22 : kind === 'scout' ? 0.2 : 0.42;
      const L = Math.max(0.01, len - head * 0.7);
      it.rib.position.set(it.x + (dx / (len || 1)) * L / 2, y, it.z + (dz / (len || 1)) * L / 2);
      it.rib.rotation.y = a; it.rib.scale.set(L, 1, w);
      it.tex.repeat.x = Math.max(1, L / 1.3); it.tex.offset.x = -time * 0.9;
      it.head.position.set(it.x2, y + 0.01, it.z2); it.head.rotation.y = a; it.head.scale.set(head, 1, head);
      it.head.visible = len > 1.5;
      it.rib.visible = len > 1.5;
    }
    if (kind === 'attack' || kind === 'defend' || kind === 'scout') {
      setSprite(it, pill(label, col, n), 0.1, 0.025);
      it.spr.position.set(it.x, hAt(it.x, it.z) + 2.6, it.z);
    } else if (kind === 'work') {
      setSprite(it, badge(label, col, n), 0.028, 0.028);
      it.spr.position.set(it.x, hAt(it.x, it.z) + 2.1, it.z);
    } else if (kind === 'ghost') {
      const s = m[5] + 0.3;
      it.box.position.set(it.x, hAt(it.x, it.z) + 0.15, it.z); it.box.scale.set(s, 1, s);
      it.box.material.opacity = 0.65 + 0.35 * Math.sin(time * 5);
      setSprite(it, pill(label, col, 1), 0.075, 0.019);
      it.spr.position.set(it.x, hAt(it.x, it.z) + 2.4, it.z);
    } else if (kind === 'rally') {
      it.spr.visible = false;
    }
    if (kind !== 'rally') it.spr.visible = !(textOff && pillText(kind, label, n));
  }

  function setAlpha(it, a) {
    it.g.traverse((o) => { if (o.material) o.material.opacity = (o.userData.base ?? 1) * a; });
    it.g.visible = a > 0.01;
  }

  let latest = [];
  return {
    // the broadcast draws the text of the markers on its label layer: there no label covers another or leaves the frame
    textOff(off) { textOff = !!off; },
    labels() {
      const out = [];
      for (const it of items.values()) {
        const text = pillText(it.kind, it.label, it.n);
        if (text && it.alpha > 0.02) out.push({ x: it.x, z: it.z, h: it.kind === 'ghost' ? 2.4 : 2.6, text, o: it.owner, a: Math.min(1, it.alpha) });
      }
      return out;
    },
    // new snapshot
    set(mk) {
      latest = mk || [];
      const seen = new Set();
      for (const m of latest) {
        seen.add(m[0]);
        let it = items.get(m[0]);
        if (!it) { it = make(m); items.set(m[0], it); it.x = m[3]; it.z = m[4]; it.x2 = m[5]; it.z2 = m[6]; }
        it.target = 1;
      }
      for (const [k, it] of items) if (!seen.has(k)) it.target = 0;
    },
    // every frame
    frame(dt, time) {
      const byKey = new Map(latest.map((m) => [m[0], m]));
      for (const [k, it] of items) {
        it.alpha += (it.target - it.alpha) * Math.min(1, dt * 6);
        const m = byKey.get(k);
        if (m) layout(it, m, dt, time);
        setAlpha(it, clamp(it.alpha, 0, 1) * 0.95);
        if (it.target === 0 && it.alpha < 0.02) {
          root.remove(it.g);
          it.g.traverse((o) => { if (o.material) o.material.dispose(); });
          if (it.tex) it.tex.dispose();
          items.delete(k);
        }
      }
    },
    get count() { return items.size; },
  };
}
