# Stick Fight — Combat Simulator

A stick-figure fighting game built on a real fighting-game engine: frame-data moves,
guard heights, parries, counter hits, combo scaling, stamina, and verlet ragdolls for
knockdowns and KOs.

The interesting part is that the whole fight engine is **DOM-free and deterministic**.
The same code that draws two stick figures beating each other up on a canvas also runs
headless under Node, thousands of matches at a time, so balance questions get answered
with numbers instead of opinions.

```
Boxer vs Kickboxer, 400 matches, Veteran AI — about 9 seconds
  Boxer      ███████████░░░░░░░░░  54.0%    210.4 dmg/match   48% accuracy
  Kickboxer  █████████░░░░░░░░░░░  46.0%    203.8 dmg/match   49% accuracy
```

## Running it

The game is ES modules, so it needs to be served over HTTP — opening `index.html`
straight off disk will not work (the browser blocks module loading from `file://`).

```bash
cd stick-fight
npm start                      # python3 -m http.server 8080
# or: npx serve -l 8080 .
```

Then open <http://localhost:8080/>. There is no build step and no dependencies.

## Modes

| Mode | What it is |
| --- | --- |
| **Player vs CPU** | You against a CPU at one of four difficulties |
| **Player vs Player** | Two people, one keyboard |
| **CPU vs CPU** | Watch two AIs fight — good for seeing the moveset |
| **Training** | Infinite clock against a dummy that stands, blocks, or fights back |
| **Simulation lab** | Headless batch runs and an archetype round robin |

## Controls

