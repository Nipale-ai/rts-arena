// God mode in the 3D world: storm areas (dark disc, ring, drifting clouds, rain) and treasure chests (chest, light pillar).
// Fed with snapshot.god = { storms: [[x, y, r, ticksLeft, ticksTotal]], chests: [[id, x, y]] }; used by the spectator page and the broadcast renderer.
export class GodWorld {
  constructor({ THREE, scene, hAt }) {
    this.T = THREE;
    this.scene = scene;
    this.hAt = hAt;
    this.storms = new Map();
    this.chests = new Map();
    const T = THREE;
    this.discMat = new T.MeshBasicMaterial({ color: 0x1b2a44, transparent: true, opacity: 0.3, depthWrite: false });
    this.ringMat = new T.MeshBasicMaterial({ color: 0x7fb2ff, transparent: true, opacity: 0.8, depthWrite: false });
    this.cloudMat = new T.MeshStandardMaterial({ color: 0x59657a, roughness: 1, transparent: true, opacity: 0.8, depthWrite: false });
    this.rainMat = new T.LineBasicMaterial({ color: 0xb9d4ff, transparent: true, opacity: 0.55 });
    this.woodMat = new T.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.8 });
    this.bandMat = new T.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.3, metalness: 0.7, emissive: 0x6a4a00 });
    this.beamMat = new T.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.32, depthWrite: false, blending: T.AdditiveBlending });
  }

  update(god) {
    const T = this.T;
    const sKeys = new Set(), cKeys = new Set();
    if (god) {
      for (const s of god.storms || []) {
        const key = `${s[0]},${s[1]},${s[4]}`;
        sKeys.add(key);
        let o = this.storms.get(key);
        if (!o) { o = this.makeStorm(s); this.storms.set(key, o); }
        o.left = s[3]; o.total = s[4];
      }
      for (const c of god.chests || []) {
        cKeys.add(c[0]);
        if (!this.chests.has(c[0])) this.chests.set(c[0], this.makeChest(c));
      }
    }
    for (const [k, o] of this.storms) if (!sKeys.has(k)) { this.scene.remove(o.grp); this.storms.delete(k); void T; }
    for (const [k, o] of this.chests) if (!cKeys.has(k)) { this.scene.remove(o.grp); this.chests.delete(k); }
  }

  makeStorm(s) {
    const T = this.T, [x, z, r] = s;
    const grp = new T.Group();
    const gy = this.hAt(x, z);
    grp.position.set(x, gy + 0.35, z);
    const disc = new T.Mesh(new T.CircleGeometry(r, 48).rotateX(-Math.PI / 2), this.discMat.clone());
    disc.renderOrder = 3;
    const ring = new T.Mesh(new T.RingGeometry(r - 0.35, r, 64).rotateX(-Math.PI / 2), this.ringMat.clone());
    ring.position.y = 0.05; ring.renderOrder = 4;
    grp.add(disc, ring);
    const clouds = [];
    const n = Math.max(6, Math.round(r * 1.2));
    for (let i = 0; i < n; i++) {
      const m = new T.Mesh(new T.SphereGeometry(1, 8, 6), this.cloudMat.clone());
      const rr = r * (0.2 + 0.75 * ((i * 0.618) % 1)), a0 = i * 2.399, sc = 2 + ((i * 7) % 5) * 0.5;
      m.scale.set(sc * 1.6, sc * 0.55, sc * 1.2);
      m.userData = { rr, a0, sp: 0.12 + ((i * 3) % 5) * 0.03, y: 7 + (i % 3) * 1.2 };
      m.renderOrder = 6;
      grp.add(m); clouds.push(m);
    }
    const nr = Math.round(r * r * 1.4 + 40), pos = new Float32Array(nr * 6), seeds = new Float32Array(nr * 3);
    for (let i = 0; i < nr; i++) {
      const a = Math.random() * 6.283, d = r * Math.sqrt(Math.random());
      seeds[i * 3] = Math.cos(a) * d; seeds[i * 3 + 1] = Math.random() * 7; seeds[i * 3 + 2] = Math.sin(a) * d;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    const rain = new T.LineSegments(geo, this.rainMat);
    rain.frustumCulled = false; rain.renderOrder = 7;
    grp.add(rain);
    this.scene.add(grp);
    return { grp, disc, ring, clouds, rain, pos, seeds, r, born: null, left: s[3], total: s[4] };
  }

  makeChest(c) {
    const T = this.T, [, x, z] = c;
    const grp = new T.Group();
    grp.position.set(x, this.hAt(x, z), z);
    const body = new T.Mesh(new T.BoxGeometry(0.9, 0.5, 0.6), this.woodMat);
    body.position.y = 0.25;
    const lid = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, 0.9, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), this.woodMat);
    lid.position.y = 0.5; lid.rotation.y = 0;
    const band = new T.Mesh(new T.BoxGeometry(0.12, 0.56, 0.64), this.bandMat);
    band.position.y = 0.26;
    const lock = new T.Mesh(new T.BoxGeometry(0.14, 0.16, 0.08), this.bandMat);
    lock.position.set(0, 0.42, 0.33);
    const beam = new T.Mesh(new T.CylinderGeometry(0.45, 0.8, 12, 12, 1, true), this.beamMat);
    beam.position.y = 6;
    beam.renderOrder = 8;
    const ring = new T.Mesh(new T.RingGeometry(0.9, 1.15, 28).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ color: 0xffd966, transparent: true, opacity: 0.8, depthWrite: false }));
    ring.position.y = 0.06;
    [body, lid, band, lock].forEach((m) => { m.castShadow = true; });
    grp.add(body, lid, band, lock, beam, ring);
    grp.scale.setScalar(1.5);
    this.scene.add(grp);
    return { grp, beam, ring, base: grp.position.y };
  }

  frame(dt, time) {
    for (const o of this.storms.values()) {
      const f = o.total ? Math.max(0, Math.min(1, Math.min(o.left / 25, (o.total - o.left) / 12 + 0.15))) : 1; // fade in at the start, out in the last 2.5 s
      o.disc.material.opacity = 0.3 * f;
      o.ring.material.opacity = (0.55 + 0.25 * Math.sin(time * 3)) * f;
      for (const m of o.clouds) {
        const u = m.userData, a = u.a0 + time * u.sp;
        m.position.set(Math.cos(a) * u.rr, u.y, Math.sin(a) * u.rr);
        m.material.opacity = 0.8 * f;
      }
      const p = o.pos, s = o.seeds;
      for (let i = 0; i < s.length / 3; i++) {
        const fall = (s[i * 3 + 1] - time * 9) % 7, y = fall < 0 ? fall + 7 : fall;
        p[i * 6] = s[i * 3]; p[i * 6 + 1] = y + 0.9; p[i * 6 + 2] = s[i * 3 + 2];
        p[i * 6 + 3] = s[i * 3] - 0.12; p[i * 6 + 4] = y; p[i * 6 + 5] = s[i * 3 + 2];
      }
      o.rain.geometry.attributes.position.needsUpdate = true;
      o.rain.material.opacity = 0.55 * f;
    }
    for (const o of this.chests.values()) {
      o.grp.rotation.y = Math.sin(time * 0.8) * 0.25;
      o.beam.material.opacity = 0.22 + 0.12 * Math.sin(time * 2.4);
      o.ring.scale.setScalar(1 + 0.12 * Math.sin(time * 2.4));
    }
  }
}
