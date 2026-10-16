import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
  ATMOSPHERE_KPA, chamberLook, createAirlockSystem, LIGHT_MODE_LABELS, O2_FRACTION, SEQUENCES,
} from './airlock.js';
import { createAstronaut } from './astronaut.js';
import { createEquipment } from './equipment.js';
import { createMist } from './mist.js';
import { createPanels } from './panels.js';
import { createPlayer, isLiftKey, isMoveKey, THRUST } from './player.js';
import { createThrusters } from './thrusters.js';
import {
  b2t, DOOR_CENTER_Z, DOOR_FRONT_Y, DOOR_SLIDE, FLOOR_Z, HATCH_HALF_W, HATCH_LEAF_Y, HATCH_SLIDE,
  HATCH_TOP_Z, HATCH_WALL_Y0, HATCH_WALL_Y1, HATCH_Y, isMicrogravity, roomAt, toBlenderY,
} from './world.js';
import './style.css';

// -----------------------------------------------------------------------------
// Settings.  Positions are written in Blender coordinates (Z up, corridor along
// +Y) so they can be compared with scifi_airlock.py; b2t() converts them.
// -----------------------------------------------------------------------------
const MODEL_URL = `${import.meta.env.BASE_URL}models/airlock.glb`;

const HORIZONTAL_FOV = 58.7;            // Blender camera: 32 mm lens, 36 mm sensor
const PLAYER_FOV = 80;                  // wider while following the astronaut in the tight modules
const EXPOSURE = Math.pow(2, -0.5);     // Blender exposure -0.5 EV
const LUMENS_PER_WATT = 683;            // glTF exporter: candela = W / 4pi * 683
const ENV_INTENSITY = 0.2;              // probes ignore parallax and over-spread the strips' glow
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
const SHADOW_SIZE = IS_TOUCH ? 1024 : 2048;

const UNLOCK_PHASE = 0.22;              // share of a door's travel time spent unlocking first
const INDICATOR_OPEN = new THREE.Color(0x00ff55);
const PANEL_RANGE = 1.3;                // metres from a panel's standing spot

const VIEWS = {
  corridor: { camera: [0, -3.5, 1.6], target: [0, 2.1, 1.75] },
  door: { camera: [0.75, -0.55, 1.6], target: [0, 2.1, 1.75] },
  trench: { camera: [0.85, -2.7, 1.25], target: [0.15, -0.9, 0.2] },
  ceiling: { camera: [0, -1.6, 0.95], target: [0, 0.4, 3.5] },
  // The equipment lock is only 2.5 m long, so its view widens the lens.
  equip: { camera: [0.3, 2.9, 2.1], target: [-0.15, 5.0, 1.45], fov: 86, needsOpenDoor: true },
  chamber: { camera: [0.3, 5.75, 1.6], target: [0, HATCH_Y, 1.75], needsOpenDoor: true },
};

// Lights come from the GLB (positions, colours, cones); this table only adds
// real-time settings.  Shadow maps are what make the grating cast its grid.
const LIGHT_SETUP = [
  { prefix: 'Airlock_Key_Spot', key: true, shadow: { near: 0.2, far: 12, bias: -0.0002, normalBias: 0.02 } },
  { prefix: 'Airlock_Trench_Uplight', shadow: { near: 0.05, far: 6, bias: -0.0001, normalBias: 0.004 } },
  { prefix: 'Airlock_Warning_Rim', rim: true },
  // No shadows, so they are range-limited and faded by which room the camera is in.
  { prefix: 'Equip_Light', distance: 3.2, room: 'equip' },
  { prefix: 'Chamber_Light', distance: 3.6, room: 'crew' },
];

const ENV_PROBES = {
  corridorClosed: { at: [0, -0.8, 1.7], room: 'corridor' },
  corridorOpen: { at: [0, -0.8, 1.7], room: 'corridor' },
  equip: { at: [0, 3.75, 1.9], room: 'equip' },
  crew: { at: [0, 7.4, 1.75], room: 'crew' },
};

const ROOM_INDEX = { corridor: 0, equip: 1, crew: 2 };
const ROOM_LABELS = { corridor: '站內走廊', equip: '裝備艙', crew: '氣閘艙' };

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  viewport: $('viewport'),
  doorButtons: { blast: $('blast-toggle'), hatch: $('hatch-toggle') },
  doorStatus: { blast: $('blast-status'), hatch: $('hatch-status') },
  modeButton: $('mode-toggle'),
  lampButton: $('lamp-toggle'),
  viewButtons: [...document.querySelectorAll('[data-view]')],
  hint: $('hint'),
  prompt: $('prompt'),
  toast: $('toast'),
  fade: $('fade'),
  joystick: $('joystick'),
  touchAction: $('touch-action'),
  touchLift: $('touch-lift'),
  touchUp: $('touch-up'),
  touchDown: $('touch-down'),
  telemetry: {
    room: $('t-room'),
    gravity: $('t-gravity'),
    pressure: $('t-pressure'),
    oxygen: $('t-oxygen'),
    temperature: $('t-temp'),
    light: $('t-light'),
    sequence: $('t-seq'),
    gauge: $('t-gauge'),
  },
  loader: $('loader'),
  loaderTitle: $('loader-title'),
  loaderFill: $('loader-fill'),
  loaderPct: $('loader-pct'),
};

const HINTS = {
  free: IS_TOUCH
    ? '單指旋轉 · 雙指縮放／平移 · 點擊艙門或面板按鈕'
    : '拖曳旋轉視角 · 滾輪縮放 · 右鍵拖曳平移 · 點擊艙門或面板按鈕 · 快捷鍵 O（最近的艙門）、C、1–6',
  walk: IS_TOUCH
    ? '左下搖桿移動 · 拖曳轉動鏡頭 · 點「互動」操作控制面板'
    : 'WASD／方向鍵移動 · Shift 快跑 · 拖曳轉動鏡頭 · 滾輪縮放 · E 操作面板 · F 頭燈 · Esc 自由視角',
  float: IS_TOUCH
    ? '微重力：搖桿噴氣推進 · ▲▼ 升降 · 拖曳轉動鏡頭 · 點「互動」操作控制面板'
    : '微重力：WASD 噴氣推進 · 空白鍵上升 · X 下降 · Shift 加速 · E 操作面板 · F 頭燈 · Esc 自由視角',
};

const setText = (element, text) => {
  if (element.textContent !== text) element.textContent = text;
};

let toastTimer = 0;
function toast(text) {
  setText(ui.toast, text);
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2800);
}

