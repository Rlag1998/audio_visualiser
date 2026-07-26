# NeuroWorld — a 2D world generator whose terrain *is* a neural network

**[Open `index.html` in any browser. No build, no server, no dependencies.](index.html)**
Or take **[`neuroworld.html`](neuroworld.html)** — the same app inlined into one
133 KB file you can email to someone. Regenerate it with `node build.js` after any
change; the modular files under `js/` stay the source of truth.

Most procedural world generators layer fractal noise and then sort the result into
biomes with an if-chain. NeuroWorld replaces both halves with neural networks:

- **The terrain is a network's output.** A CPPN — a compositional pattern producing
  network with random weights and a random activation function per neuron — is
  evaluated at every tile coordinate. Its six output channels *are* elevation,
  moisture, temperature, rivers, flora and minerals. Nothing is precomputed and
  nothing is persisted — the map is unbounded in every direction because it is a
  pure function of position.
- **The biomes are a network's classification.** A small MLP trains in your tab,
  with Adam and cross-entropy, to read those fields and answer with a probability
  distribution over 16 biomes. You watch the loss come down before the first frame
  is drawn. Because the answer is a softmax rather than a threshold, coastlines,
  treelines and desert margins come out as gradients.

And because the terrain is weights, worlds can be **bred** — including a full
tournament mode: head-to-head duels you judge, winners crossed with each other,
mutation shrinking each generation so the line converges on what you keep picking.
Every mutation step is a seed and a whole tournament serialises to one ~50-byte
lineage entry, so an evolved planet is reproducible from a URL.

And on top of the terrain sits a **derived civilisation** — nothing simulated,
nothing stored, everything a pure function of the ground:

- **Settlements** score their sites from the six channels — fresh water, workable
  ground, flora, ore, a tolerable climate.
- **Cultures** are the regional terrain: coastal regions raise Tidefolk, highlands
  Cragfolk, deserts Duneborn, wetlands Mirefolk, tundra Frostkin, plains
  Heartlanders. Each family owns a phoneme bank, so every person, clan, deity,
  town and nation in a region sounds related — and each family forms **dialects**:
  every 1024-tile region applies its own pair of sound shifts to the bank and its
  own patronymic formula, so neighbouring towns speak identically while the same
  folk half a world away sound like cousins, not clones (Maren speech in the
  *Bryno manner* names a town Brynhaven where another coast says Brenhaven).
  The same regional drift carries the rest of material culture: which of the
  family's crafts a region is known for, what it builds in (stone because it *is*
  stony), what is on its table, and the value its climate's real scarcity
  teaches.
- **Nations** form around the best town of each province; every other town swears
  to the capital *cheapest to reach over real terrain*, so borders fall on
  mountains and straits by construction.
- **Religions** worship what the land actually offers — sea, peaks, rivers, fire,
  forest, sky — with rites answering the climate's real scarcities and taboos to
  match.
- **Clans, people, families**: three generations per leading clan, patronymics
  running through them in the culture's own formula, ages consistent with the
  world's calendar.
- **Artifacts** are made of the materials the town really has (volcanic glass,
  walrus ivory, heart-oak), by the clan whose craft fits, for the faith the
  nation really holds — and never predate their town.
- **Trade** flows between complementary neighbours, and **roads** are pathfound
  over the actual ground: they climb passes, bridge rivers, and turn into dashed
  ferry lines over water.
- **History** is annotation of geography: wars happen at the pass or strait
  between neighbouring capitals, floods to low river capitals, ash-years to
  volcanic ones.

Click any town for its dossier. Ask about a town a million tiles away and its
founding year, patron deity and ruling clans are already decided — they follow
from the ground it stands on.

## Try this first

1. Open it and wait ~2 seconds for the biome network to train.
2. **Hover the map.** The inspector at the bottom of the panel shows that tile's
   entire forward pass: the input vector, every hidden activation, and the softmax
   the renderer blended into that pixel's colour.
3. Look at the contact sheet under **the network**: every neuron of a hidden layer,
   over the same patch of map, from one forward pass. That is the basis the terrain
   is built from — a weighted sum of those pictures is your coastline. Click one to
   put it on the main map full size.
4. Drag **network authority** from 100% to 0%. At 100% the terrain is purely the
   network; at 0% it is the plain fractal noise the network receives as input —
   weighted as a conventional fbm terrain, not deliberately made bland, because a
   comparison against a rigged baseline is worth nothing. The land/sea split and
   the climate spread are held identical across the dial too. What changes is
   structure: the noise gives you smooth blobby landmasses, the network gives you
   folded coastlines, marbling and enclosed basins.
5. Click an **offspring** thumbnail, then another, then another. That is interactive
   evolution: each is the parent's weights plus gaussian noise, with the odd
   activation function swapped. Hit **link** and the whole lineage is in the URL.
   For the full loop, **run a tournament**: three duels pick a generation's
   winners, a final crowns its champion, and the next generation is the champion
   kept unchanged plus three crossbreeds of the winners plus two mutants, with
   mutation decaying 20% per generation. Adopt the champion whenever you're happy.
