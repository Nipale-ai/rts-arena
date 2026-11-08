// Building visuals from the 3D models: picks the asset per owner tier (and tower damage state), loads it on demand and swaps it
// into the building group in place of the classic procedural model. Team colour: the TEAM material (untextured part) is tinted per owner.
import * as THREE from './vendor/three.module.js';
import { damageLevel } from './assets3d.mjs';
import { themeOrder } from './theme/building-theme.mjs'; // C4: the draw order of a model of a theme (its id is a string)
import * as ANIM from './anim.mjs';

// video only (tools/render-story.mjs puts these into the page address through RTS_QUERY; without them nothing changes):
//   bodytint=K (0..1)  the walls of a building are pulled towards the owner: a blue owner gets cool slate walls (desaturated, a blue cast), the others a light push towards their own hue at the same brightness
//                      (Dustmoon: both teams have the same rust-orange container walls, in wide shots only the roofs told them apart; Partie 11 check 05.11.)
//   teamdetail=1       flat team parts (no roof texture) get panel seams and a little brightness variation, so a roof is not one flat red block
const Q = typeof location === 'undefined' ? new URLSearchParams('') : new URLSearchParams(location.search);
const BODY_TINT = Math.max(0, Math.min(1, +(Q.get('bodytint') ?? 0) || 0));
const TEAM_DETAIL = Q.get('teamdetail') === '1';
function bodyMaterial(base, c, K) {
  const m = base.clone(), blue = c.b > c.r && c.b > c.g, lu = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b || 1;
  const col = new THREE.Vector3(c.r / lu, c.g / lu, c.b / lu), desat = blue ? 0.62 * K : 0, tint = (blue ? 0.16 : 0.3) * K;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBodyCol = { value: col }; sh.uniforms.uBodyDesat = { value: desat }; sh.uniforms.uBodyTint = { value: tint };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec3 uBodyCol; uniform float uBodyDesat; uniform float uBodyTint;\nvoid main() {')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  float bl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bl), uBodyDesat);\n  diffuseColor.rgb = mix(diffuseColor.rgb, bl * uBodyCol, uBodyTint);');
  };
  m.customProgramCacheKey = () => 'bodytint';
  return m;
}
function detailFlat(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'varying vec3 vBW;\nvoid main() {').replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'varying vec3 vBW;\nvoid main() {').replace('#include <color_fragment>', `#include <color_fragment>
  vec3 q = vBW * 2.2; vec3 f = abs(fract(q) - 0.5);
  float seam = max(smoothstep(0.44, 0.5, f.x), max(smoothstep(0.44, 0.5, f.y), smoothstep(0.44, 0.5, f.z)));
  float nz = fract(sin(dot(floor(q), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  diffuseColor.rgb *= (1.0 - 0.28 * seam) * (0.86 + 0.24 * nz);`);
  };
  m.customProgramCacheKey = () => 'teamdetail';
  return m;
}

// owner material for a textured TEAM part (roof shingle x owner colour x gain); flags wave, see ANIM.modelMaterial
export function teamPartMaterial(p, flat) {
  const m = p.flag ? ANIM.modelMaterial(p.mat, { flag: p.flag }) : p.mat.clone();
  m.color.copy(flat.color).multiplyScalar(p.gain); m.roughness = 0.7; m.name = 'TEAMTEX';
  return m;
}

// group with the model's meshes; `spin` = pivot group of the rotating part (mill sails) or null
// teamMat: plain TEAM material (untextured parts) or fn(part) -> material (textured roofs)
export function buildVisual(m, teamMat, hub, bodyMat = null) {
  const inner = new THREE.Group();
  let spin = null;
  m.parts.forEach((p, pi) => {
    const mesh = new THREE.Mesh(p.geo, p.team ? (typeof teamMat === 'function' ? teamMat(p) : teamMat) : p.glow ? (p.gmat ||= ANIM.modelMaterial(p.mat, { glow: true })) : bodyMat ? bodyMat(p) : p.mat);
    if (p.flag) mesh.customDepthMaterial = ANIM.modelDepthMaterialCached(p.flag); // the flag shadow follows the wave
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.renderOrder = (typeof m.id === 'number' ? m.id * 4 : themeOrder(m.id)) + pi; // fixed draw order, see Scatter
    if (p.spin && hub) {
      spin = new THREE.Group(); spin.position.fromArray(hub); mesh.position.fromArray(hub).negate(); spin.add(mesh); inner.add(spin);
    } else inner.add(mesh);
  });
  return { inner, spin };
}

