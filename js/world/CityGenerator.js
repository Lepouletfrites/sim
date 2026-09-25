import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

/**
 * Génère le plan d'une ville :
 *  1. Découpage en îlots séparés par des avenues (grille irrégulière).
 *  2. Désordre : îlots fusionnés, avenues de largeurs variables, boulevards.
 *  3. Subdivision BSP de chaque îlot avec des ruelles ; parcs.
 *  4. Chaque parcelle devient un ou plusieurs bâtiments, ou un espace vert.
 *  5. Rivière optionnelle qui serpente à travers la ville, franchie par quelques ponts.
 *
 * La densité (1 à 10) fait passer d'un village à un centre-ville :
 *  - faible : grands îlots, beaucoup de parcelles vides (champs, jardins),
 *    petits bâtiments en retrait qui n'occupent qu'une partie de leur terrain
 *  - forte  : petits îlots, parcelles étroites, bâtiments mitoyens qui couvrent tout
 *
 * Chaque ruelle traverse entièrement son rectangle parent : toutes les rues
 * débouchent sur une autre rue. Les îlots fusionnés restent entourés d'avenues,
 * et les ponts relient les deux rives : le réseau reste connexe.
 *
 * @param {object} [options]
 * @param {number} [options.chaos]  0..1 : désordre du plan
 * @param {number} [options.green]  0..1 : part d'espaces verts
 * @param {boolean} [options.river] rivière traversant la ville
 */
export function generateCity(width, height, seed, density, { chaos = 0, green = 0, river = false } = {}) {
  const cfg = CONFIG.city;
  const rng = new Random(seed);
  const t = densityRatio(density);

  const params = {
    t,
    chaos,
    green,
    blockSize: lerp(cfg.blockSize.low, cfg.blockSize.high, t),
    maxLot: lerp(cfg.maxLot.low, cfg.maxLot.high, t),
    setback: lerp(cfg.setback.low, cfg.setback.high, t),
    plazaChance: lerp(cfg.plazaChance.low, cfg.plazaChance.high, t) + cfg.greenLots * green,
    fillMin: lerp(cfg.buildingFill.low[0], cfg.buildingFill.high[0], t) - 0.25 * chaos,
    fillMax: lerp(cfg.buildingFill.low[1], cfg.buildingFill.high[1], t),
  };

  const columns = splitAxis(width, params.blockSize, rng, chaos);
  const rows = splitAxis(height, params.blockSize, rng, chaos);

  // Îlots de la grille, dont certains fusionnent avec un voisin (la grille se brise).
  const grid = rows.spans.map(([y0, y1]) => columns.spans.map(([x0, x1]) => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })));
  const blocks = mergeBlocks(grid, rng, cfg.mergeChance * chaos);

  const buildings = [];
  const plazas = [];
  for (const block of blocks) {
    if (rng.chance(cfg.parkBlocks * green)) {
      plazas.push(block); // un îlot entier devient un parc
      continue;
    }
    subdivide(block, 0, params, rng, buildings, plazas);
  }

  const layout = {
    width,
    height,
    seed,
    density,
    params,
    blocks,
    buildings,
    plazas,
    water: [],
    bridges: [],
    avenuesX: columns.centers,
    avenuesY: rows.centers,
  };
  if (river) addRiver(layout, columns, rows, rng, chaos);
  return layout;
}

/**
 * Densité ramenée à [0, 1] : 0 = rural, 1 = centre-ville.
 * Courbe adoucie : le milieu du curseur donne une petite ville, pas un gros village.
 */
export function densityRatio(density) {
  const { min, max } = CONFIG.city.density;
  return Math.pow(clamp((density - min) / (max - min), 0, 1), 0.6);
}

/**
 * Découpe un axe en îlots séparés par des avenues. Avec du désordre, les îlots
 * ont des tailles plus inégales et les avenues des largeurs variables (quelques
 * boulevards). Les avenues de ceinture gardent leur largeur normale.
 * @returns {{spans: number[][], gaps: number[][], centers: number[]}}
 */
function splitAxis(length, size, rng, chaos) {
  const cfg = CONFIG.city;
  const border = cfg.avenueWidth;
  const spans = [];
  const gaps = [[0, border]];
  const minSpan = size * 0.4;
  const end = length - border;
  let cursor = border;

  if (end - cursor < minSpan) return { spans, gaps: [], centers: [] };

  while (cursor < end) {
    let span = size * rng.range(0.75 - 0.35 * chaos, 1.25 + 0.55 * chaos);
    span = Math.max(minSpan, span);
    let gap = border;
    if (chaos > 0) {
      gap = border * rng.range(1 - 0.4 * chaos, 1 + 0.2 * chaos);
      if (rng.chance(cfg.boulevardChance * chaos)) gap = border * 1.6; // boulevard
      gap = Math.max(cfg.alleyWidth + 4, gap);
    }
    // Le dernier îlot absorbe le reste s'il serait trop petit.
    if (end - (cursor + span) < minSpan + gap) span = end - cursor;
    spans.push([cursor, cursor + span]);
    cursor += span;
    if (cursor < end) {
      gaps.push([cursor, cursor + gap]);
      cursor += gap;
    }
  }
  gaps.push([length - border, length]);
  const centers = gaps.map(([a, b]) => (a + b) / 2);
  return { spans, gaps, centers };
}

