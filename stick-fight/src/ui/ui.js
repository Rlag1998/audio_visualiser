// Menu / lab DOM. Kept apart from main.js so the game loop stays readable and
// the engine keeps zero knowledge of the document.

import { ARCHETYPES, ARCHETYPE_IDS, DIFFICULTIES, DIFFICULTY_IDS, PALETTES } from '../game/config.js';
import { CONTROL_HELP } from '../input/input.js';

export const MODES = [
  { id: 'pvc', label: 'Player vs CPU', human: [true, false] },
  { id: 'pvp', label: 'Player vs Player', human: [true, true] },
  { id: 'cvc', label: 'CPU vs CPU', human: [false, false] },
  { id: 'training', label: 'Training', human: [true, false] },
];

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid);
  return n;
};

export function fillSelect(select, entries, value) {
  select.textContent = '';
  for (const [val, label] of entries) {
    select.append(el('option', { value: val, text: label }));
  }
  if (value !== undefined) select.value = value;
}

export const archetypeEntries = () => ARCHETYPE_IDS.map((id) => [id, ARCHETYPES[id].name]);
export const difficultyEntries = () => DIFFICULTY_IDS.map((id) => [id, DIFFICULTIES[id].name]);

/** Mode selector: a row of toggle chips. */
export function buildModeRow(root, settings, onChange) {
  root.textContent = '';
  for (const mode of MODES) {
    const b = el('button', {
      class: 'chip',
      type: 'button',
      text: mode.label,
      'aria-pressed': String(settings.mode === mode.id),
      onclick: () => {
        settings.mode = mode.id;
        onChange();
      },
    });
    root.append(b);
  }
}

/** One fighter setup card: archetype, colour, and CPU difficulty. */
export function buildFighterCard(root, side, settings, onChange) {
  const cfg = settings.sides[side];
  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0];
  const isHuman = mode.human[side];
  const training = settings.mode === 'training';
  const palette = PALETTES[cfg.palette % PALETTES.length];

  root.textContent = '';
  root.append(
    el('div', { class: 'fighter-head' }, [
      el('span', { class: 'swatch', style: `background:${palette.body};color:${palette.body}` }),
      el('strong', { text: side === 0 ? 'LEFT CORNER' : 'RIGHT CORNER' }),
      el('span', {
        class: 'side-tag',
        text: training && side === 1 ? 'DUMMY' : isHuman ? `HUMAN · P${side + 1}` : 'CPU',
      }),
    ]),
  );

  const chips = el('div', { class: 'row' });
  for (const id of ARCHETYPE_IDS) {
    chips.append(el('button', {
      class: 'chip',
      type: 'button',
      text: ARCHETYPES[id].name,
      'aria-pressed': String(cfg.archetype === id),
      onclick: () => {
        cfg.archetype = id;
        onChange();
      },
    }));
  }
  root.append(chips);
  root.append(el('div', { class: 'blurb', text: ARCHETYPES[cfg.archetype].blurb }));

  const colours = el('div', { class: 'row' });
  PALETTES.forEach((p, i) => {
    colours.append(el('button', {
      class: 'chip',
      type: 'button',
      title: p.id,
      style: `padding:6px 10px`,
      'aria-pressed': String(cfg.palette === i),
      onclick: () => {
        cfg.palette = i;
        onChange();
      },
    }, [el('span', { class: 'swatch', style: `background:${p.body};color:${p.body};display:block` })]));
  });
  root.append(colours);

  if (training && side === 1) {
    const sel = el('select');
    fillSelect(sel, [
      ['stand', 'Stands still'],
      ['block', 'Blocks everything'],
      ['fight', 'Fights back'],
    ], cfg.dummy);
    sel.addEventListener('change', () => {
      cfg.dummy = sel.value;
      onChange();
    });
    root.append(el('label', { class: 'field', text: 'Behaviour' }, [sel]));
  }

  if (!isHuman && !(training && side === 1 && cfg.dummy !== 'fight')) {
    const sel = el('select');
    fillSelect(sel, difficultyEntries(), cfg.difficulty);
    sel.addEventListener('change', () => {
      cfg.difficulty = sel.value;
      onChange();
    });
    root.append(el('label', { class: 'field', text: 'CPU difficulty' }, [sel]));
  }
}

export function renderControls(table) {
  table.textContent = '';
  const head = el('thead', {}, [
    el('tr', {}, [
      el('th', { text: 'Action' }),
      el('th', { text: 'Player 1' }),
      el('th', { text: 'Player 2' }),
    ]),
  ]);
  const body = el('tbody');
  for (const [action, p1, p2] of CONTROL_HELP) {
    body.append(el('tr', {}, [
      el('td', { text: action }),
      el('td', {}, [el('span', { class: 'kbd', text: p1 })]),
      el('td', {}, [el('span', { class: 'kbd', text: p2 })]),
    ]));
  }
  const extra = [
    ['Pause / menu', 'Esc', ''],
    ['Rematch', 'R', ''],
    ['Hitbox debug view', 'F2', ''],
  ];
  for (const [action, p1, p2] of extra) {
    body.append(el('tr', {}, [
      el('td', { text: action }),
      el('td', {}, [el('span', { class: 'kbd', text: p1 })]),
      el('td', { text: p2 }),
    ]));
  }
  table.append(head, body);
}

