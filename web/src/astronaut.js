import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural EVA astronaut: rigid segments on a joint hierarchy, animated in
// code (walk / run / idle / reach).  Built facing +Z; its left side is +X.
// Limbs are surfaces of revolution, so bearings and convolute folds sit flush
// on the fabric.  Elbows and knees have a "mid" group that turns half as far
// as the joint, so their folds bridge the bend instead of floating on one side.
const BODY_SCALE = 0.94;          // ~1.9 m tall including the helmet
const HIP_HEIGHT = 1.015;         // hip pivot height above the soles (unscaled)
const FABRIC_TILE = 0.16;         // metres covered by one tile of the fabric normal map
const HUT_DEPTH = 0.68;           // hard upper torso: elliptical, flatter front to back
const BRIEF_DEPTH = 0.74;
const SCYE_TILT = 0.35;           // shoulder bearings face outwards and a little down
const CENTRE_OF_MASS = 1.0;       // floating lean pivots here (metres above the soles)
const DOWN = new THREE.Vector3(0, -1, 0);
const IDENTITY = new THREE.Quaternion();

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function missionPatchTexture() {
  return canvasTexture(256, 256, (ctx, size) => {
    const c = size / 2;
    const disc = (r) => {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
    };
    disc(126);
    ctx.fillStyle = '#c9a54a';
    ctx.fill();
    disc(114);
    ctx.fillStyle = '#0b1f3f';
    ctx.fill();
    ctx.save();
    disc(114);
    ctx.clip();
    const planet = ctx.createRadialGradient(c - 40, c + 70, 10, c, c + 120, 120);
    planet.addColorStop(0, '#7cc0ff');
    planet.addColorStop(1, '#1b4c96');
    ctx.fillStyle = planet;
    ctx.beginPath();
    ctx.arc(c, c + 130, 110, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#ff5a36';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.ellipse(c, c + 4, 84, 30, -0.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 6 : 15;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(c + 52 + Math.cos(a) * r, c - 40 + Math.sin(a) * r);
    }
    ctx.fill();
    ctx.font = 'bold 30px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('AIRLOCK 07', c, c - 62);
  });
}

function crewPatchTexture() {
  return canvasTexture(256, 180, (ctx, w, h) => {
    ctx.fillStyle = '#0d1a33';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c9a54a';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = '#3fd8ff';
    ctx.beginPath();
    ctx.moveTo(w * 0.18, h * 0.62);
    ctx.lineTo(w * 0.5, h * 0.24);
    ctx.lineTo(w * 0.82, h * 0.62);
    ctx.lineTo(w * 0.7, h * 0.62);
    ctx.lineTo(w * 0.5, h * 0.4);
    ctx.lineTo(w * 0.3, h * 0.62);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EVA · AL-07', w / 2, h * 0.86);
  });
}

function nameTapeTexture() {
  return canvasTexture(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#d6d3ca';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1b2a4a';
    ctx.lineWidth = 4;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = '#1b2a4a';
    ctx.font = 'bold 40px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EVA-01', w / 2, h / 2 + 2);
  });
}

function plssLabelTexture() {
  return canvasTexture(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#20242b';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e0b020';
    for (let x = -h; x < 46; x += 18) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + 9, h);
      ctx.lineTo(x + 9 + h, 0);
      ctx.lineTo(x + h, 0);
      ctx.fill();
    }
    ctx.fillStyle = '#e8eef5';
    ctx.font = 'bold 30px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('PLSS-07', 62, h / 2 + 1);
  });
}