let audio = null;
function beep(frequency = 880, duration = 0.08, volume = 0.04) {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  } catch {
    // Audio is optional.
  }
}

/** Soft hiss of the jet-pack nozzles, `level` 0..1. */
let hiss = null;
let hissLevel = 0;
function setHiss(level) {
  if (level === hissLevel || (level > 0 && Math.abs(level - hissLevel) < 0.02)) return;
  hissLevel = level;
  try {
    if (!audio) {
      if (level <= 0) return;
      audio = new AudioContext();
    }
    if (!hiss) {
      const buffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = audio.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 3200;
      filter.Q.value = 0.8;
      hiss = audio.createGain();
      hiss.gain.value = 0;
      source.connect(filter).connect(hiss).connect(audio.destination);
      source.start();
    }
    hiss.gain.setTargetAtTime(level * 0.02, audio.currentTime, 0.06);
  } catch {
    // Audio is optional.
  }
}

let fading = false;
/** Black-out cut, used when a move would otherwise pass through a closed door. */
function fadeCut(action) {
  if (fading) return;
  fading = true;
  ui.fade.classList.add('on');
  setTimeout(() => {
    action();
    requestAnimationFrame(() => {
      ui.fade.classList.remove('on');
      fading = false;
    });
  }, 260);
}

// -----------------------------------------------------------------------------
// Renderer, camera, controls, post-processing
// -----------------------------------------------------------------------------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
} catch (error) {
  ui.loaderTitle.textContent = '你的瀏覽器不支援 WebGL，無法顯示 3D 模型。';
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.25 : 1.75));
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = EXPOSURE;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;   // shadows are re-rendered only when something moves
ui.viewport.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.environmentIntensity = ENV_INTENSITY;

const camera = new THREE.PerspectiveCamera(40, 1, 0.03, 200);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.6;
controls.screenSpacePanning = true;
controls.minDistance = 0.25;
controls.maxDistance = 7.5;

const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
);
composer.addPass(new RenderPass(scene, camera));
// The emissive strips are ~25x brighter than white, so bloom must stay faint.
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.07, 0.1, 3.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let horizontalFov = HORIZONTAL_FOV;
let viewFov = HORIZONTAL_FOV;           // free camera: the last preset view's lens

function applyFov() {
  const halfH = THREE.MathUtils.degToRad(horizontalFov / 2);
  const vertical = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfH) / camera.aspect));
  camera.fov = THREE.MathUtils.clamp(vertical, 30, 75);
  camera.updateProjectionMatrix();
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  applyFov();
  renderer.setSize(width, height);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);
}
window.addEventListener('resize', resize);
resize();

// -----------------------------------------------------------------------------
// Materials and lights
// -----------------------------------------------------------------------------
const materials = new Map();
const roomLights = { equip: [], crew: [] };
const shadowLights = [];
const chamberBaseColor = new THREE.Color(1, 1, 1);
let rimLight = null;
let stripMaterial = null;
let blastWarning = null;

/** Tiling normal map standing in for the Blender Noise/Voronoi bump. */
function createSteelNormalMap(size = 256, strength = 2.5) {
  let seed = 7;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const height = new Float32Array(size * size);
  for (const [cells, amplitude] of [[8, 0.5], [16, 0.3], [32, 0.2]]) {
    const grid = Array.from({ length: cells * cells }, random);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const gy = (y / size) * cells;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const at = (cx, cy) => grid[(cy % cells) * cells + (cx % cells)];
        const top = THREE.MathUtils.lerp(at(x0, y0), at(x0 + 1, y0), sx);
        const bottom = THREE.MathUtils.lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx);
        height[y * size + x] += THREE.MathUtils.lerp(top, bottom, sy) * amplitude;
      }
    }
  }
  const data = new Uint8Array(size * size * 4);
  const h = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const normal = new THREE.Vector3();
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
  texture.repeat.set(3, 3);                 // UVs are in metres -> ~33 cm tile
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function prepareMaterials(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    const material = object.material;
    materials.set(material.name, material);
    const isEmitter = material.emissiveIntensity > 1 || /Glass|Planet|Stars/.test(material.name);
    object.castShadow = !isEmitter;
    object.receiveShadow = !isEmitter;
  });

  const steel = materials.get('Airlock_CoatedDarkSteel');
  if (steel) {
    steel.normalMap = createSteelNormalMap();
    steel.normalScale.set(0.1, 0.1);
    steel.needsUpdate = true;
  }
  const glass = materials.get('Airlock_PortholeGlass');
  if (glass) {
    glass.transparent = true;
    glass.depthWrite = false;
  }
  stripMaterial = materials.get('Airlock_ChamberLight') ?? null;
  const warning = materials.get('Airlock_WarningEmission');
  blastWarning = warning ? { material: warning, intensity: warning.emissiveIntensity } : null;
}

function prepareLights(root) {
  const position = new THREE.Vector3();
  root.traverse((object) => {
    if (!object.isLight) return;
    const name = object.name || object.parent?.name || '';
    const setup = LIGHT_SETUP.find((entry) => name.startsWith(entry.prefix)) ?? {};
    object.intensity /= LUMENS_PER_WATT;
    if (setup.shadow) {
      object.castShadow = true;
      object.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
      object.shadow.camera.near = setup.shadow.near;
      object.shadow.camera.far = setup.shadow.far;
      object.shadow.bias = setup.shadow.bias;
      object.shadow.normalBias = setup.shadow.normalBias;
      object.shadow.autoUpdate = false;
      object.getWorldPosition(position);
      object.userData.blender = { x: position.x, y: -position.z, key: Boolean(setup.key) };
      shadowLights.push(object);
    }
    if (setup.distance) object.distance = setup.distance;
    if (setup.rim) rimLight = { light: object, intensity: object.intensity };
    if (setup.room) {
      if (setup.room === 'crew') chamberBaseColor.copy(object.color);
      roomLights[setup.room].push({ light: object, intensity: object.intensity });
    }
  });
}

function invalidateShadows(lights = shadowLights) {
  for (const light of lights) light.shadow.needsUpdate = true;
  renderer.shadowMap.needsUpdate = true;
}

// -----------------------------------------------------------------------------
// Scene additions: astronaut, equipment-lock props, outer hatch lamps,
// decon mist and jet-pack exhaust
// -----------------------------------------------------------------------------
const astronaut = createAstronaut();
scene.add(astronaut.root);
const equipment = createEquipment(scene);
const mist = createMist(scene);
const thrusters = createThrusters(scene);

