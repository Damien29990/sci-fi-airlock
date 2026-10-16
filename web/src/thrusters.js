import * as THREE from 'three';
import { discTexture } from './mist.js';

// Cold-gas puffs from the jet-pack nozzles: fast, short-lived and spreading
// as they slow down.
const COUNT = 260;
const SIZE = 0.09;

export function createThrusters(scene) {
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 4);
  const velocity = new Float32Array(COUNT * 3);
  const age = new Float32Array(COUNT).fill(1);
  const life = new Float32Array(COUNT).fill(1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: SIZE, map: discTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true,
  }));
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  let cursor = 0;
  let alive = 0;

  return {
    points,
    /** One puff leaving a nozzle at `position` along the exhaust `direction` (world). */
    emit(position, direction) {
      const i = cursor;
      cursor = (cursor + 1) % COUNT;
      const o = i * 3;
      const speed = 1.1 + Math.random() * 0.7;
      positions[o] = position.x;
      positions[o + 1] = position.y;
      positions[o + 2] = position.z;
      velocity[o] = direction.x * speed + (Math.random() - 0.5) * 0.25;
      velocity[o + 1] = direction.y * speed + (Math.random() - 0.5) * 0.25;
      velocity[o + 2] = direction.z * speed + (Math.random() - 0.5) * 0.25;
      age[i] = 0;
      life[i] = 0.35 + Math.random() * 0.3;
      alive = Math.max(alive, 1);
    },
    update(dt) {
      if (alive === 0) {
        points.visible = false;
        return;
      }
      points.visible = true;
      alive = 0;
      const drag = Math.exp(-dt * 4.5);
      for (let i = 0; i < COUNT; i++) {
        if (age[i] >= life[i]) {
          colors[i * 4 + 3] = 0;
          continue;
        }
        age[i] += dt;
        const o = i * 3;
        velocity[o] *= drag;
        velocity[o + 1] *= drag;
        velocity[o + 2] *= drag;
        positions[o] += velocity[o] * dt;
        positions[o + 1] += velocity[o + 1] * dt;
        positions[o + 2] += velocity[o + 2] * dt;
        const t = Math.min(1, age[i] / life[i]);
        colors[i * 4] = 0.86;
        colors[i * 4 + 1] = 0.93;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = (1 - t) * (1 - t) * 0.55;
        alive++;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    },
  };
}
