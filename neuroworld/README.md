# NeuroWorld — a 2D world generator whose terrain *is* a neural network

**[Open `index.html` in any browser. No build, no server, no dependencies.](index.html)**

Most procedural world generators layer fractal noise and then sort the result into
biomes with an if-chain. NeuroWorld replaces both halves with neural networks:

- **The terrain is a network's output.** A CPPN — a compositional pattern producing
  network with random weights and a random activation function per neuron — is
  evaluated at every tile coordinate. Its six output channels *are* elevation,
  moisture, temperature, rivers, flora and minerals. Nothing is stored; the map is
  unbounded in every direction because it is a pure function of position.
- **The biomes are a network's classification.** A small MLP trains in your tab,
  with Adam and cross-entropy, to read those fields and answer with a probability
  distribution over 16 biomes. You watch the loss come down before the first frame
  is drawn. Because the answer is a softmax rather than a threshold, coastlines,
  treelines and desert margins come out as gradients.

And because the terrain is weights, worlds can be **bred**. Every mutation step is a
seed, so an evolved planet is reproducible from a URL.

## Try this first

1. Open it and wait ~2 seconds for the biome network to train.
2. **Hover the map.** The inspector at the bottom of the panel shows that tile's
   entire forward pass: the input vector, every hidden activation, and the softmax
   the renderer blended into that pixel's colour.
3. Set the view to **neuron activation** and step through the neurons. Every feature
   you see on the map is a weighted sum of pictures like those.
4. Drag **network authority** from 100% to 0%. At 100% the terrain is purely the
   network; at 0% it is the plain fractal noise the network receives as input. The
   land/sea split and climate spread are held identical across the dial, so it is a
   fair comparison of what the network actually contributes.
5. Click an **offspring** thumbnail, then another, then another. That is interactive
   evolution: each is the parent's weights plus gaussian noise, with the odd
   activation function swapped. Hit **link** and the whole lineage is in the URL.

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
softmax → blended palette → hillshade → tiles + props
```

### Three problems worth knowing about

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
confetti.** Coarse views drop the noise octaves below their own Nyquist limit and
supersample 2× before downscaling. Zoomed-out maps, the minimap and the offspring
thumbnails all go through that path — a thumbnail you cannot tell apart from its
siblings is useless for choosing a parent.

### Streaming

Terrain is generated in 48×48 tile chunks, nearest-first, inside an 11 ms per-frame
budget, with a one-chunk prefetch ring beyond the viewport and an LRU cap of 200
chunks. Anything not yet generated shows the coarse preview instead of a black
square, so panning into new territory arrives blurred and then sharpens. A chunk
costs ~30 ms: 2500 CPPN forward passes, 2500 classifications, gradients, hillshade
and rasterisation.

### Reproducibility

A world is entirely described by `{seed, depth, width, gain, lineage, z, scale, sea,
authority, rivers}`, which is what the **link** button puts in the URL fragment.
`Math.random` is never called in the generator; mutations replay from their step
seeds. A two-step evolved lineage with a custom latent vector rebuilds bit-identically
in a fresh tab.

## Files

| file | |
|---|---|
| `js/rng.js` | seeded PRNG, gaussians, hash-gradient Perlin noise, fbm, ridged fbm |
| `js/nn.js` | the CPPN (batched forward, mutation, tracing) and the trainable MLP (Adam, backprop) |
| `js/biome.js` | 16 biomes, the rule oracle, dataset synthesis, time-sliced trainer |
| `js/world.js` | features, normalisation, hypsometry, rivers, slope, shading, chunk cache |
| `js/render.js` | chunk rasters, colour ramps, coarse LOD downsampling, props |
| `js/ui.js` | loss curve, biome bars, network diagram, minimap, permalinks |
| `js/main.js` | camera, streaming, evolution, input, wiring |

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
- No pinch-to-zoom; touch users get the HUD zoom buttons.
- Animating the latent vector regenerates the visible region every frame and runs
  around 30 fps at a coarse sampling. That is the intended cost of a live morph.
