import * as THREE from 'three';

// Inner-chamber systems: lighting modes, decontamination and the
// depressurisation cycle.  Timelines and readings are pure functions of time.
export const ATMOSPHERE_KPA = 101.3;
export const O2_FRACTION = 0.209;

export const LIGHT_MODES = ['normal', 'alert', 'off'];
export const LIGHT_MODE_LABELS = { normal: '標準', alert: '警示', off: '關閉' };

export const SEQUENCES = {
  decon: {
    label: '消毒程序',
    steps: [['prep', '準備', 1.0], ['spray', '消毒噴霧', 6.0], ['purge', '排氣', 1.8]],
  },
  cycle: {
    label: '洩壓循環',
    steps: [['seal', '密封', 1.5], ['depress', '洩壓中', 8.0], ['vacuum', '真空・外艙門解鎖', 3.5],
      ['repress', '加壓中', 6.0], ['done', '完成', 1.0]],
  },
};

export const nextLightMode = (mode) => LIGHT_MODES[(LIGHT_MODES.indexOf(mode) + 1) % LIGHT_MODES.length];

export function sequenceStep(kind, t) {
  const { steps } = SEQUENCES[kind];
  const total = steps.reduce((sum, [, , duration]) => sum + duration, 0);
  let start = 0;
  for (const [name, label, duration] of steps) {
    if (t < start + duration) return { name, label, local: (t - start) / duration, progress: t / total, done: false };
    start += duration;
  }
  return { name: 'finished', label: '完成', local: 1, progress: 1, done: true };
}

export function pressureAt(kind, step) {
  if (kind !== 'cycle') return ATMOSPHERE_KPA;
  if (step.name === 'depress') return ATMOSPHERE_KPA * Math.pow(1 - step.local, 2.2);
  if (step.name === 'vacuum') return 0;
  if (step.name === 'repress') return ATMOSPHERE_KPA * (1 - Math.pow(1 - step.local, 2.2));
  return ATMOSPHERE_KPA;
}

/** Adiabatic cooling while venting, recovering as air returns. */
export const temperatureAt = (pressure) => 21 - 7 * (1 - pressure / ATMOSPHERE_KPA);

export const doorLockReason = (kind) => (kind ? `${SEQUENCES[kind].label}進行中` : null);

export function createAirlockSystem() {
  const state = {
    lightMode: 'normal',
    sequence: null,       // { kind, t }
    step: null,
    pressure: ATMOSPHERE_KPA,
    temperature: 21,
  };
  return {
    state,
    get lockReason() {
      return doorLockReason(state.sequence?.kind);
    },
    start(kind) {
      if (state.sequence) return false;
      state.sequence = { kind, t: 0 };
      return true;
    },
    cycleLights() {
      state.lightMode = nextLightMode(state.lightMode);
      return state.lightMode;
    },
    /** Returns the kind of sequence that finished this frame, if any. */
    update(dt) {
      const sequence = state.sequence;
      if (!sequence) {
        state.step = null;
        state.pressure = ATMOSPHERE_KPA;
        state.temperature = temperatureAt(state.pressure);
        return null;
      }
      sequence.t += dt;
      state.step = sequenceStep(sequence.kind, sequence.t);
      state.pressure = pressureAt(sequence.kind, state.step);
      state.temperature = temperatureAt(state.pressure);
      if (!state.step.done) return null;
      state.sequence = null;
      return sequence.kind;
    },
  };
}

const COLORS = {
  red: new THREE.Color(0xff1206),
  violet: new THREE.Color(0x8f62ff),
  amber: new THREE.Color(0xffa020),
  strip: new THREE.Color(0xdff7ff),
  dim: new THREE.Color(0x3fa9c9),
  mist: new THREE.Color(0xd6ecff),
  mistViolet: new THREE.Color(0xd2c2ff),
};

/**
 * Chamber look for the current state.  `base` is the lights' own colour.
 * Writes into and returns `out` = { lightColor, level, stripColor,
 * stripIntensity, hatch: 'locked'|'blink'|'open', mist, mistColor, beacon }.
 */
export function chamberLook(state, time, base, out) {
  const pulse = 0.5 + 0.5 * Math.sin(time * 4);
  const blink = Math.sin(time * 9) > 0;
  out.hatch = 'locked';
  out.mist = null;
  out.mistColor = COLORS.mist;
  out.beacon = false;

  if (state.lightMode === 'alert') {
    out.lightColor = COLORS.red;
    out.level = 0.16 + 0.14 * pulse;
    out.stripColor = COLORS.red;
    out.stripIntensity = 3 + 6 * pulse;
  } else if (state.lightMode === 'off') {
    out.lightColor = base;
    out.level = 0.05;
    out.stripColor = COLORS.dim;
    out.stripIntensity = 0.8;
  } else {
    out.lightColor = base;
    out.level = 1;
    out.stripColor = COLORS.strip;
    out.stripIntensity = 10;
  }

  const sequence = state.sequence;
  const step = state.step;
  if (!sequence || !step) return out;

  if (sequence.kind === 'decon') {
    if (step.name === 'prep') {
      out.stripColor = COLORS.violet;
      out.stripIntensity = blink ? 10 : 2;
    } else if (step.name === 'spray') {
      out.lightColor = COLORS.violet;
      out.level = 0.35 + 0.08 * pulse;
      out.stripColor = COLORS.violet;
      out.stripIntensity = 9 + 4 * pulse;
      out.mist = 'spray';
      out.mistColor = COLORS.mistViolet;
    } else {
      out.lightColor = base;
      out.level = THREE.MathUtils.lerp(0.6, 1, step.local);
      out.mist = 'purge';
    }
    return out;
  }

  out.beacon = true;
  if (step.name === 'seal') {
    out.stripColor = COLORS.amber;
    out.stripIntensity = blink ? 9 : 2;
  } else if (step.name === 'depress') {
    out.lightColor = COLORS.red;
    out.level = 0.14 + 0.12 * pulse;
    out.stripColor = COLORS.red;
    out.stripIntensity = 3 + 7 * pulse;
    out.hatch = 'blink';
    out.mist = 'vent';
  } else if (step.name === 'vacuum') {
    out.lightColor = COLORS.red;
    out.level = 0.1;
    out.stripColor = COLORS.red;
    out.stripIntensity = 3;
    out.hatch = 'open';
  } else if (step.name === 'repress') {
    out.lightColor = COLORS.amber;
    out.level = THREE.MathUtils.lerp(0.2, 0.6, step.local);
    out.stripColor = COLORS.amber;
    out.stripIntensity = 4 + 4 * pulse;
    out.hatch = 'blink';
    out.mist = 'fill';
  }
  return out;
}
