// Relic shrines in the 3D world (content 2): the shrine model, tinted by the holder (grey when nobody holds it), a ring on the
// ground for the capture radius and a progress ring in the colour of the team that is taking it. Fed with Game.victoryView().points.
import * as THREE from './vendor/three.module.js';
import { buildVisual } from './buildings3d.mjs';
import { natureThemed } from './theme/nature-theme.mjs'; // theme: the shrine model (classic pack without a theme)

const SIZE = 2, RADIUS = 3.4;

export class Shrines {
  constructor(scene, pack, colorOfTeam, heightAt) {
    pack = natureThemed(pack);
    this.scene = scene; this.pack = pack; this.colorOf = colorOfTeam; this.hAt = heightAt;
    this.items = new Map();
    this.id = pack?.map?.objects?.relic_shrine?.model ?? null;
    this.neutral = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.8 });
    this.mats = new Map();
    if (this.id != null) pack.load(this.id);
  }

  mat(team) {
    if (!team) return this.neutral;
    let m = this.mats.get(team);
    if (!m) this.mats.set(team, (m = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.colorOf(team)), roughness: 0.6, emissive: new THREE.Color(this.colorOf(team)), emissiveIntensity: 0.18 })));
    return m;
  }

  make(p) {
    const grp = new THREE.Group();
    const cx = p.x + SIZE / 2, cz = p.y + SIZE / 2;
    grp.position.set(cx, this.hAt(cx, cz), cz);
    const ring = new THREE.Mesh(new THREE.RingGeometry(RADIUS - 0.08, RADIUS, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
    const prog = new THREE.Mesh(new THREE.RingGeometry(RADIUS - 0.5, RADIUS - 0.12, 64, 1, 0, 0.0001), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    prog.rotation.x = -Math.PI / 2; prog.position.y = 0.08;
    grp.add(ring, prog);
    this.scene.add(grp);
    return { grp, ring, prog, inner: null, team: -1, pct: -1, cand: 0 };
  }

  update(vic) {
    if (!vic || !vic.points) return;
    for (const p of vic.points) {
      let o = this.items.get(p.id);
      if (!o) this.items.set(p.id, (o = this.make(p)));
      if (!o.inner && this.id != null) {
        const m = this.pack.peek(this.id);
        if (m) {
          const fit = this.pack.fit(this.id, SIZE * 1.6);
          o.teamKey = null;
          o.model = m; o.fit = fit;
        }
      }
      if (o.model && (o.teamKey !== p.team)) {
        if (o.inner) o.grp.remove(o.inner);
        const mt = this.mat(p.team);
        const { inner } = buildVisual(o.model, mt, null);
        inner.scale.setScalar(o.fit);
        inner.rotation.y = (((this.pack.ov(this.id).rot) || 0) * Math.PI) / 2;
        o.grp.add(inner); o.inner = inner; o.teamKey = p.team;
      }
      const col = new THREE.Color(p.team ? this.colorOf(p.team) : 0xffffff);
      o.ring.material.color.copy(col);
      if (o.pct !== p.pct || o.cand !== p.cand) {
        o.pct = p.pct; o.cand = p.cand;
        o.prog.visible = p.pct > 0;
        if (p.pct > 0) {
          o.prog.geometry.dispose();
          o.prog.geometry = new THREE.RingGeometry(RADIUS - 0.5, RADIUS - 0.12, 64, 1, 0, Math.max(0.01, (p.pct / 100) * Math.PI * 2));
          o.prog.material.color.set(this.colorOf(p.cand));
        }
      }
    }
  }
}
