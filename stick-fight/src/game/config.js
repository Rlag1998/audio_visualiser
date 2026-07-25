// Every tunable number in one place.
//
// World space: +x is right, +y is UP, the floor is y = 0. The renderer is the
// only thing that flips y for the screen. Distances are "world units" which
// happen to be pixels at 1x camera zoom. A fighter is about 132 units tall.

/** Simulation timestep. The whole game is frame-locked to this. */
export const TICK = 1 / 60;

export const ARENA = {
  halfWidth: 430,
  /** Fighters stop this far from the wall (measured at their root/feet). */
  wallMargin: 26,
};

export const BODY = {
  torsoLen: 42,
  neckFrac: 0.88, // where the shoulders sit along the torso
  neckToHead: 14,
  headR: 10,
  upperArm: 25,
  foreArm: 25,
  thigh: 34,
  shin: 34,
  /** Half-width used for body-vs-body pushing. Wide enough that two fighters
   *  in the pocket stay visually distinct rather than merging into one blob. */
  bodyR: 19,
};

export const PHYS = {
  gravity: -2100,
  /** Horizontal drag applied to knockback velocity while grounded. */
  groundFriction: 6.5,
  airFriction: 0.35,
};

export const MOVEMENT = {
  walkFwd: 172,
  walkBack: 138,
  crouchSpeed: 62,
  dashSpeed: 470,
  dashFrames: 13,
  dashRecovery: 7,
  dashCost: 12,
  jumpVel: 690,
  airControl: 105,
  /** Frames of landing recovery after a jump. */
  landFrames: 5,
};

export const STATS = {
  maxHealth: 100,
  maxStamina: 100,
  /** Stamina per second while not attacking. */
  staminaRegen: 26,
  /** Extra regen multiplier while blocking or idle at range. */
  restBonus: 1.5,
  exhaustedThreshold: 12,
  maxGuard: 100,
  guardRegen: 18,
  maxMeter: 100,
  /** Meter gained per point of damage dealt / taken. */
  meterOnDeal: 0.85,
  meterOnTake: 1.25,
};

export const COMBAT = {
  hitstop: 4,
  heavyHitstop: 9,
  blockHitstop: 3,
  /** Frames after pressing block during which an incoming hit is parried. */
  parryWindow: 6,
  parryStun: 34,
  guardBreakStun: 50,
  /** Fraction of damage that gets through a block. */
  chip: 0.14,
  /** Damage multiplier per extra hit in a combo. */
  comboScaling: 0.85,
  minComboScale: 0.34,
  /** Frames without contact before a combo is considered over. */
  comboWindow: 42,
  /** Damage bonus when hitting an opponent who is in startup/recovery. */
  counterBonus: 1.35,
  /** Invulnerability granted after getting up from a knockdown. */
  wakeupInvuln: 26,
  /** How long a downed fighter stays on the floor. */
  downFrames: 78,
  exhaustedDamageMul: 1.2,
};

export const ROUND = {
  time: 60, // seconds
  winsNeeded: 2,
  introFrames: 90,
  koFrames: 150,
  roundEndFrames: 120,
};

/**
 * Fighter archetypes. `weights` biases the AI's move selection and the
 * multipliers shape the same shared moveset into distinct feeling fighters.
 */
export const ARCHETYPES = {
  boxer: {
    name: 'Boxer',
    blurb: 'Fast hands, tight guard, lives in punch range.',
    damageMul: 0.97,
    speedMul: 1.06,
    defenseMul: 0.896,
    staminaMul: 1.1,
    weights: { jab: 3.2, cross: 2.4, hook: 1.8, uppercut: 1.4, lowKick: 0.5, highKick: 0.3, sweep: 0.4 },
  },
  kickboxer: {
    name: 'Kickboxer',
    blurb: 'Long legs, big damage, slower to recover.',
    damageMul: 1.12,
    speedMul: 0.97,
    defenseMul: 1.044,
    staminaMul: 0.95,
    weights: { jab: 1.4, cross: 1.2, hook: 0.9, uppercut: 0.7, lowKick: 2.6, highKick: 2.2, sweep: 1.5 },
  },
  brawler: {
    name: 'Brawler',
    blurb: 'Hits like a truck, guards like a screen door.',
    damageMul: 1.23,
    speedMul: 0.95,
    defenseMul: 1.002, // takes MORE damage
    staminaMul: 1.15,
    weights: { jab: 1.1, cross: 2.0, hook: 2.8, uppercut: 2.2, lowKick: 1.0, highKick: 0.8, sweep: 0.9 },
  },
  duelist: {
    name: 'Duelist',
    blurb: 'Balanced, patient, punishes everything.',
    damageMul: 0.98,
    speedMul: 1.0,
    defenseMul: 0.930,
    staminaMul: 1.0,
    weights: { jab: 1.8, cross: 1.6, hook: 1.3, uppercut: 1.2, lowKick: 1.6, highKick: 1.2, sweep: 1.2 },
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);

/**
 * AI difficulty tiers. `reaction` is in frames — it is a genuine perception
 * delay, the AI reads a stale snapshot of the opponent rather than cheating.
 */
export const DIFFICULTIES = {
  rookie: {
    name: 'Rookie',
    reaction: 20,
    blockSkill: 0.3,
    punishSkill: 0.2,
    spacing: 0.45,
    aggression: 0.5,
    comboSkill: 0.15,
    parrySkill: 0.02,
    meterSkill: 0.25,
    mistake: 0.3,
  },
  brawler: {
    name: 'Contender',
    reaction: 14,
    blockSkill: 0.5,
    punishSkill: 0.4,
    spacing: 0.6,
    aggression: 0.68,
    comboSkill: 0.35,
    parrySkill: 0.06,
    meterSkill: 0.5,
    mistake: 0.18,
  },
  veteran: {
    name: 'Veteran',
    reaction: 9,
    blockSkill: 0.72,
    punishSkill: 0.65,
    spacing: 0.78,
    aggression: 0.75,
    comboSkill: 0.6,
    parrySkill: 0.14,
    meterSkill: 0.72,
    mistake: 0.09,
  },
  master: {
    name: 'Master',
    reaction: 5,
    blockSkill: 0.9,
    punishSkill: 0.88,
    spacing: 0.92,
    aggression: 0.82,
    comboSkill: 0.85,
    parrySkill: 0.28,
    meterSkill: 0.9,
    mistake: 0.03,
  },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);

export const PALETTES = [
  { id: 'cyan', body: '#5ee7ff', accent: '#0ea5c6', trail: 'rgba(94,231,255,0.55)' },
  { id: 'amber', body: '#ffb347', accent: '#d97706', trail: 'rgba(255,179,71,0.55)' },
  { id: 'rose', body: '#ff6b8a', accent: '#be123c', trail: 'rgba(255,107,138,0.55)' },
  { id: 'lime', body: '#a3e635', accent: '#4d7c0f', trail: 'rgba(163,230,53,0.55)' },
  { id: 'violet', body: '#c4a2ff', accent: '#7c3aed', trail: 'rgba(196,162,255,0.55)' },
];
