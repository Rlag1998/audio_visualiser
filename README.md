# ORPHEUS — your song becomes a world

**[Open `index.html` in any modern browser. Drop in a song. Fly through it.](index.html)**

ORPHEUS is an audio visualiser built on one idea no realtime visualiser can copy:
**it listens to the whole song before the first frame is drawn** — so the world
*ahead* of you is the music that is *coming*.

Upload a track and ORPHEUS surveys it like a cartographer: beats, tempo, key,
stereo width, spectral colour, section structure, drops. Then it extrudes that
map into a 3D world where **distance is time** — and flies you down it, arriving
at every landmark at the exact moment you hear it.

## Why it's like nothing else

- **You can see the drop coming.** Big arrivals stand on the horizon as glowing
  monoliths long before you hear them. The camera reaches each one exactly on
  its downbeat.
- **Rhythm is architecture, not flicker.** Every beat is a physical gate placed
  at its exact position along the road; you thread each ring precisely on the
  beat. Downbeats get bigger rings with cardinal ticks.
- **The world knows the song's form.** Sections are detected and fingerprinted —
  a returning chorus returns you to the same geography and palette. Terrain
  height is carved from the bass envelope, valley width from stereo image and
  intensity, biome colour from spectral brightness, light hue from the key
  (mapped around the circle of fifths).
- **Past, present, future.** The far field holds the baked shape of the song's
  future. Only the near field trembles with the *present* — the floor around
  you is a live spectrum woven into the terrain, and strata seams in the rock
  glow with the music's timbral history.
- **Locked but alive.** The pre-computed beat grid *arms* every event; the live
  spectral flux from the playing audio *fires* it. Hits feel frame-tight without
  ever turning mechanical.
- **Honest with beatless music.** A grid only earns gates if the onsets really
  sit on it (grid-alignment test). Ambient and classical pieces get sparse gates
  at their true arrivals instead of a hallucinated techno grid.
- **Every song is a place.** The world is seeded from a hash of the audio
  itself — the same track always builds the same world. At the end the camera
  rises to reveal the journey, and you can export a **song portrait** PNG:
  the track's energy ridgeline, movements, drops, tempo and key as a poster.

## Using it

- Open `index.html` — no build, no server, no dependencies, nothing uploaded
  anywhere (all analysis is local).
- Drop an mp3 / wav / ogg / flac / m4a, or click *"conjure a demo track"*.
- After the survey completes, press **Begin**.
- `space` pause · `← →` seek ±5s · `f` fullscreen · click the map strip to seek.

## Under the hood

Single self-contained HTML file (~2,200 lines), zero dependencies:

- **AudioBrain** — hand-rolled radix-2 FFT; STFT at 2048/512; per-frame band
  energies, spectral flux, centroid, 12-bin chroma, stereo correlation; onset
  envelope → autocorrelation tempo + comb-alignment beat phase; grid-alignment
  ratio to reject phantom grids; novelty-based section segmentation with
  cosine-similarity fingerprint matching; per-song percentile normalisation so
  quiet recordings get proportional dynamics.
- **World baker** — energy-integrated arc length (time ⇆ distance), features
  resampled into a 4096×2 half-float timeline texture, gates/monoliths placed
  at exact arc positions, deterministic road curvature from the audio hash.
- **Renderer** — WebGL2: displaced low-poly terrain (faceted via derivative
  normals), procedural sky with aurora + approaching-future horizon glow,
  instanced beat gates/monolith beams/particles, HDR bloom, ACES tonemap,
  beat-driven chromatic aberration, adaptive resolution governor.

Tested end-to-end in headless Chromium with a ground-truth synthetic song
(known BPM, drop position and key) plus a beatless drone, verifying beat
tracking accuracy, section boundaries, gate placement, seek/pause/replay,
portrait export and error-free playback.