/** Fusionne des paires d'îlots voisins (l'avenue entre eux disparaît). */
function mergeBlocks(grid, rng, chance) {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;
  const used = grid.map((row) => row.map(() => false));
  const blocks = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (used[r][c]) continue;
      const a = grid[r][c];
      used[r][c] = true;
      if (rng.chance(chance)) {
        const horizontal = rng.chance(0.5);
        const [nr, nc] = horizontal ? [r, c + 1] : [r + 1, c];
        if (nr < rows && nc < cols && !used[nr][nc]) {
          const b = grid[nr][nc];
          used[nr][nc] = true;
          blocks.push(horizontal
            ? { x: a.x, y: a.y, w: b.x + b.w - a.x, h: a.h }
            : { x: a.x, y: a.y, w: a.w, h: b.y + b.h - a.y });
          continue;
        }
      }
      blocks.push(a);
    }
  }
  return blocks;
}

function subdivide(rect, depth, params, rng, buildings, plazas) {
  const { alleyWidth, minLot, maxDepth } = CONFIG.city;
  const chaos = params.chaos;
  // Ruelles un peu plus larges ou irrégulières avec le désordre (jamais plus étroites).
  const alley = alleyWidth * rng.range(1, 1 + 0.35 * chaos);
  const canSplitX = rect.w >= minLot * 2 + alley;
  const canSplitY = rect.h >= minLot * 2 + alley;
  const tooBig = rect.w > params.maxLot || rect.h > params.maxLot;
  const earlyStop =
    depth > 0 &&
    rect.w < params.maxLot * 1.5 &&
    rect.h < params.maxLot * 1.5 &&
    rng.chance(0.25);

  if (!tooBig || earlyStop || depth >= maxDepth || (!canSplitX && !canSplitY)) {
    placeLot(rect, params, rng, buildings, plazas);
    return;
  }

  // On coupe perpendiculairement au plus grand côté (sauf un peu de désordre).
  let vertical = rect.w > rect.h;
  if (rng.chance(0.25 * chaos)) vertical = !vertical;
  if (vertical && !canSplitX) vertical = false;
  if (!vertical && !canSplitY) vertical = true;
  const ratio = rng.range(0.35 - 0.15 * chaos, 0.65 + 0.15 * chaos);

  if (vertical) {
    const available = rect.w - alley;
    const a = clamp(available * ratio, minLot, available - minLot);
    subdivide({ x: rect.x, y: rect.y, w: a, h: rect.h }, depth + 1, params, rng, buildings, plazas);
    subdivide(
      { x: rect.x + a + alley, y: rect.y, w: available - a, h: rect.h },
      depth + 1, params, rng, buildings, plazas,
    );
  } else {
    const available = rect.h - alley;
    const a = clamp(available * ratio, minLot, available - minLot);
    subdivide({ x: rect.x, y: rect.y, w: rect.w, h: a }, depth + 1, params, rng, buildings, plazas);
    subdivide(
      { x: rect.x, y: rect.y + a + alley, w: rect.w, h: available - a },
      depth + 1, params, rng, buildings, plazas,
    );
  }
}