export class Bld3D {
  constructor(pack, playerColors) {
    this.pack = pack;
    this.team = playerColors.map((c) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.62, metalness: 0.05 }));
    this.teamTex = new Map(); // textured TEAM part -> owner -> material (roof texture x owner colour x gain)
    if (TEAM_DETAIL) this.team.forEach(detailFlat);
    this.bodyTex = new Map(); // body part -> owner -> material (bodytint)
    this.crossfade = false; // video only (app.mjs sets it): a look that is replaced stays in the group as o.prev until the renderer lets it go
    this.neighbours = null; // fn(tx, ty, size) -> orientation hint for wall/gate (0 = along x, 1 = along z)
  }
  // material for a TEAM part of an owner: textured roofs keep their shingle detail, plain parts use the flat owner material
  teamFor(owner, p) {
    const flat = this.team[owner - 1] || this.team[0];
    if (!p.mat) return flat;
    let per = this.teamTex.get(p);
    if (!per) this.teamTex.set(p, per = []);
    if (!per[owner]) {
      per[owner] = teamPartMaterial(p, flat);
    }
    return per[owner];
  }
  // material for a body part (not TEAM, not glowing) of an owner: the plain one, with bodytint a copy pulled towards the owner
  bodyFor(owner, p) {
    if (!BODY_TINT || !p.mat) return p.mat;
    let per = this.bodyTex.get(p);
    if (!per) this.bodyTex.set(p, per = []);
    return (per[owner] ||= bodyMaterial(p.mat, (this.team[owner - 1] || this.team[0]).color, BODY_TINT));
  }
  // o: renderer building record (grp, name, owner, size, hp). Returns true when the visual changed.
  update(o, tier, hp, orient = 0) {
    const pack = this.pack;
    const dmg = o.name === 'tower' || pack.buildingTheme?.hasDamage(o.name) ? damageLevel(hp) : 0; // (C4: a theme may give any building damage states)
    const id = pack.buildingVariant(o.name, tier, dmg);
    if (id == null) return false;
    const key = id + ':' + orient;
    if (o.vkey === key) return false;
    const m = pack.peek(id);
    if (!m) { if (o.vwait !== id) { o.vwait = id; pack.load(id); } return false; }
    if (o.inner) { if (this.crossfade) { if (o.prev) o.grp.remove(o.prev); o.prev = o.inner; o.prevT = null; } else o.grp.remove(o.inner); } // video: the old look stays for a moment and shrinks away under the dust of the new one (app.mjs updateBuilding)
    const ov = pack.ov(id);
    const fit = pack.fit(id, o.size);
    const { inner, spin } = buildVisual(m, (p) => this.teamFor(o.owner, p), ov.spin?.hub, BODY_TINT ? (p) => this.bodyFor(o.owner, p) : null);
    inner.scale.setScalar(fit);
    inner.rotation.y = (((ov.rot || 0) + (o.name === 'wall' || o.name === 'gate' ? orient : 0)) * Math.PI) / 2;
    o.spin = spin; o.bannerAnchors = ov.banner || pack.buildingTheme?.bannerAnchors(id, o.name, fit, ov.rot || 0) || null; // creator banner anchors of this model (banners.mjs); a model of a theme: from its banner_slot nodes
    o.inner = inner; o.vkey = key; o.fit = fit; o.model = m;
    o.grp.add(inner);
    for (const c of o.classic || []) c.visible = false;
    o.h = Math.max(m.box.max.y * fit, 0.6);
    return true;
  }
}
