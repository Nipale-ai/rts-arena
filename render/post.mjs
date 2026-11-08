// Light + post pipeline for the spectator and the frame-exact broadcast renderer.
//   scene render (HDR, MSAA) -> GTAO (ambient occlusion) -> selective bloom -> final pass:
//   tilt-shift blur + bloom add + ACES filmic + colour grade + vignette + sRGB.
// Presets: 'broadcast' (everything, 4096 shadow map, occluded bloom), 'live' (cheaper), 'off' (plain renderer.render).
// Deterministic: no clocks, no per-frame noise (the dither pattern depends on the pixel position only).
// Bloom convention: set `obj.userData.bloom = true` (or `mesh.layers.enable(post.BLOOM_LAYER)`) on anything that should glow;
// meshes whose material has a strong emissive colour are picked up automatically. Everything else never glows.
// Objects with `userData.noAO = true` are ignored by the AO normal pass (HP bars, rings, overlays).
import * as THREE from './vendor/three.module.js';
import { GTAOPass } from './vendor/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from './vendor/jsm/postprocessing/Pass.js';
import { mergeGeometries } from './vendor/jsm/utils/BufferGeometryUtils.js';

export const BLOOM_LAYER = 1;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Look constants: golden afternoon. Warm low sun (about 27 deg), sky-coloured image-based ambient (blue from above, warm bounce from the ground),
// a cool back fill so the shade side of units stays readable, warm aerial haze that matches the sky at the horizon.
// Kept here so the whole look is tunable in one place.
export const LOOK = {
  sunColor: 0xffd3a2, sunIntensity: 4.2,
  sunDir: new THREE.Vector3(0.78, 0.50, 0.38).normalize(), // direction TO the sun
  fillColor: 0x9cb9ee, fillIntensity: 0.75, fillDir: new THREE.Vector3(-0.72, 0.42, -0.55).normalize(),
  skyColor: 0xa9c6ee, groundColor: 0x6b6a45, hemiIntensity: 0.25, envIntensity: 0.6,
  haze: 0xd6d9cf, hazeWarm: 0xefdcc0, hazeCool: 0xa2bde0, zenith: 0x1d52b0, midSky: 0x6aa3ea, ridge: 0x8f9bb0,
  exposure: 1.0,
};