| Action | Player 1 | Player 2 |
| --- | --- | --- |
| Move / turn | `A` `D` | `←` `→` |
| Jump | `W` | `↑` |
| Crouch | `S` | `↓` |
| Dash | double-tap `A`/`D` | double-tap `←`/`→` |
| Guard (tap = parry) | `Space` | `R-Shift` / `Num0` / `'` |
| Jab | `J` | `Num1` / `,` |
| Punch — hold forward for a hook, crouch for an uppercut | `K` | `Num2` / `.` |
| Kick — crouch for a sweep | `L` | `Num3` / `/` |
| High kick | `I` | `Num5` / `;` |
| Finisher (needs a full meter) | `U` | `NumEnter` / `\` |

`Esc` pauses, `R` restarts the match, `F2` draws hitboxes and hurtboxes.
Gamepads are picked up automatically if one is plugged in.

## The fight system

**Frame data.** Every attack is startup → active → recovery, in 60Hz frames. A jab is
4/3/9 — fast, safe, low reward. A high kick is 13/5/23 — it will win the round or get you
punished, nothing in between. The AI reads this table too, so it knows a slow move is a
bad idea when you are about to recover.

| Move | Startup | Active | Recovery | Damage | Guard height | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Jab | 4 | 3 | 9 | 6 | high | The poke. Starts everything. |
| Cross | 7 | 4 | 15 | 12 | high | The workhorse. |
| Hook | 11 | 4 | 19 | 17 | high | Commitment. Punishable on whiff. |
| Uppercut | 9 | 4 | 23 | 15 | mid | Launcher. Anti-air. Awful on block. |
| Low kick | 8 | 4 | 15 | 10 | low | Goes under a standing guard. |
| High kick | 13 | 5 | 23 | 19 | high | Longest normal. Sails over a crouch. |
| Sweep | 10 | 5 | 22 | 9 | low | Knocks down. |
| Finisher | 16 | 6 | 26 | 30 | mid | Breaks guards, cannot be parried. |
| Air kick | 6 | 8 | 10 | 13 | high | Air only. |

**Guard height.** Standing guard stops highs and mids; crouching guard stops lows and
mids. So sweeps and low kicks beat a standing guard, and high kicks beat a crouching one.
That is the mixup, and the AI plays it — it tracks which way you have been guarding and
starts going the other way.

**Parry.** A guard *pressed* within 6 frames of the hit reflects it and stuns the
attacker for over half a second. Holding guard does not re-arm the window; you have to
time the press. The CPU only attempts parries as often as its skill stat allows.

**Guard meter.** Blocking chips it away. Empty it and your guard breaks, leaving you
stunned for 50 frames — long enough to eat a full combo.

**Counter hits** do 35% extra and land when you catch someone in startup or recovery.

**Combos.** Landing a hit lets you cancel the rest of your recovery into another move,
up to four deep. Each extra hit scales damage down toward a 34% floor, so a long combo is
flashy but not free.

**Stamina** pays for every attack and every dash. Run out and you cannot attack or guard
until it recovers — and you take 20% more damage while exhausted.

**Ragdolls.** Knockdowns and KOs hand the skeleton to a verlet solver seeded with the
fighter's own joint positions and momentum, so the transition is seamless. Get knocked
down and you stand back up wherever your body landed, with brief wake-up invulnerability.

## Archetypes

Four fighters share one moveset but not one personality — the multipliers reshape it, and
the AI's move weights make each one *look* different in motion.

| | Damage | Speed | Damage taken | Stamina | Plays like |
| --- | --- | --- | --- | --- | --- |
| **Boxer** | ×0.97 | ×1.06 | ×0.93 | ×1.10 | Lives in punch range, tight guard |
| **Kickboxer** | ×1.12 | ×0.97 | ×1.00 | ×0.95 | Long legs, big damage, slower recovery |
| **Brawler** | ×1.23 | ×0.95 | ×1.04 | ×1.15 | Hits like a truck, guards like a screen door |
| **Duelist** | ×0.98 | ×1.00 | ×0.90 | ×1.00 | Balanced, patient, punishes everything |

Those numbers are not guesses — they were tuned against the simulator. `npm run balance`
runs the full round robin across five seeds and reports the mean, because a single round
robin has a standard deviation of several points and will happily tell you a balanced
roster is broken:

```
$ npm run balance

  Balance across 5 seeds x 60 matches per pairing (1800 matches, 42s)

    archetype      mean     sd   worst    best   under <-- 50% --> over
    Brawler       51.6%   4.1%   45.6%   55.6%   ...............|#.............
    Kickboxer     50.5%   1.5%   47.8%   52.2%   ...............#..............
    Duelist       50.0%   1.8%   47.2%   52.8%   ...............#..............
    Boxer         48.0%   2.0%   45.6%   51.1%   .............#.|..............

  worst deviation from even: 2.0 points
  BALANCED — within 4 points
