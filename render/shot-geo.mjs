// Meshes of the flying shots: an arrow (shaft, steel head, fletching; points along +Z) and a rough rock / iron ball (unit size).
import * as THREE from './vendor/three.module.js';
import { mergeGeometries } from './vendor/jsm/utils/BufferGeometryUtils.js';

const paint = (geo, hex) => {
  const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
};

export function arrowGeometry() {
  const parts = [
    paint(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 5).rotateX(Math.PI / 2), 0xc79b62),
    paint(new THREE.ConeGeometry(0.06, 0.16, 4).rotateX(Math.PI / 2).translate(0, 0, 0.39), 0xc9ced6),
    paint(new THREE.BoxGeometry(0.14, 0.004, 0.17).translate(0, 0, -0.25), 0xf4efe2),
    paint(new THREE.BoxGeometry(0.004, 0.14, 0.17).translate(0, 0, -0.25), 0xf4efe2),
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

export const shellGeometry = () => new THREE.IcosahedronGeometry(0.5, 1);

// The glowing bolt of a theme (render/shooter-theme.mjs): a slim hot core with a pointed nose and a long tapered tail, points along +Z, one unit long (z -0.55 .. +0.45) and one unit wide
// (the caller scales x and y by the radius and z by the length of the theme). The vertex colours are the HDR brightness of the core (> 1: the bloom picks it up); the colour of the
// theme comes per instance (setColorAt), so every bolt is lit in the colour of its shooter.
export function boltGeometry() {
  const hot = (geo, k) => { const n = geo.attributes.position.count, a = new Float32Array(n * 3).fill(k); geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); return geo; };
  const parts = [
    hot(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.02), 1.7), // core
    hot(new THREE.ConeGeometry(0.5, 0.28, 6).rotateX(Math.PI / 2).translate(0, 0, 0.31), 2.3), // nose (points to +z)
    hot(new THREE.ConeGeometry(0.5, 0.42, 6).rotateX(-Math.PI / 2).translate(0, 0, -0.34), 1.0), // tail (tapers to -z)
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}
