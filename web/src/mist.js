import * as THREE from 'three';
import { b2t, CHAMBER_RING_YS, DOOR_CENTER_Z, HATCH_WALL_Y1, HATCH_Y } from './world.js';

// Particle mist for the crew lock: decon spray from the ring frames, air
// venting towards the hatch, and air refilling from the rings.  Microgravity:
// the droplets only drift and slow down, they never settle.
const COUNT = 1100;
const RING_RADIUS = 1.22;
const HATCH = b2t(0, HATCH_Y - 0.1, DOOR_CENTER_Z);
const SPAWN_RATE = { spray: 320, vent: 180, fill: 100 };

export function discTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createMist(scene) {
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 4);
  const velocity = new Float32Array(COUNT * 3);
  const age = new Float32Array(COUNT).fill(1);
  const life = new Float32Array(COUNT).fill(1);
  const maxAlpha = new Float32Array(COUNT);
  const mode = new Uint8Array(COUNT);      // 0 drift, 1 drawn to the hatch
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.45, map: discTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true,
  }));
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  let cursor = 0;
  let pending = 0;
  let alive = 0;
  const p = new THREE.Vector3();
  const toHatch = new THREE.Vector3();

  function spawn(kind) {
    const i = cursor;
    cursor = (cursor + 1) % COUNT;
    const o = i * 3;
    if (kind === 'vent') {
      p.copy(b2t((Math.random() - 0.5) * 1.8, HATCH_WALL_Y1 + 0.2 + Math.random() * (HATCH_Y - HATCH_WALL_Y1 - 0.5), 0.7 + Math.random() * 2.1));
      velocity.set([(Math.random() - 0.5) * 0.1, 0, (Math.random() - 0.5) * 0.1], o);
      life[i] = 2.4;
      maxAlpha[i] = 0.2;
      mode[i] = 1;
    } else {
      // Nozzles on the upper and side faces of the decon rings (not under the floor).
      const angle = -0.7 + Math.random() * (Math.PI + 1.4);
      const ring = CHAMBER_RING_YS[Math.floor(Math.random() * CHAMBER_RING_YS.length)];
      const cx = Math.cos(angle);
      const cz = Math.sin(angle);
      p.copy(b2t(cx * RING_RADIUS, ring + (Math.random() - 0.5) * 0.12, DOOR_CENTER_Z + cz * RING_RADIUS));
      const speed = kind === 'spray' ? 0.7 + Math.random() * 0.5 : 0.35 + Math.random() * 0.2;
      velocity.set([-cx * speed, -cz * speed, (Math.random() - 0.5) * 0.5], o);
      life[i] = kind === 'spray' ? 2.6 + Math.random() * 1.2 : 2.2;
      maxAlpha[i] = kind === 'spray' ? 0.32 : 0.14;
      mode[i] = 0;
    }
    positions.set([p.x, p.y, p.z], o);
    age[i] = 0;
  }

  /** kind: 'spray' | 'vent' | 'fill' | 'purge' | null */
  function update(dt, kind, color) {
    if (kind && SPAWN_RATE[kind]) {
      pending += SPAWN_RATE[kind] * dt;
      while (pending >= 1) {
        spawn(kind);
        pending -= 1;
      }
    } else {
      pending = 0;
    }
    if (!kind && alive === 0) {
      points.visible = false;
      return;
    }
    points.visible = true;
    alive = 0;
    const drag = Math.exp(-dt * 1.3);
    for (let i = 0; i < COUNT; i++) {
      if (age[i] >= life[i]) {
        colors[i * 4 + 3] = 0;
        continue;
      }
      age[i] += dt * (kind === 'purge' ? 1.8 : 1);
      const o = i * 3;
      if (mode[i] === 1 || kind === 'purge') {
        toHatch.set(HATCH.x - positions[o], HATCH.y - positions[o + 1], HATCH.z - positions[o + 2]);
        const distance = toHatch.length();
        toHatch.multiplyScalar((mode[i] === 1 ? 2.4 : 0.8) / Math.max(distance, 0.2));
        velocity[o] += toHatch.x * dt;
        velocity[o + 1] += toHatch.y * dt;
        velocity[o + 2] += toHatch.z * dt;
        if (distance < 0.25) age[i] = life[i];
      } else {
        velocity[o] *= drag;
        velocity[o + 1] *= drag;
        velocity[o + 2] *= drag;
      }
      positions[o] += velocity[o] * dt;
      positions[o + 1] += velocity[o + 1] * dt;
      positions[o + 2] += velocity[o + 2] * dt;
      const fade = Math.sin(Math.PI * Math.min(1, age[i] / life[i]));
      colors[i * 4] = color.r;
      colors[i * 4 + 1] = color.g;
      colors[i * 4 + 2] = color.b;
      colors[i * 4 + 3] = fade * maxAlpha[i];
      alive++;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  }

  return { points, update };
}