6. Zoom in. Place names appear around 6 px/tile, props past 8, and roads thread
   between the towns. **Click any town**: its dossier opens — nation, culture,
   faith, clans, three generations of named people, treasures, trade partners and
   the nation's chronicle, all derived, all consistent with the terrain around it.

## Controls

| | |
|---|---|
| drag / **WASD** | pan |
| wheel, **+** / **−**, HUD buttons | zoom |
| **R** | new brain (new seed) |
| **N** | adopt the first mutant |
| **M** | cycle view mode |
| **space** | animate the latent vector |
| **G** | chunk grid |

Nine view modes: learned biomes, elevation, moisture, temperature, slope, hydrology,
flora density, mineral density, and a single hidden neuron's activation.

The panel carries the instrumentation: the network's topology and activation mix, the
contact sheet of every neuron in a layer, the biome network's loss curve and its
honest agreement score, a 16-class legend, and an inspector that shows the complete
forward pass for whatever tile is under the cursor.

## How it works

```
tile (x, y)
   │
   ├─ 16 features: sinusoids of position, 6 gradient-noise channels, latent z
   │
   ▼
CPPN  16 → 24 → 24 → 24 → 6      random weights, per-neuron activation, untrained
   │
   ├─ percentile normalisation (per world, measured from 2048 scattered samples)
   ├─ hypsometric curve  → elevation
   ├─ altitude lapse     → temperature
   ├─ ∇ of channel 4     → rivers at the zero-crossings, decorrelated from height
   │
   ▼
biome MLP  5 → 20 → 18 → 16      trained in-browser against a rule oracle
   │
   ▼
softmax → blended palette → hillshade → tiles → props, settlements
```

### Four problems worth knowing about

**A random deep network's output is not usable as-is.** Stacked tanh piles its mass
at ±1, so the raw elevation channel gives a planet that is all abyss and all
snowcap with nothing between. Each world therefore measures its own output
distribution once (2048 scattered samples, a 256-bin lookup table per channel) and
terrain is built from the *rank* rather than the value. This changes nothing about
where the network puts its features — every coastline is still exactly a level set
of the network — it only fixes how those levels map onto heights and climates.

**Blending two ranks by averaging is wrong.** The mean of two independent uniforms
bunches around 0.5, which silently deleted every mountain and abyss at authority
0.8. The authority dial mixes in logit space and rescales the variance, so the
marginal distribution is identical at every setting.

**Point-sampling a world with detail at a few tiles per cycle aliases into
confetti.** Every coarse view drops the noise octaves below its own Nyquist limit,
and the ones that are *still* images — the minimap, the offspring thumbnails — also
supersample 2× before downscaling. A thumbnail you cannot tell apart from its
siblings is useless for choosing a parent. The viewport preview skips the
supersampling on purpose: it is only ever shown while something is moving, and
motion hides aliasing that resolution would have had to fix.

**Every zero-crossing of the river channel is a watercourse, and there are far more
of them than a map should draw.** Ungated they cover the continent in a uniform net
of threads that reads as contour lines rather than water. Two smooth gates fix it
without touching the geometry — rivers run where it rains, and they fade with
altitude — leaving drainage basins with their trunks in the lowlands.

### Staying at 60 fps

Terrain is generated in 32×32 tile chunks, nearest-first, inside an 11 ms per-frame
budget, with a one-chunk prefetch ring beyond the viewport and an LRU cap of 400
chunks. A chunk costs ~17 ms — 1156 CPPN forward passes, 1024 classifications,
gradients, hillshade and rasterisation — and that number is the reason chunks are
this size: work that cannot be interrupted has to be small enough to fit in a frame.

Every other expensive thing is deferred, sliced, or budgeted:

- **Budgets are in milliseconds, not samples.** A 5x48 CPPN costs six times a
  default one, so a fixed sample count that is comfortable at the default turns
  into a freeze at the largest topology. Each frame's coarse work is sized from a
  running measurement of what a sample currently costs — calibrated on chunk builds
  only, since calibrating on the preview would make the preview size itself from
  its own last cost and drift.
- **Chunks not yet generated show the coarse preview**, so panning into new
  territory arrives blurred and then sharpens. As a backdrop it gets a 13 ms budget;
  when it *is* the picture — a drag, a morph — it gets 45 ms and drops the pan
  margin it would otherwise keep for reuse.
- **The minimap is 16k samples**, a third of a second of work. Built a band at a
  time into a back buffer, only in frames where no chunk is waiting, swapped in when
  complete — so it never blanks and never stalls.
- **Offspring thumbnails** wait until the visible map is finished, then build in
  bands of their own.

