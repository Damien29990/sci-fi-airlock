import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Wall-mounted control panels.  Each panel face is one canvas (title, live
// screen, button captions) drawn as an emissive texture; the buttons are real
// meshes so they can be hovered, pressed and raycast.
export const TONES = {
  cyan: '#00e5ff',
  red: '#ff3b1f',
  green: '#2bff88',
  amber: '#ffb020',
  violet: '#a77dff',
  grey: '#5d6b74',
};

const DEPTH = 0.06;
const FACE_INSET = 0.012;
const PX_PER_M = 1400;
const REDRAW_INTERVAL = 0.1;
const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const housingMaterial = new THREE.MeshStandardMaterial({ color: 0x1d2025, metalness: 0.75, roughness: 0.42 });
const ringMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 1, roughness: 0.3 });
const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x030405, emissive: 0x00e5ff, emissiveIntensity: 3 });
const ringGeometry = new THREE.CylinderGeometry(0.034, 0.036, 0.008, 32).rotateX(Math.PI / 2);
const capGeometry = new THREE.CylinderGeometry(0.025, 0.025, 0.014, 32).rotateX(Math.PI / 2);

function buildPanel(def, scene) {
  const group = new THREE.Group();
  group.name = `Panel_${def.id}`;
  group.position.copy(def.mount);
  group.quaternion.setFromUnitVectors(Z_AXIS, def.normal);
  scene.add(group);

  const housing = new THREE.Mesh(new RoundedBoxGeometry(def.width, def.height, DEPTH, 3, 0.01), housingMaterial);
  housing.position.z = DEPTH / 2;
  housing.receiveShadow = true;
  group.add(housing);

  const trim = new THREE.Mesh(new THREE.BoxGeometry(def.width * 0.6, 0.006, 0.004), trimMaterial);
  trim.position.set(0, def.height / 2 - 0.004, DEPTH + 0.001);
  group.add(trim);

  const faceW = def.width - FACE_INSET * 2;
  const faceH = def.height - FACE_INSET * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(faceW * PX_PER_M);
  canvas.height = Math.round(faceH * PX_PER_M);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(faceW, faceH),
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 1.5, roughness: 0.25,
    }),
  );
  face.position.z = DEPTH + 0.0008;
  group.add(face);

  const panel = {
    def,
    group,
    canvas,
    texture,
    faceW,
    faceH,
    signature: '',
    lastDraw: -Infinity,
    center: def.mount.clone().addScaledVector(def.normal, DEPTH),
    normal: def.normal,
    surfaces: [housing, face],
    buttons: [],
  };

  for (const spec of def.buttons) {
    const holder = new THREE.Group();
    holder.position.set(spec.x, spec.y, DEPTH);
    group.add(holder);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.z = 0.004;
    const material = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: TONES.cyan, emissiveIntensity: 1.5, roughness: 0.3 });
    const cap = new THREE.Mesh(capGeometry, material);
    cap.position.z = 0.01;
    holder.add(ring, cap);
    const button = {
      id: spec.id,
      key: `${def.id}.${spec.id}`,
      panel,
      spec,
      holder,
      cap,
      material,
      label: spec.label,
      tone: 'cyan',
      enabled: true,
      blink: false,
      hover: 0,
      flash: 0,
    };
    ring.userData.button = button;
    cap.userData.button = button;
    panel.buttons.push(button);
  }
  return panel;
}