function placeLot(rect, params, rng, buildings, plazas) {
  if (rng.chance(params.plazaChance)) {
    plazas.push(rect);
    return;
  }
  // Terrain constructible (parcelle moins le retrait), dont le bâtiment n'occupe
  // qu'une partie à la campagne : on le place n'importe où sur le terrain.
  const inset = params.setback * rng.range(0.6, 1.4);
  const areaW = rect.w - inset * 2;
  const areaH = rect.h - inset * 2;
  const fillMin = Math.max(0.3, params.fillMin);
  const w = Math.max(12, areaW * rng.range(fillMin, params.fillMax));
  const h = Math.max(12, areaH * rng.range(fillMin, params.fillMax));
  if (w > areaW || h > areaH) return;
  const x = rect.x + inset + rng.next() * (areaW - w);
  const y = rect.y + inset + rng.next() * (areaH - h);

  // Désordre : deux bâtiments accolés de profondeurs différentes (façade irrégulière).
  if (params.chaos > 0 && rng.chance(CONFIG.city.splitBuildings * params.chaos) && Math.max(w, h) >= 30) {
    const alongX = w >= h;
    const cut = rng.range(0.35, 0.65);
    const shrink = rng.range(0.55, 0.85);
    if (alongX) {
      const w1 = Math.round(w * cut);
      const h2 = Math.max(12, Math.round(h * shrink));
      const offset = rng.chance(0.5) ? 0 : h - h2;
      buildings.push({ x: Math.round(x), y: Math.round(y), w: w1, h: Math.round(h) });
      buildings.push({ x: Math.round(x) + w1, y: Math.round(y + offset), w: Math.round(w) - w1, h: h2 });
    } else {
      const h1 = Math.round(h * cut);
      const w2 = Math.max(12, Math.round(w * shrink));
      const offset = rng.chance(0.5) ? 0 : w - w2;
      buildings.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: h1 });
      buildings.push({ x: Math.round(x + offset), y: Math.round(y) + h1, w: w2, h: Math.round(h) - h1 });
    }
    return;
  }

  buildings.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
}

/**
 * Rivière : elle serpente autour d'une avenue centrale, d'un bord à l'autre de la
 * carte. On la franchit par des ponts, là où elle croise certaines avenues
 * perpendiculaires. Les bâtiments qu'elle recouvre disparaissent.
 */
function addRiver(layout, columns, rows, rng, chaos) {
  const cfg = CONFIG.city.riverShape;
  const vertical = rng.chance(layout.width >= layout.height ? 0.65 : 0.35);
  const along = vertical ? rows : columns;       // avenues que la rivière coupe
  const across = vertical ? columns : rows;      // avenues parallèles à la rivière
  const length = vertical ? layout.height : layout.width;
  const span = vertical ? layout.width : layout.height;
  if (across.centers.length < 3) return;

  // Axe : une avenue intérieure proche du centre ; méandres autour de cet axe.
  const inner = across.centers.slice(1, -1);
  const axis = inner.reduce((best, c) => (Math.abs(c - span / 2) < Math.abs(best - span / 2) ? c : best), inner[0]);
  const width = rng.range(cfg.width[0], cfg.width[1]);
  const amplitude = cfg.amplitude[0] + (cfg.amplitude[1] - cfg.amplitude[0]) * chaos;
  const k1 = rng.range(0.006, 0.012);
  const k2 = rng.range(0.018, 0.03);
  const p1 = rng.range(0, Math.PI * 2);
  const p2 = rng.range(0, Math.PI * 2);
  const center = (v) => clamp(
    axis + amplitude * Math.sin(v * k1 + p1) + amplitude * 0.35 * Math.sin(v * k2 + p2),
    width, span - width,
  );

  // Ponts : une partie des avenues coupées, dont au moins deux intérieures.
  const crossings = along.gaps.slice(1, -1);
  const bridges = crossings.filter(() => rng.chance(cfg.bridgeChance));
  while (bridges.length < Math.min(2, crossings.length)) {
    const candidate = crossings[rng.int(0, crossings.length - 1)];
    if (!bridges.includes(candidate)) bridges.push(candidate);
  }
  const onBridge = (v0, v1) => bridges.some(([a, b]) => v0 < b && v1 > a);

  const step = cfg.step;
  const water = [];
  const path = []; // tracé lisse pour le dessin (les collisions utilisent les rectangles)
  for (let v = -step; v <= length + step; v += step) {
    const u = center(v);
    path.push(vertical ? { x: u, y: v } : { x: v, y: u });
  }
  for (let v = 0; v < length; v += step) {
    const v1 = Math.min(length, v + step);
    if (onBridge(v, v1)) continue;
    const u = center((v + v1) / 2);
    const rect = vertical
      ? { x: u - width / 2, y: v, w: width, h: v1 - v }
      : { x: v, y: u - width / 2, w: v1 - v, h: width };
    water.push(rect);
  }

  // Tablier des ponts (pour le dessin des parapets).
  for (const [a, b] of bridges) {
    const u = center((a + b) / 2);
    const half = width / 2 + 4;
    layout.bridges.push(vertical
      ? { x: u - half, y: a, w: half * 2, h: b - a }
      : { x: a, y: u - half, w: b - a, h: half * 2 });
  }

  // Les bâtiments dans l'eau (ou collés à la berge) disparaissent.
  const margin = 3;
  const overlaps = (b) => water.some((w) =>
    b.x < w.x + w.w + margin && b.x + b.w > w.x - margin && b.y < w.y + w.h + margin && b.y + b.h > w.y - margin);
  layout.buildings = layout.buildings.filter((b) => !overlaps(b));
  layout.water = water;
  layout.river = { path, width };
}
