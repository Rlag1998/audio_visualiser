// Application shell: fixed-timestep loop, mode wiring, menus and the lab.
//
// The simulation runs at a locked 60Hz regardless of the display refresh rate,
// so a 144Hz monitor sees smoother frames of the *same* fight, not a faster one.

import { Match, PHASE } from './game/match.js';
import { AIController, DummyController } from './game/ai.js';
import { ARCHETYPES, DIFFICULTIES, PALETTES, TICK } from './game/config.js';
import { STATE } from './game/fighter.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './render/hud.js';
import { Sfx } from './audio/sfx.js';
import { Keyboard, HumanController } from './input/input.js';
import { BatchRunner, RoundRobinRunner, roundRobin } from './sim/batch.js';
import { makeRng, randomSeed } from './core/rng.js';
import {
  MODES, buildFighterCard, buildModeRow, fillSelect, archetypeEntries, difficultyEntries,
  renderBatchReport, renderControls, renderTournament,
} from './ui/ui.js';

const $ = (id) => document.getElementById(id);

const dom = {
  stage: $('stage'),
  overlay: $('overlay'),
  boot: $('boot'),
  menu: $('menu'),
  lab: $('lab'),
  help: $('help'),
  pause: $('pause'),
  hint: $('hint'),
};

const settings = {
  mode: 'pvc',
  sides: [
    { archetype: 'boxer', palette: 0, difficulty: 'veteran', dummy: 'block' },
    { archetype: 'kickboxer', palette: 2, difficulty: 'veteran', dummy: 'block' },
  ],
  winsNeeded: 2,
  roundTime: 60,
  seed: 1,
  sound: true,
};

const renderer = new Renderer(dom.stage);
const hud = new Hud();
const sfx = new Sfx();
const keyboard = new Keyboard(window);

let match = null;
let running = false;
let paused = false;
let timeScale = 1;
let accumulator = 0;
let lastFrame = performance.now();
let screen = 'menu';

// --------------------------------------------------------------------- setup

function refreshMenu() {
  buildModeRow($('modeRow'), settings, refreshMenu);
  buildFighterCard($('cardP1'), 0, settings, refreshMenu);
  buildFighterCard($('cardP2'), 1, settings, refreshMenu);
}

function showScreen(name) {
  screen = name;
  const panels = { menu: dom.menu, lab: dom.lab, help: dom.help, pause: dom.pause };
  for (const [key, node] of Object.entries(panels)) node.classList.toggle('hidden', key !== name);
  dom.boot.classList.add('hidden');
  dom.overlay.classList.toggle('hidden', name === 'game');
  dom.hint.classList.toggle('hidden', name !== 'game');
  // Menus need Space, the arrows and `/` for their own controls.
  keyboard.setEnabled(name === 'game');
}

function controllerFor(side) {
  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0];
  const cfg = settings.sides[side];

  if (settings.mode === 'training' && side === 1) {
    if (cfg.dummy === 'stand') return new DummyController({ block: false });
    if (cfg.dummy === 'block') return new DummyController({ block: true });
    return new AIController({ difficulty: cfg.difficulty, rng: makeRng((settings.seed ^ 0xbeef) + side) });
  }
  if (mode.human[side]) {
    return new HumanController(keyboard, side === 0 ? 'p1' : 'p2', side);
  }
  return new AIController({
    difficulty: cfg.difficulty,
    rng: makeRng((settings.seed ^ 0x5eed) + side * 7919),
  });
}

function startMatch() {
  const training = settings.mode === 'training';
  settings.seed = Math.max(0, Math.floor(Number($('seed').value) || 1));
  settings.winsNeeded = Number($('winsNeeded').value);
  settings.roundTime = Number($('roundTime').value);
  settings.sound = $('sound').value === 'on';
  sfx.setEnabled(settings.sound);

  match = new Match({
    seed: settings.seed,
    roundTime: training ? 999 : settings.roundTime,
    winsNeeded: training ? 99 : settings.winsNeeded,
    fighters: settings.sides.map((s, i) => ({
      name: nameFor(i),
      archetype: s.archetype,
      palette: PALETTES[s.palette % PALETTES.length],
    })),
  });
  match.setControllers(controllerFor(0), controllerFor(1));

  hud.reset();
  renderer.particles.clear();
  renderer.fx.clear();
  accumulator = 0;
  timeScale = 1;
  paused = false;
  running = true;
  showScreen('game');
  updateHint();
}

function nameFor(side) {
  const cfg = settings.sides[side];
  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0];
  const arch = ARCHETYPES[cfg.archetype].name;
  if (settings.mode === 'training' && side === 1) return `Dummy ${arch}`;
  if (mode.human[side]) return `P${side + 1} ${arch}`;
  return `${DIFFICULTIES[cfg.difficulty].name} ${arch}`;
}

