// Deep mirror comparison: every unit field (hidden ones too), entity refs by mirrored position,
// units paired by ph (per-owner creation count). Usage: node tools/deep-sym.mjs [--bot boom] [--seed 2] [--minutes 22]
import { runMatch } from "./run-match.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) { if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i]; }
const bot = args.bot || "boom", seed = +(args.seed || 2), minutes = +(args.minutes || 22);

function makeSer(g, mirror) {
  const W = g.W, H = g.H;
  const mx = (x) => (mirror ? W * 1000 - x : x), my = (y) => (mirror ? H * 1000 - y : y);
  const entKey = (v) => {
    if (v && v.kind === 1) return `u@${mx(v.x)},${my(v.y)}`;
    if (v && (v.kind === 2 || v.kind === 3)) return `b@${mirror ? W - v.tx - v.size : v.tx},${mirror ? H - v.ty - v.size : v.ty}`;
    if (v && v.k === "t") { const i = v.idx, x = i % W, y = (i / W) | 0; return `t@${mirror ? W - 1 - x : x},${mirror ? H - 1 - y : y}`; }
    if (v && typeof v === "object") return ser(v, 3);
    return String(v);
  };
  function ser(v, depth) {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t !== "object") return v;
    if (Array.isArray(v)) return v.map((q) => (q && typeof q === "object" ? ser(q, depth - 1) : q));
    if (depth <= 0) return "…";
    const r = {};
    for (const k of Object.keys(v).sort()) {
      const vv = v[k];
      if (typeof vv === "function") continue;
      if (k === "id" || k === "owner") continue;
      if (k === "x0" || k === "x1") { const w = [mx(v.x0), mx(v.x1)].sort((q, r2) => q - r2); r.xmin = w[0]; r.xmax = w[1]; continue; }
      if (k === "y0" || k === "y1") { const w = [my(v.y0), my(v.y1)].sort((q, r2) => q - r2); r.ymin = w[0]; r.ymax = w[1]; continue; }
      if (k === "tx") { r[k] = mirror ? g.W - vv - (v.size || 0) : vv; continue; }
      if (k === "ty") { r[k] = mirror ? g.H - vv - (v.size || 0) : vv; continue; }
      if (k === "cx") { r[k] = vv === 0 ? 0 : mx(vv); continue; }
      if (k === "cy") { r[k] = vv === 0 ? 0 : my(vv); continue; }
      if (k === "fx" || k === "sx") { r[k] = vv === 0 ? 0 : mx(vv); continue; }
      if (k === "fy" || k === "sy") { r[k] = vv === 0 ? 0 : my(vv); continue; }
      if (k === "x" || k === "px" || k === "hx") { r[k] = mx(vv); continue; }
      if (k === "y" || k === "py" || k === "hy") { r[k] = my(vv); continue; }
      if (k === "wp" && Array.isArray(vv) && vv.every((q) => typeof q === "number")) { const w = []; for (let i = 0; i + 1 < vv.length; i += 2) { w.push(mx(vv[i]), my(vv[i + 1])); } r[k] = w; continue; }
      if ((k === "drop" || k === "tgt" || k === "hitBy" || k === "ftid" || k === "fol") && typeof vv === "number" && vv !== 0) {
        const e = g.get(vv) || g.units.get(vv) || g.buildings.get(vv); r[k] = e ? entKey(e) : "?DEAD"; continue;
      }
      r[k] = (vv && typeof vv === "object") ? entKey(vv) : vv;
    }
    return r;
  }
  return ser;
}

function unitMap(g, pid, mirror) {
  const ser = makeSer(g, mirror);
  const N = (mirror ? (pid === 2 ? g.W : g.W) : g.W) * 1000;
  const mirrorNum = (v, ax) => (mirror ? g[ax === 'x' ? 'W' : 'H'] * 1000 - v : v);
  const out = new Map();
  for (const u of g.units.values()) {
    if (u.owner !== pid) continue;
    const d = {};
    for (const k of Object.keys(u).sort()) {
      if (k === "id" || k === "owner") continue;
      const v = u[k];
      if (typeof v === "function" || v === undefined) continue;
      if (k === "fx" || k === "sx") { d[k] = v === 0 ? 0 : mirrorNum(v, "x"); continue; }
      if (k === "fy" || k === "sy") { d[k] = v === 0 ? 0 : mirrorNum(v, "y"); continue; }
      if (k === "x" || k === "px") { d[k] = mirrorNum(v, "x"); continue; }
      if (k === "y" || k === "py") { d[k] = mirrorNum(v, "y"); continue; }
      if (k === "wp" && Array.isArray(v) && v.every((q) => typeof q === "number")) { const w = []; for (let i = 0; i + 1 < v.length; i += 2) { w.push(mirrorNum(v[i], "x"), mirrorNum(v[i + 1], "y")); } d[k] = w; continue; }
      if ((k === "tgt" || k === "hitBy" || k === "ftid" || k === "fol") && typeof v === "number" && v !== 0) { const e = g.get(v) || g.units.get(v) || g.buildings.get(v); d[k] = e ? JSON.stringify(ser(e, 3)) : "?DEAD"; continue; }
      d[k] = (v && typeof v === "object") ? ser(v, 4) : v;
    }
    out.set(u.type + ":" + u.ph, JSON.stringify(d));
  }
  return out;
}

let found = null;
const stop = new Error("stop");
try {
  runMatch({
    seed, bots: [bot, bot], maxMinutes: minutes, rules: { preset: "fast", weather: "off", caravans: false },
    onTick: (g) => {
      const a = unitMap(g, 1, false), b = unitMap(g, 2, true);
      const keys = new Set([...a.keys(), ...b.keys()]);
      for (const k of keys) {
        const x = a.get(k), y = b.get(k);
        if (x === y) continue;
        found = { tick: g.t, unit: k, a: x ?? "FEHLT", b: y ?? "FEHLT" };
        throw stop;
      }
    },
  });
} catch (e) { if (e !== stop) throw e; }
console.log(JSON.stringify(found, null, 1));