```

The first pass through this harness caught a real problem: the Duelist had the best
damage reduction in the game and no drawback to pay for it, and was winning 56% of a
1800-match round robin. It took one measured iteration to bring the whole roster inside
two points of even. You can try a candidate tuning without editing anything:

```bash
node src/sim/balance.mjs 60 veteran '{"duelist":{"defenseMul":0.85}}'
```

## The CPU

The AI is deliberately **not** omniscient. It reads a snapshot of its opponent that is
`reaction` frames stale, so a Rookie genuinely cannot see a 4-frame jab coming and a
Master can. Everything else is probability: how often it blocks, guesses the guard height
right, punishes a whiff, respects spacing, or throws something out for no reason at all.

| | Reaction | Blocks | Punishes | Spacing | Parries | Mistakes |
| --- | --- | --- | --- | --- | --- | --- |
| Rookie | 20f | 30% | 20% | 45% | 2% | 30% |
| Contender | 14f | 50% | 40% | 60% | 6% | 18% |
| Veteran | 9f | 72% | 65% | 78% | 14% | 9% |
| Master | 5f | 90% | 88% | 92% | 28% | 3% |

The ladder is monotonic, and measurably so — 200 matches of Rookie vs Master:

```
Rookie  █░░░░░░░░░░░░░░░░░░░   5.0%    129.1 dmg/match   42% accuracy
Master  ███████████████████░  95.0%    230.5 dmg/match   56% accuracy
```

## The simulation lab

Because the engine never touches the DOM and every decision draws from a seeded RNG, a
match is a pure function of its seed. That buys three things:

- **Reproducible fights.** Same seed, same fight, frame for frame.
- **Batch balance testing.** Run 1000 matches in the browser without blocking the page,
  and read win rates, per-move hit rates, accuracy, KOs, parries and best combos.
- **Regression tests.** The test suite asserts on whole-match outcomes.

In the browser: **Simulation lab** on the menu. From the terminal:

```bash
node src/sim/cli.mjs match 42 boxer brawler veteran   # one fight, blow by blow
node src/sim/cli.mjs batch 200 boxer kickboxer veteran master
node src/sim/cli.mjs tournament 40 veteran            # every archetype vs every other
node src/sim/balance.mjs 60 veteran                  # multi-seed balance report
```

```
$ node src/sim/cli.mjs batch 400 boxer kickboxer veteran

  400 matches, veteran vs veteran AI, 9182ms (44/s)
  avg match 53.1s   draws 0   timeouts 0

  Boxer/Veteran     ############.......... 54.0%  dmg/match 210.4  acc 48%  KO 518
  Kickboxer/Veteran ##########............ 46.0%  dmg/match 203.8  acc 49%  KO 466

  Boxer/Veteran
    move        thrown    hit  blocked   hit%      dmg
    cross         4889   3246     1100     66    39324
    jab           4819   2174      987     45    12771
    lowKick       1046    439       93     42     4705
    hook          1667    253      291     15     5500
    ...
```

That last column is the point: the cross lands two thirds of the time and the hook lands
one in seven. Both numbers are intentional — one is the workhorse, the other is the
gamble — but you only know they landed where you wanted them by running the fight a few
thousand times.

## Tests

```bash
npm test        # 41 tests, no browser required
```

They cover the frame-data table, pose blending, the IK solver (bone lengths preserved,
unreachable targets clamped rather than exploding), guard-height rules, the parry
window — including a regression test for a free-parry exploit found during development —
guard breaks, combo scaling, knockdown and wake-up, ragdoll stability, arena bounds,
match termination, seed determinism, the batch report's internal consistency, and a wide
guard rail on roster balance.

## Layout

```
src/
  core/      math.js, rng.js                pure helpers, seeded RNG
  game/      config.js                      every tunable number
             pose.js, skeleton.js           poses, FK arms + IK legs, hurt volumes
             moves.js                       the move table
             fighter.js                     state machine, physics, combat
             ragdoll.js                     verlet ragdoll
             ai.js                          the CPU opponent
             match.js                       rounds, hit resolution, stats
  sim/       batch.js, cli.mjs, balance.mjs  headless simulation and tuning
  render/    camera.js, particles.js, renderer.js, hud.js
  audio/     sfx.js                         procedural WebAudio, zero assets
  input/     input.js                       keyboard + gamepad
  ui/        ui.js                          menus and lab DOM
  main.js                                   app shell and the fixed-timestep loop
test/        engine.test.mjs, match.test.mjs
```

The dependency rule: `core` → `game` → `sim` never import from `render`, `audio`, `input`,
`ui` or `main`. That is what keeps the engine testable and the simulator fast.

## Notes on the design

**Legs are IK, arms are FK.** Authoring a kick as "put the foot *here*" is far easier to
tune than a chain of joint angles, and it guarantees feet land on the floor instead of
hovering or sinking. Arms stay FK because a punch is about the shape of the arm, not where
the fist ends up.

**Fixed timestep.** The simulation always advances in 1/60s ticks with an accumulator, so
a 144Hz monitor shows smoother frames of the *same* fight rather than a faster one — and
the browser and headless runs stay bit-identical.

**No assets.** Sound is synthesised from oscillators and a noise buffer at runtime; the
skyline is procedural. The whole project is text.
