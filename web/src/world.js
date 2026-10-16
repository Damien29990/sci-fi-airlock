import * as THREE from 'three';

// Layout values mirrored from scifi_airlock.py.  Positions are Blender
// coordinates (Z up, corridor along +Y); b2t() converts them for three.js.
export const b2t = (x, y, z) => new THREE.Vector3(x, z, -y);
export const toBlenderY = (v) => -v.z;

export const FLOOR_Z = 0.5;               // GRATE_TOP_Z
export const DOOR_FRONT_Y = 2.12;         // DOOR_Y_FRONT
export const DOOR_CENTER_Z = 1.75;        // DOOR_CENTER_Z
export const DOOR_SLIDE = 1.32;           // DOOR_SLIDE
export const CHAMBER_START_Y = 2.45;      // just behind the blast door leaves; microgravity from here on
export const HATCH_WALL_Y0 = 5.0;         // HATCH_WALL_Y0 .. HATCH_WALL_Y1: bulkhead with the sliding hatch
export const HATCH_WALL_Y1 = 5.3;
export const HATCH_LEAF_Y = 5.15;         // between HATCH_LEAF_Y0 and HATCH_LEAF_Y1
export const HATCH_HALF_W = 0.55;         // HATCH_HALF_W
export const HATCH_TOP_Z = 2.75;          // HATCH_TOP_Z
export const HATCH_SLIDE = 0.64;          // HATCH_SLIDE
export const CHAMBER_RING_YS = [6.7, 8.1];
export const HATCH_Y = 9.5;               // CHAMBER_Y1: outer hatch

/** 'corridor' (station gravity) | 'equip' (equipment lock) | 'crew' (crew lock). */
export const roomAt = (y) => (y < CHAMBER_START_Y ? 'corridor' : y < HATCH_LEAF_Y ? 'equip' : 'crew');
export const isMicrogravity = (y) => y >= CHAMBER_START_Y;

// Limits for the astronaut's body centre (x, y) and the height of the soles
// above the deck (alt).  A doorway is the stretch of Y where the body touches
// a door frame: the leaves block it unless the door is fully open.
const DOORWAYS = {
  blast: { y0: 1.6, y1: 2.8, halfWidth: 0.4, alt: 0.6 },
  hatch: { y0: HATCH_WALL_Y0 - 0.32, y1: HATCH_WALL_Y1 + 0.32, halfWidth: 0.15, alt: 0.3 },
};
const CORRIDOR_HALF_W = 0.9;
const CORRIDOR_START_Y = -3.7;
const MODULE_HALF_W = 0.62;               // floating body clear of the octagon walls
const MODULE_END_Y = HATCH_Y - 0.35;
const SUIT_STAND_Y = 4.1;                 // spare suit hanging on the left wall of the equipment lock
const FUNNEL_SLOPE = 2.5;                 // open door frames guide the body in
const DUCK_SLOPE = 1.5;

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

export const isInDoorway = (key, y) => y > DOORWAYS[key].y0 && y < DOORWAYS[key].y1;

const ringDistance = (y) => Math.min(...CHAMBER_RING_YS.map((ring) => Math.abs(y - ring)));

/** Helmet clear of the octagon ceiling and upper diagonals (narrower at the decon frames). */
function ceilingAlt(x, y) {
  const room = Math.min(0.78, 1.22 - Math.abs(x));
  if (y < HATCH_WALL_Y1) return room;
  const ring = Math.min(0.63, 1.02 - Math.abs(x));
  return lerp(ring, room, smoothstep(ringDistance(y), 0.3, 0.55));
}