// ------------------------------------------------------------------- results

function winBar(name, frac, color) {
  return el('div', { class: 'winbar' }, [
    el('span', { text: name }),
    el('div', { class: 'meter' }, [
      el('div', { style: `width:${(frac * 100).toFixed(1)}%;background:${color}` }),
    ]),
    el('span', { class: 'val', text: `${(frac * 100).toFixed(1)}%` }),
  ]);
}

export function renderBatchReport(root, report) {
  root.textContent = '';
  const [A, B] = report.sides;

  root.append(el('h2', { text: 'Win rate' }));
  root.append(winBar(A.name, A.winRate, 'linear-gradient(90deg,#5ee7ff,#22d3ee)'));
  root.append(winBar(B.name, B.winRate, 'linear-gradient(90deg,#ff6b8a,#f43f5e)'));
  if (report.draws) {
    root.append(el('div', { class: 'note', text: `${report.draws} draw${report.draws === 1 ? '' : 's'}.` }));
  }

  root.append(el('h2', { text: 'Match summary' }));
  const sum = el('table');
  sum.append(el('thead', {}, [el('tr', {}, [
    'Fighter', 'Wins', 'Rounds', 'Dmg / match', 'Hits / match', 'Accuracy', 'KOs', 'Parries', 'Best combo',
  ].map((t) => el('th', { text: t })))]));
  const sbody = el('tbody');
  for (const s of report.sides) {
    sbody.append(el('tr', {}, [
      el('td', { text: s.name }),
      el('td', { text: String(s.matchWins) }),
      el('td', { text: String(s.roundWins) }),
      el('td', { text: s.avgDamagePerMatch.toFixed(1) }),
      el('td', { text: s.avgHitsPerMatch.toFixed(1) }),
      el('td', { text: `${(s.accuracy * 100).toFixed(0)}%` }),
      el('td', { text: String(s.kos) }),
      el('td', { text: String(s.parries) }),
      el('td', { text: String(s.bestCombo) }),
    ]));
  }
  sum.append(sbody);
  root.append(sum);

  for (const s of report.sides) {
    root.append(el('h2', { text: `${s.name} — move breakdown` }));
    const t = el('table');
    t.append(el('thead', {}, [el('tr', {}, ['Move', 'Thrown', 'Hit', 'Blocked', 'Hit %', 'Contact %', 'Damage']
      .map((x) => el('th', { text: x })))]));
    const tb = el('tbody');
    for (const m of s.moves) {
      if (!m.thrown) continue;
      tb.append(el('tr', {}, [
        el('td', { text: m.id }),
        el('td', { text: String(m.thrown) }),
        el('td', { text: String(m.hit) }),
        el('td', { text: String(m.blocked) }),
        el('td', { text: `${(m.hitRate * 100).toFixed(0)}%` }),
        el('td', { text: `${(m.contactRate * 100).toFixed(0)}%` }),
        el('td', { text: m.damage.toFixed(0) }),
      ]));
    }
    t.append(tb);
    root.append(t);
  }

  root.append(el('div', {
    class: 'note',
    style: 'margin-top:12px',
    text: `${report.matches} matches · average ${report.avgMatchSeconds}s of fight time each` +
      (report.timeouts ? ` · ${report.timeouts} hit the safety frame limit` : ''),
  }));
}

export function renderTournament(root, rows, meta) {
  root.textContent = '';
  root.append(el('h2', { text: 'Round robin standings' }));
  for (const r of rows) {
    root.append(winBar(r.name, r.winRate, 'linear-gradient(90deg,#5ee7ff,#ffd166)'));
  }
  const t = el('table');
  t.append(el('thead', {}, [el('tr', {}, ['Archetype', 'Played', 'Won', 'Lost', 'Drawn', 'Win rate']
    .map((x) => el('th', { text: x })))]));
  const tb = el('tbody');
  for (const r of rows) {
    tb.append(el('tr', {}, [
      el('td', { text: r.name }),
      el('td', { text: String(r.played) }),
      el('td', { text: String(r.wins) }),
      el('td', { text: String(r.losses) }),
      el('td', { text: String(r.draws) }),
      el('td', { text: `${(r.winRate * 100).toFixed(1)}%` }),
    ]));
  }
  t.append(tb);
  root.append(t);
  if (meta) root.append(el('div', { class: 'note', style: 'margin-top:12px', text: meta }));
}

export { el };
