/*
 * civ.js — the derived civilisation.
 *
 * Nothing in this file is simulated and nothing is stored. Cultures, nations,
 * religions, clans, people, artifacts, trade and history are all pure functions
 * of the terrain, which is itself a pure function of the network. That is the
 * whole design: the same properties that make the map infinite and sharable —
 * determinism, laziness, derivation — extend to the people on it. Ask about a
 * town a million tiles away and its founding year, patron deity and ruling
 * clans are already decided, because they follow from the ground it stands on.
 *
 * The coherence chain, root to leaf:
 *
 *   terrain (CPPN) ─→ settlements (existing layer, re-derived here standalone)
 *        │
 *        ├─→ culture: the *regional* terrain — coastal, highland, arid, wet,
 *        │   cold or plain — picks one of six culture families. Each family
 *        │   owns a phoneme bank and naming customs, so every person, clan,
 *        │   deity, town and nation in a region sounds related.
 *        │
 *        ├─→ nations: capitals are the best-scoring towns of each province;
 *        │   every town belongs to the capital cheapest to reach over real
 *        │   terrain, so borders fall on mountains and straits by construction.
 *        │
 *        ├─→ religion: each nation worships what its landscape actually offers
 *        │   — sea, peaks, rivers, fire, forest or sun — with rites shaped by
 *        │   its climate's real scarcities.
 *        │
 *        ├─→ clans / people / families: per town, from its size, trade and
 *        │   faith; names follow the culture's morphology, three generations
 *        │   of consistent patronymics.
 *        │
 *        ├─→ artifacts: made of the materials the town really has (its ore,
 *        │   its forests, its shore), by the clan whose craft fits, for the
 *        │   faith the nation really holds.
 *        │
 *        └─→ trade & roads: specialisations from terrain, partners whose
 *            surpluses complement, routes pathfound over the actual ground.
 *
 * Everything is cached per world instance and recomputed identically on
 * demand; the caches are memory, not truth.
 */