function updateHint() {
  const training = settings.mode === 'training';
  dom.hint.textContent = training
    ? 'TRAINING — R resets · ESC menu · F2 hitboxes'
    : 'ESC pause · R rematch · F2 hitboxes';
}

// ---------------------------------------------------------------- game loop

function stepSimulation() {
  const events = match.step(TICK);
  renderer.handleEvents(events);
  sfx.playEvents(events);

  // Training never really ends — reset the moment someone drops.
  if (settings.mode === 'training' && match.phase === PHASE.KO) {
    match.restartRound();
    hud.reset();
    return;
  }

  // Slow motion for the knockout, then the results panel.
  if (match.phase === PHASE.KO) timeScale = 0.32;
  else if (match.phase === PHASE.MATCH_END) {
    timeScale = 1;
    if (running) {
      running = false;
      showResults();
    }
  } else timeScale = 1;
}

function showResults() {
  const winner = match.fighters[match.winner];
  $('pauseTitle').textContent = 'MATCH OVER';
  $('pauseSub').textContent = `${winner.name} takes it ${match.p1.wins}–${match.p2.wins}.`;
  $('pauseStats').innerHTML = statsTable();
  $('resumeBtn').textContent = 'REMATCH';
  showScreen('pause');
}

function statsTable() {
  const rows = match.fighters.map((f, i) => {
    const s = match.stats[i];
    return `<tr><td>${f.name}</td><td>${Math.round(s.damageDealt)}</td><td>${s.hits}</td>` +
      `<td>${s.blocked}</td><td>${s.parries}</td><td>${s.knockdowns}</td><td>${s.maxCombo}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Fighter</th><th>Damage</th><th>Hits</th><th>Blocked</th>` +
    `<th>Parries</th><th>Knockdowns</th><th>Best combo</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function frame(now) {
  const raw = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  if (match && running && !paused) {
    accumulator += raw * timeScale;
    let steps = 0;
    while (accumulator >= TICK && steps < 6) {
      stepSimulation();
      accumulator -= TICK;
      steps++;
      if (!running) break;
    }
    if (accumulator > TICK * 6) accumulator = 0; // recover from a long stall

    // Only retire edge-triggered presses once a tick has actually consumed
    // them. On a 144Hz display most animation frames run zero ticks, and
    // clearing here unconditionally would silently swallow more than half of
    // every player's attacks.
    if (steps > 0) keyboard.endFrame();
  } else {
    // Nothing is simulating — drop whatever was pressed rather than letting it
    // pile up and fire as a burst on the first tick after resuming.
    keyboard.endFrame();
  }

  if (match) {
    renderer.draw(match, raw);
    const ctx = renderer.ctx;
    ctx.save();
    ctx.setTransform(renderer.dpr, 0, 0, renderer.dpr, 0, 0);
    hud.draw(ctx, match, {
      width: renderer.cssWidth,
      height: renderer.cssHeight,
      camera: renderer.camera,
    }, raw);
    ctx.restore();
  }

  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------- the lab

let labRunner = null;
let labRaf = 0;

function stopLab() {
  if (labRaf) cancelAnimationFrame(labRaf);
  labRaf = 0;
  labRunner = null;
}

function runBatchUi() {
  stopLab();
  const opts = {
    matches: Number($('labCount').value),
    seed: Math.max(0, Math.floor(Number($('labSeed').value) || 1)),
    a: {
      archetype: $('labArchA').value,
      difficulty: $('labDiffA').value,
      name: `${ARCHETYPES[$('labArchA').value].name} · ${DIFFICULTIES[$('labDiffA').value].name}`,
    },
    b: {
      archetype: $('labArchB').value,
      difficulty: $('labDiffB').value,
      name: `${ARCHETYPES[$('labArchB').value].name} · ${DIFFICULTIES[$('labDiffB').value].name}`,
    },
  };
  labRunner = new BatchRunner(opts);
  $('labResults').textContent = '';
  const t0 = performance.now();

  const tick = () => {
    if (!labRunner) return;
    // Keep each slice under ~24ms so the page never visibly stalls.
    const sliceEnd = performance.now() + 24;
    while (performance.now() < sliceEnd && !labRunner.finished) labRunner.runChunk(4);

    const pct = labRunner.progress;
    $('labProgress').style.width = `${(pct * 100).toFixed(1)}%`;
    $('labStatus').textContent = `Simulating… ${labRunner.done} / ${labRunner.total} matches`;

    if (labRunner.finished) {
      const ms = Math.round(performance.now() - t0);
      $('labStatus').textContent =
        `${labRunner.total} matches simulated in ${ms}ms (${Math.round(labRunner.total / (ms / 1000))} per second).`;
      renderBatchReport($('labResults'), labRunner.report());
      stopLab();
      return;
    }
    labRaf = requestAnimationFrame(tick);
  };
  labRaf = requestAnimationFrame(tick);
}

function runTournamentUi() {
  stopLab();
  const difficulty = $('labDiffA').value;
  const per = Number($('labCount').value);
  const runner = new RoundRobinRunner({
    matchesPerPair: per,
    difficulty,
    seed: Math.max(0, Math.floor(Number($('labSeed').value) || 7)),
  });
  labRunner = runner;
  $('labResults').textContent = '';
  const t0 = performance.now();
  const totalMatches = per * runner.pairs.length;

  const tick = () => {
    if (labRunner !== runner) return;
    const sliceEnd = performance.now() + 24;
    while (performance.now() < sliceEnd && !runner.finished) runner.runChunk(4);

    $('labProgress').style.width = `${(runner.progress * 100).toFixed(1)}%`;
    $('labStatus').textContent =
      `Simulating ${runner.label}… ${(runner.progress * 100).toFixed(0)}% of ${totalMatches} matches`;

    if (runner.finished) {
      const ms = Math.round(performance.now() - t0);
      $('labStatus').textContent = `${totalMatches} matches across ${runner.pairs.length} pairings in ${ms}ms.`;
      renderTournament($('labResults'), runner.report(),
        `${per} matches per pairing at ${DIFFICULTIES[difficulty].name} difficulty.`);
      stopLab();
      return;
    }
    labRaf = requestAnimationFrame(tick);
  };
  labRaf = requestAnimationFrame(tick);
}

// -------------------------------------------------------------------- wiring

function wire() {
  refreshMenu();
  renderControls($('controlTable'));

  fillSelect($('labArchA'), archetypeEntries(), 'boxer');
  fillSelect($('labArchB'), archetypeEntries(), 'kickboxer');
  fillSelect($('labDiffA'), difficultyEntries(), 'veteran');
  fillSelect($('labDiffB'), difficultyEntries(), 'veteran');

  $('fightBtn').addEventListener('click', () => {
    sfx.unlock();
    sfx.ui();
    startMatch();
  });
  $('labBtn').addEventListener('click', () => {
    sfx.unlock();
    showScreen('lab');
  });
  $('helpBtn').addEventListener('click', () => showScreen('help'));
  $('helpBackBtn').addEventListener('click', () => showScreen('menu'));
  $('labBackBtn').addEventListener('click', () => {
    stopLab();
    showScreen('menu');
  });
  $('randomSeedBtn').addEventListener('click', () => {
    $('seed').value = String(randomSeed() % 100000);
  });
  $('runBatchBtn').addEventListener('click', runBatchUi);
  $('runTourneyBtn').addEventListener('click', runTournamentUi);

  $('resumeBtn').addEventListener('click', () => {
    if (running) {
      paused = false;
      showScreen('game');
    } else {
      startMatch();
    }
  });
  $('rematchBtn').addEventListener('click', () => startMatch());
  $('menuBtn').addEventListener('click', () => {
    running = false;
    match = null;
    showScreen('menu');
  });

  window.addEventListener('resize', () => renderer.resize());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (screen === 'game') {
        paused = true;
        $('pauseTitle').textContent = 'PAUSED';
        $('pauseSub').textContent = 'The fight is on hold.';
        $('pauseStats').innerHTML = match ? statsTable() : '';
        $('resumeBtn').textContent = 'RESUME';
        showScreen('pause');
      } else if (screen === 'pause') {
        if (running) {
          paused = false;
          showScreen('game');
        } else {
          showScreen('menu');
        }
      } else if (screen !== 'menu') {
        stopLab();
        showScreen('menu');
      }
      e.preventDefault();
    } else if (e.code === 'KeyR' && (screen === 'game' || screen === 'pause') && match) {
      startMatch();
    } else if (e.code === 'F2') {
      renderer.showDebug = !renderer.showDebug;
      e.preventDefault();
    }
  });

  // Any first interaction unlocks audio.
  const unlock = () => sfx.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  showScreen('menu');
  renderer.resize();
  requestAnimationFrame((t) => {
    lastFrame = t;
    frame(t);
  });
}

wire();

// Handy for poking at the engine from the console.
globalThis.stickFight = {
  get match() { return match; },
  settings,
  renderer,
  roundRobin,
  BatchRunner,
};