/** Side limits and ceiling for a body centre at `y`; `doors` = { blast, hatch } openness 0..1. */
function bounds(y, doors) {
  let xMin;
  let xMax;
  let altMax = Infinity;
  const { blast, hatch } = DOORWAYS;
  if (y <= blast.y0) {
    xMin = -CORRIDOR_HALF_W;
    xMax = CORRIDOR_HALF_W;
  } else if (y < blast.y1) {
    xMin = -blast.halfWidth;
    xMax = blast.halfWidth;
    altMax = blast.alt;
  } else if (y <= hatch.y0) {
    const suit = 1 - smoothstep(Math.abs(y - SUIT_STAND_Y), 0.65, 0.95);
    xMin = -lerp(MODULE_HALF_W, 0.22, suit);
    xMax = MODULE_HALF_W;
  } else if (y < hatch.y1) {
    xMin = -hatch.halfWidth;
    xMax = hatch.halfWidth;
    altMax = hatch.alt;
  } else {
    const half = lerp(0.5, MODULE_HALF_W, smoothstep(ringDistance(y), 0.3, 0.55));
    xMin = -half;
    xMax = half;
  }
  // Funnels in front of open doors tighten as the leaves open, so nothing snaps.
  for (const [key, door] of Object.entries(DOORWAYS)) {
    const outside = Math.max(0, door.y0 - y, y - door.y1);
    const slack = (1 - doors[key]) * 2;
    const half = door.halfWidth + FUNNEL_SLOPE * outside + slack;
    xMin = Math.max(xMin, -half);
    xMax = Math.min(xMax, half);
    altMax = Math.min(altMax, door.alt + DUCK_SLOPE * outside + slack);
  }
  return { xMin, xMax, altMax };
}

/**
 * Resolve a body move against walls, door frames, deck and ceiling.
 * from / to: { x, y, alt } (Blender XY of the body centre, soles above the deck).
 * doors: { blast, hatch } openness, where 1 means fully open and passable.
 * Returns the corrected position and which axes were stopped (for bounces).
 */
export function constrainBody(from, to, doors) {
  let { x, y, alt } = to;
  let hitX = false;
  let hitY = false;
  let hitAlt = false;

  for (const [key, door] of Object.entries(DOORWAYS)) {
    if (y <= door.y0 || y >= door.y1) continue;
    const inside = from.y > door.y0 && from.y < door.y1;
    const aligned = Math.abs(from.x) <= door.halfWidth + 0.05 && from.alt <= door.alt + 0.05;
    if (!(doors[key] >= 1 && (inside || aligned))) {
      y = from.y <= door.y0 ? door.y0 : door.y1;
      hitY = true;
    }
  }
  if (y < CORRIDOR_START_Y || y > MODULE_END_Y) {
    y = clamp(y, CORRIDOR_START_Y, MODULE_END_Y);
    hitY = true;
  }

  const limits = bounds(y, doors);
  if (x < limits.xMin || x > limits.xMax) {
    x = clamp(x, limits.xMin, limits.xMax);
    hitX = true;
  }
  const ceiling = Math.max(0, isMicrogravity(y) ? Math.min(limits.altMax, ceilingAlt(x, y)) : limits.altMax);
  if (alt < 0 || alt > ceiling) {
    alt = clamp(alt, 0, ceiling);
    hitAlt = true;
  }
  return { x, y, alt, hitX, hitY, hitAlt };
}

function insideOctagon(x, dz, apothem) {
  const ax = Math.abs(x);
  const az = Math.abs(dz);
  return ax <= apothem && az <= apothem && ax + az <= apothem * Math.SQRT2;
}

/** True when a camera at Blender (x, y, z) keeps clear of every wall. */
export function isCameraSpaceFree(x, y, z, doors) {
  if (y < -3.85 || y > HATCH_Y - 0.15 || z < 0.68) return false;
  if (y <= 1.85) return Math.abs(x) <= 1.3 && z <= 3.35 && Math.abs(x) + z <= 4.29;
  if (y < 2.62) return doors.blast > 0.98 && insideOctagon(x, z - DOOR_CENTER_Z, 1.17);
  if (y > HATCH_WALL_Y0 - 0.12 && y < HATCH_WALL_Y1 + 0.12) {
    const ax = Math.abs(x);
    return doors.hatch > 0.98 && ax <= HATCH_HALF_W - 0.12 && z <= HATCH_TOP_Z - 0.12 - Math.max(0, ax - 0.25);
  }
  return insideOctagon(x, z - DOOR_CENTER_Z, 1.22);
}
