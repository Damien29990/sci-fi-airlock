import * as THREE from 'three';
import {
  constrainBody, FLOOR_Z, isCameraSpaceFree, isInDoorway, isMicrogravity, roomAt,
} from './world.js';

// Third-person controller: camera-relative movement, wall collision, a camera
// boom that shortens instead of clipping through walls, and a "panel focus"
// mode that brings the astronaut to a control panel and frames it.
// The corridor has station gravity (walking).  Behind the blast door the
// modules are in microgravity: the astronaut floats and manoeuvres with the
// jet pack - momentum, a translation-hold damper and soft bounces off walls.
const WALK_SPEED = 1.25;
const RUN_SPEED = 2.3;
const GRAVITY = 9.81;
export const THRUST = 1.4;      // m/s^2 from the jet pack
const BOOST = 1.8;              // Shift multiplier
const LIFT_THRUST = 1.0;
const FLOAT_SPEED = 1.0;
const BOOST_SPEED = 1.7;
const LIFT_SPEED = 0.6;
const HOLD_DAMPING = 0.8;       // 1/s when no jets are commanded (translation hold)
const DRIFT_DAMPING = 0.3;
const HOVER_ALT = 0.18;         // drifts up to here after floating in off the deck
const RESTITUTION = 0.35;
const PIVOT_HEIGHT = 1.6;
const FLOAT_PIVOT_HEIGHT = 1.4;
const SHOULDER_OFFSET = 0.32;   // camera sits over the right shoulder
const MIN_DISTANCE = 1.0;
const MAX_DISTANCE = 3.4;
const MIN_PITCH = -0.25;
const MAX_PITCH = 1.1;
const BOOM_STEP = 0.05;
const HIDE_DISTANCE = 0.5;      // hide the body when the camera is inside it
const FOCUS_BACKOFF = 0.7;      // panel camera sits this far behind the astronaut
const FOCUS_SIDE = 0.3;
const FOCUS_RISE = 0.45;        // looks down over the shoulder rather than past the arm
const FOCUS_FILL = 0.45;        // share of the screen width a focused panel covers
const UP = new THREE.Vector3(0, 1, 0);

const MOVE_KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const LIFT_KEYS = { Space: 1, KeyX: -1, PageUp: 1, PageDown: -1 };
export const isMoveKey = (code) => code in MOVE_KEYS;
export const isLiftKey = (code) => code in LIFT_KEYS;

function dampAngle(current, target, rate, dt) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-rate * dt));
}

/** three.js yaw that faces a panel from Blender floor position (x, y). */
const headingToward = (panel, x, y) => Math.atan2(panel.center.x - x, panel.center.z + y);

/**
 * getDoors() -> { blast, hatch }: how far each door is open (1 = passable).
 */