(function (NW) {
  'use strict';

  var rand = NW.rand;
  var clamp = NW.world.clamp;

  var CELL = 34;          /* settlement cell, must match the render layer */
  var PROV = 16;          /* province = 16x16 cells = 544 tiles square */
  var CULT = 256;         /* culture quantised per 256-tile cell */
  var CAP_SAMPLES = 24;   /* candidate cells probed per province for a capital */
  var CAP_FLOOR = 0.74;   /* minimum site score to seat a capital */

  /* ------------------------------------------------------------ cultures --- */

  /*
   * Six families, keyed to what the regional terrain actually is. Each owns a
   * phoneme bank (onsets / cores / endings), person-name endings, a patronymic
   * formula, deity epithets, polity vocabulary and value words. The banks are
   * deliberately distinct in mouth-feel: maritime liquid, highland clustered,
   * desert glottal, wetland nasal, tundra clipped, plains broad.
   */
  var FAMILIES = [
    {
      key: 'tide', folk: 'Tidefolk', tongue: 'Maren speech',
      on: ['mar', 'sel', 'ael', 'vor', 'len', 'wen', 'tal', 'bren', 'col', 'nym'],
      core: ['a', 'e', 'ae', 'o', 'ea'],
      end: ['is', 'wyn', 'mor', 'ay', 'eth', 'a'],
      pEnd: ['a', 'is', 'en', 'ric', 'wyn', 'o'],
      patros: ['{child}, {parent}-born', '{child} of {parent}’s crew'],
      shifts: ['a>ae', 'w>v', 'l>ll', 'en>yn', 'o>oa'],
      deity: ['the Deep Mother', 'the Grey Swell', 'the Wavefather', 'the Ninth Tide'],
      polity: ['League', 'Compact', 'Free Harbours'],
      values: ['open harbours', 'oath-keeping between crews', 'hospitality to the shipwrecked'],
      crafts: ['net-weaving and hull-lore', 'pearl-diving and rope-craft', 'chart-making and tide-reading']
    },
    {
      key: 'crag', folk: 'Cragfolk', tongue: 'Karvek speech',
      on: ['kar', 'dro', 'thar', 'grim', 'bal', 'skor', 'vred', 'hark', 'dun', 'krag'],
      core: ['a', 'o', 'u', 'ar', 'or'],
      end: ['gar', 'dun', 'holt', 'grim', 'ek', 'ar'],
      pEnd: ['ek', 'ar', 'grim', 'a', 'or', 'ka'],
      patros: ['{child} {parent}sblood', '{child}, hewn of {parent}'],
      shifts: ['k>kh', 'g>gg', 'ar>or', 'u>ou', 'dun>dhun'],
      deity: ['the Anvil Sky', 'the First Peak', 'the Ash Warden', 'the Ridge Father'],
      polity: ['Hold', 'High Moot', 'Clanhold'],
      values: ['debts repaid in kind', 'the guest-right of the pass', 'stone before speech'],
      crafts: ['stone-cutting and delving', 'ore-smelting and bell-founding', 'wall-raising and pass-craft']
    },
    {
      key: 'dune', folk: 'Duneborn', tongue: 'Azhari speech',
      on: ['az', 'har', 'qas', 'ir', 'sef', 'nal', 'zar', 'oma', 'tas', 'khe'],
      core: ['a', 'i', 'aa', 'e', 'ai'],
      end: ['im', 'ar', 'esh', 'ud', 'ai', 'an'],
      pEnd: ['im', 'a', 'esh', 'ai', 'ud', 'an'],
      patros: ['{child} ked-{parent}', '{child} al-{parent}'],
      shifts: ['a>ah', 'ir>yr', 's>sh', 'e>i', 'z>dz'],
      deity: ['the Unblinking Sun', 'the First Well', 'the Star Road', 'the Red Horizon'],
      polity: ['Caliphate of the Wells', 'Caravan Court', 'Emirate'],
      values: ['water shared is honour earned', 'the star-paths kept secret', 'salt bonds unbroken'],
      crafts: ['star-reading and salt-trade', 'glass-firing and well-craft', 'dye-work and caravan-law']
    },
    {
      key: 'mire', folk: 'Mirefolk', tongue: 'Ondwe speech',
      on: ['ond', 'mel', 'yen', 'lom', 'san', 'ver', 'ilu', 'nam', 'osh', 'ren'],
      core: ['e', 'o', 'ue', 'i', 'eo'],
      end: ['we', 'en', 'ola', 'esh', 'um', 'ei'],
      pEnd: ['we', 'en', 'ola', 'u', 'ei', 'am'],
      patros: ['{child} of {parent}’s hearth', '{child}, reed of {parent}'],
      shifts: ['e>ie', 'o>ou', 'n>nn', 'w>v', 'l>lh'],
      deity: ['the River That Remembers', 'the Green Silence', 'the Rain Bringer', 'the Reed Mother'],
      polity: ['Delta Kingdom', 'River Court', 'Confluence'],
      values: ['the river carries all debts', 'no gate against the flood', 'green things tended'],
      crafts: ['reed-craft and flood-farming', 'dye-steeping and eel-trapping', 'boat-weaving and silt-lore']
    },
    {
      key: 'frost', folk: 'Frostkin', tongue: 'Ulvet speech',
      on: ['ulv', 'ket', 'sva', 'nir', 'hod', 'brek', 'tyr', 'ost', 'vak', 'skel'],
      core: ['e', 'i', 'a', 'ei', 'y'],
      end: ['ik', 'stad', 'vik', 'en', 'heim', 'a'],
      pEnd: ['ik', 'a', 'en', 'dis', 'ulf', 'ny'],
      patros: ['{child} {parent}sdottir-or-son', '{child} {parent}skin'],
      shifts: ['i>y', 'e>ei', 'v>f', 'k>kk', 'a>o'],
      deity: ['the Long Night', 'the Hearth Undying', 'the White Bear', 'the Thaw'],
      polity: ['Jarldom', 'Thing', 'Winter Court'],
      values: ['the hearth refused to none', 'meat shared before the dark', 'ice read truly'],
      crafts: ['bone-carving and ice-craft', 'fur-dressing and lamp-oil rendering', 'sled-wrighting and star-steering']
    },
    {
      key: 'heart', folk: 'Heartlanders', tongue: 'Aldspeech',
      on: ['ald', 'ber', 'ock', 'ham', 'wil', 'ash', 'mead', 'fen', 'hol', 'ellow'],
      core: ['a', 'e', 'o', 'ea', 'i'],
      end: ['ton', 'field', 'stead', 'march', 'don', 'wick'],
      pEnd: ['a', 'ric', 'win', 'eth', 'ell', 'ot'],
      patros: ['{child} {parent}son', '{child} of {parent}’s line'],
      shifts: ['ton>tun', 'field>felde', 'o>ou', 'e>ea', 'w>wh'],
      deity: ['the Golden Furrow', 'the Turning Year', 'the Oak King', 'the Quiet Harvest'],
      polity: ['Kingdom', 'Shire Moot', 'March'],
      values: ['fences mended, feuds ended', 'the harvest tithe honest', 'roads kept open'],
      crafts: ['wheat-lore and wainwrighting', 'orchard-keeping and cider-craft', 'horse-breaking and hedge-law']
    }
  ];

  var SUFFIX = {
    river: ['ford', 'mere', 'bridge', 'weir'],
    coast: ['port', 'haven', 'bay', 'strand'],
    high: ['fell', 'crag', 'scar', 'heights'],
    wood: ['holt', 'wood', 'glade', 'thicket'],
    dry: ['reach', 'waste', 'well', 'span'],
    plain: ['stead', 'ton', 'field', 'march', 'garth']
  };

  var TOTEMS = {
    4: ['gull', 'seal', 'crab'], 5: ['viper', 'hawk', 'jackal'], 6: ['horse', 'lark', 'hare'],
    7: ['lion', 'stork', 'hyena'], 8: ['ox', 'bee', 'crane'], 9: ['stag', 'boar', 'owl'],
    10: ['serpent', 'heron', 'panther'], 11: ['elk', 'wolf', 'raven'], 12: ['fox', 'ptarmigan', 'bear'],
    13: ['eagle', 'goat', 'marten'], 14: ['white bear', 'snow owl', 'seal'], 15: ['salamander', 'ashwing', 'ember-moth']
  };

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function pick(rnd, arr) { return arr[(rnd() * arr.length) | 0]; }

  /* ------------------------------------------------------------ dialects --- */

  /*
   * A tongue is not one thing everywhere: within a family, each dialect region
   * (1024 tiles square) applies two of the family's sound-shift rules to the
   * whole phoneme bank, picks its own patronymic formula, and names its own
   * manner of speech. Neighbouring towns therefore speak identically; the same
   * folk half a world away sound like cousins, not clones — Maren speech in the
   * Maera manner against Maren speech in the Vellae manner.
   *
   * The same regional drift carries every other cultural expression that used
   * to be uniform by family: which craft the folk are known for is the
   * dialect region's pick of the family's three.
   */
  var DIA = 1024;

  function applyShifts(words, rules) {
    return words.map(function (w) {
      for (var r = 0; r < rules.length; r++) {
        var xy = rules[r].split('>');
        w = w.replace(xy[0], xy[1]);
      }
      return w;
    });
  }

  function dialectFor(world, fi, rx, ry) {
    var civ = civOf(world);
    var key = fi + '|' + rx + ',' + ry;
    var got = civ.dialects.get(key);
    if (got) return got;

    var fam = FAMILIES[fi];
    var h = rand.hash2(rx * 6 + fi, ry, civ.seed ^ 0xd1a) >>> 0;
    var rnd = rand.rng(h);
    /* two distinct shift rules define this region's accent */
    var i1 = (rnd() * fam.shifts.length) | 0;
    var i2 = (i1 + 1 + ((rnd() * (fam.shifts.length - 1)) | 0)) % fam.shifts.length;
    var rules = [fam.shifts[i1], fam.shifts[i2]];

    /* Cores stay unshifted: they are bare vowels, and drifting them on top of
     * the onset shifts turns names into vowel mush ("Maereaeric"). Consonant
     * frames carry the accent; the vowels keep the names pronounceable. */
    var bank = {
      on: applyShifts(fam.on, rules),
      core: fam.core,
      end: applyShifts(fam.end, rules),
      pEnd: applyShifts(fam.pEnd, rules)
    };
    var d = {
      key: key,
      bank: bank,
      rules: rules,
      patro: fam.patros[h % fam.patros.length],
      craft: fam.crafts[(h >>> 3) % fam.crafts.length],
      name: cap(bank.on[(h >>> 6) % bank.on.length] + bank.core[(h >>> 9) % bank.core.length]) + ' manner'
    };
    civ.dialects.set(key, d);
    return d;
  }

  function word(rnd, bank, withCore) {
    var w = pick(rnd, bank.on);
    if (withCore === undefined ? rnd() < 0.5 : withCore) w += pick(rnd, bank.core);
    return w;
  }

  function personName(rnd, bank) {
    return cap(word(rnd, bank, rnd() < 0.35) + pick(rnd, bank.pEnd));
  }

  function placeName(rnd, bank, kind) {
    var w = word(rnd, bank);
    if (rnd() < 0.4) w += pick(rnd, bank.core);
    return cap(w + pick(rnd, SUFFIX[kind] || SUFFIX.plain));
  }

  function clanName(rnd, bank) {
    return cap(word(rnd, bank, false) + pick(rnd, bank.end));
  }

  /*
   * The rest of a region's material culture, read from the same terrain stats
   * that chose the family — what people build from, what is on their table, and
   * the value their climate's real scarcity teaches. Uniform nowhere, arbitrary
   * nowhere: a region builds in stone because it *is* stony.
   */
  function architectureOf(st) {
    if (st.relief > 0.25) return 'dressed stone and slate';
    if (st.sea > 0.2) return 'tarred timber on stone piers';
    if (st.warmth < 0.3) return 'turf-roofed stone and hide';
    if (st.moisture > 0.68) return 'reed bundle and fired clay';
    if (st.moisture < 0.33) return 'mudbrick and canvas';
    return 'timber frame and thatch';
  }

  function tableOf(st) {
    if (st.sea > 0.2) return 'salt fish, samphire and dark bread';
    if (st.warmth < 0.3) return 'smoked meat, marrow and berry-mash';
    if (st.moisture < 0.33) return 'flatbread, dates and salted curd';
    if (st.moisture > 0.68) return 'eel, rice-reed and river greens';
    if (st.relief > 0.25) return 'goat cheese, oat-cake and thin beer';
    return 'wheat bread, orchard fruit and ale';
  }

  function climateValueOf(st) {
    if (st.moisture < 0.33) return 'no traveller refused water';
    if (st.warmth < 0.3) return 'fire and roof owed to the lost';
    if (st.moisture > 0.68) return 'high ground held in common';
    if (st.relief > 0.25) return 'the paths kept marked';
    if (st.sea > 0.2) return 'the drowned named and mourned';
    return 'boundary stones respected';
  }

  /* -------------------------------------------------------------- caches --- */

  function civOf(world) {
    if (!world.civ) {
      world.civ = {
        seed: NW.rand.hashString(world.key) ^ 0x5bf03635,
        sites: new Map(),      /* cell -> site | null */
        cultures: new Map(),   /* cult-cell -> culture */
        provs: new Map(),      /* province -> capital site | null */
        dialects: new Map(),   /* family|region -> drifted bank etc. */
        nations: new Map(),    /* capital key -> nation */
        siteNation: new Map(), /* site key -> nation */
        dossiers: new Map(),   /* site key -> dossier */
        roads: new Map(),      /* pair key -> road */
        roadList: [],
        rev: 0                 /* bumped when new sites resolve; render watches */
      };
    }
    return world.civ;
  }

  /* --------------------------------------------------------------- sites --- */

  /*
   * Standalone re-derivation of the settlement layer. The original scored
   * candidates from whichever chunk happened to evaluate them, which clipped
   * the coast test at chunk borders; this probes an 11x11 window around the
   * candidate itself, so a site is exactly the same object no matter who asks.
   */
  function siteAt(world, gx, gy) {
    var civ = civOf(world);
    var key = gx + ',' + gy;
    if (civ.sites.has(key)) return civ.sites.get(key);

    var h = rand.hash2(gx, gy, civ.seed);
    var wx = gx * CELL + (h % CELL);
    var wy = gy * CELL + (((h / CELL) | 0) % CELL);

    var site = null;
    var p = world.buildRegion(wx - 5, wy - 5, 11, 11, 1);
    var c = 5 * 11 + 5;
    var hn = p.hn[c];
    if (hn >= 0.004 && hn <= 0.62 && p.slope[c] <= 0.62) {
      var coast = false;
      for (var i = 0; i < 121 && !coast; i++) if (p.hn[i] < 0) coast = true;
      var river = p.river[c] > 0.2;
      var score =
        (river ? 0.34 : 0) + (coast ? 0.24 : 0) +
        p.flora[c] * 0.26 + p.ore[c] * 0.16 +
        (1 - p.slope[c]) * 0.18 +
        (1 - Math.abs(p.temp[c] - 0.55) * 2) * 0.2 +
        p.moist[c] * 0.1;
      if (score >= 0.58) {
        var kind = river ? 'river' : (coast ? 'coast'
          : (hn > 0.34 ? 'high'
            : (p.biome[c] === 9 || p.biome[c] === 10 || p.biome[c] === 11 ? 'wood'
              : (p.moist[c] < 0.25 ? 'dry' : 'plain'))));
        var cult = cultureAt(world, wx, wy);
        var rnd = rand.rng((h ^ 0x5f3a) >>> 0);
        var bank = cult.bank;
        site = {
          key: key, gx: gx, gy: gy, wx: wx, wy: wy,
          score: score, rank: score > 1.0 ? 2 : (score > 0.8 ? 1 : 0),
          kind: kind, biome: p.biome[c],
          hn: hn, ore: p.ore[c], flora: p.flora[c], moist: p.moist[c],
          temp: p.temp[c], river: river, coast: coast,
          culture: cult,
          name: placeName(rnd, bank, kind)
        };
      }
    }
    civ.sites.set(key, site);
    civ.rev++;
    return site;
  }

  /* ------------------------------------------------------------- culture --- */

  function cultureAt(world, wx, wy) {
    var civ = civOf(world);
    var cx = Math.floor(wx / CULT), cy = Math.floor(wy / CULT);
    var key = cx + ',' + cy;
    var got = civ.cultures.get(key);
    if (got) return got;

    /*
     * Culture is the terrain of the *region*, not the tile: a 7x7 sample at
     * 8-tile spacing (a 56-tile window) around the culture-cell centre. Means
     * over that window decide the family, so every town on the same stretch of
     * coast is Tidefolk together and the border to the Cragfolk falls where
     * the regional ground actually rises.
     */
    /* A 7x7 sample at 40-tile spacing — a 280-tile window, wider than the
     * cell, so neighbouring cells see overlapping ground and the family field
     * changes gently instead of flickering cell to cell. */
    var ox = cx * CULT + CULT / 2 - 120, oy = cy * CULT + CULT / 2 - 120;
    var p = world.buildRegion(ox, oy, 7, 7, 40);
    var mh = 0, mm = 0, mt = 0, sea = 0;
    for (var i = 0; i < 49; i++) {
      mh += p.hn[i]; mm += p.moist[i]; mt += p.temp[i];
      if (p.hn[i] < 0) sea++;
    }
    mh /= 49; mm /= 49; mt /= 49; sea /= 49;

    var fi;
    if (sea > 0.25) fi = 0;            /* Tidefolk */
    else if (mh > 0.3) fi = 1;         /* Cragfolk */
    else if (mt < 0.3) fi = 4;         /* Frostkin */
    else if (mm < 0.33) fi = 2;        /* Duneborn */
    else if (mm > 0.68) fi = 3;        /* Mirefolk */
    else fi = 5;                       /* Heartlanders */

    var fam = FAMILIES[fi];
    var rnd = rand.rng((rand.hash2(cx, cy, civ.seed ^ 0x1ced) >>> 0));
    var stats = { relief: mh, moisture: mm, warmth: mt, sea: sea };
    var dia = dialectFor(world, fi, Math.floor(wx / DIA), Math.floor(wy / DIA));
    var culture = {
      key: key, fi: fi, fam: fam,
      folk: fam.folk, tongue: fam.tongue,
      dialect: dia,
      bank: dia.bank,
      patro: dia.patro,
      craft: dia.craft,
      /* Two of the family's three values (the drop index chosen ONCE — a
       * filter callback that rolled the dice per element could keep all three
       * or none), plus the value the local climate actually teaches. */
      values: (function () {
        var drop = (rnd() * 3) | 0;
        var v = [];
        for (var vi = 0; vi < 3; vi++) if (vi !== drop) v.push(fam.values[vi]);
        v.push(climateValueOf(stats));
        return v;
      })(),
      architecture: architectureOf(stats),
      table: tableOf(stats),
      stats: stats
    };
    civ.cultures.set(key, culture);
    return culture;
  }

  /* --------------------------------------------------- provinces, nations --- */

  function provCapital(world, pvx, pvy) {
    var civ = civOf(world);
    var key = pvx + ',' + pvy;
    if (civ.provs.has(key)) return civ.provs.get(key);

    /*
     * The capital is the best-scoring town among a fixed hash-chosen sample of
     * the province's cells. Sampling (rather than exhaustively probing 256
     * cells) keeps this ~30ms; the sample is part of the world's definition,
     * so it is the same capital for everyone, forever.
     */
    var rnd = rand.rng((rand.hash2(pvx, pvy, civ.seed ^ 0x9e37) >>> 0));
    var best = null;
    for (var s = 0; s < CAP_SAMPLES; s++) {
      var gx = pvx * PROV + ((rnd() * PROV) | 0);
      var gy = pvy * PROV + ((rnd() * PROV) | 0);
      var site = siteAt(world, gx, gy);
      if (site && site.score >= CAP_FLOOR && (!best || site.score > best.score)) best = site;
    }
    civ.provs.set(key, best);
    return best;
  }

  /*
   * Cost of the straight line between two points, sampled over real terrain.
   * Water and mountains multiply it, which is what pushes borders onto them:
   * a town joins the capital it can actually reach, not the one nearest as
   * the crow flies.
   */
  function lineCost(world, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return 0.01;
    var water = 0, mtn = 0, N = 10;
    for (var i = 1; i <= N; i++) {
      var t = i / (N + 1);
      var p = world.buildRegion(Math.round(ax + dx * t), Math.round(ay + dy * t), 1, 1, 1);
      if (p.hn[0] < 0) water++;
      else if (p.hn[0] > 0.42 || p.slope[0] > 0.7) mtn++;
    }
    return dist * (1 + 2.4 * (water / N) + 1.7 * (mtn / N));
  }

  var POLITY_KIND = { coast: 0, river: 1, high: 1, wood: 2, dry: 2, plain: 0 };

  function nationOf(world, site) {
    var civ = civOf(world);
    var cached = civ.siteNation.get(site.key);
    if (cached) return cached;

    var pvx = Math.floor(site.gx / PROV), pvy = Math.floor(site.gy / PROV);
    var bestCap = null, bestCost = Infinity;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var capSite = provCapital(world, pvx + dx, pvy + dy);
        if (!capSite) continue;
        var cost = lineCost(world, site.wx, site.wy, capSite.wx, capSite.wy);
        if (cost < bestCost) { bestCost = cost; bestCap = capSite; }
      }
    }
    /* A town beyond every capital's reach rules itself. */
    if (!bestCap) bestCap = site;

    var nation = civ.nations.get(bestCap.key);
    if (!nation) {
      nation = buildNation(world, bestCap);
      civ.nations.set(bestCap.key, nation);
    }
    civ.siteNation.set(site.key, nation);
    return nation;
  }

  function buildNation(world, capSite) {
    var civ = civOf(world);
    var fam = capSite.culture.fam;
    var bank = capSite.culture.bank;
    var rnd = rand.rng((rand.hash2(capSite.gx, capSite.gy, civ.seed ^ 0x7a11) >>> 0));
    var polity = fam.polity[POLITY_KIND[capSite.kind] || 0];
    var coreName = cap(word(rnd, bank, true) + pick(rnd, bank.end));
    var year = currentYear(world);
    var founded = year - (120 + ((rnd() * 640) | 0));
    return {
      key: capSite.key,
      capital: capSite,
      name: 'the ' + coreName + ' ' + polity,
      shortName: coreName,
      color: 'hsl(' + ((rand.hash2(capSite.gx, capSite.gy, civ.seed ^ 0xc01) % 360 + 360) % 360) + ',48%,60%)',
      culture: capSite.culture,
      founded: founded,
      faith: buildFaith(world, capSite, rnd),
      independent: capSite.score < CAP_FLOOR
    };
  }

  /* ------------------------------------------------------------ religion --- */

  /*
   * A nation worships what its land actually presents. The awe-feature is read
   * from the capital's own probe: the sea if it is coastal, fire if volcanic
   * ground is near, the peaks if the region stands high, the river if one runs
   * through, the forest if it is wooded, and the sun over dry country. Rites
   * answer the climate's real scarcities — water-rites where water is scarce,
   * hearth-rites where warmth is.
   */
  function buildFaith(world, capSite, rnd) {
    var cs = capSite.culture.stats;
    var kind, focus;
    if (capSite.biome === 15 || (capSite.temp > 0.78 && capSite.ore > 0.6)) {
      kind = 'fire'; focus = 'the mountain’s fire';
    } else if (capSite.coast || cs.sea > 0.2) {
      kind = 'sea'; focus = 'the sea';
    } else if (cs.relief > 0.3) {
      kind = 'peak'; focus = 'the high peaks';
    } else if (capSite.river) {
      kind = 'river'; focus = 'the river';
    } else if (capSite.biome === 9 || capSite.biome === 10 || capSite.biome === 11) {
      kind = 'grove'; focus = 'the old forest';
    } else {
      kind = 'sky'; focus = 'the open sky';
    }
    /* The name is the culture's; the epithet is the faith's. A Heartlander
     * harbour capital worships a sea-god with a Heartlander name — not the Oak
     * King standing knee-deep in the surf. */
    var KIND_EPITHETS = {
      sea: ['Keeper of the Deep', 'the Tide-Turner', 'Lord of the Grey Swell'],
      peak: ['the Summit-Watcher', 'Keeper of the High Silence', 'the Unmelting'],
      fire: ['the Ember-Heart', 'Keeper of the Under-Fire', 'the Ash-Bringer'],
      river: ['the Current-Keeper', 'the Ford-Warden', 'Giver of Silt'],
      grove: ['the Root-Deep', 'Keeper of the Old Shade', 'the Leaf-Listener'],
      sky: ['the Wide-Watcher', 'Keeper of the Turning Year', 'the Rain-Promiser']
    };
    var deityName = personName(rnd, capSite.culture.bank);
    var epithet = pick(rnd, KIND_EPITHETS[kind]);
    var rites =
      cs.moisture < 0.35 ? 'water-blessing at every well' :
      cs.warmth < 0.3 ? 'the hearth kept lit through the dark months' :
      cs.sea > 0.2 ? 'first catch given back to the water' :
      'first furrow cut at the turning of the year';
    var taboo =
      kind === 'fire' ? 'no flame carried over a threshold unasked' :
      kind === 'sea' ? 'no drowning unmourned' :
      kind === 'peak' ? 'no summit climbed in anger' :
      kind === 'river' ? 'no ford crossed without a token' :
      kind === 'grove' ? 'no elder tree felled' :
      'no harvest begun before the birds';
    return {
      kind: kind,
      deity: deityName + ', ' + epithet,
      creed: 'keepers of ' + focus,
      rites: rites,
      taboo: taboo
    };
  }

  /* ------------------------------------------- clans, people, artifacts --- */

  var ROLE_BY_KIND = {
    coast: ['harbourmaster', 'shipwright', 'chartkeeper'],
    river: ['fordwarden', 'millwright', 'ferrykeeper'],
    high: ['delvemaster', 'stonereader', 'passwarden'],
    wood: ['timberreeve', 'bowyer', 'sapcollector'],
    dry: ['wellkeeper', 'caravanmaster', 'saltreeve'],
    plain: ['granarykeeper', 'horsemarshal', 'hedgereeve']
  };

  var GOODS = {
    ore: 'worked metal', flora: 'timber and resin', coastal: 'salt fish and rope',
    river: 'milled grain and ferry rights', grass: 'grain and horses',
    dry: 'salt and gemstones', cold: 'furs and rendered oil', wet: 'dyes and reed-cloth'
  };

  function specialise(site) {
    var out = [];
    if (site.ore > 0.62) out.push('ore');
    if (site.flora > 0.62 && (site.biome === 9 || site.biome === 10 || site.biome === 11)) out.push('flora');
    if (site.coast) out.push('coastal');
    if (site.river) out.push('river');
    if (site.biome === 7 || site.biome === 8) out.push('grass');
    if (site.moist < 0.28) out.push('dry');
    if (site.temp < 0.28) out.push('cold');
    if (site.moist > 0.7) out.push('wet');
    if (!out.length) out.push('grass');
    return out.slice(0, 3);
  }

  function buildClans(world, site, rnd) {
    var bank = site.culture.bank;
    var n = 1 + site.rank + (rnd() < 0.4 ? 1 : 0);
    var totems = TOTEMS[site.biome] || TOTEMS[8];
    var spec = specialise(site);
    var clans = [];
    for (var i = 0; i < n; i++) {
      clans.push({
        name: clanName(rnd, bank),
        totem: pick(rnd, totems),
        trade: GOODS[spec[i % spec.length]],
        seat: i === 0 ? 'the old quarter' : (i === 1 ? 'the ' + site.kind + ' side' : 'the outwalls')
      });
    }
    return clans;
  }

  /*
   * Three generations per leading clan, patronymics running through them in
   * the culture's own formula, ages consistent with the world's current year.
   */
  function buildPeople(world, site, clans, rnd) {
    var bank = site.culture.bank;
    var patro = site.culture.patro;
    var year = currentYear(world);
    var roles = ROLE_BY_KIND[site.kind] || ROLE_BY_KIND.plain;
    var people = [];
    for (var c = 0; c < Math.min(2, clans.length); c++) {
      var clan = clans[c];
      var elderAge = 58 + ((rnd() * 22) | 0);
      var elder = {
        name: personName(rnd, bank), clan: clan.name,
        born: year - elderAge,
        role: c === 0 ? 'elder of clan ' + clan.name : pick(rnd, roles),
        line: null
      };
      var midAge = elderAge - 24 - ((rnd() * 8) | 0);
      var mid = {
        name: personName(rnd, bank), clan: clan.name,
        born: year - midAge,
        role: pick(rnd, roles),
        line: patro.replace('{child}', '').replace('{parent}', elder.name).trim()
      };
      people.push(elder, mid);
      if (midAge > 20) {
        var yAge = midAge - 18 - ((rnd() * 6) | 0);
        if (yAge > 3) {
          people.push({
            name: personName(rnd, bank), clan: clan.name,
            born: year - yAge,
            role: yAge < 16 ? 'ward of the ' + clan.totem + ' lodge' : 'apprentice ' + pick(rnd, roles),
            line: patro.replace('{child}', '').replace('{parent}', mid.name).trim()
          });
        }
      }
    }
    return people;
  }

  var MATERIALS = [
    { test: function (s) { return s.biome === 15; }, m: 'volcanic glass' },
    { test: function (s) { return s.ore > 0.75; }, m: 'native silver' },
    { test: function (s) { return s.ore > 0.6; }, m: 'cold-hammered iron' },
    { test: function (s) { return s.temp < 0.25; }, m: 'walrus ivory' },
    { test: function (s) { return s.coast; }, m: 'mother-of-pearl' },
    { test: function (s) { return s.flora > 0.6; }, m: 'heart-oak' },
    { test: function (s) { return s.moist < 0.3; }, m: 'sun-fired clay' },
    { test: function (s) { return true; }, m: 'river amber' }
  ];

  var ARTIFACT_FORMS = ['chalice', 'crown', 'lantern', 'loom-weight', 'signet', 'prow-figure', 'bell', 'reliquary'];

  function buildArtifacts(world, site, nation, clans, founded, rnd) {
    var count = site.rank === 2 ? 2 : (site.rank === 1 ? 1 : (rnd() < 0.35 ? 1 : 0));
    var year = currentYear(world);
    var out = [];
    for (var i = 0; i < count; i++) {
      var material = null;
      for (var m = 0; m < MATERIALS.length; m++) {
        if (MATERIALS[m].test(site)) { material = MATERIALS[m].m; break; }
      }
      if (i > 0) material = MATERIALS[MATERIALS.length - 1 - ((rnd() * 3) | 0)].m;
      var form = pick(rnd, ARTIFACT_FORMS);
      var age = 40 + ((rnd() * Math.max(60, year - nation.founded)) | 0);
      var maker = clans[(rnd() * clans.length) | 0];
      out.push({
        name: 'the ' + cap(word(rnd, site.culture.bank, true)) + ' ' + cap(form),
        material: material,
        /* A thing made by this town's clan cannot predate the town. */
        made: Math.min(year - 5, Math.max(founded, nation.founded, year - age)),
        maker: 'clan ' + maker.name,
        purpose: rnd() < 0.5
          ? 'carried in the ' + nation.faith.kind + '-rites of ' + nation.faith.deity.split(',')[0]
          : 'seal of the ' + (site.kind === 'coast' ? 'harbour toll' : site.kind === 'river' ? 'ford toll' : 'market peace')
      });
    }
    return out;
  }

  /* ----------------------------------------------------- trade and roads --- */

  /*
   * Neighbour discovery exploits the fact that candidate *positions* are pure
   * hashes — free to enumerate. Cells are walked nearest-first and probed only
   * until enough real towns are found, so a neighbour search costs a dozen
   * probes, not a survey of the county.
   */
  function nearestSites(world, site, want, maxRing) {
    var civ = civOf(world);
    var cand = [];
    for (var dy = -maxRing; dy <= maxRing; dy++) {
      for (var dx = -maxRing; dx <= maxRing; dx++) {
        if (!dx && !dy) continue;
        var gx = site.gx + dx, gy = site.gy + dy;
        var h = rand.hash2(gx, gy, civ.seed);
        var wx = gx * CELL + (h % CELL), wy = gy * CELL + (((h / CELL) | 0) % CELL);
        var d2 = (wx - site.wx) * (wx - site.wx) + (wy - site.wy) * (wy - site.wy);
        cand.push([d2, gx, gy]);
      }
    }
    cand.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
    var found = [], probes = 0;
    for (var i = 0; i < cand.length && found.length < want && probes < 30; i++) {
      var s = siteAt(world, cand[i][1], cand[i][2]);
      probes++;
      if (s) found.push(s);
    }
    return found;
  }

  function buildTrade(world, site, nation) {
    var spec = specialise(site);
    var exports_ = spec.map(function (k) { return GOODS[k]; });
    var lacks = [];
    if (spec.indexOf('grass') < 0 && spec.indexOf('river') < 0) lacks.push(GOODS.grass);
    if (spec.indexOf('flora') < 0) lacks.push(GOODS.flora);
    if (spec.indexOf('ore') < 0) lacks.push(GOODS.ore);
    var partners = nearestSites(world, site, 3, 5).map(function (p) {
      var pSpec = specialise(p).map(function (k) { return GOODS[k]; });
      /* What flows each way: their surplus we lack, our surplus they lack. */
      var sends = pSpec.filter(function (g) { return exports_.indexOf(g) < 0; });
      var takes = exports_.filter(function (g) { return pSpec.indexOf(g) < 0; });
      return {
        site: p,
        sends: sends.length ? sends[0] : 'coin and news',
        takes: takes.length ? takes[0] : 'coin and news'
      };
    });
    return { exports: exports_, imports: lacks.slice(0, 2), partners: partners };
  }

  /*
   * Roads: A* over a coarse cost grid covering the pair's bounding box. Slope
   * is expensive, water very expensive but crossable (a ferry), rivers cost a
   * bridge. Fully deterministic: fixed neighbour order, index tie-break.
   */
  function roadBetween(world, a, b) {
    var civ = civOf(world);
    /* Canonical direction: the cache key is symmetric, so the computation must
     * be too — otherwise the road exists in two versions depending on which
     * town asked for it first, and determinism dies by argument order. */
    if (b.key < a.key) { var t_ = a; a = b; b = t_; }
    var key = a.key + '|' + b.key;
    var got = civ.roads.get(key);
    if (got !== undefined) return got;

    var pad = 20;
    var x0 = Math.min(a.wx, b.wx) - pad, y0 = Math.min(a.wy, b.wy) - pad;
    var x1 = Math.max(a.wx, b.wx) + pad, y1 = Math.max(a.wy, b.wy) + pad;
    var step = 3;
    while (((x1 - x0) / step) * ((y1 - y0) / step) > 5200) step += 1;
    var W = Math.ceil((x1 - x0) / step) + 1, H = Math.ceil((y1 - y0) / step) + 1;

    var p = world.buildRegion(x0, y0, W, H, step);
    var costG = new Float32Array(W * H);
    for (var i = 0; i < W * H; i++) {
      costG[i] = 1 + p.slope[i] * 5 +
        (p.hn[i] < 0 ? 26 : 0) +
        (p.river[i] > 0.3 ? 3.5 : 0) +
        (p.hn[i] > 0.5 ? 2 : 0);
    }

    var start = ((Math.round((a.wy - y0) / step)) * W + Math.round((a.wx - x0) / step));
    var goal = ((Math.round((b.wy - y0) / step)) * W + Math.round((b.wx - x0) / step));
    start = clamp(start, 0, W * H - 1); goal = clamp(goal, 0, W * H - 1);

    var open = [start], gScore = new Float32Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1);
    var closed = new Uint8Array(W * H);
    gScore[start] = 0;
    var NDX = [-1, 1, 0, 0, -1, 1, -1, 1];
    var NDY = [0, 0, -1, 1, -1, -1, 1, 1];
    var ND = [1, 1, 1, 1, 1.414, 1.414, 1.414, 1.414];
    var gx2 = goal % W, gy2 = (goal / W) | 0;

    function fOf(n) {
      var nx = n % W, ny = (n / W) | 0;
      return gScore[n] + Math.sqrt((nx - gx2) * (nx - gx2) + (ny - gy2) * (ny - gy2));
    }

    var guard = 0;
    while (open.length && guard++ < 40000) {
      var bi = 0, bf = fOf(open[0]);
      for (var oi = 1; oi < open.length; oi++) {
        var f = fOf(open[oi]);
        if (f < bf || (f === bf && open[oi] < open[bi])) { bf = f; bi = oi; }
      }
      var cur = open.splice(bi, 1)[0];
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      var cx = cur % W, cy = (cur / W) | 0;
      for (var nb = 0; nb < 8; nb++) {
        var nx = cx + NDX[nb], ny = cy + NDY[nb];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var n = ny * W + nx;
        if (closed[n]) continue;
        var g = gScore[cur] + ND[nb] * 0.5 * (costG[cur] + costG[n]);
        if (g < gScore[n]) {
          gScore[n] = g;
          from[n] = cur;
          open.push(n);
        }
      }
    }

    var road = null;
    if (from[goal] >= 0 || goal === start) {
      var pts = [], n2 = goal;
      while (n2 >= 0) {
        pts.push([x0 + (n2 % W) * step, y0 + ((n2 / W) | 0) * step, p.hn[n2] < 0 ? 1 : 0]);
        n2 = from[n2];
      }
      pts.reverse();
      /* Decimate but keep land/water transitions so ferries render honestly. */
      var slim = [pts[0]];
      for (var q = 1; q < pts.length - 1; q++) {
        if (q % 2 === 0 || pts[q][2] !== pts[q - 1][2]) slim.push(pts[q]);
      }
      slim.push(pts[pts.length - 1]);
      road = {
        key: key, a: a.key, b: b.key, pts: slim,
        cost: gScore[goal],
        bbox: [x0, y0, x1, y1]
      };
      civ.roadList.push(road);
    }
    civ.roads.set(key, road);
    civ.rev++;
    return road;
  }

  /* ------------------------------------------------------------- history --- */

  var ERAS = ['the Age of Salt', 'the Age of Embers', 'the Long Peace', 'the Age of Sails',
    'the Age of the Broken Crown', 'the Quiet Centuries'];

  function currentYear(world) {
    var civ = civOf(world);
    return 300 + (rand.hash2(7, 13, civ.seed) % 600);
  }

  function eraName(world) {
    var civ = civOf(world);
    return ERAS[rand.hash2(3, 11, civ.seed) % ERAS.length];
  }

  /*
   * A nation's chronicle is annotation of its actual geography: wars happen
   * with the neighbour capital whose approach is narrowest (the midpoint of
   * the line between them names the pass or strait), floods happen to river
   * capitals on low ground, ash-years to volcanic ones, droughts to dry ones.
   */
  function buildHistory(world, nation) {
    var civ = civOf(world);
    var capSite = nation.capital;
    var rnd = rand.rng((rand.hash2(capSite.gx, capSite.gy, civ.seed ^ 0x41f) >>> 0));
    var year = currentYear(world);
    var ev = [{ y: nation.founded, t: nation.name + ' founded at ' + capSite.name }];

    /* the nearest other capital, for a war or a treaty */
    var pvx = Math.floor(capSite.gx / PROV), pvy = Math.floor(capSite.gy / PROV);
    var rival = null, rd = Infinity;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var other = provCapital(world, pvx + dx, pvy + dy);
        if (other && other.key !== capSite.key) {
          var d = Math.abs(other.wx - capSite.wx) + Math.abs(other.wy - capSite.wy);
          if (d < rd) { rd = d; rival = other; }
        }
      }
    }
    if (rival) {
      var mx = Math.round((capSite.wx + rival.wx) / 2), my = Math.round((capSite.wy + rival.wy) / 2);
      var mid = world.buildRegion(mx, my, 1, 1, 1);
      var terrain = mid.hn[0] < 0 ? 'Strait' : (mid.hn[0] > 0.35 ? 'Pass' : 'March');
      var warYear = nation.founded + 30 + ((rnd() * Math.max(40, year - nation.founded - 60)) | 0);
      var won = rnd() < 0.5;
      ev.push({
        y: warYear,
        t: 'the War of the ' + terrain + ' against ' + rival.name +
          (won ? ' — the ' + terrain.toLowerCase() + ' held' : ' — the ' + terrain.toLowerCase() + ' was lost a generation')
      });
      ev.push({
        y: warYear + 8 + ((rnd() * 30) | 0),
        t: 'peace of the ' + terrain.toLowerCase() + ' sworn under ' + nation.faith.deity.split(',')[0]
      });
    }
    if (capSite.river && capSite.hn < 0.12) {
      ev.push({ y: nation.founded + 15 + ((rnd() * 200) | 0), t: 'the Great Flood — ' + capSite.name + ' rebuilt on higher stones' });
    }
    if (capSite.biome === 15 || capSite.temp > 0.8) {
      ev.push({ y: nation.founded + 40 + ((rnd() * 200) | 0), t: 'the Ash Year — harvests failed under a red sky' });
    }
    if (capSite.moist < 0.3) {
      ev.push({ y: nation.founded + 25 + ((rnd() * 220) | 0), t: 'the Deep Drought — the wells of ' + capSite.name + ' dug twice as deep' });
    }
    ev.sort(function (a, b) { return a.y - b.y; });
    return ev.filter(function (e) { return e.y <= year; });
  }

  /* ------------------------------------------------------------- dossier --- */

  function dossier(world, site) {
    var civ = civOf(world);
    var got = civ.dossiers.get(site.key);
    if (got) return got;

    var rnd = rand.rng((rand.hash2(site.gx, site.gy, civ.seed ^ 0xd05) >>> 0));
    var nation = nationOf(world, site);
    var year = currentYear(world);
    var founded = Math.min(nation.founded + (rand.hash2(site.gx, site.gy, civ.seed ^ 0x77) % 300),
      year - 20);
    var clans = buildClans(world, site, rnd);
    var people = buildPeople(world, site, clans, rnd);
    var artifacts = buildArtifacts(world, site, nation, clans, founded, rnd);
    var trade = buildTrade(world, site, nation);
    var history = buildHistory(world, nation);
    var pop = [60 + rand.hash2(site.gx, site.gy, civ.seed ^ 0x99) % 240,
      400 + rand.hash2(site.gx, site.gy, civ.seed ^ 0x99) % 1600,
      2500 + rand.hash2(site.gx, site.gy, civ.seed ^ 0x99) % 9500][site.rank];

    var d = {
      site: site,
      nation: nation,
      culture: site.culture,
      faith: nation.faith,
      localShrine: site.kind !== nation.capital.kind
        ? 'keeps also a ' + (site.kind === 'coast' ? 'sea-shrine' : site.kind === 'river' ? 'ford-shrine'
          : site.kind === 'high' ? 'peak-cairn' : site.kind === 'wood' ? 'grove-shrine' : 'field-shrine')
        : null,
      clans: clans,
      people: people,
      artifacts: artifacts,
      trade: trade,
      history: history,
      year: year,
      era: eraName(world),
      founded: founded,
      population: pop
    };
    civ.dossiers.set(site.key, d);
    return d;
  }

  /* Sites overlapping one chunk, from the shared cache; misses are reported so
   * the app can queue probes rather than stall the frame. */
  function sitesForChunk(world, chunk, misses) {
    var bx = chunk.cx * NW.world.CHUNK, by = chunk.cy * NW.world.CHUNK;
    var civ = civOf(world);
    var g0x = Math.floor(bx / CELL), g1x = Math.floor((bx + NW.world.CHUNK - 1) / CELL);
    var g0y = Math.floor(by / CELL), g1y = Math.floor((by + NW.world.CHUNK - 1) / CELL);
    var out = [];
    for (var gy = g0y; gy <= g1y; gy++) {
      for (var gx = g0x; gx <= g1x; gx++) {
        var key = gx + ',' + gy;
        if (!civ.sites.has(key)) {
          if (misses) misses.push([gx, gy]);
          continue;
        }
        var s = civ.sites.get(key);
        if (s && s.wx >= bx && s.wy >= by && s.wx < bx + NW.world.CHUNK && s.wy < by + NW.world.CHUNK) {
          out.push(s);
        }
      }
    }
    return out;
  }

  NW.civ = {
    CELL: CELL,
    PROV: PROV,
    FAMILIES: FAMILIES,
    civOf: civOf,
    siteAt: siteAt,
    cultureAt: cultureAt,
    dialectFor: dialectFor,
    provCapital: provCapital,
    nationOf: nationOf,
    lineCost: lineCost,
    nearestSites: nearestSites,
    roadBetween: roadBetween,
    dossier: dossier,
    currentYear: currentYear,
    eraName: eraName,
    sitesForChunk: sitesForChunk,
    specialise: specialise
  };
})(window.NW = window.NW || {});