function blobShadowTexture() {
  return canvasTexture(128, 128, (ctx, size) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
}

/**
 * Outer-layer fabric: a fine ripstop weave over soft folds.  UV u runs round
 * a limb and v along it, so the folds are stretched to crease across the limb.
 */
function fabricNormalMap(size = 256) {
  let seed = 11;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const height = new Float32Array(size * size);
  for (const [cellsU, cellsV, amplitude] of [[2, 4, 1], [4, 9, 0.4]]) {
    const grid = Array.from({ length: cellsU * cellsV }, random);
    const at = (cx, cy) => grid[(cy % cellsV) * cellsU + (cx % cellsU)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cellsU;
        const gy = (y / size) * cellsV;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const sx = THREE.MathUtils.smootherstep(gx - x0, 0, 1);
        const sy = THREE.MathUtils.smootherstep(gy - y0, 0, 1);
        const top = THREE.MathUtils.lerp(at(x0, y0), at(x0 + 1, y0), sx);
        const bottom = THREE.MathUtils.lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx);
        height[y * size + x] += THREE.MathUtils.lerp(top, bottom, sy) * amplitude;
      }
    }
  }
  const WEAVE = 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wx = Math.cos((x / size) * Math.PI * 2 * WEAVE);
      const wy = Math.cos((y / size) * Math.PI * 2 * WEAVE);
      height[y * size + x] += 0.02 * Math.max(wx, wy);
    }
  }
  const data = new Uint8Array(size * size * 4);
  const h = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const normal = new THREE.Vector3();
  const strength = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      normal.set((h(x - 1, y) - h(x + 1, y)) * strength, (h(x, y - 1) - h(x, y + 1)) * strength, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (normal.x * 0.5 + 0.5) * 255;
      data[i + 1] = (normal.y * 0.5 + 0.5) * 255;
      data[i + 2] = (normal.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / FABRIC_TILE, 1 / FABRIC_TILE);   // part UVs are in metres
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function createMaterials() {
  const fabricNormal = fabricNormalMap();
  const normalScale = new THREE.Vector2(0.55, 0.55);
  return {
    fabric: new THREE.MeshPhysicalMaterial({
      color: 0xe8e6df, roughness: 0.82, sheen: 0.6, sheenRoughness: 0.7, sheenColor: 0xffffff,
      normalMap: fabricNormal, normalScale,
    }),
    fabricShade: new THREE.MeshPhysicalMaterial({
      color: 0xc9ccd0, roughness: 0.85, sheen: 0.4, sheenRoughness: 0.8, sheenColor: 0xffffff,
      normalMap: fabricNormal, normalScale,
    }),
    shell: new THREE.MeshPhysicalMaterial({ color: 0xf2f2ee, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.15 }),
    shellGrey: new THREE.MeshPhysicalMaterial({ color: 0xcfd0cc, roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.2 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xa9b1ba, metalness: 1, roughness: 0.28 }),
    bearing: new THREE.MeshStandardMaterial({ color: 0x2f5fbf, metalness: 0.6, roughness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x24272d, roughness: 0.6 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.9 }),
    webbing: new THREE.MeshStandardMaterial({ color: 0x5d636c, roughness: 0.85 }),
    glove: new THREE.MeshStandardMaterial({ color: 0xdcdbd4, roughness: 0.72 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x575b62, roughness: 0.9 }),
    mirror: new THREE.MeshStandardMaterial({ color: 0xe4ebf2, metalness: 1, roughness: 0.04 }),
    red: new THREE.MeshStandardMaterial({ color: 0xb3242c, roughness: 0.7 }),
    hoseBlue: new THREE.MeshStandardMaterial({ color: 0x3567c9, roughness: 0.5 }),
    knobRed: new THREE.MeshStandardMaterial({ color: 0xc8302a, roughness: 0.45 }),
    knobYellow: new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.45 }),
    visor: new THREE.MeshPhysicalMaterial({
      color: 0xffc46b, metalness: 1, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.1,
    }),
    helmetInner: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xdff6ff, emissiveIntensity: 0.4 }),
    display: new THREE.MeshStandardMaterial({ color: 0x030405, emissive: 0x00e5ff, emissiveIntensity: 2.5 }),
    ledGreen: new THREE.MeshStandardMaterial({ color: 0x030303, emissive: 0x2bff88, emissiveIntensity: 3 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0x030303, emissive: 0xff2a1a, emissiveIntensity: 0.3 }),
    patch: new THREE.MeshStandardMaterial({ map: missionPatchTexture(), roughness: 0.8, alphaTest: 0.4 }),
    crewPatch: new THREE.MeshStandardMaterial({ map: crewPatchTexture(), roughness: 0.8 }),
    nameTape: new THREE.MeshStandardMaterial({ map: nameTapeTexture(), roughness: 0.8 }),
    plssLabel: new THREE.MeshStandardMaterial({ map: plssLabelTexture(), roughness: 0.6 }),
  };
}

// --- Geometry helpers ------------------------------------------------------------
// Profiles are [radius, y] pairs listed from the top of a part downwards.

/** Surface of revolution round +Y, with UVs in metres for the fabric normal map. */
function turned(points, segments = 28) {
  // LatheGeometry faces outwards when its profile runs upwards.
  const profile = points.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)).reverse();
  const geometry = new THREE.LatheGeometry(profile, segments);
  const meanRadius = profile.reduce((sum, p) => sum + p.x, 0) / profile.length;
  const around = Math.max(1, Math.round((Math.PI * 2 * meanRadius) / FABRIC_TILE)) * FABRIC_TILE;
  const along = [0];
  for (let j = 1; j < profile.length; j++) along.push(along[j - 1] + profile[j].distanceTo(profile[j - 1]));
  const uv = geometry.attributes.uv;
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j < profile.length; j++) uv.setXY(i * profile.length + j, (i / segments) * around, along[j]);
  }
  return geometry;
}

/** Catmull-Rom through the control points, for smooth fabric and shell curves. */
function smooth(points, samples = 4) {
  const curve = new THREE.SplineCurve(points.map(([r, y]) => new THREE.Vector2(r, y)));
  return curve.getPoints((points.length - 1) * samples).map((p) => [p.x, p.y]);
}

/** Convolute joint: `count` rounded folds between y0 and y1. */
function folds(radius, depth, y0, y1, count, steps = 6) {
  const points = [];
  for (let k = 0; k <= count * steps; k++) {
    const t = k / (count * steps);
    const bulge = Math.pow(Math.abs(Math.sin(Math.PI * count * t)), 0.6);
    points.push([radius + depth * bulge, y0 + (y1 - y0) * t]);
  }
  return points;
}

/** Stitched seam: a shallow groove round the part. */
const groove = (r, y, width = 0.005, depth = 0.0025) => [
  [r, y + width], [r - depth, y + width * 0.3], [r - depth, y - width * 0.3], [r, y - width],
];