function drawPanel(panel, content) {
  const { canvas, def, faceW, faceH } = panel;
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / faceW;
  const X = (x) => (x + faceW / 2) * scale;
  const Y = (y) => (faceH / 2 - y) * scale;
  const px = (m) => m * scale;
  const W = canvas.width;
  const H = canvas.height;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0d1318');
  bg.addColorStop(1, '#06090c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Corner brackets and title strip.
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.55)';
  ctx.lineWidth = px(0.002);
  const corner = px(0.02);
  const pad = px(0.006);
  [[pad, pad, 1, 1], [W - pad, pad, -1, 1], [pad, H - pad, 1, -1], [W - pad, H - pad, -1, -1]].forEach(([x, y, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(x + sx * corner, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * corner);
    ctx.stroke();
  });
  ctx.fillStyle = '#e6f6fb';
  ctx.font = `bold ${px(0.022)}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(def.title, px(0.016), px(0.026));
  ctx.fillStyle = 'rgba(0, 229, 255, 0.7)';
  ctx.font = `${px(0.012)}px Consolas, monospace`;
  ctx.textAlign = 'right';
  ctx.fillText(def.code, W - px(0.016), px(0.027));
  ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
  ctx.fillRect(px(0.016), px(0.044), W - px(0.032), px(0.0015));

  // Screen: grid backdrop, status line, data rows and bar gauges.
  const sc = def.screen;
  const sx = X(sc.x - sc.w / 2);
  const sy = Y(sc.y + sc.h / 2);
  const sw = px(sc.w);
  const sh = px(sc.h);
  ctx.fillStyle = '#021419';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.08)';
  ctx.lineWidth = 1;
  const step = px(0.012);
  for (let gx = sx + step; gx < sx + sw; gx += step) {
    ctx.beginPath();
    ctx.moveTo(gx, sy);
    ctx.lineTo(gx, sy + sh);
    ctx.stroke();
  }
  for (let gy = sy + step; gy < sy + sh; gy += step) {
    ctx.beginPath();
    ctx.moveTo(sx, gy);
    ctx.lineTo(sx + sw, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
  ctx.lineWidth = px(0.0015);
  ctx.strokeRect(sx, sy, sw, sh);

  const inner = px(0.014);
  const line = px(sc.lineHeight ?? 0.03);
  const columns = sc.columns ?? 1;
  const columnW = (sw - inner * 2) / columns;
  const statusSize = px(sc.statusSize ?? 0.02);
  let cy = sy + inner + statusSize * 0.6;
  ctx.textAlign = 'left';
  ctx.font = `bold ${statusSize}px ${FONT}`;
  ctx.fillStyle = TONES[content.tone] ?? TONES.cyan;
  ctx.fillText(content.status, sx + inner, cy);
  cy += line * 1.1;
  content.rows.forEach(([label, value], i) => {
    const column = i % columns;
    const left = sx + inner + column * columnW;
    const right = left + columnW - (column < columns - 1 ? inner * 1.5 : 0);
    const rowY = cy + Math.floor(i / columns) * line * 0.95;
    ctx.font = `${px(sc.labelSize ?? 0.015)}px ${FONT}`;
    ctx.fillStyle = 'rgba(180, 220, 230, 0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(label, left, rowY);
    ctx.font = `bold ${px(sc.valueSize ?? 0.017)}px Consolas, ${FONT}`;
    ctx.fillStyle = '#e8fbff';
    ctx.textAlign = 'right';
    ctx.fillText(value, right, rowY);
  });
  // Bar gauges stack upwards from the bottom of the screen.
  const barH = px(sc.barSize ?? 0.008);
  let by = sy + sh - inner * 0.6 - px(0.008) - barH;
  for (const bar of [...(content.bars ?? [])].reverse()) {
    const bw = sw - inner * 2;
    ctx.fillStyle = 'rgba(0, 229, 255, 0.12)';
    ctx.fillRect(sx + inner, by, bw, barH);
    ctx.fillStyle = TONES[bar.tone] ?? TONES.cyan;
    ctx.fillRect(sx + inner, by, bw * THREE.MathUtils.clamp(bar.value, 0, 1), barH);
    for (let t = 0; t <= 10; t++) {
      ctx.fillStyle = 'rgba(0, 229, 255, 0.35)';
      ctx.fillRect(sx + inner + (bw * t) / 10, by + barH + px(0.001), 1.5, px(t % 5 ? 0.003 : 0.006));
    }
    const labelSize = px(sc.barLabelSize ?? 0.012);
    ctx.font = `${labelSize}px ${FONT}`;
    ctx.fillStyle = 'rgba(180, 220, 230, 0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(bar.label, sx + inner, by - labelSize * 0.75);
    by -= labelSize * 1.6 + barH + px(0.01);
  }
  // Captions under the buttons.
  ctx.textAlign = 'center';
  ctx.font = `bold ${px(def.captionSize ?? 0.0145)}px ${FONT}`;
  for (const button of panel.buttons) {
    ctx.fillStyle = button.enabled ? TONES[button.tone] : TONES.grey;
    ctx.fillText(button.label, X(button.spec.x), Y(button.spec.y - 0.05));
  }
  panel.texture.needsUpdate = true;
}

/**
 * defs: [{ id, title, code, mount: Vector3 (on the wall), normal: Vector3,
 *          width, height, screen: {x, y, w, h}, buttons: [{id, x, y, label}],
 *          content(snapshot) -> {status, tone, rows, bars} }]
 */
export function createPanels(scene, defs) {
  const panels = defs.map((def) => buildPanel(def, scene));
  const buttons = panels.flatMap((panel) => panel.buttons);
  const buttonMeshes = buttons.flatMap((button) => button.holder.children);
  const surfaces = panels.flatMap((panel) => panel.surfaces);
  const byKey = new Map(buttons.map((button) => [button.key, button]));
  let hovered = null;

  return {
    panels,
    buttons,
    get(key) {
      return byKey.get(key);
    },
    setButton(key, state) {
      Object.assign(byKey.get(key), state);
    },
    setHover(button) {
      hovered = button;
    },
    flash(button) {
      button.flash = 1;
    },
    /** First button under the ray, unless something in `occluders` is nearer. */
    pick(raycaster, occluders = []) {
      const hits = raycaster.intersectObjects([...buttonMeshes, ...surfaces, ...occluders], true);
      return hits[0]?.object.userData.button ?? null;
    },
    update(dt, time, snapshot) {
      for (const button of buttons) {
        button.hover += ((button === hovered ? 1 : 0) - button.hover) * (1 - Math.exp(-dt * 12));
        button.flash = Math.max(0, button.flash - dt * 2.2);
        button.cap.position.z = 0.01 - 0.006 * Math.min(1, button.flash * 2);
        button.material.emissive.set(button.enabled ? TONES[button.tone] : TONES.grey);
        const blink = button.blink ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 8)) : 1;
        button.material.emissiveIntensity = button.enabled ? (1.4 + 2.6 * button.hover + 6 * button.flash) * blink : 0.35;
      }
      for (const panel of panels) {
        const content = panel.def.content(snapshot);
        const signature = JSON.stringify([content, panel.buttons.map((b) => [b.label, b.tone, b.enabled])]);
        if (signature !== panel.signature && time - panel.lastDraw >= REDRAW_INTERVAL) {
          panel.signature = signature;
          panel.lastDraw = time;
          drawPanel(panel, content);
        }
      }
    },
  };
}
