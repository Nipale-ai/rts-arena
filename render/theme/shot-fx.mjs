// The shot layer of a theme, the part that needs THREE (package C6): the mesh projectile and the hooks that render/app.mjs calls. The rules (what is a usable file, where the flash sits,
// which blow gets an effect) are in render/theme/shot-theme.mjs, which has no THREE.
//
//   const SHOTFX = new ShotFx(SHOOTERS);                         once, beside the shooter table (render/shooter-theme.mjs)
//   SHOTFX.build(world, scene, pack3d && pack3d.loader);         once, when the world is built: loads the projectile meshes the theme names; a file that is missing or unusable = the bolt
//   if (bolt && th.projectile.mesh && SHOTFX.mesh(th.projectile, dummy, P, fx)) continue;     per shot, before the bolt is drawn: true = a delivered mesh was drawn (with the halo and the trail of the bolt)
//   SHOTFX.flush();                                              once per frame, after the shots: the counts of the mesh pools
//   SHOTFX.muzzle(fx, P, th, unit, ux, uz, rand)                 the muzzle flash in the first frame of a themed shot, at the anchor of the model when it has one
//   SHOTFX.meleeHit(fx, name, act, cu, tx, tz, sz, victim, gy, rand)    the `hit` effect of a melee attacker at the moment its blow lands
// Without a theme (or a theme with none of these slots) nothing is built, nothing is loaded, and every call returns "classic": the picture is the one of before.
// No Math.random: the effects take the seeded generator of the caller.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/jsm/utils/BufferGeometryUtils.js';
import { SHOOTERS } from '../shooter-theme.mjs';
import { muzzleFlash, meleeHit } from './shot-theme.mjs';

export const MESH_GAIN = 1.5; // brightness of the colours of a projectile mesh (above 1 the bloom picks it up, like the hot core of the bolt)
export const MESH_TRIS_MAX = 2000; // a file with more triangles is not drawn (the check script allows 600; this keeps a file that skipped the check from eating the frame rate)
export const POOL_CAP = 400; // shots of one mesh in the air at once (the bolt pool of render/app.mjs has the same)

// The lights of a bolt in flight: a halo (a light that lives a frame or two) and a trail. The same numbers as the bolt block of render/app.mjs, so a mesh shot glows like a bolt in the colours of its theme.
export function boltLights(fx, P, pj) {
  if (fx.load >= 0.8) return;
  fx.boltTrail(P.x, P.y, P.z, pj.glow, 0.07, 0.3 + pj.width * 4);
  if (pj.trail && P.adv > 0.3) fx.boltTrail(P.x - P.dx * 0.4, P.y - P.dy * 0.4, P.z - P.dz * 0.4, pj.trail.color, 0.24, pj.trail.size * 2.5);
}

// The geometry of a projectile mesh, from a loaded glb (root = gltf.scene): all its meshes in one geometry with vertex colours, its middle on the origin, scaled so that its extent along z is 1
// (THEME-VERTRAG.md 6.5: it points along +Z, the game scales it to the `length` of the slot). The colour of a vertex is the vertex colour of the file (or white) times the colour of its material plus
// the glow of that material, times MESH_GAIN: the shot is drawn flat and bright, the way the bolt is. Textures are not used.
// Returns { geometry, tris } or null when the file cannot be a shot (no triangles, no extent along z, a longest side that is not z, not finite, more than MESH_TRIS_MAX triangles).
export function meshProjectileGeometry(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    const pos = g.attributes.position, col = g.attributes.color, n = pos.count;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const glow = m && m.emissive ? m.emissiveIntensity ?? 1 : 0;
    const base = ['r', 'g', 'b'].map((c) => ((m && m.color ? m.color[c] : 1) + (m && m.emissive ? m.emissive[c] * glow : 0)) * MESH_GAIN); // colour of the material plus its glow
    const xyz = new Float32Array(n * 3), rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      xyz[i * 3] = pos.getX(i); xyz[i * 3 + 1] = pos.getY(i); xyz[i * 3 + 2] = pos.getZ(i);
      rgb[i * 3] = (col ? col.getX(i) : 1) * base[0]; rgb[i * 3 + 1] = (col ? col.getY(i) : 1) * base[1]; rgb[i * 3 + 2] = (col ? col.getZ(i) : 1) * base[2];
    }
    const part = new THREE.BufferGeometry();
    part.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    part.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    parts.push(part);
  });
  if (!parts.length) return null;
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!geometry) return null;
  geometry.computeBoundingBox();
  const b = geometry.boundingBox, ex = b.max.x - b.min.x, ey = b.max.y - b.min.y, ez = b.max.z - b.min.z;
  if (!(ez > 1e-6) || !Number.isFinite(ez + ex + ey)) return null;
  if (!(ez >= 0.9 * Math.max(ex, ey) * (1 - 1e-5))) return null; // the longest side must lie along +Z, the rule of tools/theme-check.mjs (a hair of room for Float32): else the scale to the length of the slot would blow it up
  const tris = geometry.attributes.position.count / 3;
  if (!(tris >= 1) || tris > MESH_TRIS_MAX) return null;
  geometry.translate(-(b.max.x + b.min.x) / 2, -(b.max.y + b.min.y) / 2, -(b.max.z + b.min.z) / 2);
  geometry.scale(1 / ez, 1 / ez, 1 / ez);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, tris };
}