export function createPlayer({ camera, astronaut, getDoors, spawn }) {
  const keys = new Set();
  const touch = new THREE.Vector2();
  const startFloating = isMicrogravity(spawn.y);
  const state = {
    pos: new THREE.Vector2(spawn.x, spawn.y),   // Blender XY of the body centre
    alt: startFloating ? HOVER_ALT : 0,          // soles above the deck
    vel: new THREE.Vector3(),                    // Blender XYZ (z = altitude rate)
    thrust: new THREE.Vector3(),                 // commanded jet acceleration, Blender XYZ
    float: startFloating ? 1 : 0,                // 0 walking .. 1 floating (pose blend)
    brace: 0,                                    // 0..1 upright at a panel (foot restraints)
    lean: 0,
    roll: 0,
    heading: spawn.heading,                      // three.js yaw the body faces
    speed: 0,
    moved: false,
    yaw: spawn.heading + Math.PI,
    pitch: 0.3,
    distance: 2.3,
    boom: 2.3,
    shoulder: SHOULDER_OFFSET,
    focus: null,
    focusFov: 50,                                // horizontal degrees while a panel is focused
    faceHeading: 0,
    faceUntil: -Infinity,
  };
  let clock = 0;
  let lift = 0;                                  // touch up / down buttons
  let doors = getDoors();
  let wasFloating = startFloating;
  const moveDir = new THREE.Vector2();
  const desiredVel = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const shoulderPivot = new THREE.Vector3();
  const look = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const focusCamera = new THREE.Vector3();
  let blendRate = 14;

  const free = (v) => isCameraSpaceFree(v.x, -v.z, v.y, doors);
  const boosting = () => keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.length() > 0.95;
  const pivotHeight = () => FLOOR_Z + state.alt + THREE.MathUtils.lerp(PIVOT_HEIGHT, FLOAT_PIVOT_HEIGHT, state.float);

  function clearance(origin, direction, maxLength) {
    let clear = 0;
    for (let t = BOOM_STEP; t <= maxLength + 1e-6; t += BOOM_STEP) {
      if (!free(probe.copy(origin).addScaledVector(direction, t))) break;
      clear = t;
    }
    return clear;
  }

  /**
   * Panel camera: behind the astronaut and on the far side of the panel from
   * them, so the body stays at the edge of frame instead of in front of it.
   */
  function focusPose(panel, out) {
    const { center, normal, def } = panel;
    probe.set(def.stand[0], center.y, -def.stand[1]).sub(center);
    const standDepth = probe.dot(normal);
    const side = offset.crossVectors(UP, normal).normalize();
    const sign = probe.dot(side) > 0 ? -1 : 1;
    let distance = standDepth + FOCUS_BACKOFF;
    for (; distance > 0.6; distance -= 0.1) {
      // Panels beside a bulkhead have less room to the side than in front.
      for (const lateral of [FOCUS_SIDE, FOCUS_SIDE * 0.7, FOCUS_SIDE * 0.4]) {
        out.copy(center).addScaledVector(normal, distance).addScaledVector(side, lateral * sign);
        out.y += FOCUS_RISE;
        if (free(out)) return distance;
      }
    }
    distance = 0.8;
    out.copy(center).addScaledVector(normal, distance);
    return distance;
  }

  function readInput() {
    let x = touch.x;
    let y = touch.y;
    for (const code of keys) {
      const dir = MOVE_KEYS[code];
      if (dir) {
        x += dir[0];
        y += dir[1];
      }
    }
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    return { x, y, length: Math.min(length, 1) };
  }

  function readLift() {
    let value = lift;
    for (const code of keys) value += LIFT_KEYS[code] ?? 0;
    return THREE.MathUtils.clamp(value, -1, 1);
  }

  /** Camera-relative input -> Blender XY direction in moveDir; returns the matching yaw. */
  function steer(input) {
    const fx = -Math.sin(state.yaw);
    const fz = -Math.cos(state.yaw);
    const wx = fx * input.y + Math.cos(state.yaw) * input.x;
    const wz = fz * input.y - Math.sin(state.yaw) * input.x;
    const len = Math.hypot(wx, wz);
    moveDir.set(wx / len, -wz / len);
    return Math.atan2(wx, wz);
  }

  /** Station gravity: walk / run, and fall back to the deck after floating out. */
  function walk(dt, controlled) {
    let targetSpeed = 0;
    let targetHeading = null;
    const focus = state.focus;
    if (focus) {
      const dx = focus.def.stand[0] - state.pos.x;
      const dy = focus.def.stand[1] - state.pos.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.03) {
        moveDir.set(dx / distance, dy / distance);
        targetSpeed = Math.min(WALK_SPEED, distance * 4);
        targetHeading = Math.atan2(moveDir.x, -moveDir.y);
      } else {
        targetHeading = headingToward(focus, state.pos.x, state.pos.y);
      }
    } else if (controlled) {
      const input = readInput();
      if (input.length > 0.05) {
        targetHeading = steer(input);
        targetSpeed = input.length * (boosting() ? RUN_SPEED : WALK_SPEED);
      }
    }
    state.speed += (targetSpeed - state.speed) * (1 - Math.exp(-dt * 9));
    state.vel.x = moveDir.x * state.speed;
    state.vel.y = moveDir.y * state.speed;
    state.vel.z = state.alt > 0 || state.vel.z > 0 ? state.vel.z - GRAVITY * dt : 0;
    return targetHeading;
  }

  /** Microgravity: jet-pack thrust with momentum; panel focus flies an autopilot. */
  function fly(dt, controlled) {
    let targetHeading = null;
    const jet = state.thrust;
    const focus = state.focus;
    let boost = false;
    if (focus) {
      const dx = focus.def.stand[0] - state.pos.x;
      const dy = focus.def.stand[1] - state.pos.y;
      const dz = -state.alt;                     // settle onto the deck (foot restraints)
      const distance = Math.hypot(dx, dy, dz);
      const speed = Math.min(0.8, distance * 1.8);
      desiredVel.set(dx, dy, dz).multiplyScalar(speed / Math.max(distance, 1e-6));
      jet.subVectors(desiredVel, state.vel).multiplyScalar(3).clampLength(0, 2.2);
      if (jet.lengthSq() < 0.01) jet.set(0, 0, 0);
      targetHeading = Math.hypot(dx, dy) > 0.08
        ? Math.atan2(dx, -dy)
        : headingToward(focus, state.pos.x, state.pos.y);
    } else if (controlled) {
      const input = readInput();
      boost = boosting();
      if (input.length > 0.05) {
        targetHeading = steer(input);
        const thrust = input.length * THRUST * (boost ? BOOST : 1);
        jet.x = moveDir.x * thrust;
        jet.y = moveDir.y * thrust;
      }
      const up = readLift();
      if (Math.abs(up) > 0.05) jet.z = up * LIFT_THRUST;
    }
    const commanded = jet.lengthSq() > 0;
    state.vel.addScaledVector(jet, dt);
    // Lift gently off the deck (as if pushing off) unless told to go down.
    if (!focus && jet.z === 0 && state.alt < HOVER_ALT) state.vel.z += ((HOVER_ALT - state.alt) * 2 - state.vel.z * 1.2) * dt;
    state.vel.multiplyScalar(Math.exp(-(commanded ? DRIFT_DAMPING : HOLD_DAMPING) * dt));
    const horizontal = Math.hypot(state.vel.x, state.vel.y);
    const maxSpeed = boost ? BOOST_SPEED : FLOAT_SPEED;
    if (horizontal > maxSpeed) {
      state.vel.x *= maxSpeed / horizontal;
      state.vel.y *= maxSpeed / horizontal;
    }
    state.vel.z = THREE.MathUtils.clamp(state.vel.z, -LIFT_SPEED, LIFT_SPEED);
    return targetHeading;
  }

  function updateBody(dt, controlled) {
    doors = getDoors();
    const floating = isMicrogravity(state.pos.y);
    if (floating !== wasFloating && !floating) {
      // Carry the drift into the walk so crossing into gravity has no hitch.
      state.speed = Math.hypot(state.vel.x, state.vel.y);
      if (state.speed > 1e-4) moveDir.set(state.vel.x / state.speed, state.vel.y / state.speed);
    }
    wasFloating = floating;
    state.float += ((floating ? 1 : 0) - state.float) * (1 - Math.exp(-dt * 2.5));
    state.brace += ((state.focus ? 1 : 0) - state.brace) * (1 - Math.exp(-dt * 3));
    state.thrust.set(0, 0, 0);

    let targetHeading = floating ? fly(dt, controlled) : walk(dt, controlled);
    if (targetHeading === null && clock < state.faceUntil) targetHeading = state.faceHeading;
    if (targetHeading !== null) state.heading = dampAngle(state.heading, targetHeading, floating ? 3.5 : 10, dt);

    const from = { x: state.pos.x, y: state.pos.y, alt: state.alt };
    const to = { x: from.x + state.vel.x * dt, y: from.y + state.vel.y * dt, alt: from.alt + state.vel.z * dt };
    const next = constrainBody(from, to, doors);
    const bounce = floating ? -RESTITUTION : 0;
    if (next.hitX && Math.sign(to.x - next.x) === Math.sign(state.vel.x)) state.vel.x *= bounce;
    if (next.hitY && Math.sign(to.y - next.y) === Math.sign(state.vel.y)) state.vel.y *= bounce;
    if (next.hitAlt && Math.sign(to.alt - next.alt) === Math.sign(state.vel.z)) state.vel.z *= bounce;

    const travelled = Math.hypot(next.x - from.x, next.y - from.y);
    state.moved = travelled > 1e-5 || Math.abs(next.alt - from.alt) > 1e-5;
    state.pos.set(next.x, next.y);
    state.alt = next.alt;

    // Floating: tip into the direction of travel and bank on sideways drift.
    const fx = Math.sin(state.heading);
    const fy = -Math.cos(state.heading);
    const forward = state.vel.x * fx + state.vel.y * fy;
    const sideways = state.vel.x * fy - state.vel.y * fx;
    const k = 1 - Math.exp(-dt * 3);
    state.lean += (THREE.MathUtils.clamp(forward * 0.3, -0.2, 0.38) * state.float - state.lean) * k;
    state.roll += (THREE.MathUtils.clamp(sideways * 0.28, -0.3, 0.3) * state.float - state.roll) * k;
    const drift = state.float;
    astronaut.root.position.set(state.pos.x, FLOOR_Z, -state.pos.y);
    astronaut.root.rotation.y = state.heading;
    astronaut.setPose(
      state.alt + Math.sin(clock * 0.9) * 0.02 * drift,
      state.lean + Math.sin(clock * 0.37) * 0.03 * drift,
      state.roll + Math.sin(clock * 0.29 + 1) * 0.03 * drift,
    );
    return floating ? 0 : travelled / Math.max(dt, 1e-4);
  }

  function updateCamera(dt) {
    pivot.set(state.pos.x, pivotHeight(), -state.pos.y);
    const focus = state.focus;
    if (focus) {
      desired.copy(focusCamera);
      look.copy(focus.center);
    } else {
      right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
      const shoulder = Math.max(0, Math.min(SHOULDER_OFFSET, clearance(pivot, right, SHOULDER_OFFSET + 0.15) - 0.15));
      state.shoulder += (shoulder - state.shoulder) * (1 - Math.exp(-dt * 6));
      shoulderPivot.copy(pivot).addScaledVector(right, state.shoulder);

      const cp = Math.cos(state.pitch);
      offset.set(Math.sin(state.yaw) * cp, Math.sin(state.pitch), Math.cos(state.yaw) * cp);
      const allowed = Math.max(0.3, clearance(shoulderPivot, offset, state.distance) - 0.05);
      state.boom = allowed < state.boom ? allowed : state.boom + (allowed - state.boom) * (1 - Math.exp(-dt * 3));
      desired.copy(shoulderPivot).addScaledVector(offset, state.boom);
      look.copy(shoulderPivot);
    }
    const k = 1 - Math.exp(-dt * (focus ? 5 : blendRate));
    camera.position.lerp(desired, k);
    lookTarget.lerp(look, k);
    camera.lookAt(lookTarget);
    blendRate = Math.min(20, blendRate + dt * 10);
    astronaut.root.visible = Boolean(focus) || camera.position.distanceTo(pivot) > HIDE_DISTANCE;
  }

  return {
    state,
    keys,
    touch,
    get pivot() {
      return pivot.set(state.pos.x, pivotHeight(), -state.pos.y);
    },
    get room() {
      return roomAt(state.pos.y);
    },
    get floating() {
      return isMicrogravity(state.pos.y);
    },
    inDoorway(key) {
      return isInDoorway(key, state.pos.y);
    },
    /** Touch buttons: +1 up, -1 down, 0 released. */
    setLift(value) {
      lift = value;
    },
    /** Begin third-person control with the camera swinging in behind the body. */
    enter(currentTarget) {
      state.yaw = state.heading + Math.PI;
      state.boom = state.distance;
      lookTarget.copy(currentTarget);
      blendRate = 4;
    },
    snapCamera() {
      updateCamera(1);
      camera.position.copy(desired);
      lookTarget.copy(look);
      camera.lookAt(lookTarget);
    },
    rotate(dx, dy) {
      state.yaw -= dx * 0.006;
      state.pitch = THREE.MathUtils.clamp(state.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
    },
    zoom(deltaY) {
      state.distance = THREE.MathUtils.clamp(state.distance * (1 + deltaY * 0.001), MIN_DISTANCE, MAX_DISTANCE);
    },
    focusPanel(panel) {
      state.focus = panel;
      const distance = focusPose(panel, focusCamera);
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(panel.def.width / FOCUS_FILL / 2 / distance));
      state.focusFov = THREE.MathUtils.clamp(fov, 34, 60);
    },
    leavePanel() {
      if (!state.focus) return;
      state.focus = null;
      state.yaw = state.heading + Math.PI;
      state.boom = Math.min(state.boom, 1);
      blendRate = 5;
    },
    /** Turn to a panel briefly (pressing it without entering panel focus). */
    faceToward(panel) {
      state.faceHeading = headingToward(panel, state.pos.x, state.pos.y);
      state.faceUntil = clock + 0.9;
    },
    distanceTo(stand) {
      return Math.hypot(stand[0] - state.pos.x, stand[1] - state.pos.y);
    },
    /** Teleport (used when cutting between rooms). */
    place(x, y, heading) {
      state.pos.set(x, y);
      state.heading = heading;
      state.alt = isMicrogravity(y) ? HOVER_ALT : 0;
      state.vel.set(0, 0, 0);
      state.speed = 0;
      wasFloating = isMicrogravity(y);
    },
    update(dt, time, controlled) {
      clock = time;
      const speed = updateBody(dt, controlled);
      astronaut.update(dt, speed, time, state.float * (1 - 0.75 * state.brace));
      if (controlled) updateCamera(dt);
    },
  };
}