const hatchLampMaterial = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xff2200, emissiveIntensity: 22 });
for (const side of [-1, 1]) {
  for (const dz of [0.92, -0.92]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.01), hatchLampMaterial);
    lamp.position.copy(b2t(side * 0.92, HATCH_Y - 0.037, DOOR_CENTER_Z + dz));
    scene.add(lamp);
  }
}

// -----------------------------------------------------------------------------
// Reflection probes: metals need something to reflect, so the scene (with its
// glowing strips) is rendered into cube maps and used as the environment.
// -----------------------------------------------------------------------------
const pmrem = new THREE.PMREMGenerator(renderer);
const environments = {};
let clockTime = 0;

function captureEnvironment(key) {
  const probe = ENV_PROBES[key];
  applyLighting(clockTime, probe.room);
  const hidden = [astronaut.root, mist.points, thrusters.points].filter((object) => object.visible);
  hidden.forEach((object) => (object.visible = false));
  const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCamera = new THREE.CubeCamera(0.05, 120, target);
  cubeCamera.position.copy(b2t(...probe.at));
  const previous = scene.environment;
  scene.environment = null;
  invalidateShadows();
  cubeCamera.update(renderer, scene);
  scene.environment = previous;
  environments[key]?.dispose();
  environments[key] = pmrem.fromCubemap(target.texture).texture;
  target.dispose();
  hidden.forEach((object) => (object.visible = true));
}

let currentEnvironment = null;
function updateEnvironment(cameraRoom) {
  const wanted = cameraRoom === 'crew' ? environments.crew
    : cameraRoom === 'equip' ? environments.equip
      : (doors.blast.phase > 0.5 && environments.corridorOpen) || environments.corridorClosed;
  if (wanted && wanted !== currentEnvironment) {
    currentEnvironment = wanted;
    scene.environment = wanted;
    astronaut.setEnvironment(wanted);
    equipment.setEnvironment(wanted);
  }
}

// -----------------------------------------------------------------------------
// Airlock systems and the two sliding doors: the blast door between the
// corridor and the equipment lock, and the hatch between the equipment lock
// and the crew lock (interlocked with the decon / depressurisation sequences).
// -----------------------------------------------------------------------------
const airlock = createAirlockSystem();
const lookState = {};

const BLAST_CENTER = b2t(0, DOOR_FRONT_Y, DOOR_CENTER_Z);
const makeDoor = (spec) => ({
  ...spec,
  phase: 0,            // 0 closed .. 1 open
  travel: 0,           // eased leaf travel 0..1
  wantOpen: false,
  moving: false,
  leaves: [],
  indicator: null,
  indicatorClosed: new THREE.Color(),
  indicatorIntensity: 1,
});
const doors = {
  blast: makeDoor({
    key: 'blast',
    label: '防爆門',
    leafNames: ['Airlock_DoorLeaf_L', 'Airlock_DoorLeaf_R'],
    slide: DOOR_SLIDE,
    duration: 2.6,
    indicatorName: 'Airlock_DoorIndicator',
    y: 2.26,
    reach: 2.4,
    // Clicks test the door plane rather than the meshes: the seam between the
    // leaves (and the open doorway) would otherwise let them fall through.
    plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), DOOR_FRONT_Y),
    contains: (point) => point.distanceTo(BLAST_CENTER) < 1.45,   // just outside the chrome trim
    waypoints: [[0, 1.2, 1.65], [0, 2.9, 1.65]],
  }),
  hatch: makeDoor({
    key: 'hatch',
    label: '氣閘門',
    leafNames: ['Hatch_Leaf_L', 'Hatch_Leaf_R'],
    slide: HATCH_SLIDE,
    duration: 2.0,
    indicatorName: 'Airlock_HatchIndicator',
    y: HATCH_LEAF_Y,
    reach: 1.9,
    plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), HATCH_LEAF_Y),
    contains: (point) => Math.abs(point.x) < HATCH_HALF_W + 0.12 && point.y > FLOOR_Z - 0.05 && point.y < HATCH_TOP_Z + 0.12,
    waypoints: [[0, 4.5, 1.6], [0, 5.8, 1.6]],
  }),
};
const DOOR_LIST = [doors.blast, doors.hatch];   // corridor | blast | equip | hatch | crew
let pendingView = null;
let pendingSequence = null;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const isOpen = (door) => door.phase >= 1 && door.wantOpen;
const lockFor = (door) => (door === doors.hatch ? airlock.lockReason : null);
const doorsBetween = (a, b) => DOOR_LIST.slice(Math.min(ROOM_INDEX[a], ROOM_INDEX[b]), Math.max(ROOM_INDEX[a], ROOM_INDEX[b]));

/** Door openness as world.js expects it: 1 only when fully open and passable. */
const doorOpenness = { blast: 0, hatch: 0 };
function getDoors() {
  for (const door of DOOR_LIST) doorOpenness[door.key] = isOpen(door) ? 1 : Math.min(door.travel, 0.99);
  return doorOpenness;
}

function prepareDoors(root) {
  for (const door of DOOR_LIST) {
    door.leaves = door.leafNames
      .map((name, i) => {
        const node = root.getObjectByName(name);
        return node && { node, side: i === 0 ? -1 : 1, baseX: node.position.x };
      })
      .filter(Boolean);
    door.indicator = materials.get(door.indicatorName) ?? null;
    if (door.indicator) {
      door.indicatorClosed.copy(door.indicator.emissive);
      door.indicatorIntensity = door.indicator.emissiveIntensity;
    }
  }
}

/** Every door request goes through the interlocks. */
function requestDoor(door, open) {
  if (open === door.wantOpen) return true;
  const lock = lockFor(door);
  if (lock) {
    toast(`互鎖：${lock}，${door.label}已鎖定`);
    beep(220, 0.15);
    return false;
  }
  if (!open && player.inDoorway(door.key)) {
    toast(`${door.label}感應到人員，無法關閉`);
    beep(220, 0.15);
    return false;
  }
  door.wantOpen = open;
  if (!open) pendingView = null;
  return true;
}

function updateDoor(door, dt) {
  const previous = door.phase;
  door.phase = THREE.MathUtils.clamp(door.phase + ((door.wantOpen ? 1 : -1) * dt) / door.duration, 0, 1);
  door.moving = door.phase !== previous;
  if (!door.moving) return;

  const unlock = THREE.MathUtils.clamp(door.phase / UNLOCK_PHASE, 0, 1);
  door.travel = easeInOutCubic(THREE.MathUtils.clamp((door.phase - UNLOCK_PHASE) / (1 - UNLOCK_PHASE), 0, 1));
  for (const leaf of door.leaves) leaf.node.position.x = leaf.baseX + leaf.side * door.slide * door.travel;
  door.indicator?.emissive.lerpColors(door.indicatorClosed, INDICATOR_OPEN, unlock);
  invalidateShadows();
  if (door.phase === 0 || door.phase === 1) onDoorSettled(door);
}

