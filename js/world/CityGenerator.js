import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

/**
 * Génère le plan d'une ville :
 *  1. Découpage en super-blocs séparés par des avenues (grille irrégulière).
 *  2. Subdivision BSP de chaque super-bloc avec des ruelles.
 *  3. Chaque parcelle devient un bâtiment (avec retrait) ou une place.
 *
 * Chaque ruelle traverse entièrement son rectangle parent : toutes les rues
 * débouchent donc sur une autre rue, le réseau est connexe par construction.
 */
export function generateCity(width, height, seed, density) {
  const cfg = CONFIG.city;
  const rng = new Random(seed);
  const t = clamp((density - cfg.density.min) / (cfg.density.max - cfg.density.min), 0, 1);

  const params = {
    blockSize: lerp(cfg.blockSize.low, cfg.blockSize.high, t),
    maxLot: lerp(cfg.maxLot.low, cfg.maxLot.high, t),
    setback: lerp(cfg.setback.low, cfg.setback.high, t),
    plazaChance: lerp(cfg.plazaChance.low, cfg.plazaChance.high, t),
  };

  const columns = splitAxis(width, params.blockSize, cfg.avenueWidth, rng);
  const rows = splitAxis(height, params.blockSize, cfg.avenueWidth, rng);

  const buildings = [];
  const plazas = [];

  for (const [y0, y1] of rows) {
    for (const [x0, x1] of columns) {
      subdivide({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0, params, rng, buildings, plazas);
    }
  }

  return {
    width,
    height,
    seed,
    density,
    params,
    buildings,
    plazas,
    avenuesX: avenueCenters(columns, cfg.avenueWidth),
    avenuesY: avenueCenters(rows, cfg.avenueWidth),
  };
}

/** Découpe un axe en segments [début, fin] séparés par des avenues. */
function splitAxis(length, size, gap, rng) {
  const spans = [];
  const minSpan = size * 0.5;
  const end = length - gap;
  let cursor = gap;

  if (end - cursor < minSpan) return spans;

  while (cursor < end) {
    let span = size * rng.range(0.75, 1.25);
    // Le dernier bloc absorbe le reste s'il serait trop petit.
    if (end - (cursor + span) < minSpan + gap) span = end - cursor;
    spans.push([cursor, cursor + span]);
    cursor += span + gap;
  }
  return spans;
}

function avenueCenters(spans, gap) {
  if (spans.length === 0) return [];
  const centers = spans.map(([start]) => start - gap / 2);
  centers.push(spans[spans.length - 1][1] + gap / 2);
  return centers;
}

function subdivide(rect, depth, params, rng, buildings, plazas) {
  const { alleyWidth, minLot, maxDepth } = CONFIG.city;
  const canSplitX = rect.w >= minLot * 2 + alleyWidth;
  const canSplitY = rect.h >= minLot * 2 + alleyWidth;
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

  // On coupe perpendiculairement au plus grand côté.
  let vertical = rect.w > rect.h;
  if (vertical && !canSplitX) vertical = false;
  if (!vertical && !canSplitY) vertical = true;

  if (vertical) {
    const available = rect.w - alleyWidth;
    const a = clamp(available * rng.range(0.35, 0.65), minLot, available - minLot);
    subdivide({ x: rect.x, y: rect.y, w: a, h: rect.h }, depth + 1, params, rng, buildings, plazas);
    subdivide(
      { x: rect.x + a + alleyWidth, y: rect.y, w: available - a, h: rect.h },
      depth + 1, params, rng, buildings, plazas,
    );
  } else {
    const available = rect.h - alleyWidth;
    const a = clamp(available * rng.range(0.35, 0.65), minLot, available - minLot);
    subdivide({ x: rect.x, y: rect.y, w: rect.w, h: a }, depth + 1, params, rng, buildings, plazas);
    subdivide(
      { x: rect.x, y: rect.y + a + alleyWidth, w: rect.w, h: available - a },
      depth + 1, params, rng, buildings, plazas,
    );
  }
}

function placeLot(rect, params, rng, buildings, plazas) {
  if (rng.chance(params.plazaChance)) {
    plazas.push(rect);
    return;
  }
  const inset = params.setback * rng.range(0.5, 1.5);
  const building = {
    x: Math.round(rect.x + inset),
    y: Math.round(rect.y + inset),
    w: Math.round(rect.w - inset * 2),
    h: Math.round(rect.h - inset * 2),
  };
  if (building.w >= 8 && building.h >= 8) buildings.push(building);
}