/** Flush ring (bearing, stripe, strap) with chamfered edges, from y0 down to y1. */
const band = (r, y0, y1, chamfer = 0.004, inset = 0.015) => turned([
  [r - inset, y0], [r - chamfer, y0], [r, y0 - chamfer], [r, y1 + chamfer], [r - chamfer, y1], [r - inset, y1],
], 32);

/** Closes a profile onto the axis just below its last point. */
const capBottom = (points) => {
  const [r, y] = points[points.length - 1];
  return [...points, [r * 0.5, y - 0.005], [0, y - 0.007]];
};

function metricUV(geometry, su, sv) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geometry;
}

const ball = (r) => metricUV(new THREE.SphereGeometry(r, 24, 16), Math.PI * 2 * r, Math.PI * r);
const box = (w, h, d, r, s = 3) => new RoundedBoxGeometry(w, h, d, s, r);
const cylinder = (r, h, s = 16) => new THREE.CylinderGeometry(r, r, h, s);
/** Capsule hanging down from its top (finger segments). */
const capsuleDown = (r, length) => new THREE.CapsuleGeometry(r, length, 4, 10).translate(0, -length / 2, 0);
/** Curved patch wrapped round a limb, centred on angle `theta` (0 = front, PI/2 = +X). */
const wrap = (r, height, width, theta) => new THREE.CylinderGeometry(
  r, r, height, 12, 1, true, theta - width / r / 2, width / r,
);
const mat = (position = [0, 0, 0], rotation = [0, 0, 0]) => new THREE.Matrix4().compose(
  new THREE.Vector3(...position),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
  new THREE.Vector3(1, 1, 1),
);