function onDoorSettled(door) {
  if (door === doors.blast && door.phase === 1 && !environments.corridorOpen) captureEnvironment('corridorOpen');
  if (door.phase === 1 && pendingView) {
    const view = VIEWS[pendingView];
    const route = doorsBetween(roomAt(toBlenderY(camera.position)), roomAt(view.camera[1]));
    if (route.every(isOpen)) {
      const key = pendingView;
      pendingView = null;
      flyTo(key);
    }
  }
  if (door === doors.hatch && door.phase === 0 && pendingSequence) {
    const kind = pendingSequence;
    pendingSequence = null;
    startSequence(kind);
  }
}

function startSequence(kind) {
  const label = SEQUENCES[kind].label;
  if (airlock.state.sequence) {
    toast('已有程序進行中，請稍候');
    return;
  }
  const hatch = doors.hatch;
  if (hatch.phase > 0 || hatch.wantOpen) {
    if (!requestDoor(hatch, false)) return;
    pendingSequence = kind;
    toast(`正在關閉氣閘門，隨後開始${label}`);
    return;
  }
  airlock.start(kind);
  toast(`${label}開始`);
}

/** How much of each room's light the camera can see through the doors. */
function roomVisibility(cameraRoom) {
  const blast = doors.blast.travel;
  const hatch = doors.hatch.travel;
  if (cameraRoom === 'corridor') return { corridor: 1, equip: blast, crew: blast * hatch };
  if (cameraRoom === 'equip') return { corridor: blast, equip: 1, crew: hatch };
  return { corridor: blast * hatch, equip: hatch, crew: 1 };
}

/** Lights, strips and lamps for the current airlock state and camera room. */
function applyLighting(time, cameraRoom) {
  const look = chamberLook(airlock.state, time, chamberBaseColor, lookState);
  // With no shadows, module light would leak through the bulkheads (and the
  // rim light into the modules), so each room's lights fade with the doors.
  const visible = roomVisibility(cameraRoom);
  for (const { light, intensity } of roomLights.crew) {
    light.color.copy(look.lightColor);
    light.intensity = intensity * look.level * visible.crew;
  }
  for (const { light, intensity } of roomLights.equip) light.intensity = intensity * visible.equip;
  if (rimLight) rimLight.light.intensity = rimLight.intensity * visible.corridor;
  if (stripMaterial) {
    stripMaterial.emissive.copy(look.stripColor);
    stripMaterial.emissiveIntensity = look.stripIntensity;
  }
  hatchLampMaterial.emissive.setHex(look.hatch === 'open' ? 0x00ff55 : 0xff2200);
  hatchLampMaterial.emissiveIntensity = look.hatch === 'blink' && Math.sin(time * 9) < 0 ? 1 : 22;
  const pulse = 0.45 + 0.55 * Math.abs(Math.sin(time * 6));
  if (blastWarning) blastWarning.material.emissiveIntensity = blastWarning.intensity * (doors.blast.moving || look.beacon ? pulse : 1);
  const hatch = doors.hatch;
  if (hatch.indicator) hatch.indicator.emissiveIntensity = hatch.indicatorIntensity * (hatch.moving ? pulse : 1);
  scene.environmentIntensity = ENV_INTENSITY * (cameraRoom === 'crew' ? THREE.MathUtils.clamp(look.level, 0.12, 1) : 1);
  return look;
}

// -----------------------------------------------------------------------------
// Control panels
// -----------------------------------------------------------------------------
const doorPanel = { width: 0.36, height: 0.45, captionSize: 0.016,
  screen: { x: 0, y: 0.07, w: 0.31, h: 0.17, lineHeight: 0.034, labelSize: 0.017, valueSize: 0.02 } };
const PANEL_DEFS = [
  {
    id: 'corridor',
    title: '防爆門控制',
    code: 'AL-07 · A',
    zone: 'corridor',
    mount: b2t(-1.448, 0.99, 1.57),
    normal: new THREE.Vector3(1, 0, 0),
    width: 0.28,
    height: 0.42,
    stand: [-0.8, 0.6],
    screen: { x: 0, y: 0.06, w: 0.236, h: 0.16, lineHeight: 0.028, statusSize: 0.018 },
    buttons: [{ id: 'blast', x: 0, y: -0.1, label: '開啟艙門' }],
    content: (s) => ({ status: s.blastStatus, tone: s.blastTone, rows: [['前方艙室', '裝備艙'], ['艙內重力', '微重力']] }),
  },
  {
    id: 'equip-blast',
    title: '防爆門控制',
    code: 'AL-07 · B',
    zone: 'equip',
    mount: b2t(-1.466, 3.04, 1.775),
    normal: new THREE.Vector3(1, 0, 0),
    stand: [-0.32, 3.32],
    ...doorPanel,
    buttons: [{ id: 'blast', x: 0, y: -0.11, label: '開啟艙門' }],
    content: (s) => ({ status: s.blastStatus, tone: s.blastTone, rows: [['通往', '站內走廊'], ['走廊重力', '1.00 g']] }),
  },
  {
    id: 'hatch-equip',
    title: '氣閘門控制',
    code: 'AL-07 · C',
    zone: 'equip',
    mount: b2t(1.466, 4.62, 1.775),
    normal: new THREE.Vector3(-1, 0, 0),
    stand: [0.42, 4.25],
    ...doorPanel,
    buttons: [{ id: 'hatch', x: 0, y: -0.11, label: '開啟艙門' }],
    content: (s) => ({ status: s.hatchStatus, tone: s.hatchTone, rows: [['氣閘艙壓', s.pressureText], ['互鎖', s.lockText]] }),
  },
  {
    id: 'hatch-crew',
    title: '氣閘門控制',
    code: 'AL-07 · D',
    zone: 'crew',
    mount: b2t(-1.466, 5.68, 1.775),
    normal: new THREE.Vector3(1, 0, 0),
    stand: [-0.42, 6.05],
    ...doorPanel,
    buttons: [{ id: 'hatch', x: 0, y: -0.11, label: '開啟艙門' }],
    content: (s) => ({ status: s.hatchStatus, tone: s.hatchTone, rows: [['艙壓', s.pressureText], ['互鎖', s.lockText]] }),
  },
  {
    id: 'console',
    title: '氣閘控制台',
    code: 'AL-07 · MAIN',
    zone: 'crew',
    mount: b2t(1.466, 6.05, 1.8),
    normal: new THREE.Vector3(-1, 0, 0),
    width: 0.72,
    height: 0.5,
    stand: [0.42, 6.4],
    screen: {
      x: 0, y: 0.065, w: 0.64, h: 0.24, columns: 2,
      lineHeight: 0.04, statusSize: 0.026, labelSize: 0.02, valueSize: 0.026, barSize: 0.012, barLabelSize: 0.015,
    },
    captionSize: 0.018,
    buttons: [
      { id: 'lights', x: -0.22, y: -0.135, label: '照明' },
      { id: 'decon', x: 0, y: -0.135, label: '消毒程序' },
      { id: 'cycle', x: 0.22, y: -0.135, label: '洩壓循環' },
    ],
    content: (s) => ({
      status: s.consoleStatus,
      tone: s.consoleTone,
      rows: [['艙壓', s.pressureText], ['O₂ 分壓', s.oxygenText], ['溫度', s.temperatureText], ['照明', s.lightText]],
      bars: [{ label: s.barLabel, value: s.barValue, tone: s.barTone }],
    }),
  },
];
const panels = createPanels(scene, PANEL_DEFS);
const DOOR_BUTTONS = [
  ['corridor.blast', doors.blast], ['equip-blast.blast', doors.blast],
  ['hatch-equip.hatch', doors.hatch], ['hatch-crew.hatch', doors.hatch],
];