export class ShotFx {
  // table = the ShooterTable of the match (render/shooter-theme.mjs)
  constructor(table) {
    this.table = table;
    this.pools = new Map(); // url of a mesh -> { state: 'loading' | 'ready' | 'failed', mesh: InstancedMesh | null, n: shots drawn this frame, cap }
    this.ready = null; // promise: every projectile mesh of the theme is loaded or has failed (null = there is nothing to load)
  }
  get count() { let n = 0; for (const e of this.pools.values()) n += e.mesh ? e.mesh.count : 0; return n; } // mesh shots drawn in the last frame (for the tools that look at the page)

  // Loads the projectile meshes of the theme (one pool per file, shared by every shooter that names it). loader = a GLTFLoader (pack3d.loader) or anything with loadAsync(url).
  // The promise joins world.siegeReady, which the broadcast page awaits before its first frame: a frame-exact render then shows the mesh in every frame, not the bolt in the first few.
  build(world, scene, loader) {
    if (this.ready) return this.ready;
    const t = this.table;
    if (!t || !t.themed || !loader) return null;
    const urls = new Set();
    for (const [isB, list] of [[false, SHOOTERS.units], [true, SHOOTERS.buildings]]) for (const n of list) { const u = t.get(isB, n)?.projectile?.mesh; if (u) urls.add(u); }
    if (!urls.size) return null;
    const jobs = [];
    for (const url of urls) {
      const e = { state: 'loading', mesh: null, n: 0, cap: POOL_CAP };
      this.pools.set(url, e);
      jobs.push(Promise.resolve().then(() => loader.loadAsync(url)).then((gltf) => {
        const g = meshProjectileGeometry(gltf.scene);
        if (!g) throw new Error('not a usable projectile mesh (no triangles, no extent along z, or more than ' + MESH_TRIS_MAX + ' triangles)');
        const m = new THREE.InstancedMesh(g.geometry, new THREE.MeshBasicMaterial({ vertexColors: true }), e.cap);
        m.count = 0; m.frustumCulled = false; m.castShadow = false; m.name = 'shot-mesh';
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.userData.bloom = true; // (before the first frame sees it: render/post.mjs tags a mesh once)
        scene.add(m);
        e.mesh = m; e.state = 'ready';
      }).catch((err) => { e.state = 'failed'; console.warn('projectile mesh not used, the bolt is drawn instead:', url, (err && err.message) || err); }));
    }
    this.ready = Promise.all(jobs);
    if (world) { world.projM = this; (world.siegeReady ||= []).push(this.ready); }
    return this.ready;
  }

  // One shot with a projectile mesh: pj = the projectile of the profile ({ mesh: url, length, glow, width, trail }), dummy = the Object3D of the frame, already placed at the shot and turned along its flight (lookAt).
  // True = drawn (the bolt must not be). False = the file is not loaded (yet), failed, or the pool is full: the caller draws the bolt, as it did before meshes existed.
  mesh(pj, dummy, P, fx) {
    const e = pj.mesh ? this.pools.get(pj.mesh) : null;
    if (!e || e.state !== 'ready' || e.n >= e.cap) return false;
    dummy.scale.setScalar(pj.length);
    dummy.updateMatrix();
    e.mesh.setMatrixAt(e.n++, dummy.matrix);
    boltLights(fx, P, pj);
    return true;
  }
  // after the last shot of a frame: how many of each mesh are drawn
  flush() {
    for (const e of this.pools.values()) {
      if (!e.mesh) continue;
      if (e.n || e.mesh.count) { e.mesh.count = e.n; e.mesh.instanceMatrix.needsUpdate = true; }
      e.n = 0;
    }
  }

  muzzle(fx, P, th, unit, ux, uz, rand) { muzzleFlash(fx, P, th, unit, ux, uz, rand); }

  // The melee blow of the unit type `name` lands: true = the theme drew its `hit` effect in place of the classic contact flash (a blow on a unit); false = nothing was drawn, or the effect was added to the chips of a wall.
  meleeHit(fx, name, act, cu, tx, tz, sz, victim, gy, rand) {
    if (!this.table || !this.table.themed) return false;
    return meleeHit(fx, this.table.get(false, name), act, cu, tx, tz, sz, victim, gy, rand);
  }
}