/** headlamp: false for a static prop suit (a spot light costs every material a shader slot). */
export function createAstronaut({ headlamp: withHeadlamp = true } = {}) {
  const m = createMaterials();

  // Parts are merged per joint, material and shadow flag to keep draw calls low.
  const buckets = new Map();
  const add = (parent, geometry, material, shadow = true) => {
    const key = `${parent.uuid}|${material.uuid}|${shadow}`;
    if (!buckets.has(key)) buckets.set(key, { parent, material, shadow, parts: [] });
    buckets.get(key).parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
  };
  const group = (parent, [x = 0, y = 0, z = 0] = []) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  const root = new THREE.Group();
  root.name = 'Astronaut';
  // root stays on the deck (position, heading, contact shadow); `pose` lifts the
  // body off it and tilts it about the centre of mass while floating.
  const pose = group(root, [0, CENTRE_OF_MASS, 0]);
  const body = group(pose, [0, -CENTRE_OF_MASS, 0]);
  body.scale.setScalar(BODY_SCALE);

  // --- Lower torso -----------------------------------------------------------
  const hips = group(body, [0, HIP_HEIGHT, 0]);
  add(hips, turned(smooth([
    [0.168, 0.115], [0.186, 0.09], [0.197, 0.03], [0.2, -0.03], [0.192, -0.08], [0.168, -0.12],
    [0.12, -0.152], [0.05, -0.168], [0.001, -0.172],
  ]), 32).scale(1, 1, BRIEF_DEPTH), m.fabric);
  // Body-restraint strap with tether D-rings on both hips.
  add(hips, band(0.2015, 0.072, 0.046, 0.003, 0.02).scale(1, 1, BRIEF_DEPTH), m.webbing);
  for (const side of [1, -1]) {
    add(hips, box(0.012, 0.03, 0.03, 0.004, 2).translate(side * 0.2, 0.059, 0), m.metal);
    add(hips, new THREE.TorusGeometry(0.019, 0.0045, 8, 20).rotateY(Math.PI / 2).translate(side * 0.208, 0.035, 0), m.metal);
  }

  // --- Waist and hard upper torso (HUT) ------------------------------------------
  const spine = group(hips, [0, 0.1, 0]);
  add(spine, band(0.192, 0.036, -0.008, 0.005, 0.03).scale(1, 1, BRIEF_DEPTH), m.metal);
  add(spine, band(0.1935, 0.02, 0.008, 0.002, 0.01).scale(1, 1, BRIEF_DEPTH), m.bearing);
  add(spine, turned(folds(0.176, 0.011, 0.125, 0.03, 3)).scale(1, 1, 0.72), m.fabric);
  add(spine, turned(smooth([
    [0.13, 0.6], [0.165, 0.592], [0.205, 0.575], [0.238, 0.548], [0.254, 0.51], [0.258, 0.46],
    [0.254, 0.38], [0.244, 0.29], [0.226, 0.2], [0.205, 0.145], [0.192, 0.118], [0.17, 0.106], [0.1, 0.1], [0.001, 0.098],
  ], 3), 40).scale(1, 1, HUT_DEPTH), m.shell);

  // Shoulder pods with the scye bearings the arms turn in.
  for (const side of [1, -1]) {
    const scye = mat([side * 0.31, 0.5, 0], [0, 0, -side * (Math.PI / 2 + SCYE_TILT)]);
    add(spine, turned([[0.001, -0.028], ...smooth([
      [0.1, -0.03], [0.108, -0.036], [0.113, -0.055], [0.113, -0.095], [0.104, -0.135], [0.08, -0.165], [0.035, -0.18],
    ])], 32).applyMatrix4(scye), m.shell);
    add(spine, band(0.117, -0.002, -0.042, 0.005, 0.03).applyMatrix4(scye), m.metal);
    add(spine, band(0.1185, -0.016, -0.028, 0.002, 0.01).applyMatrix4(scye), m.bearing);
  }

  // Display and control module with its knobs, purge valve and status display.
  add(spine, box(0.25, 0.11, 0.1, 0.02, 2).translate(0, 0.28, 0.2), m.shellGrey);
  add(spine, box(0.06, 0.03, 0.06, 0.008, 2).translate(0, 0.35, 0.155), m.shellGrey);
  add(spine, new THREE.PlaneGeometry(0.09, 0.035).translate(0.05, 0.29, 0.2512), m.display, false);
  add(spine, new THREE.SphereGeometry(0.008, 10, 8).translate(-0.085, 0.29, 0.25), m.ledGreen, false);
  [[-0.07, m.knobRed], [-0.025, m.hoseBlue], [0.02, m.knobYellow], [0.065, m.metal]].forEach(([x, material]) => {
    add(spine, cylinder(0.013, 0.025, 14).translate(x, 0.345, 0.2), material);
  });
  add(spine, cylinder(0.016, 0.024, 16).rotateZ(Math.PI / 2).translate(-0.135, 0.27, 0.2), m.knobRed);
  add(spine, wrap(0.2605, 0.034, 0.13, 0.48).scale(1, 1, HUT_DEPTH).translate(0, 0.475, 0), m.nameTape, false);

  // Umbilical hoses from the DCM round the waist into the sides of the PLSS.
  [[1, m.hoseBlue], [-1, m.fabricShade]].forEach(([side, material]) => {
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.1, 0.25, 0.235),
      new THREE.Vector3(side * 0.175, 0.2, 0.195),
      new THREE.Vector3(side * 0.228, 0.15, 0.11),
      new THREE.Vector3(side * 0.245, 0.11, -0.02),
      new THREE.Vector3(side * 0.245, 0.09, -0.15),
      new THREE.Vector3(side * 0.235, 0.08, -0.235),
    ]);
    add(spine, new THREE.TubeGeometry(path, 40, 0.014, 10), material);
    add(spine, cylinder(0.02, 0.018).translate(side * 0.1, 0.237, 0.235), m.metal);
    add(spine, cylinder(0.021, 0.016).rotateZ(Math.PI / 2).translate(side * 0.232, 0.08, -0.235), m.metal);
  });

  // Life-support backpack (PLSS): service panel, vents, handle, antenna, beacon.
  add(spine, box(0.46, 0.6, 0.22, 0.05).translate(0, 0.33, -0.27), m.shell);
  add(spine, box(0.44, 0.14, 0.2, 0.04, 2).translate(0, -0.04, -0.27), m.shellGrey);
  add(spine, box(0.36, 0.32, 0.014, 0.005, 2).translate(0, 0.35, -0.38), m.shellGrey);
  [0.24, 0.28, 0.32].forEach((y) => add(spine, box(0.28, 0.013, 0.012, 0.004, 1).translate(0, y, -0.389), m.dark, false));
  add(spine, new THREE.PlaneGeometry(0.15, 0.038).rotateY(Math.PI).translate(0, 0.44, -0.3875), m.plssLabel, false);
  for (const side of [1, -1]) {
    for (const z of [-0.2, -0.34]) add(spine, box(0.01, 0.5, 0.012, 0.003, 1).translate(side * 0.231, 0.33, z), m.dark, false);
  }
  add(spine, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.12, 0.62, -0.33), new THREE.Vector3(-0.1, 0.665, -0.33),
    new THREE.Vector3(0.1, 0.665, -0.33), new THREE.Vector3(0.12, 0.62, -0.33),
  ]), 20, 0.011, 8), m.shellGrey);
  add(spine, cylinder(0.022, 0.03).rotateZ(Math.PI / 2).translate(0.232, -0.04, -0.27), m.knobYellow);
  add(spine, cylinder(0.006, 0.22, 8).translate(0.17, 0.73, -0.3), m.metal);
  add(spine, cylinder(0.014, 0.02, 12).translate(0.17, 0.63, -0.3), m.dark);
  add(spine, new THREE.SphereGeometry(0.014, 12, 8).translate(-0.17, 0.645, -0.31), m.beacon, false);

  // Jet pack (SAFER-style): towers down the back corners of the PLSS with a
  // nozzle cluster at each end firing sideways, up / down and fore / aft.
  const thrusterPorts = [];
  for (const side of [1, -1]) {
    add(spine, box(0.05, 0.6, 0.1, 0.012, 2).translate(side * 0.258, 0.34, -0.35), m.shellGrey);
    for (const y of [0.62, 0.07]) {
      for (const z of [-0.31, -0.39]) {
        const corner = new THREE.Vector3(side * 0.262, y, z);
        add(spine, box(0.052, 0.05, 0.05, 0.01, 2).translate(corner.x, corner.y, corner.z), m.dark);
        for (const direction of [[side, 0, 0], [0, y > 0.3 ? 1 : -1, 0], [0, 0, z > -0.35 ? 1 : -1]]) {
          const dir = new THREE.Vector3(...direction);
          const nozzle = cylinder(0.008, 0.014, 10);
          if (dir.x) nozzle.rotateZ(Math.PI / 2);
          if (dir.z) nozzle.rotateX(Math.PI / 2);
          const at = corner.clone().addScaledVector(dir, 0.03);
          add(spine, nozzle.translate(at.x, at.y, at.z), m.metal);
          thrusterPorts.push({ position: at.addScaledVector(dir, 0.008), direction: dir });
        }
      }
    }
  }

  // --- Neck ring and helmet ---------------------------------------------------------
  add(spine, turned([
    [0.12, 0.64], [0.135, 0.638], [0.15, 0.632], [0.163, 0.622], [0.167, 0.607], [0.166, 0.588], [0.155, 0.576], [0.12, 0.57],
  ], 40), m.metal);
  add(spine, band(0.1685, 0.604, 0.594, 0.002, 0.01), m.dark);
  const helmet = group(spine, [0, 0.75, 0]);
  const visorPhi = 0.95;
  const visorTop = 0.3 * Math.PI;
  const visorSpan = 0.4 * Math.PI;
  add(helmet, new THREE.SphereGeometry(0.165, 24, 16), m.helmetInner, false);
  add(helmet, new THREE.SphereGeometry(0.172, 40, 20, Math.PI / 2 - visorPhi, visorPhi * 2, visorTop, visorSpan), m.visor);
  add(helmet, new THREE.SphereGeometry(0.177, 40, 12, 0, Math.PI * 2, 0, visorTop + 0.02), m.shell);
  add(helmet, new THREE.SphereGeometry(0.177, 32, 14, Math.PI / 2 + visorPhi, Math.PI * 2 - visorPhi * 2, visorTop, visorSpan), m.shell);
  add(helmet, new THREE.SphereGeometry(0.177, 40, 4, 0, Math.PI * 2, visorTop + visorSpan - 0.02, 0.1 * Math.PI), m.shell);
  // Centre ridge of the visor assembly, from the back over the top to the visor.
  add(helmet, new THREE.TorusGeometry(0.178, 0.007, 6, 28, 1.95).rotateZ(Math.PI / 2 - 1.1).rotateY(Math.PI / 2), m.shellGrey);
  for (const side of [1, -1]) {
    add(helmet, cylinder(0.038, 0.014, 24).rotateZ(Math.PI / 2).translate(side * 0.172, -0.01, -0.01), m.shellGrey);
    add(helmet, cylinder(0.014, 0.02, 16).rotateZ(Math.PI / 2).translate(side * 0.178, -0.01, -0.01), m.metal);
    add(helmet, cylinder(0.022, 0.06, 16).rotateX(Math.PI / 2).translate(side * 0.17, 0.075, 0.03), m.shellGrey);
    add(helmet, new THREE.CircleGeometry(0.017, 16).translate(side * 0.17, 0.075, 0.0605), m.lamp, false);
  }
  add(helmet, box(0.026, 0.024, 0.05, 0.006, 2).translate(0.17, 0.112, 0.02), m.dark);
  add(helmet, new THREE.CircleGeometry(0.008, 12).translate(0.17, 0.112, 0.0455), m.helmetInner, false);
  const headlamp = new THREE.SpotLight(0xe8f6ff, 0, 9, 0.5, 0.45, 2);
  headlamp.position.set(0, 0.1, 0.16);
  headlamp.target.position.set(0, -0.6, 3);
  if (withHeadlamp) helmet.add(headlamp, headlamp.target);

  // --- Arms ----------------------------------------------------------------------
  const buildArm = (side) => {
    const shoulder = group(spine, [side * 0.31, 0.5, 0]);
    add(shoulder, ball(0.094), m.fabric);
    add(shoulder, turned(capBottom([
      ...smooth([[0.088, 0.0], [0.088, -0.05], [0.086, -0.12]]),
      ...groove(0.0845, -0.225),
      ...smooth([[0.082, -0.24], [0.078, -0.25], [0.074, -0.258]]),
    ])), m.fabric);
    add(shoulder, band(0.0915, -0.072, -0.1), m.metal);
    add(shoulder, band(0.093, -0.081, -0.091, 0.002, 0.01), m.bearing);
    add(shoulder, side > 0
      ? wrap(0.0875, 0.085, 0.085, Math.PI / 2).translate(0, -0.165, 0)
      : wrap(0.0875, 0.052, 0.072, -Math.PI / 2).translate(0, -0.16, 0),
    side > 0 ? m.patch : m.crewPatch, false);

    // Elbow convolute, turned half as far as the forearm.
    const elbowMid = group(shoulder, [0, -0.29, 0]);
    add(elbowMid, ball(0.07), m.fabric);
    add(elbowMid, turned(folds(0.069, 0.009, 0.05, -0.05, 4)), m.fabric);

    const elbow = group(shoulder, [0, -0.29, 0]);
    add(elbow, turned(capBottom([
      [0.001, -0.03], [0.05, -0.034],
      ...smooth([[0.07, -0.04], [0.071, -0.08], [0.067, -0.135]]),
      ...groove(0.0645, -0.155),
      ...smooth([[0.062, -0.17], [0.06, -0.2], [0.058, -0.222]]),
    ])), m.fabric);
    // Wrist disconnect.
    add(elbow, band(0.068, -0.198, -0.236, 0.004, 0.02), m.metal);
    add(elbow, band(0.0695, -0.211, -0.223, 0.002, 0.01), m.bearing);
    if (side > 0) {
      // Cuff checklist strapped to the left forearm.
      add(elbow, band(0.0685, -0.112, -0.124, 0.002, 0.01), m.webbing);
      add(elbow, band(0.0665, -0.166, -0.178, 0.002, 0.01), m.webbing);
      add(elbow, box(0.016, 0.085, 0.068, 0.004, 2).rotateY(0.25).translate(0.072, -0.145, 0.012), m.shellGrey);
      add(elbow, cylinder(0.0045, 0.064, 8).rotateX(Math.PI / 2).rotateY(0.25).translate(0.08, -0.103, 0.012), m.metal);
    } else {
      // Wrist mirror on the right forearm.
      add(elbow, band(0.0675, -0.14, -0.152, 0.002, 0.01), m.webbing);
      add(elbow, box(0.014, 0.022, 0.018, 0.004, 1).translate(-0.072, -0.146, 0.01), m.dark);
      add(elbow, cylinder(0.026, 0.006, 24).rotateZ(Math.PI / 2 - 0.5).translate(-0.084, -0.138, 0.012), m.dark);
      add(elbow, new THREE.CircleGeometry(0.023, 24).rotateY(-Math.PI / 2).rotateZ(-0.5).translate(-0.0873, -0.1362, 0.012), m.mirror, false);
    }

    // Glove: gauntlet, palm with grip pad, knuckle guard, jointed fingers and thumb.
    const hand = group(elbow, [0, -0.27, 0]);
    add(hand, turned(capBottom(smooth([[0.058, 0.045], [0.064, 0.02], [0.066, -0.01], [0.06, -0.04], [0.05, -0.058]]))), m.fabricShade);
    const glove = mat([0, -0.04, 0], [0, -side * Math.PI / 2, 0]);   // palm (+Z) faces the thigh
    const inGlove = (geometry, matrix = new THREE.Matrix4()) => geometry.applyMatrix4(glove.clone().multiply(matrix));
    add(hand, inGlove(box(0.09, 0.096, 0.052, 0.02).translate(0, -0.054, 0)), m.glove);
    add(hand, inGlove(box(0.072, 0.064, 0.01, 0.004, 2).translate(0, -0.06, 0.023)), m.grip);
    add(hand, inGlove(box(0.092, 0.026, 0.014, 0.006, 2).translate(0, -0.088, -0.023)), m.shellGrey);
    add(hand, inGlove(box(0.074, 0.04, 0.01, 0.004, 2).translate(0, -0.044, -0.024)), m.shellGrey);
    [[0.031, 0.0112, 0.029, 0.024], [0.0105, 0.0118, 0.032, 0.026], [-0.0105, 0.0115, 0.03, 0.025], [-0.031, 0.0105, 0.024, 0.021]]
      .forEach(([x, r, base, tip]) => {
        const knuckle = mat([side * x, -0.098, 0.004], [-0.38, 0, 0]);
        add(hand, inGlove(capsuleDown(r, base), knuckle), m.glove);
        add(hand, inGlove(capsuleDown(r * 0.95, tip), knuckle.clone().multiply(mat([0, -base, 0], [-0.6, 0, 0]))), m.grip);
      });
    const thumb = mat([side * 0.044, -0.032, 0.012], [-0.4, 0, -side * 0.45]);
    add(hand, inGlove(capsuleDown(0.0138, 0.03), thumb), m.glove);
    add(hand, inGlove(capsuleDown(0.013, 0.024), thumb.clone().multiply(mat([0, -0.03, 0], [-0.3, 0, -side * 0.3]))), m.grip);
    return { shoulder, elbowMid, elbow, hand, side };
  };
  const armL = buildArm(1);
  const armR = buildArm(-1);

  // --- Legs ----------------------------------------------------------------------
  const buildLeg = (side) => {
    const hip = group(hips, [side * 0.11, -0.06, 0]);
    add(hip, ball(0.096), m.fabric);
    add(hip, turned(capBottom([
      ...smooth([[0.096, 0.0], [0.097, -0.06], [0.095, -0.16]]),
      ...groove(0.0925, -0.2),
      ...smooth([[0.091, -0.22], [0.088, -0.28], [0.084, -0.35], [0.081, -0.385]]),
    ])), m.fabric);
    add(hip, band(0.1, -0.11, -0.137), m.metal);
    add(hip, band(0.1015, -0.119, -0.128, 0.002, 0.01), m.bearing);
    add(hip, band(0.0905, -0.3, -0.33, 0.002, 0.01), m.red);
    // Thigh pocket on the outside of the leg.
    add(hip, box(0.03, 0.09, 0.075, 0.008, 2).translate(side * 0.093, -0.24, 0.008), m.fabricShade);
    add(hip, box(0.034, 0.028, 0.079, 0.007, 2).translate(side * 0.095, -0.203, 0.008), m.shellGrey);

    // Knee convolute, turned half as far as the shin.
    const kneeMid = group(hip, [0, -0.43, 0]);
    add(kneeMid, ball(0.084), m.fabric);
    add(kneeMid, turned(folds(0.082, 0.01, 0.055, -0.055, 4)), m.fabric);

    const knee = group(hip, [0, -0.43, 0]);
    add(knee, turned(capBottom([
      [0.001, -0.035], [0.05, -0.04],
      ...smooth([[0.08, -0.05], [0.083, -0.1], [0.082, -0.16], [0.077, -0.24], [0.072, -0.3], [0.07, -0.335]]),
    ])), m.fabric);
    add(knee, band(0.077, -0.288, -0.318), m.metal);
    add(knee, band(0.0785, -0.298, -0.308, 0.002, 0.01), m.bearing);

    // EVA boot: gaiter, upper, toe cap, heel counter, straps and a lugged sole.
    const ankle = group(knee, [0, -0.41, 0]);
    add(ankle, turned(capBottom(smooth([[0.066, 0.088], [0.073, 0.06], [0.078, 0.02], [0.077, -0.02], [0.07, -0.05]]))), m.fabricShade);
    add(ankle, box(0.152, 0.115, 0.17, 0.045).translate(0, -0.045, -0.005), m.fabricShade);
    add(ankle, box(0.146, 0.072, 0.155, 0.034).translate(0, -0.068, 0.105), m.fabricShade);
    add(ankle, box(0.152, 0.042, 0.064, 0.018, 2).translate(0, -0.082, 0.164), m.shellGrey);
    add(ankle, box(0.156, 0.052, 0.055, 0.018, 2).translate(0, -0.076, -0.072), m.shellGrey);
    add(ankle, box(0.162, 0.026, 0.305, 0.01, 2).translate(0, -0.102, 0.047), m.rubber);
    for (const [y, z, tilt] of [[-0.002, 0.07, 0.55], [-0.03, 0.118, 0.35]]) {
      add(ankle, box(0.156, 0.013, 0.03, 0.005, 1).rotateX(tilt).translate(0, y, z), m.webbing);
      add(ankle, box(0.006, 0.02, 0.024, 0.002, 1).translate(side * 0.08, y - 0.012, z), m.metal);
    }
    return { hip, kneeMid, knee, ankle };
  };
  const legL = buildLeg(1);
  const legR = buildLeg(-1);
  const halfJoints = [[armL.elbowMid, armL.elbow], [armR.elbowMid, armR.elbow], [legL.kneeMid, legL.knee], [legR.kneeMid, legR.knee]];

  for (const { parent, material, shadow, parts } of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    parent.add(mesh);
  }

  // Soft contact shadow: the chamber lights cast no real-time shadows.
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 0.95).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: blobShadowTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4,
    }),
  );
  blob.position.y = 0.004;
  blob.renderOrder = 1;
  root.add(blob);

  // --- Animation ----------------------------------------------------------------
  let phase = 0;
  let walkWeight = 0;
  let runWeight = 0;
  let reachWeight = 0;
  let reachUntil = 0;
  let clock = 0;
  const reachPoint = new THREE.Vector3();
  const local = new THREE.Vector3();
  const aim = new THREE.Quaternion();

  function setLeg(leg, hipAngle, kneeAngle) {
    leg.hip.rotation.set(hipAngle, 0, 0);
    leg.knee.rotation.set(kneeAngle, 0, 0);
    leg.ankle.rotation.set(-(hipAngle + kneeAngle) * 0.85, 0, 0);
  }

  function applyReach() {
    root.updateWorldMatrix(true, false);
    local.copy(reachPoint);
    root.worldToLocal(local);
    const arm = local.x >= 0 ? armL : armR;
    spine.rotation.z = -arm.side * 0.12 * reachWeight;
    spine.updateWorldMatrix(true, false);
    local.copy(reachPoint);
    spine.worldToLocal(local);
    local.sub(arm.shoulder.position).normalize();
    aim.setFromUnitVectors(DOWN, local);
    arm.shoulder.quaternion.slerp(aim, reachWeight);
    arm.elbow.rotation.x *= 1 - 0.9 * reachWeight;
    arm.hand.rotation.x = -0.6 * reachWeight;
  }

  function blendRotation(object, x, y, z, weight) {
    const r = object.rotation;
    r.set(r.x + (x - r.x) * weight, r.y + (y - r.y) * weight, r.z + (z - r.z) * weight);
  }

  /** Relaxed "neutral body posture" of microgravity, drifting slowly. */
  function applyFloat(time, weight) {
    const drift = (rate, offset, amount) => Math.sin(time * rate + offset) * amount;
    hips.position.y += (HIP_HEIGHT - hips.position.y) * weight;
    blendRotation(spine, 0.1 + drift(0.4, 0, 0.02), drift(0.23, 1, 0.04), 0, weight);
    blendRotation(helmet, -0.06, 0, 0, weight);
    blendRotation(legL.hip, -0.55 + drift(0.5, 0.3, 0.06), 0, 0.07, weight);
    blendRotation(legR.hip, -0.4 + drift(0.43, 2.1, 0.06), 0, -0.07, weight);
    blendRotation(legL.knee, 0.9 + drift(0.5, 1.1, 0.07), 0, 0, weight);
    blendRotation(legR.knee, 0.7 + drift(0.43, 2.9, 0.07), 0, 0, weight);
    blendRotation(legL.ankle, 0.25, 0, 0, weight);
    blendRotation(legR.ankle, 0.3, 0, 0, weight);
    blendRotation(armL.shoulder, -0.55 + drift(0.37, 0.5, 0.05), 0, 0.42 + drift(0.31, 1.7, 0.04), weight);
    blendRotation(armR.shoulder, -0.5 + drift(0.33, 2.4, 0.05), 0, -0.42 - drift(0.29, 0.2, 0.04), weight);
    blendRotation(armL.elbow, -0.85, 0, 0, weight);
    blendRotation(armR.elbow, -0.8, 0, 0, weight);
    blendRotation(armL.hand, -0.25, 0, 0, weight);
    blendRotation(armR.hand, -0.25, 0, 0, weight);
  }

  /**
   * speed: horizontal walking speed in m/s actually travelled this frame.
   * float: 0 standing / walking .. 1 floating in microgravity.
   */
  function update(dt, speed, time, float = 0) {
    clock = time;
    const k = 1 - Math.exp(-dt * 8);
    walkWeight += (THREE.MathUtils.clamp(speed / 1.1, 0, 1) - walkWeight) * k;
    runWeight += (THREE.MathUtils.clamp((speed - 1.5) / 0.7, 0, 1) - runWeight) * k;
    const strideLength = THREE.MathUtils.lerp(1.25, 2.1, runWeight);
    phase = (phase + (speed / strideLength) * Math.PI * 2 * dt) % (Math.PI * 2);

    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const move = Math.min(1, walkWeight + runWeight);
    const breathe = Math.sin(time * 1.7);

    const legSwing = 0.38 * walkWeight + 0.22 * runWeight;
    const kneeLift = 0.55 * walkWeight + 0.55 * runWeight;
    setLeg(legL, -s * legSwing, Math.max(0, c) * kneeLift + 0.04 * move);
    setLeg(legR, s * legSwing, Math.max(0, -c) * kneeLift + 0.04 * move);
    hips.position.y = HIP_HEIGHT + (Math.cos(2 * phase) * 0.018 - 0.012) * move - 0.03 * runWeight;

    spine.rotation.set(0.04 * walkWeight + 0.12 * runWeight + breathe * 0.012, s * 0.07 * move, 0);
    helmet.rotation.set(-0.04 * runWeight, -s * 0.04 * move, 0);

    const armSwing = 0.32 * walkWeight + 0.4 * runWeight;
    const idleSway = breathe * 0.02 * (1 - move);
    armL.shoulder.rotation.set(s * armSwing + idleSway, 0, 0.16 + breathe * 0.01);
    armR.shoulder.rotation.set(-s * armSwing + idleSway, 0, -0.16 - breathe * 0.01);
    armL.elbow.rotation.set(-0.28 - Math.max(0, -s) * 0.35 * move - 0.5 * runWeight, 0, 0);
    armR.elbow.rotation.set(-0.28 - Math.max(0, s) * 0.35 * move - 0.5 * runWeight, 0, 0);
    armL.hand.rotation.set(-0.1, 0, 0);
    armR.hand.rotation.set(-0.1, 0, 0);
    if (float > 0.001) applyFloat(time, float);

    reachWeight += ((time < reachUntil ? 1 : 0) - reachWeight) * (1 - Math.exp(-dt * 9));
    if (reachWeight > 0.002) applyReach();
    for (const [mid, joint] of halfJoints) mid.quaternion.slerpQuaternions(IDENTITY, joint.quaternion, 0.5);

    m.beacon.emissiveIntensity = time % 1.4 < 0.12 ? 8 : 0.3;
  }

  const firing = thrusterPorts.map(() => ({ position: new THREE.Vector3(), direction: new THREE.Vector3() }));

  return {
    root,
    update,
    /** Floating: soles `alt` above the deck, lean forward / roll right in radians. */
    setPose(alt, lean, roll) {
      pose.position.y = CENTRE_OF_MASS + alt;
      pose.rotation.set(lean, 0, roll);
      blob.material.opacity = THREE.MathUtils.clamp(1 - alt * 1.4, 0.2, 1);
      blob.scale.setScalar(1 + alt * 0.6);
    },
    /** World-space nozzles whose exhaust opposes `accel` (a world vector); reuses its result array. */
    firingPorts(accel, out = []) {
      out.length = 0;
      const length = accel.length();
      if (length < 1e-4) return out;
      spine.updateWorldMatrix(true, false);
      thrusterPorts.forEach((port, i) => {
        const slot = firing[i];
        slot.direction.copy(port.direction).transformDirection(spine.matrixWorld);
        if (-slot.direction.dot(accel) / length < 0.55) return;
        slot.position.copy(port.position).applyMatrix4(spine.matrixWorld);
        out.push(slot);
      });
      return out;
    },
    /** Point the nearer arm at a world position for `duration` seconds. */
    reach(point, duration = 0.7) {
      reachPoint.copy(point);
      reachUntil = clock + duration;
    },
    setHeadlamp(on) {
      headlamp.intensity = on ? 22 : 0;
      m.lamp.emissiveIntensity = on ? 9 : 0.4;
    },
    get headlampOn() {
      return headlamp.intensity > 0;
    },
    /** The visor needs a stronger reflection than scene.environmentIntensity allows. */
    setEnvironment(texture) {
      m.visor.envMap = texture;
      m.visor.needsUpdate = true;
    },
  };
}