// Directional aerial perspective: the fog colour is the sky's horizon colour in the view direction (warm toward the sun, cool away from it),
// the same function the sky dome uses, so distant ground melts into the sky without a seam. Replaces the flat uniform fog colour for every material.
const lin = (hex) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`; };
const HAZE_GLSL = `
const vec3 HZ_WARM = ${lin(LOOK.hazeWarm)};
const vec3 HZ_COOL = ${lin(LOOK.hazeCool)};
const vec2 SUN_H = vec2(${LOOK.sunDir.x.toFixed(5)}, ${LOOK.sunDir.z.toFixed(5)}) / ${Math.hypot(LOOK.sunDir.x, LOOK.sunDir.z).toFixed(5)};
vec3 hazeColor(vec3 d) {
  float t = dot(normalize(d.xz + vec2(1e-4)), SUN_H) * 0.5 + 0.5;
  vec3 base = mix(HZ_COOL, HZ_WARM, smoothstep(0.1, 0.95, t));
  // fogColor carries the map type's haze and the weather (render/world-fx.mjs): the integer part of .r is the blend in 1/16 steps, the rest is the colour
  float k = floor(fogColor.r) / 16.0;
  return k > 0.0 ? mix(base, vec3(fract(fogColor.r), fogColor.g, fogColor.b), k) : base;
}`;
if (!THREE.ShaderChunk.fog_vertex.includes('vFogDir')) {
  THREE.ShaderChunk.fog_pars_vertex += '\n#ifdef USE_FOG\nvarying vec3 vFogDir;\n#endif';
  THREE.ShaderChunk.fog_vertex += '\n#ifdef USE_FOG\nvFogDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif';
  THREE.ShaderChunk.fog_pars_fragment += '\n#ifdef USE_FOG\nvarying vec3 vFogDir;\n' + HAZE_GLSL + '\n#endif';
  THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace('fogColor', 'hazeColor(normalize(vFogDir))');
}

export const FINAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene, tBloom;
uniform vec2 texel;            // 1 / drawing buffer size
uniform float focusY;          // focus line in uv.y
uniform float band;            // half height of the sharp band (uv units)
uniform float tiltBlur;        // max blur radius in pixels (0 = off)
uniform float bloomAmount;
uniform float exposure;
uniform float vignette;
uniform float saturation, contrast, warmth, blackLift;
varying vec2 vUv;
const float GA = 2.39996323;
vec3 aces(vec3 x) { // Stephen Hill fit as used by three.js (ACESFilmicToneMapping)
  mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  x = inM * (x * exposure / 0.6);
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  float d = max(0.0, abs(vUv.y - focusY) - band) / max(0.05, 1.0 - band);
  float coc = tiltBlur * d * d * (3.0 - 2.0 * d) ;           // pixels, smooth ramp outside the band
  vec3 col;
  if (coc < 0.35) col = texture2D(tScene, vUv).rgb;
  else {
    // golden-angle disc, fixed rotation (deterministic)
    vec3 acc = vec3(0.0); float wsum = 0.0;
    for (int i = 0; i < 20; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / 20.0) * coc;
      float a = fi * GA;
      vec2 o = vec2(cos(a), sin(a)) * r * texel;
      vec3 s = texture2D(tScene, vUv + o).rgb;
      float w = 1.0 + 0.5 * dot(s, vec3(0.3, 0.5, 0.2)); // slight highlight weighting, bokeh feel
      acc += s * w; wsum += w;
    }
    col = acc / wsum;
  }
  col += texture2D(tBloom, vUv).rgb * bloomAmount;
  col = aces(col);
  // grade in display space: contrast around mid grey, saturation, warm/cool split
  col = mix(col, col * col * (3.0 - 2.0 * col), contrast); // gentle S-curve
  col = pow(col, vec3(0.9)); // open up the dark mids (dark rocks and bushes keep their form) without touching the highlights
  col = col * (1.0 - blackLift) + blackLift * vec3(0.55, 0.60, 0.80); // lifted, slightly cool blacks: no crushed shadows
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, saturation);
  col *= vec3(1.0 + warmth, 1.0 + warmth * 0.25, 1.0 - warmth * 0.9);
  vec2 q = vUv - 0.5; col *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(q, q) * 2.0);
  col = toSrgb(clamp(col, 0.0, 1.0));
  // static ordered dither, 1/255 amplitude, no temporal term
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// Viewer variant of FINAL_FRAG (preset flag tiltEco): the 20-tap disc blur is skipped below 1 px of blur instead of 0.35 px (a sub-pixel
// blur is not visible). Derived from FINAL_FRAG by one replace, so FINAL_FRAG itself and the broadcast material stay byte-identical.
const ECO_FROM = 'if (coc < 0.35) col = texture2D(tScene, vUv).rgb;';
export const FINAL_FRAG_ECO = FINAL_FRAG.replace(ECO_FROM, 'if (coc < 1.0) col = texture2D(tScene, vUv).rgb;');
if (FINAL_FRAG_ECO === FINAL_FRAG) throw new Error('post.mjs: FINAL_FRAG changed, update ECO_FROM');

// Viewer-only flags (only 'live' sets them; 'broadcast' and 'off' never do, test/post-presets.test.mjs pins that):
//   shadowOnce: the shadow map is drawn once per frame (the main pass); the GTAO normal pass reuses it instead of drawing it again.
//   tiltEco:    the final pass uses FINAL_FRAG_ECO, which skips the 20 blur taps below 1 px of blur instead of below 0.35 px.
const PRESET_TABLE = {
  broadcast: { shadow: 4096, ao: true, aoScale: 1, bloom: true, bloomOccluded: true, tilt: true, samples: 4, bloomScale: 0.5 },
  live: { shadow: 2048, ao: true, aoScale: 0.5, bloom: true, bloomOccluded: false, tilt: true, samples: 4, bloomScale: 0.5, shadowOnce: true, tiltEco: true },
  off: { shadow: 2048, ao: false, aoScale: 1, bloom: false, bloomOccluded: false, tilt: false, samples: 0, bloomScale: 0.5 },
};
for (const k of Object.keys(PRESET_TABLE)) Object.freeze(PRESET_TABLE[k]);
export const PRESETS = Object.freeze(PRESET_TABLE);

export function createPost({ renderer, scene, camera, preset = 'live' }) {
  // ---- renderer, sky, light ----
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // used only by preset 'off'; the final pass tone maps itself
  renderer.toneMappingExposure = LOOK.exposure;
  scene.background = new THREE.Color(LOOK.haze);
  // procedural sky dome: warm haze at the horizon, blue overhead, sun glow, two far ridge layers and soft static clouds (a fixed
  // function of the view direction: no clock, so it is identical in every frame and every render). Follows the camera, never fogged or shadowed.
  const skyUniforms = (env) => ({
    md: { value: new THREE.Color(LOOK.midSky) }, zn: { value: new THREE.Color(LOOK.zenith) },
    rg: { value: new THREE.Color(LOOK.ridge) }, sd: { value: LOOK.sunDir.clone() }, sunCol: { value: new THREE.Color(LOOK.sunColor) },
    gnd: { value: new THREE.Color(LOOK.groundColor) }, uEnv: { value: env ? 1 : 0 },
    uOver: { value: 0 }, uOverCol: { value: new THREE.Color(0x8d98a6) }, uStorm: { value: 0 }, uFlash: { value: 0 }, uHz: { value: new THREE.Vector4(0, 0, 0, 0) },
  });
  const SKY_VS = 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const SKY_FS = /* glsl */ `
