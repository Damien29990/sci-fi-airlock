import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createAstronaut } from './astronaut.js';
import { b2t, FLOOR_Z, HATCH_WALL_Y0, HATCH_WALL_Y1 } from './world.js';

// Equipment-lock dressing added by the viewer: a spare suit hanging on its
// donning stand, wall signs, and loose items floating in microgravity.  The
// items drift on the cabin air flow (a weak pull back to where they were
// left) and get knocked away when the astronaut floats into them.
const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
const SUIT = { x: -0.92, y: 4.1, alt: 0.32 };
const PLSS_Z = 2.18;              // backpack centre of the hanging suit (Blender Z)
const AIR_PULL = 0.12;            // 1/s^2 back towards the resting spot
const AIR_DRAG = 0.35;            // 1/s
const SPIN_DRAG = 0.06;
const BODY_RADIUS = 0.36;         // astronaut as a vertical capsule
const BOUNDS = { x: 1.1, y0: 2.65, y1: HATCH_WALL_Y0 - 0.12, z0: 0.62, z1: 3.05 };

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

function hazardBorder(ctx, w, h, band) {
  ctx.save();
  ctx.fillStyle = '#f2b705';
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.rect(band, band, w - band * 2, h - band * 2);
  ctx.clip('evenodd');
  ctx.fillStyle = '#111';
  for (let x = -h; x < w + h; x += band * 2) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + band, h);
    ctx.lineTo(x + band + h, 0);
    ctx.lineTo(x + h, 0);
    ctx.fill();
  }
  ctx.restore();
}

const SIGNS = [
  {
    // Above the hatch, equipment-lock side.
    position: b2t(0, HATCH_WALL_Y0, 3.04), rotationY: 0, width: 0.5, height: 0.11, glow: 1.2,
    draw: (ctx, w, h) => roomSign(ctx, w, h, '氣閘艙', 'CREW LOCK · AL-07'),
  },
  {
    // Above the hatch, crew-lock side.
    position: b2t(0, HATCH_WALL_Y1, 3.04), rotationY: Math.PI, width: 0.5, height: 0.11, glow: 1.2,
    draw: (ctx, w, h) => roomSign(ctx, w, h, '裝備艙', 'EQUIPMENT LOCK'),
  },
  {
    // Corridor wall just before the blast door.
    position: b2t(1.434, 1.755, 2.15), rotationY: -Math.PI / 2, width: 0.28, height: 0.2, glow: 0.35, printed: true,
    draw: (ctx, w, h) => {
      hazardBorder(ctx, w, h, h * 0.07);
      ctx.fillStyle = '#f2b705';
      ctx.fillRect(h * 0.07, h * 0.07, w - h * 0.14, h - h * 0.14);
      ctx.fillStyle = '#111';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${h * 0.25}px ${FONT}`;
      ctx.fillText('⚠ 前方微重力區', w / 2, h * 0.38);
      ctx.font = `bold ${h * 0.1}px Consolas, ${FONT}`;
      ctx.fillText('MICROGRAVITY BEYOND DOOR', w / 2, h * 0.62);
      ctx.font = `${h * 0.085}px ${FONT}`;
      ctx.fillText('固定隨身物品 · 使用噴氣背包', w / 2, h * 0.77);
    },
  },
  {
    // Under the spare suit's backpack, on the donning stand plate.
    position: b2t(-1.424, SUIT.y, 1.42), rotationY: Math.PI / 2, width: 0.3, height: 0.075, glow: 0.8,
    draw: (ctx, w, h) => roomSign(ctx, w, h, '備用太空衣', 'EMU 02 · 已充電'),
  },
];

function roomSign(ctx, w, h, title, subtitle) {
  ctx.fillStyle = '#071015';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)';
  ctx.lineWidth = h * 0.05;
  ctx.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8fbff';
  ctx.font = `bold ${h * 0.5}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(title, h * 0.3, h * 0.53);
  ctx.fillStyle = '#00e5ff';
  ctx.font = `${h * 0.26}px Consolas, ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(subtitle, w - h * 0.3, h * 0.55);
}

function buildSigns(scene) {
  const plateMaterial = new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.7, roughness: 0.45 });
  for (const sign of SIGNS) {
    const texture = canvasTexture(Math.round(sign.width * 1600), Math.round(sign.height * 1600), sign.draw);
    const group = new THREE.Group();
    group.position.copy(sign.position);
    group.rotation.y = sign.rotationY;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(sign.width + 0.016, sign.height + 0.016, 0.01), plateMaterial);
    plate.position.z = 0.005;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(sign.width, sign.height),
      new THREE.MeshStandardMaterial({
        color: sign.printed ? 0xffffff : 0x000000, map: sign.printed ? texture : null,
        emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: sign.glow, roughness: 0.5,
      }),
    );
    face.position.z = 0.0105;
    plate.receiveShadow = true;
    group.add(plate, face);
    scene.add(group);
  }
}

function buildStand(scene) {
  const material = new THREE.MeshStandardMaterial({ color: 0x2a2e34, metalness: 0.8, roughness: 0.4 });
  const bolts = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 1, roughness: 0.3 });
  const parts = [
    [new RoundedBoxGeometry(0.025, 1.0, 0.46, 2, 0.008), [-1.437, SUIT.y, 1.8], material],
    [new RoundedBoxGeometry(0.17, 0.12, 0.1, 2, 0.015), [-1.35, SUIT.y, PLSS_Z], material],
    [new RoundedBoxGeometry(0.02, 0.26, 0.32, 2, 0.006), [-1.283, SUIT.y, PLSS_Z], material],
  ];
  for (const dz of [-0.42, 0.42]) {
    for (const dy of [-0.18, 0.18]) {
      parts.push([new THREE.CylinderGeometry(0.012, 0.012, 0.012, 12).rotateZ(Math.PI / 2), [-1.42, SUIT.y + dy, 1.8 + dz], bolts]);
    }
  }
  for (const [geometry, [x, y, z], mat] of parts) {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.copy(b2t(x, y, z));
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

// --- Loose items -------------------------------------------------------------
function checklistCover() {
  return canvasTexture(256, 352, (ctx, w, h) => {
    ctx.fillStyle = '#f2efe6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1f4f9a';
    ctx.fillRect(0, 0, w, h * 0.3);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 44px ${FONT}`;
    ctx.fillText('EVA', 22, 56);
    ctx.font = `bold 28px ${FONT}`;
    ctx.fillText('CHECKLIST', 22, 92);
    ctx.fillStyle = '#1b1f24';
    ctx.font = `26px ${FONT}`;
    ['出艙程序', '氣閘 AL-07', 'REV 3.2'].forEach((line, i) => ctx.fillText(line, 22, 150 + i * 38));
    ['#d9363e', '#f2b705', '#2b9d5c', '#1f4f9a'].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(w - 18, 130 + i * 50, 18, 40);
    });
  });
}