const BUTTON_ACTIONS = {
  blast: () => requestDoor(doors.blast, !doors.blast.wantOpen),
  hatch: () => requestDoor(doors.hatch, !doors.hatch.wantOpen),
  lights: () => toast(`氣閘艙照明：${LIGHT_MODE_LABELS[airlock.cycleLights()]}`),
  decon: () => startSequence('decon'),
  cycle: () => startSequence('cycle'),
};

function doorReading(door) {
  if (lockFor(door)) return ['互鎖・艙門鎖定', 'red'];
  if (door.phase > 0 && door.phase < 1) return [door.wantOpen ? '艙門開啟中…' : '艙門關閉中…', 'amber'];
  if (door.phase >= 1) return ['艙門已開啟', 'green'];
  return ['艙門已關閉', 'cyan'];
}

function buildSnapshot() {
  const s = airlock.state;
  const sequence = s.sequence;
  const [blastStatus, blastTone] = doorReading(doors.blast);
  const [hatchStatus, hatchTone] = doorReading(doors.hatch);
  const ratio = s.pressure / ATMOSPHERE_KPA;
  return {
    blastStatus,
    blastTone,
    hatchStatus,
    hatchTone,
    lockText: airlock.lockReason ? '啟動' : '正常',
    pressureText: `${s.pressure.toFixed(1)} kPa`,
    oxygenText: s.pressure > 1 ? `${(s.pressure * O2_FRACTION).toFixed(1)} kPa` : '—',
    temperatureText: `${s.temperature.toFixed(1)} °C`,
    lightText: LIGHT_MODE_LABELS[s.lightMode],
    sequenceText: sequence ? s.step.label : '待命',
    consoleStatus: sequence ? `${SEQUENCES[sequence.kind].label}・${s.step.label}` : '系統待命',
    consoleTone: sequence ? (sequence.kind === 'decon' ? 'violet' : 'red') : 'green',
    barLabel: sequence ? `程序進度 ${Math.round(s.step.progress * 100)}%` : `艙壓 ${Math.round(ratio * 100)}%`,
    barValue: sequence ? s.step.progress : ratio,
    barTone: sequence ? (sequence.kind === 'decon' ? 'violet' : 'amber') : 'cyan',
    pressureRatio: ratio,
  };
}

function syncButtons() {
  for (const [key, door] of DOOR_BUTTONS) {
    panels.setButton(key, {
      label: door.wantOpen ? '關閉艙門' : '開啟艙門',
      tone: door.wantOpen ? 'amber' : 'cyan',
      enabled: !lockFor(door),
      blink: door.phase > 0 && door.phase < 1,
    });
  }
  const sequence = airlock.state.sequence?.kind ?? pendingSequence;
  const mode = airlock.state.lightMode;
  panels.setButton('console.lights', {
    label: `照明：${LIGHT_MODE_LABELS[mode]}`,
    tone: { normal: 'cyan', alert: 'red', off: 'amber' }[mode],
  });
  panels.setButton('console.decon', { tone: 'violet', enabled: !sequence || sequence === 'decon', blink: sequence === 'decon' });
  panels.setButton('console.cycle', { tone: 'red', enabled: !sequence || sequence === 'cycle', blink: sequence === 'cycle' });
}

// -----------------------------------------------------------------------------
// Player (third person) and modes
// -----------------------------------------------------------------------------
const player = createPlayer({ camera, astronaut, getDoors, spawn: { x: -0.38, y: 8.5, heading: Math.PI - 0.4 } });
let mode = 'free';           // 'free' orbit viewer | 'player' third person
let shownFloating = null;

function nearestPanel() {
  const zone = player.room;
  let best = null;
  let bestDistance = PANEL_RANGE;
  for (const panel of panels.panels) {
    const distance = player.distanceTo(panel.def.stand);
    if (panel.def.zone === zone && distance < bestDistance) {
      best = panel;
      bestDistance = distance;
    }
  }
  return best;
}

function setMode(next) {
  if (next === mode) return;
  if (next === 'player') {
    tween = null;
    pendingView = null;
    controls.enabled = false;
    player.enter(controls.target);
    const blocked = doorsBetween(roomAt(toBlenderY(camera.position)), player.room).some((door) => !isOpen(door));
    if (blocked) fadeCut(() => player.snapCamera());
  } else {
    player.leavePanel();
    player.keys.clear();
    player.touch.set(0, 0);
    player.setLift(0);
    controls.target.copy(player.pivot);
    controls.enabled = true;
    astronaut.root.visible = true;
  }
  mode = next;
  syncModeUi();
  beep(next === 'player' ? 740 : 520, 0.06);
}

function syncModeUi() {
  const playing = mode === 'player';
  const floating = player.floating;
  shownFloating = floating;
  setText(ui.modeButton, playing ? '自由視角' : '操控太空人');
  ui.modeButton.classList.toggle('active', playing);
  ui.lampButton.hidden = !playing;
  ui.joystick.hidden = !(playing && IS_TOUCH);
  ui.touchAction.hidden = !(playing && IS_TOUCH);
  ui.touchLift.hidden = !(playing && IS_TOUCH && floating);
  setText(ui.hint, playing ? (floating ? HINTS.float : HINTS.walk) : HINTS.free);
  if (playing) ui.viewButtons.forEach((button) => button.classList.remove('active'));
}