Measured while dragging the map continuously for six seconds: median frame 16.7 ms,
p90 22 ms, p99 41 ms, worst 46 ms, nothing over 100 ms. Dragging a terrain dial holds
16.7 ms median; at the heaviest topology the same drag runs at ~27 fps and says so —
the panel marks a chunk cost over 30 ms as *heavy*.

### Does the tournament actually converge?

Measured, not assumed. A simulated user with a fixed preference plays the same
tournament the UI offers — six individuals, three duels, a final, breed, repeat:

- Preference "look like this target world" (correlation between elevation fields
  of the champion and a world grown from an unrelated seed): the champion gains
  **+0.24 correlation on average over 10 generations** (3 seeds × 4 targets; every
  strategy in a 4-way breeding sweep landed within 0.007 of this, so the scheme is
  robust rather than tuned).
- Preference "more land" (mean of the raw elevation channel): **0.71 → 0.97 in 8
  generations** — broad, perceivable qualities converge fast; matching a specific
  unseen target is the hard case and still moves steadily.
- The recorded picks replay to a bit-identical champion, and the adopted lineage
  entry round-trips through the permalink (`evo-test.js` in the session notes;
  the browser test clicks through two real generations and compares field hashes).

### The civilisation is audited, not asserted

`civ-test.js` treats "all coherent" as a falsifiable claim and checks it:

- dossiers are bit-identical across independent world instances;
- towns in the same region share a culture family 77% of the time vs 55% across
  distant regions;
- dialects are identical within a region 6/6 and differ between far regions of
  the *same* family 29/30; architecture, table and craft are honest to the
  terrain 20/20 (a region claiming stonework has the relief to quarry);
- 6/6 sampled nations worship something their capital's terrain actually has;
- 64/64 sampled names decompose over their culture's phoneme bank;
- ages are ordered, every patronymic resolves to a named parent, artifacts fall
  within their town's lifetime;
- no trade partner sends a good the town already exports;
- chronicles are sorted, bounded by the current year, and wars are named for the
  real terrain at the midpoint between the capitals;
- roads are deterministic (including argument order — the first version wasn't:
  the A* route from A to B could differ from B to A on equal-cost ties, so the
  computation is canonicalised), end at their towns, and beat the straight line
  on both terrain cost and water crossed, 12/12.

### Reproducibility

A world is entirely described by `{seed, depth, width, gain, lineage, z, scale, sea,
authority, rivers}`, which is what the **link** button puts in the URL fragment.
A lineage step is either a mutation `[seed, sigma]` or a recorded tournament
`{t: seed, p: picks}` — the picks *are* the champion's genome.
`Math.random` is never called in the generator; mutations replay from their step
seeds. A two-step evolved lineage with a custom latent vector rebuilds bit-identically
in a fresh tab.

## Files

| file | |
|---|---|
| `js/rng.js` | seeded PRNG, gaussians, hash-gradient Perlin noise, fbm, ridged fbm |
| `js/nn.js` | the CPPN (batched forward, mutation, crossover, tracing) and the trainable MLP (Adam, backprop) |
| `js/evo.js` | tournament genetics: population, breeding, deterministic replay from picks |
| `js/civ.js` | the derived civilisation: cultures, nations, faiths, clans, people, artifacts, trade, roads, chronicles |
| `js/biome.js` | 16 biomes, the rule oracle, dataset synthesis, time-sliced trainer |
| `js/world.js` | features, normalisation, hypsometry, rivers, slope, shading, chunk cache |
| `js/render.js` | chunk rasters, colour ramps, coarse LOD downsampling, props, settlements |
| `js/ui.js` | loss curve, biome bars, network diagram, minimap, permalinks |
| `js/main.js` | camera, streaming, evolution, input, wiring |
| `build.js` | inlines the above into one file (`--fragment` omits the document shell) |

Plain scripts and one stylesheet — it runs from `file://` with no toolchain.

## Limits, honestly

- The biome network's agreement with its rule oracle is ~94%; the disagreements are
  a real part of what you see, mostly as softened borders. The panel reports the
  number rather than hiding it.
- Rivers are zero-crossings of a network channel, not simulated flow. All six outputs
  read from the same hidden layer, so the river channel arrives correlated with
  elevation and its crossings land on the shoreline; the generator measures that
  correlation per world and subtracts it, which is what makes rivers cut inland. They
  still do not always run downhill, and they neither merge nor reach the sea reliably.
- The civilisation is derived, not simulated: no one is born, nothing burns down,
  and the chronicle never gains a new entry. That is the trade that keeps it
  infinite, lazy and reproducible from a URL — the same trade the terrain makes.
- On touch screens: pinch zooms, drag pans, a tap inspects the tile under your
  finger, and the tournament was designed around thumb-sized targets.
- Animating the latent vector regenerates the whole visible region every frame, at
  roughly 1/200th of screen resolution and ~17 fps. It is legibly soft, and that is
  inherent: a sharp full-screen morph would be 400 ms a frame.