function pouchLabel() {
  return canvasTexture(192, 160, (ctx, w, h) => {
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1f6fd1';
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText('H₂O', 14, 33);
    ctx.fillStyle = '#1b1f24';
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText('飲用水', 14, 88);
    ctx.font = `20px Consolas, ${FONT}`;
    ctx.fillText('500 mL · AL-07', 14, 128);
  });
}

function buildItems(scene) {
  const standard = (color, metalness, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
  const chrome = standard(0xb8bec6, 1, 0.28);
  const dark = standard(0x2a2d33, 0.6, 0.4);
  const items = [];
  const add = (object, radius, anchor) => {
    object.traverse((child) => {
      if (child.isMesh) child.castShadow = false;
    });
    scene.add(object);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    object.quaternion.copy(quaternion);
    object.position.set(anchor[0], anchor[2], -anchor[1]);
    items.push({
      object,
      radius,
      anchor: new THREE.Vector3(...anchor),
      pos: new THREE.Vector3(...anchor),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.6),
      phase: Math.random() * 10,
    });
  };

  // Checklist book: pages, blue back, printed cover on top.
  const book = new THREE.Group();
  const pages = standard(0xe9e5da, 0, 0.9);
  book.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.014, 0.22), [pages, pages, pages, standard(0x1f4f9a, 0, 0.7), pages, pages]));
  const cover = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.22).rotateX(-Math.PI / 2), standard(0xffffff, 0, 0.7, { map: checklistCover() }));
  cover.position.y = 0.0072;
  book.add(cover);
  add(book, 0.12, [0.3, 4.0, 2.2]);

  // Flashlight with a warm lens.
  const flashlight = new THREE.Group();
  flashlight.add(new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.15, 16), dark));
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.019, 0.04, 16), dark);
  head.position.y = 0.09;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 16).rotateX(-Math.PI / 2), standard(0x111111, 0, 0.2, { emissive: 0xfff1cc, emissiveIntensity: 3 }));
  lens.position.y = 0.1105;
  const button = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.025, 0.008), standard(0xd9363e, 0, 0.5));
  button.position.set(0, 0.03, 0.017);
  flashlight.add(head, lens, button);
  add(flashlight, 0.09, [-0.05, 3.75, 2.55]);

  // Spanner: flat handle, open jaw at one end, ring at the other.
  const spanner = new THREE.Group();
  spanner.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.007), chrome));
  const jaw = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.007, 8, 18, Math.PI * 1.4).rotateZ(Math.PI * 0.3), chrome);
  jaw.position.x = 0.095;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.006, 8, 18), chrome);
  ring.position.x = -0.092;
  spanner.add(jaw, ring);
  add(spanner, 0.1, [0.5, 3.95, 1.5]);

  // Drink pouch with label, straw and clamp.
  const pouch = new THREE.Group();
  pouch.add(new THREE.Mesh(new RoundedBoxGeometry(0.095, 0.14, 0.024, 3, 0.01), standard(0xc9ccd2, 0.85, 0.35)));
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.0625), standard(0xffffff, 0, 0.6, { map: pouchLabel() }));
  label.position.set(0, -0.01, 0.0125);
  const straw = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.05, 8), standard(0xd9363e, 0, 0.5));
  straw.position.y = 0.09;
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.01, 0.012), dark);
  clamp.position.y = 0.076;
  pouch.add(label, straw, clamp);
  add(pouch, 0.09, [-0.1, 4.6, 2.3]);

  // Coiled data cable with a connector.
  const cable = new THREE.Group();
  const orange = standard(0xe8741c, 0, 0.55);
  cable.add(new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.008, 8, 32), orange));
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.008, 8, 32), orange);
  loop.rotation.set(0.25, 0.2, 0);
  const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.035, 12).rotateZ(Math.PI / 2), dark);
  plug.position.set(0.075, 0.0, 0.02);
  cable.add(loop, plug);
  add(cable, 0.08, [0.55, 3.5, 2.6]);

  // Pen with cap and clip.
  const pen = new THREE.Group();
  pen.add(new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.13, 10), standard(0x1f4f9a, 0.2, 0.4)));
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0058, 0.0058, 0.035, 10), dark);
  cap.position.y = 0.05;
  const clip = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.03, 0.002), chrome);
  clip.position.set(0, 0.048, 0.0068);
  pen.add(cap, clip);
  add(pen, 0.07, [-0.3, 3.7, 1.9]);

  return items;
}