function interact() {
  if (mode !== 'player') return;
  if (player.state.focus) {
    player.leavePanel();
    return;
  }
  const panel = nearestPanel();
  if (!panel) {
    toast('附近沒有控制面板，請靠近牆上的面板');
    return;
  }
  player.focusPanel(panel);
  beep(660, 0.06);
}

function toggleHeadlamp() {
  astronaut.setHeadlamp(!astronaut.headlampOn);
  setText(ui.lampButton, astronaut.headlampOn ? '頭燈：開' : '頭燈：關');
  ui.lampButton.classList.toggle('active', astronaut.headlampOn);
  beep(astronaut.headlampOn ? 990 : 600, 0.05);
}

const pressPoint = new THREE.Vector3();
function pressButton(button) {
  const panel = button.panel;
  if (mode === 'player' && !player.state.focus && player.distanceTo(panel.def.stand) > PANEL_RANGE) {
    toast(`請靠近「${panel.def.title}」再操作（靠近後按 E）`);
    return;
  }
  panels.flash(button);
  if (mode === 'player') {
    button.cap.getWorldPosition(pressPoint);
    astronaut.reach(pressPoint);
    player.faceToward(panel);
  }
  if (!button.enabled) {
    beep(220, 0.15);
    toast(airlock.lockReason ? `互鎖：${airlock.lockReason}` : '此功能暫時無法使用');
    return;
  }
  beep(880);
  BUTTON_ACTIONS[button.id]?.();
}

// Jet-pack exhaust: puffs from the nozzles that oppose the commanded thrust.
const firingPorts = [];
const jetWorld = new THREE.Vector3();
let puffBudget = 0;
function updateJets(dt) {
  const jet = player.state.thrust;
  const level = Math.min(1, jet.length() / THRUST);
  setHiss(level > 0.05 ? level : 0);
  if (level <= 0.05) {
    puffBudget = 0;
    return;
  }
  jetWorld.set(jet.x, jet.z, -jet.y);
  astronaut.firingPorts(jetWorld, firingPorts);
  if (!firingPorts.length) return;
  puffBudget += dt * 110 * level;
  while (puffBudget >= 1) {
    const port = firingPorts[Math.floor(Math.random() * firingPorts.length)];
    thrusters.emit(port.position, port.direction);
    puffBudget -= 1;
  }
}

// -----------------------------------------------------------------------------
// Free camera: preset flights and limits
// -----------------------------------------------------------------------------
let tween = null;

function markView(key) {
  ui.viewButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === key));
}

function flyTo(key) {
  const view = VIEWS[key];
  if (!view) return;
  if (mode !== 'free') setMode('free');
  const from = camera.position.clone();
  const to = b2t(...view.camera);
  const target = b2t(...view.target);
  const fromRoom = roomAt(toBlenderY(from));
  const toRoom = roomAt(view.camera[1]);
  const route = doorsBetween(fromRoom, toRoom);
  markView(key);
  viewFov = view.fov ?? HORIZONTAL_FOV;
  const closed = route.filter((door) => door.phase < 1);
  if (closed.length) {
    if (view.needsOpenDoor && closed.every((door) => !lockFor(door))) {
      pendingView = key;
      closed.forEach((door) => requestDoor(door, true));
      return;
    }
    fadeCut(() => {
      tween = null;
      camera.position.copy(to);
      controls.target.copy(target);
    });
    return;
  }
  // Thread the flight through the doorways in the order they are crossed.
  const forward = ROOM_INDEX[toRoom] >= ROOM_INDEX[fromRoom];
  const points = [from];
  for (const door of forward ? route : [...route].reverse()) {
    for (const point of forward ? door.waypoints : [...door.waypoints].reverse()) points.push(b2t(...point));
  }
  points.push(to);
  tween = {
    path: points.length > 2 ? new THREE.CatmullRomCurve3(points) : new THREE.LineCurve3(from, to),
    fromTarget: controls.target.clone(),
    toTarget: target,
    duration: 1.5 + 0.9 * route.length,
    elapsed: 0,
  };
  controls.enabled = false;
}

function updateTween(dt) {
  tween.elapsed += dt;
  const t = Math.min(tween.elapsed / tween.duration, 1);
  const eased = easeInOutCubic(t);
  camera.position.copy(tween.path.getPoint(eased));
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
  if (t === 1) {
    tween = null;
    controls.enabled = true;
  }
}

// Y spans the orbiting camera may use in each room; open doors join them.
const CAMERA_ROOMS = [[-3.85, 1.75], [2.62, HATCH_WALL_Y0 - 0.15], [HATCH_WALL_Y1 + 0.15, HATCH_Y - 0.3]];

/** Keep the orbiting camera inside the rooms it can reach, funnelled through doorways. */
function clampFreeCamera(position) {
  const clamp = THREE.MathUtils.clamp;
  let x = position.x;
  let y = -position.z;
  let z = position.y;
  const room = y < 2.3 ? 0 : y < HATCH_LEAF_Y ? 1 : 2;
  let first = room;
  let last = room;
  while (first > 0 && DOOR_LIST[first - 1].phase > 0.98) first--;
  while (last < 2 && DOOR_LIST[last].phase > 0.98) last++;
  y = clamp(y, CAMERA_ROOMS[first][0], CAMERA_ROOMS[last][1]);
  const outside = (y0, y1) => Math.max(0, y0 - y, y - y1);
  const blast = outside(1.85, 2.6);
  const hatch = outside(HATCH_WALL_Y0 - 0.1, HATCH_WALL_Y1 + 0.1);
  const corridor = y <= 1.85;
  const xMax = Math.min(corridor ? 1.3 : 1.1, 0.95 + 2 * blast, 0.42 + 2 * hatch);
  const zMax = Math.min(corridor ? 3.35 : 2.85, 2.8 + 2 * blast, 2.6 + 2 * hatch);
  x = clamp(x, -xMax, xMax);
  z = clamp(z, corridor ? 0.62 : 0.65, zMax);
  position.set(x, z, -y);
}