uniform vec3 md, zn, rg, sd, sunCol, gnd; uniform float uEnv, uOver, uStorm, uFlash; uniform vec3 uOverCol; uniform vec4 uHz; varying vec3 vD;
const vec3 fogColor = vec3(0.0); // (the sky has no fog uniform: uHz carries the haze override instead)
${HAZE_GLSL}
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vD);
  float y = d.y, sdot = max(dot(d, sd), 0.0);
  vec3 hz = hazeColor(d);
  if (uHz.w > 0.0) hz = mix(hz, uHz.rgb, uHz.w); // the haze of the map type and the weather (the sky dome has no fog uniform)
  vec3 c;
  if (y < 0.0) {
    c = mix(hz, uEnv > 0.5 ? gnd * 1.3 : hz * 0.9, smoothstep(0.0, uEnv > 0.5 ? -0.25 : -0.35, y));
  } else {
    // bright warm horizon, clearly blue sky overhead
    c = mix(hz, md, smoothstep(0.0, 0.20, y));
    c = mix(c, zn, smoothstep(0.06, 0.70, y));
    c += hz * 0.35 * exp(-y * 14.0); // luminous band hugging the horizon
    float glow = pow(sdot, 6.0) * 0.16 + pow(sdot, 48.0) * 0.55;
    c += vec3(1.0, 0.80, 0.52) * glow * (uEnv > 0.5 ? 0.5 : 1.0);
    if (uEnv < 0.5) {
      c += sunCol * smoothstep(0.99935, 0.99985, sdot) * 5.0;
      // soft cumulus: a fixed noise field projected onto a plane; lit side toward the sun, bluish shade underneath
      vec2 uv = d.xz / (y + 0.09) * 0.42;
      float n1 = fbm(uv * 1.6 + 3.0), n2 = fbm(uv * 1.6 + 3.0 + sd.xz * 0.10);
      float body = smoothstep(0.50, 0.66, n1);
      float cover = body * smoothstep(0.012, 0.075, y) * (1.0 - 0.55 * smoothstep(0.45, 0.9, y));
      float lit = clamp(0.5 + (n1 - n2) * 9.0, 0.0, 1.0);
      vec3 shade = vec3(0.50, 0.60, 0.80) * 1.1, sunl = mix(vec3(1.25, 1.12, 0.95), vec3(1.7, 1.35, 0.95), pow(sdot, 3.0));
      vec3 cc = mix(shade, sunl, lit);
      cc = mix(cc, hz * 1.1, 1.0 - smoothstep(0.012, 0.11, y)); // thin into the haze toward the horizon
      c = mix(c, cc, cover * 0.92);
      // two layers of far hills, hazed into the horizon colour
      float az = atan(d.z, d.x);
      float y2 = 0.004 + 0.034 * pow(0.55 * vn(vec2(az * 2.2, 4.0)) + 0.3 * vn(vec2(az * 6.0, 9.0)) + 0.15 * vn(vec2(az * 17.0, 3.0)), 1.6);
      c = mix(c, mix(hz, rg, 0.22), smoothstep(y2 + 0.0015, y2 - 0.0015, y));
    }
  }
  if (uOver > 0.0) { // weather: the sky closes (rain, snow, storm); dark, fast-looking cloud banks in a storm; a lightning flash lights it up
    vec2 uv = d.xz / (abs(y) + 0.14) * 0.38;
    float cl = fbm(uv * 1.5 + 11.0);
    vec3 oc = uOverCol * (0.72 + 0.55 * cl);
    oc = mix(oc, oc * 0.5, uStorm * smoothstep(0.32, 0.8, cl));
    oc = mix(oc, hz, 1.0 - smoothstep(-0.02, 0.2, y)); // melts into the haze at the horizon
    c = mix(c, oc, min(1.0, uOver * 1.6) * 0.8);
    c += vec3(0.75, 0.82, 1.0) * uFlash * (0.35 + 0.65 * smoothstep(0.0, 0.5, y)) * (0.4 + 0.8 * cl);
  }
  gl_FragColor = vec4(c, 1.0);
}`;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(700, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false, uniforms: skyUniforms(false), vertexShader: SKY_VS, fragmentShader: SKY_FS,
  }));
  dome.frustumCulled = false; dome.renderOrder = -10; dome.userData.noAO = true; dome.userData.noBloomOccluder = true;
  scene.add(dome);
  // image-based ambient from the same sky (once, static): blue from above, warm bounce from below; replaces most of the flat hemisphere light
  {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false, uniforms: skyUniforms(true), vertexShader: SKY_VS, fragmentShader: SKY_FS,
    })));
    const pm = new THREE.PMREMGenerator(renderer);
    const rt = pm.fromScene(envScene, 0.04, 1, 1000);
    scene.environment = rt.texture;
    scene.environmentIntensity = LOOK.envIntensity;
    pm.dispose();
  }
  scene.fog = new THREE.Fog(LOOK.haze, 150, 480);

  const hemi = new THREE.HemisphereLight(LOOK.skyColor, LOOK.groundColor, LOOK.hemiIntensity);
  const sun = new THREE.DirectionalLight(LOOK.sunColor, LOOK.sunIntensity);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05; sun.shadow.radius = 3;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 600;
  const fill = new THREE.DirectionalLight(LOOK.fillColor, LOOK.fillIntensity); // cool, no shadow: keeps the shade side of units readable
  fill.position.copy(LOOK.fillDir).multiplyScalar(100);
  scene.add(hemi, sun, sun.target, fill, fill.target);

  // ---- map type and weather (render/biomes.mjs, render/world-fx.mjs): sky tint, haze, light strength, fog density ----
  const wx = { over: 0, overCol: new THREE.Color(0x8d98a6), storm: 0, flash: 0, fogMul: 1, sunMul: 1, hazeK: 0, hazeCol: new THREE.Color(LOOK.haze) };
  const biome = { sun: 1, hazeK: 0, hazeCol: new THREE.Color(LOOK.haze), far: null };
  function setBiome(b) {
    biome.sun = b.sun ?? 1;
    biome.hazeK = b.haze ? b.haze.k : 0;
    if (b.haze) biome.hazeCol.set(b.haze.color);
    biome.far = b.far || null; biome.noFarTrees = !!b.noFarTrees;
    if (b.sky) { dome.material.uniforms.md.value.set(b.sky.mid); dome.material.uniforms.zn.value.set(b.sky.zenith); }
  }
  function setWeather(w) { Object.assign(wx, w); }
  const _hz = new THREE.Color(), _ov = new THREE.Color();
  function applyLook() {
    const k = Math.max(biome.hazeK, wx.over * 0.5), over = wx.over;
    _hz.copy(biome.hazeCol).lerp(wx.overCol, over * 0.85);
    const kq = Math.round(clamp(k, 0, 1) * 16);
    scene.fog.color.setRGB(kq + clamp(_hz.r, 0, 0.999), _hz.g, _hz.b); // see hazeColor in the fog shader chunk
    const u = dome.material.uniforms;
    u.uHz.value.set(_hz.r, _hz.g, _hz.b, kq / 16);
    u.uOver.value = over; u.uOverCol.value.copy(wx.overCol); u.uStorm.value = wx.storm; u.uFlash.value = wx.flash;
    scene.background.copy(_hz.lerp(_ov.copy(wx.overCol), 0));
    const dim = 1 - 0.3 * over;
    sun.intensity = LOOK.sunIntensity * biome.sun * dim + wx.flash * 1.5;
    hemi.intensity = LOOK.hemiIntensity * (1 - 0.15 * over) + wx.flash * 1.2;
    fill.intensity = LOOK.fillIntensity * (1 - 0.3 * over);
    scene.environmentIntensity = LOOK.envIntensity * (1 - 0.35 * over) + wx.flash * 1.4;
  }

  const P = { name: preset, cfg: PRESETS[preset] || PRESETS.live };
  const size = new THREE.Vector2(1, 1);
  let rtA, rtB, rtBloom, gtao, bloom, quad, mat, matEco = null, noBloomMat, bloomSet = new WeakSet(), bloomSeen = new WeakSet();
  const focus = { y: 0.5, band: 0.3, blur: 0 };

  function applyShadowSize() {
    const s = P.cfg.shadow;
    if (sun.shadow.mapSize.x !== s) { sun.shadow.mapSize.set(s, s); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  }

  function build() {
    const c = P.cfg;
    for (const t of [rtA, rtB, rtBloom]) t && t.dispose();
    gtao && gtao.dispose(); bloom && bloom.dispose?.(); gtao = bloom = null;
    applyShadowSize();
    if (P.name === 'off') return;
    renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x | 0), h = Math.max(2, size.y | 0);
    const opts = { type: THREE.HalfFloatType, samples: c.samples, depthBuffer: true };
    rtA = new THREE.WebGLRenderTarget(w, h, opts);
    rtB = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    if (c.ao) {
      const aw = Math.max(2, Math.round(w * c.aoScale)), ah = Math.max(2, Math.round(h * c.aoScale));
      gtao = new GTAOPass(scene, camera, aw, ah);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.75;
      gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, radiusExponent: 1, rings: 2, samples: 12 });
    }
    if (c.bloom) {
      const bw = Math.round(w * c.bloomScale), bh = Math.round(h * c.bloomScale);
      rtBloom = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: true });
      bloom = new UnrealBloomPass(new THREE.Vector2(bw, bh), 0.9, 0.55, 0.7); // strength, radius, threshold (linear HDR luma)
      bloom.nMips = 5;
    }
    if (!quad) {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          tScene: { value: null }, tBloom: { value: null }, texel: { value: new THREE.Vector2() },
          focusY: { value: 0.5 }, band: { value: 0.3 }, tiltBlur: { value: 0 }, bloomAmount: { value: 1 }, exposure: { value: LOOK.exposure },
          vignette: { value: 0.2 }, saturation: { value: 1.2 }, contrast: { value: 0.2 }, warmth: { value: 0.015 }, blackLift: { value: 0.07 },
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
      });
      quad = new FullScreenQuad(mat);
      noBloomMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    }
    mat.uniforms.texel.value.set(1 / w, 1 / h);
  }

  function resize() { renderer.getDrawingBufferSize(size); if (P.name !== 'off') build(); }

  function setPreset(name) { if (!PRESETS[name]) return; P.name = name; P.cfg = PRESETS[name]; build(); }

  // ---- far field: the terrain continues past the map edge ----
  // A non-uniform grid ring around the map block (dense at the edge, coarse far out). At the edge it takes the terrain's own height and vertex
  // colour (so there is no step and no skirt to see), then relaxes into gentle rolling hills; cheap instanced trees and rocks (forest patches by
  // noise) and the same sun-dried / lush macro tint as the terrain shader make it read as more of the same land. Everything is a pure function
  // of (x, z, seed): deterministic. Replaces the flat apron.
  let farField = null, farProps = [], farHeightFn = null;
  function setFarField(n, seed = 1, terr = null) {
    for (const o of [farField, ...farProps]) if (o) { scene.remove(o); o.geometry.dispose(); }
    farField = null; farProps = [];
    const hash = (x, y) => { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const vnoise = (x, y) => { const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1); return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy; };
    const edgeH = (x, z) => (terr && terr.heightAt ? Math.max(-0.25, terr.heightAt(clamp(x, 0, n), clamp(z, 0, n))) : -0.1);
    const NVt = n * 2 + 1; // terrain grid (2 vertices per tile)
    const tcol = terr && terr.mesh ? terr.mesh.geometry.getAttribute('color') : null;
    const edgeCol = (x, z, out) => { if (!tcol) return false; const i = clamp(Math.round(clamp(x, 0, n) * 2), 0, NVt - 1), j = clamp(Math.round(clamp(z, 0, n) * 2), 0, NVt - 1), k = j * NVt + i; out.setRGB(tcol.getX(k), tcol.getY(k), tcol.getZ(k)); return true; };
    const dist = (x, z) => Math.max(-x, x - n, -z, z - n, 0); // distance from the map block (square metric)
    const farH = (x, z) => {
      const d = dist(x, z), e = edgeH(x, z);
      const f = 0.55 * vnoise(x * 0.0055 + 11, z * 0.0055) + 0.3 * vnoise(x * 0.014, z * 0.014 + 5) + 0.15 * vnoise(x * 0.037 + 3, z * 0.037);
      const ramp = smooth(12, 330, d), roll = 0.9 * vnoise(x * 0.05, z * 0.05) * smooth(2, 25, d);
      const hills = ramp * 38 * Math.pow(f, 1.5) + roll;
      return d <= 0 ? e : e + (hills - e) * smooth(0, 28, d);
    };
    farHeightFn = farH;
    const R = 760, axis = [];
    const side = []; for (let sp = 5, x = 0; x < R; sp *= 1.2) { x += sp; side.push(Math.min(x, R)); }
    for (let i = side.length - 1; i >= 0; i--) axis.push(-side[i]);
    for (let x = 0; x < n; x += 2) axis.push(x);
    axis.push(n); for (const v of side) axis.push(n + v);
    const m = axis.length, pos = new Float32Array(m * m * 3), colA = new Float32Array(m * m * 3), col = new THREE.Color(), ec = new THREE.Color();
    const fc = biome.far || {};
    const wGrass = new THREE.Color(fc.grass ?? 0x4f8a3a), wDry = new THREE.Color(fc.dry ?? 0x869a4a), wForest = new THREE.Color(fc.forest ?? 0x2b5f33), wRock = new THREE.Color(fc.rock ?? 0x77735f);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const x = axis[i], z = axis[j], k = j * m + i, d = dist(x, z), h = farH(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      const t = vnoise(x * 0.012 + 40, z * 0.012), u = vnoise(x * 0.03 + 9, z * 0.03 + 9);
      col.copy(wGrass).lerp(wDry, clamp((t - 0.4) * 2, 0, 1) * 0.8).lerp(wForest, clamp((u - 0.55) * 3, 0, 1) * 0.8);
      col.lerp(wRock, clamp((h - 16) / 24, 0, 1) * 0.6);
      col.multiplyScalar(0.85 + 0.3 * vnoise(x * 0.09 + 20, z * 0.09));
      if (edgeCol(x, z, ec)) col.lerpColors(ec, col, smooth(0, 70, d)); // carry the terrain colour out of the edge
      colA[k * 3] = col.r; colA[k * 3 + 1] = col.g; colA[k * 3 + 2] = col.b;
    }
    const idx = [];
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < m - 1; i++) {
      const cx = (axis[i] + axis[i + 1]) / 2, cz = (axis[j] + axis[j + 1]) / 2;
      if (cx > 0 && cx < n && cz > 0 && cz < n) continue;
      const a = j * m + i, b = a + 1, c = a + m, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const fmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true });
    const G3 = terr && terr.ground;
    fmat.onBeforeCompile = (sh) => { // same broad sun-dried / lush tint as the terrain, so the join is not a colour step
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWP;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{ float mt = smoothstep(0.30, 0.72, vn(vWP.xz * 0.034 + 5.0) * 0.65 + vn(vWP.xz * 0.011) * 0.35);
  diffuseColor.rgb *= mix(vec3(0.99, 1.0, 0.92), vec3(0.88, 1.03, 0.98), mt); }`);
      if (G3) { // the same ground texture detail as the playable terrain, fading out with the distance from the map border (no step at the edge)
        const nm = ['grass_a', 'grass_b', 'grass_c'];
        nm.forEach((q, i) => { sh.uniforms['tG' + i] = { value: G3.tex[q] }; });
        sh.uniforms.uMean = { value: nm.map((q) => G3.mean[q]) }; sh.uniforms.uDet = G3.det; sh.uniforms.uN = { value: n };
        sh.fragmentShader = sh.fragmentShader.replace('varying vec3 vWP;', 'varying vec3 vWP; uniform sampler2D tG0, tG1, tG2; uniform vec3 uMean[3]; uniform float uDet, uN;\nvec3 dtex(sampler2D t, vec2 uv, vec3 m){ vec3 c = texture2D(t, uv).rgb / m; float l = dot(c, vec3(0.299, 0.587, 0.114)); return mix(vec3(l), c, 0.25); }')
          .replace('#include <color_fragment>', `#include <color_fragment>
{ vec2 gp = vWP.xz; float dd = max(max(-gp.x, gp.x - uN), max(-gp.y, gp.y - uN));
  float vs = vn(gp * 0.045), vs2 = vn(gp * 0.031 + 17.0);
  vec3 gA = dtex(tG0, gp * 0.21, uMean[0]), gB = dtex(tG1, gp * 0.19 + 0.37, uMean[1]), gC = dtex(tG2, gp * 0.17 + 0.71, uMean[2]);
  vec3 g = mix(mix(gA, gB, smoothstep(0.35, 0.55, vs)), gC, smoothstep(0.6, 0.8, vs2));
  float nz = 0.55 * vn(gp * 3.1) + 0.3 * vn(gp * 7.7) + 0.15 * vn(gp * 19.0);
  float k = 1.0 - smoothstep(20.0, 150.0, dd);
  diffuseColor.rgb *= mix(vec3(1.0), clamp(g, 0.35, 2.2) * (0.92 + 0.16 * nz) * (0.94 + 0.12 * vn(gp * 0.21)), uDet * k);
  diffuseColor.rgb *= mix(1.0, 0.92, k * 0.0); }`);
      }
    };
    fmat.customProgramCacheKey = () => 'far-field' + (G3 ? '-3d' : '');
    farField = new THREE.Mesh(g, fmat);
    farField.frustumCulled = false; farField.receiveShadow = true; farField.userData.noAO = true; farField.name = 'far-field';
    scene.add(farField);

    // ---- cheap far-LOD trees and rocks (instanced, no shadows): conifers and round trees in forest patches, a few rocks ----
    const mk = (geos) => { // merge vertex-coloured parts
      const parts = geos.map(([geo, y, c]) => { geo = geo.toNonIndexed(); geo.translate(0, y, 0); const cnt = geo.getAttribute('position').count, ca = new Float32Array(cnt * 3); for (let q = 0; q < cnt; q++) { ca[q * 3] = c.r; ca[q * 3 + 1] = c.g; ca[q * 3 + 2] = c.b; } geo.setAttribute('color', new THREE.BufferAttribute(ca, 3)); geo.deleteAttribute('uv'); return geo; });
      return mergeGeometries(parts);
    };
    const gTrunk = new THREE.Color(0x4a3524), gPine = new THREE.Color(biome.far ? biome.far.forest : 0x1b4a2c), gRound = new THREE.Color(biome.far ? biome.far.dry : 0x5c7a2c), gRock = new THREE.Color(0x8a8678);
    const pineGeo = mk([[new THREE.CylinderGeometry(0.18, 0.28, 1.2, 5), 0.6, gTrunk], [new THREE.ConeGeometry(1.5, 2.8, 6), 2.2, gPine], [new THREE.ConeGeometry(1.1, 2.4, 6), 3.8, gPine], [new THREE.ConeGeometry(0.7, 2.0, 6), 5.2, gPine]]);
    const roundGeo = mk([[new THREE.CylinderGeometry(0.2, 0.3, 2.0, 5), 1.0, gTrunk], [new THREE.IcosahedronGeometry(1.7, 0), 3.2, gRound]]);
    const rockGeo = mk([[new THREE.IcosahedronGeometry(0.9, 0), 0.35, gRock]]);
    const spots = { pine: [], round: [], rock: [] };
    const STEP = 4.2, X0 = -330, X1 = n + 330;
    for (let gz = X0; gz < X1; gz += STEP) for (let gx = X0; gx < X1; gx += STEP) {
      const ix = Math.round(gx / STEP), iz = Math.round(gz / STEP);
      const x = gx + (hash(ix, iz) - 0.5) * STEP * 0.95, z = gz + (hash(ix + 77, iz) - 0.5) * STEP * 0.95, d = dist(x, z);
      if (d < 3.5) continue;
      if (terr && terr.nearTrees && d < 52) continue; // the game's own tree models stand here (render/forest.mjs buildFarForest)
      const fo = vnoise(x * 0.022 + 100, z * 0.022 + 50) * 0.7 + vnoise(x * 0.06, z * 0.06) * 0.3;
      const r = hash(ix + 5, iz + 9);
      if (r < clamp((fo - 0.5) * 3.2, 0, 0.9) + (d < 60 ? 0.02 : 0.06)) {
        const hh = farH(x, z), sc = (0.62 + hash(ix, iz + 31) * 0.5) * (1 + smooth(40, 400, d) * 1.1);
        const kind = vnoise(x * 0.01 + 7, z * 0.01) > 0.5 ? (hash(ix + 3, iz + 3) > 0.25 ? 'pine' : 'round') : (hash(ix + 3, iz + 3) > 0.7 ? 'pine' : 'round');
        spots[kind].push([x, hh, z, sc, hash(ix + 13, iz + 7)]);
      } else if (r > 0.985) spots.rock.push([x, farH(x, z), z, 0.8 + hash(ix, iz + 21) * 1.8, hash(ix + 1, iz + 1)]);
    }
    const dm = new THREE.Object3D(), ic = new THREE.Color();
    for (const [name, geo] of [['pine', pineGeo], ['round', roundGeo], ['rock', rockGeo]]) {
      const list = (biome.noFarTrees || (terr && terr.nearTrees)) && name !== 'rock' ? [] : spots[name]; // with the 3D pack the far trees are the game's own models (render/forest.mjs buildFarTrees) if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true }), list.length);
      list.forEach(([x, y, z, sc, r], q) => {
        dm.position.set(x, y - 0.15, z); dm.rotation.set(0, r * 6.283, 0); dm.scale.set(sc * (0.85 + r * 0.3), sc * (0.9 + r * 0.35), sc * (0.85 + r * 0.3)); dm.updateMatrix();
        im.setMatrixAt(q, dm.matrix);
        ic.setRGB(0.8 + r * 0.35, 0.85 + r * 0.25, 0.7 + r * 0.4); im.setColorAt(q, ic);
      });
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.userData.noAO = true; im.name = 'far-' + name;
      scene.add(im); farProps.push(im);
    }
    return farField;
  }

  // ---- light fitting ----
  // One shadow map, fitted to the visible ground (a low side-on view is clamped to a reach that grows with the camera distance, the far field is
  // hazed anyway). The light camera has a FIXED orientation (the sun never moves); its square extent comes from a ladder of fixed sizes and its
  // centre is snapped to whole texels in light space, so panning, orbiting and zooming never make shadow edges swim.
  const _v = new THREE.Vector3(), _ray = new THREE.Ray(), _n = new THREE.Vector3(0, 1, 0), _plane = new THREE.Plane(_n, 0);
  const _pts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const _R = new THREE.Vector3(0, 1, 0).cross(LOOK.sunDir).normalize(), _U = LOOK.sunDir.clone().cross(_R).normalize();
  const _c = new THREE.Vector3();
  const LADDER = 1.18, BASE_E = 14;
  function fitLight(tx, tz, maxExtent = 200) {
    camera.updateMatrixWorld();
    const camPos = camera.position;
    const toT = camPos.distanceTo(_pts[4].set(tx, 0, tz));
    const reach = toT * 1.25 + 30; // ground farther than this from the camera is not shadowed (it is in haze)
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([x, y], i) => {
      _v.set(x, y, 0.5).unproject(camera);
      _ray.origin.copy(camPos); _ray.direction.copy(_v).sub(camPos).normalize();
      const hit = _ray.intersectPlane(_plane, _pts[i]);
      const dist = hit ? hit.distanceTo(camPos) : Infinity;
      if (!hit || dist > reach) _pts[i].copy(camPos).addScaledVector(_ray.direction, reach).setY(0);
    });
    _pts[4].set(tx, 0, tz);
    const L = LOOK.sunDir;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < 5; i++) {
      const a = _pts[i].dot(_R), b = _pts[i].dot(_U);
      x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b);
    }
    const pad = 7; // things above the ground plane (hills, roofs, trees) land a little off the plane-projected box
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const ladder = (h) => BASE_E * Math.pow(LADDER, Math.ceil(Math.log(Math.max(Math.min(h, maxExtent / 2), BASE_E) / BASE_E) / Math.log(LADDER) - 1e-6));
    const EX = ladder((x1 - x0) / 2), EY = ladder((y1 - y0) / 2); // a rectangle: texels are not square, but fewer shadow casters are drawn
    const tx_ = (2 * EX) / sun.shadow.mapSize.x, ty_ = (2 * EY) / sun.shadow.mapSize.y;
    const sx = Math.round(((x0 + x1) / 2) / tx_) * tx_, sy = Math.round(((y0 + y1) / 2) / ty_) * ty_;
    _c.copy(_R).multiplyScalar(sx).addScaledVector(_U, sy); // centre on the light plane through the world origin
    sun.target.position.copy(_c);
    sun.position.copy(_c).addScaledVector(L, 260);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    const lc = sun.shadow.camera;
    lc.position.copy(sun.position); lc.lookAt(_c); lc.updateMatrixWorld();
    lc.left = -EX; lc.right = EX; lc.bottom = -EY; lc.top = EY;
    lc.updateProjectionMatrix();
    sun.shadow.normalBias = 0.05 * Math.max(1, Math.max(EX, EY) / 50); // texels grow with the extent: keep the self-shadow offset in proportion
  }

  // aerial perspective: fog starts a little behind the look-at point and thickens toward the horizon; at a top-down view nothing is hazed,
  // at a low side-on view the far field melts into the sky colour
  function fitFog(camS) {
    const f = scene.fog;
    const d = camera.position.distanceTo(_v.set(camS ? camS.tx : 0, camS ? camS.ty || 0 : 0, camS ? camS.tz : 0));
    const e = smooth(0.5, 1.2, camS ? camS.pol : 0.9); // 0 top-down .. 1 low side-on
    f.near = (d * (1.4 - 0.9 * e) + (50 - 45 * e)) * wx.fogMul;
    f.far = f.near + (380 + 40 * e) * wx.fogMul;
  }

  // ---- bloom tagging ----
  function tagBloom() {
    scene.traverse((o) => {
      if (!o.isMesh || bloomSeen.has(o)) return;
      bloomSeen.add(o);
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const emissive = m && m.emissive ? (m.emissive.r * 0.3 + m.emissive.g * 0.55 + m.emissive.b * 0.15) * (m.emissiveIntensity ?? 1) : 0;
      if (o.userData.bloom || (m && m.userData && m.userData.bloom) || emissive > 0.15) o.layers.enable(BLOOM_LAYER);
    });
  }

  // ---- AO helper: hide things that must not enter the AO normal pass ----
  const hidden = [];
  function hideForAO() {
    scene.traverse((o) => {
      if (!o.visible || !(o.isMesh || o.isSprite)) return;
      const m = o.material;
      if (o.userData.noAO || (m && !Array.isArray(m) && m.transparent && (m.depthTest === false || m.depthWrite === false))) { o.visible = false; hidden.push(o); }
    });
  }
  function showAfterAO() { for (const o of hidden) o.visible = true; hidden.length = 0; }

  // ---- render ----
  // camS: smoothed camera state {tx, tz, dist, az, pol}; call after the camera matrices are final.
  function render(camS = api.cam) {
    dome.position.copy(camera.position);
    applyLook();
    if (camS) { fitLight(camS.tx, camS.tz); fitFog(camS); }
    if (P.name === 'off') { renderer.render(scene, camera); return; }
    const c = P.cfg;
    const oldTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rtA);
    renderer.clear();
    // shadowOnce (viewer only): the main pass draws the shadow map, the GTAO normal pass (also a renderer.render call) must not draw it again.
    // The bloom pass needs no guard: its camera sees layer 1 only, so no light is collected and the shadow pass returns early.
    const sm = renderer.shadowMap, smAuto = sm.autoUpdate;
    if (c.shadowOnce) { sm.autoUpdate = false; sm.needsUpdate = true; }
    let cur = rtA;
    try {
      renderer.render(scene, camera);
      if (gtao) {
        hideForAO();
        gtao.render(renderer, rtB, rtA);
        showAfterAO();
        cur = rtB;
      }
    } finally {
      if (c.shadowOnce) { sm.autoUpdate = smAuto; sm.needsUpdate = false; }
    }
    let bloomTex = null;
    if (bloom) {
      tagBloom();
      const bg = scene.background, fg = scene.fog, lm = camera.layers.mask, om = scene.overrideMaterial;
      const clr = new THREE.Color(); renderer.getClearColor(clr); const ca = renderer.getClearAlpha();
      scene.background = null; scene.fog = null;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(rtBloom); renderer.clear();
      if (c.bloomOccluded) { // everything else is drawn black first so glow is hidden behind solid objects
        camera.layers.set(0); scene.overrideMaterial = noBloomMat; renderer.render(scene, camera); scene.overrideMaterial = om;
      }
      camera.layers.set(BLOOM_LAYER);
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = ac;
      camera.layers.mask = lm; scene.background = bg; scene.fog = fg; renderer.setClearColor(clr, ca);
      bloom.render(renderer, null, rtBloom);
      bloomTex = bloom.renderTargetsHorizontal[0].texture;
    }
    // final pass to the canvas
    const u = mat.uniforms;
    u.tScene.value = cur.texture;
    u.tBloom.value = bloomTex || cur.texture; u.bloomAmount.value = bloomTex ? 1 : 0;
    if (c.tilt && camS) {
      _v.set(camS.tx, camS.ty || 0, camS.tz).project(camera);
      focus.y = clamp(_v.y * 0.5 + 0.5, 0, 1);
      const s = smooth(0.30, 1.15, camS.pol); // 0 top-down overview .. 1 low angle
      const hh = size.y / 1080;
      focus.blur = (0.4 + 3.6 * s) * hh; // max blur radius in pixels at 1080p: weak top-down, stronger at low angles
      focus.band = 0.40 - 0.14 * s;
    } else { focus.blur = 0; }
    u.focusY.value = focus.y; u.band.value = focus.band; u.tiltBlur.value = focus.blur;
    renderer.setRenderTarget(null);
    renderer.toneMapping = THREE.NoToneMapping;
    if (c.tiltEco) {
      if (!matEco) { matEco = new THREE.ShaderMaterial({ uniforms: mat.uniforms, vertexShader: mat.vertexShader, fragmentShader: FINAL_FRAG_ECO, depthTest: false, depthWrite: false, toneMapped: false }); }
      quad.material = matEco;
    } else if (quad.material !== mat) quad.material = mat;
    quad.render(renderer);
    renderer.toneMapping = oldTM;
  }

  build();
  const api = { get farHeight() { return farHeightFn; }, cam: null, resize, setPreset, fitLight, setFarField, setBiome, setWeather, sun, hemi, get preset() { return P.name; }, BLOOM_LAYER, LOOK, tilt: focus };
  api.render = render; api.resize = resize; api.setPreset = setPreset; api.fitLight = fitLight;
  return api;
}