export function createEquipment(scene) {
  buildSigns(scene);
  buildStand(scene);

  const spare = createAstronaut({ headlamp: false });
  spare.root.name = 'SpareSuit';
  spare.root.position.copy(b2t(SUIT.x, SUIT.y, FLOOR_Z));
  spare.root.rotation.y = Math.PI / 2;     // facing +X, backpack on the stand
  spare.update(1, 0, 0.6, 0.55);
  spare.setPose(SUIT.alt, 0.04, 0);
  spare.root.traverse((child) => {
    if (child.isMesh) child.castShadow = false;
  });
  scene.add(spare.root);

  const items = buildItems(scene);
  const target = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const relative = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const turn = new THREE.Quaternion();

  return {
    spare,
    items,
    setEnvironment(texture) {
      spare.setEnvironment(texture);
    },
    /** body: the player's state ({ pos, alt, vel } in Blender coordinates). */
    update(dt, time, body) {
      if (dt <= 0) return;
      const bottom = FLOOR_Z + body.alt + 0.25;
      const top = FLOOR_Z + body.alt + 1.8;
      for (const item of items) {
        const { pos, vel, spin } = item;
        // Air flow: a lazy pull back to the resting spot plus a slow wander.
        const t = time + item.phase;
        target.copy(item.anchor).add(relative.set(Math.sin(t * 0.21) * 0.05, Math.sin(t * 0.17) * 0.05, Math.sin(t * 0.13) * 0.04));
        vel.addScaledVector(target.sub(pos), AIR_PULL * dt).multiplyScalar(Math.exp(-AIR_DRAG * dt));

        // Knocked by the astronaut (vertical capsule).
        normal.set(pos.x - body.pos.x, pos.y - body.pos.y, pos.z - THREE.MathUtils.clamp(pos.z, bottom, top));
        const distance = normal.length();
        const reach = BODY_RADIUS + item.radius;
        if (distance < reach && distance > 1e-6) {
          normal.divideScalar(distance);
          pos.addScaledVector(normal, reach - distance);
          const approach = relative.copy(vel).sub(body.vel).dot(normal);
          if (approach < 0) {
            vel.addScaledVector(normal, -approach * 1.5);
            axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            spin.addScaledVector(axis, -approach * 6);
          }
        }
        pos.addScaledVector(vel, dt);

        // Bounce off the module walls.
        for (const [key, lo, hi] of [['x', -BOUNDS.x, BOUNDS.x], ['y', BOUNDS.y0, BOUNDS.y1], ['z', BOUNDS.z0, BOUNDS.z1]]) {
          if (pos[key] < lo || pos[key] > hi) {
            pos[key] = THREE.MathUtils.clamp(pos[key], lo, hi);
            vel[key] *= -0.5;
          }
        }

        spin.multiplyScalar(Math.exp(-SPIN_DRAG * dt));
        const rate = spin.length();
        if (rate > 1e-5) {
          turn.setFromAxisAngle(axis.copy(spin).divideScalar(rate), rate * dt);
          item.object.quaternion.premultiply(turn);
        }
        item.object.position.set(pos.x, pos.z, -pos.y);
      }
    },
  };
}