function clampTarget(target) {
  target.x = THREE.MathUtils.clamp(target.x, -1.5, 1.5);
  target.y = THREE.MathUtils.clamp(target.y, 0.0, 3.6);
  target.z = THREE.MathUtils.clamp(target.z, -(HATCH_Y + 0.1), 4.0);
}

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const doorHit = new THREE.Vector3();
let doorOccluders = [];
let occluders = [astronaut.root];
// While a panel is focused the camera keeps the body clear of it, but a reaching
// arm would otherwise swallow the next click.
const pickOccluders = () => (player.state.focus ? doorOccluders : occluders);

function setRay(event) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
}

/** The door under the pointer; through an open doorway, the door beyond it. */
function doorUnderRay() {
  const hits = [];
  for (const door of DOOR_LIST) {
    if (!door.leaves.length || !raycaster.ray.intersectPlane(door.plane, doorHit) || !door.contains(doorHit)) continue;
    hits.push({ door, distance: doorHit.distanceTo(raycaster.ray.origin) });
  }
  hits.sort((a, b) => a.distance - b.distance);
  if (hits.length > 1 && hits[0].door.travel > 0.9) return hits[1].door;
  return hits[0]?.door ?? null;
}

const playerNearDoor = (door) => Math.abs(player.state.pos.y - door.y) < door.reach;

/** The door closest to the astronaut (player mode) or the camera. */
function nearestDoor() {
  const y = mode === 'player' ? player.state.pos.y : toBlenderY(camera.position);
  return DOOR_LIST.reduce((best, door) => (Math.abs(door.y - y) < Math.abs(best.y - y) ? door : best));
}

function pickButton() {
  const canUsePanels = mode === 'free' || player.state.focus || nearestPanel();
  return canUsePanels ? panels.pick(raycaster, pickOccluders()) : null;
}

function handleClick(event) {
  setRay(event);
  const button = panels.pick(raycaster, pickOccluders());
  if (button) {
    pressButton(button);
    return;
  }
  if (mode === 'player' && player.state.focus) return;
  const door = doorUnderRay();
  if (!door) return;
  if (mode === 'player' && !playerNearDoor(door)) {
    toast(`請靠近${door.label}，或使用牆上的控制面板`);
    return;
  }
  requestDoor(door, !door.wantOpen);
}

const pointer = { id: null, x: 0, y: 0, startX: 0, startY: 0, time: 0 };
canvas.addEventListener('pointerdown', (event) => {
  if (pointer.id !== null) return;
  Object.assign(pointer, {
    id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: performance.now(),
  });
  if (mode === 'player') canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (event.pointerId === pointer.id && mode === 'player' && !player.state.focus) {
    player.rotate(event.clientX - pointer.x, event.clientY - pointer.y);
  }
  if (event.pointerId === pointer.id) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  }
  if (!IS_TOUCH && !event.buttons) queueHover(event);
});
const endPointer = (event) => {
  if (event.pointerId !== pointer.id) return;
  pointer.id = null;
  const moved = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
  if (event.type === 'pointerup' && moved < 6 && performance.now() - pointer.time < 500 && !tween) handleClick(event);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (event) => {
  if (mode !== 'player' || player.state.focus) return;
  event.preventDefault();
  player.zoom(event.deltaY);
}, { passive: false });

let hoverQueued = false;
function queueHover(event) {
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    setRay(event);
    const button = pickButton();
    panels.setHover(button);
    const door = button ? null : doorUnderRay();
    const overDoor = door && (mode === 'free' || playerNearDoor(door));
    canvas.style.cursor = button || overDoor ? 'pointer' : '';
  });
}

for (const button of document.querySelectorAll('.toolbar button')) {
  // Keep Space/Enter from re-triggering a toolbar button while moving.
  button.addEventListener('click', () => button.blur());
}
for (const door of DOOR_LIST) ui.doorButtons[door.key].addEventListener('click', () => requestDoor(door, !door.wantOpen));
ui.modeButton.addEventListener('click', () => setMode(mode === 'free' ? 'player' : 'free'));
ui.lampButton.addEventListener('click', toggleHeadlamp);
ui.viewButtons.forEach((button) => button.addEventListener('click', () => flyTo(button.dataset.view)));
ui.touchAction.addEventListener('click', interact);
for (const [button, value] of [[ui.touchUp, 1], [ui.touchDown, -1]]) {
  button.addEventListener('pointerdown', (event) => {
    button.setPointerCapture(event.pointerId);
    player.setLift(value);
    player.leavePanel();
  });
  const release = () => player.setLift(0);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) return;
  if (mode === 'player') {
    const steering = isMoveKey(event.code) || isLiftKey(event.code);
    if (steering || event.code.startsWith('Shift')) {
      player.keys.add(event.code);
      if (steering) {
        event.preventDefault();
        player.leavePanel();
      }
      return;
    }
    if (event.repeat) return;
    if (event.code === 'KeyE') return interact();
    if (event.code === 'KeyF') return toggleHeadlamp();
    if (event.code === 'Escape') return player.state.focus ? player.leavePanel() : setMode('free');
  } else if (!event.repeat) {
    const index = Number(event.key) - 1;
    if (index >= 0 && index < ui.viewButtons.length) return flyTo(ui.viewButtons[index].dataset.view);
  }
  if (event.repeat) return;
  if (event.code === 'KeyO') {
    const door = nearestDoor();
    requestDoor(door, !door.wantOpen);
  }
  if (event.code === 'KeyC') setMode(mode === 'free' ? 'player' : 'free');
});
window.addEventListener('keyup', (event) => player.keys.delete(event.code));
window.addEventListener('blur', () => {
  player.keys.clear();
  player.setLift(0);
});

// On-screen joystick for touch devices.
{
  const knob = ui.joystick.querySelector('.knob');
  const RADIUS = 46;
  let stickId = null;
  let cx = 0;
  let cy = 0;
  const move = (event) => {
    let dx = event.clientX - cx;
    let dy = event.clientY - cy;
    const length = Math.hypot(dx, dy);
    if (length > RADIUS) {
      dx *= RADIUS / length;
      dy *= RADIUS / length;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    player.touch.set(dx / RADIUS, -dy / RADIUS);
    if (length > 10) player.leavePanel();
  };
  ui.joystick.addEventListener('pointerdown', (event) => {
    stickId = event.pointerId;
    ui.joystick.setPointerCapture(event.pointerId);
    const rect = ui.joystick.getBoundingClientRect();
    cx = rect.left + rect.width / 2;
    cy = rect.top + rect.height / 2;
    move(event);
  });
  ui.joystick.addEventListener('pointermove', (event) => event.pointerId === stickId && move(event));
  const end = (event) => {
    if (event.pointerId !== stickId) return;
    stickId = null;
    player.touch.set(0, 0);
    knob.style.transform = '';
  };
  ui.joystick.addEventListener('pointerup', end);
  ui.joystick.addEventListener('pointercancel', end);
}

// -----------------------------------------------------------------------------
// HUD
// -----------------------------------------------------------------------------
function updateDoorUi() {
  for (const door of DOOR_LIST) {
    const row = ui.doorStatus[door.key];
    let state = 'moving';
    let label = door.wantOpen
      ? `${door.label}${door.phase < UNLOCK_PHASE ? '解鎖中…' : '開啟中…'}`
      : `${door.label}關閉中…`;
    if (door.phase === 0 && !door.wantOpen) {
      state = 'closed';
      label = lockFor(door) ? `${door.label}互鎖中` : `${door.label}已鎖定`;
    } else if (door.phase === 1 && door.wantOpen) {
      state = 'open';
      label = `${door.label}已開啟`;
    }
    if (row.dataset.state !== state) row.dataset.state = state;
    setText(row.querySelector('.label'), label);
    const button = ui.doorButtons[door.key];
    setText(button, `${door.wantOpen ? '關閉' : '開啟'}${door.label}`);
    button.classList.toggle('is-open', door.wantOpen);
  }
}

function updateTelemetry(snapshot) {
  const t = ui.telemetry;
  const y = mode === 'player' ? player.state.pos.y : toBlenderY(camera.position);
  setText(t.room, ROOM_LABELS[roomAt(y)]);
  setText(t.gravity, isMicrogravity(y) ? '微重力 ≈ 0 g' : '1.00 g');
  setText(t.pressure, snapshot.pressureText);
  setText(t.oxygen, snapshot.oxygenText);
  setText(t.temperature, snapshot.temperatureText);
  setText(t.light, snapshot.lightText);
  setText(t.sequence, snapshot.sequenceText);
  const width = `${Math.round(snapshot.pressureRatio * 100)}%`;
  if (t.gauge.style.width !== width) t.gauge.style.width = width;
}

let promptText = null;
function updatePrompt() {
  let text = '';
  if (mode === 'player') {
    if (player.state.focus) {
      text = IS_TOUCH ? '點擊面板按鈕操作 · 點「互動」離開' : '點擊面板按鈕操作 · E／Esc 離開面板';
    } else {
      const panel = nearestPanel();
      if (panel) text = IS_TOUCH ? `點「互動」操作「${panel.def.title}」` : `按 E 操作「${panel.def.title}」`;
    }
  }
  if (text === promptText) return;
  promptText = text;
  setText(ui.prompt, text);
  ui.prompt.hidden = !text;
}

// -----------------------------------------------------------------------------
// Load and run
// -----------------------------------------------------------------------------
function setProgress(fraction) {
  const pct = Math.round(fraction * 100);
  ui.loaderFill.style.width = `${pct}%`;
  ui.loaderPct.textContent = `${pct}%`;
}

const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG));
loader.load(
  MODEL_URL,
  (gltf) => {
    scene.add(gltf.scene);
    prepareMaterials(gltf.scene);
    prepareLights(gltf.scene);
    prepareDoors(gltf.scene);
    doorOccluders = [
      ...DOOR_LIST.flatMap((door) => door.leafNames), 'Airlock_DoorBulkhead', 'Airlock_DoorTrim', 'Hatch_Bulkhead', 'Hatch_Trim',
    ].map((name) => gltf.scene.getObjectByName(name)).filter(Boolean);
    occluders = [...doorOccluders, astronaut.root];
    player.update(0, 0, false);
    captureEnvironment('crew');
    captureEnvironment('equip');
    captureEnvironment('corridorClosed');

    const start = VIEWS.corridor;
    camera.position.copy(b2t(...start.camera));
    controls.target.copy(b2t(...start.target));
    controls.update();
    markView('corridor');
    syncModeUi();

    [...Object.values(ui.doorButtons), ui.modeButton, ...ui.viewButtons].forEach((button) => (button.disabled = false));
    setProgress(1);
    ui.loader.classList.add('done');
    renderer.setAnimationLoop(frame);
  },
  (event) => {
    if (event.lengthComputable) setProgress(event.loaded / event.total);
  },
  (error) => {
    console.error(error);
    ui.loaderTitle.textContent = '模型載入失敗，請重新整理頁面。';
  },
);

/** Re-render shadows only for lights whose shadow the astronaut can change. */
function invalidateShadowsNearPlayer() {
  const { x, y } = player.state.pos;
  const lights = shadowLights.filter(({ userData: { blender } }) => (blender.key
    ? y < 2.0 || doors.blast.travel > 0
    : Math.hypot(blender.x - x, blender.y - y) < 2.6));
  if (lights.length) invalidateShadows(lights);
}

let lastTime = performance.now();
function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  clockTime = now / 1000;

  for (const door of DOOR_LIST) updateDoor(door, dt);
  const finished = airlock.update(dt);
  if (finished) {
    toast(`${SEQUENCES[finished].label}完成`);
    beep(990, 0.15);
  }

  const fovTarget = mode === 'free' ? viewFov : player.state.focus ? player.state.focusFov : PLAYER_FOV;
  if (Math.abs(fovTarget - horizontalFov) > 0.01) {
    horizontalFov += (fovTarget - horizontalFov) * (1 - Math.exp(-dt * 5));
    applyFov();
  }

  player.update(dt, clockTime, mode === 'player');
  updateJets(dt);
  thrusters.update(dt);
  equipment.update(dt, clockTime, player.state);
  if (mode === 'free') {
    if (tween) {
      updateTween(dt);
    } else {
      controls.update();
      clampTarget(controls.target);
      clampFreeCamera(camera.position);
    }
    camera.lookAt(controls.target);
  }
  if (player.state.moved) invalidateShadowsNearPlayer();

  const cameraRoom = roomAt(toBlenderY(camera.position));
  const look = applyLighting(clockTime, cameraRoom);
  mist.update(dt, look.mist, look.mistColor);

  syncButtons();
  const snapshot = buildSnapshot();
  panels.update(dt, clockTime, snapshot);
  updateDoorUi();
  updateTelemetry(snapshot);
  updatePrompt();
  if (player.floating !== shownFloating) syncModeUi();
  updateEnvironment(cameraRoom);
  composer.render();
}

// Exposed for debugging in the browser console.
window.airlock = {
  scene, camera, controls, renderer, bloom, environments, materials, doors, airlock, player, panels, astronaut,
  equipment, thrusters, flyTo, setMode, interact, startSequence,
  requestDoor: (key, open) => requestDoor(doors[key], open),
  get mode() {
    return mode;
  },
};
