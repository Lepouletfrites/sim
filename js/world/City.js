import { CONFIG } from '../config.js';

/**
 * Représentation runtime d'une ville générée.
 * Fournit deux structures d'accélération statiques :
 *  - buildingGrid : bâtiments indexés par case (collisions cercle/rectangle)
 *  - walkGrid     : masque de cases praticables (spawn, sondes de direction)
 */
export class City {
  constructor(layout) {
    this.width = layout.width;
    this.height = layout.height;
    this.seed = layout.seed;
    this.density = layout.density;
    this.params = layout.params;
    this.buildings = layout.buildings;
    this.plazas = layout.plazas;
    this.avenuesX = layout.avenuesX;
    this.avenuesY = layout.avenuesY;

    this.buildBuildingGrid();
    this.buildWalkGrid();
  }

  // ---------------------------------------------------------------- Bâtiments

  buildBuildingGrid() {
    const cs = CONFIG.city.buildingGridCell;
    this.bCell = cs;
    this.bCols = Math.max(1, Math.ceil(this.width / cs));
    this.bRows = Math.max(1, Math.ceil(this.height / cs));
    this.bCells = Array.from({ length: this.bCols * this.bRows }, () => []);

    this.buildings.forEach((b, index) => {
      const x0 = Math.max(0, Math.floor(b.x / cs));
      const y0 = Math.max(0, Math.floor(b.y / cs));
      const x1 = Math.min(this.bCols - 1, Math.floor((b.x + b.w) / cs));
      const y1 = Math.min(this.bRows - 1, Math.floor((b.y + b.h) / cs));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) this.bCells[gy * this.bCols + gx].push(index);
      }
    });

    // Tampon anti-doublons (un bâtiment peut couvrir plusieurs cases).
    this.stamp = new Uint32Array(this.buildings.length);
    this.queryId = 0;
  }

  /**
   * Remplit `out` avec les bâtiments susceptibles de toucher le cercle (x, y, r).
   * @returns {number} nombre de bâtiments écrits
   */
  getBuildingsNear(x, y, r, out) {
    const cs = this.bCell;
    const x0 = Math.max(0, Math.floor((x - r) / cs));
    const y0 = Math.max(0, Math.floor((y - r) / cs));
    const x1 = Math.min(this.bCols - 1, Math.floor((x + r) / cs));
    const y1 = Math.min(this.bRows - 1, Math.floor((y + r) / cs));
    const id = ++this.queryId;
    let count = 0;

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = this.bCells[gy * this.bCols + gx];
        for (let k = 0; k < cell.length; k++) {
          const index = cell[k];
          if (this.stamp[index] === id) continue;
          this.stamp[index] = id;
          out[count++] = this.buildings[index];
        }
      }
    }
    return count;
  }

  isCircleFree(x, y, r, buffer = []) {
    if (x < r || y < r || x > this.width - r || y > this.height - r) return false;
    const n = this.getBuildingsNear(x, y, r, buffer);
    for (let i = 0; i < n; i++) {
      const b = buffer[i];
      const cx = x < b.x ? b.x : x > b.x + b.w ? b.x + b.w : x;
      const cy = y < b.y ? b.y : y > b.y + b.h ? b.y + b.h : y;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ Grille de marche

  buildWalkGrid() {
    const cs = CONFIG.city.walkCell;
    const c = CONFIG.city.walkClearance;
    this.wCell = cs;
    this.wCols = Math.ceil(this.width / cs);
    this.wRows = Math.ceil(this.height / cs);
    this.walk = new Uint8Array(this.wCols * this.wRows).fill(1);

    for (const b of this.buildings) {
      const left = b.x - c;
      const right = b.x + b.w + c;
      const top = b.y - c;
      const bottom = b.y + b.h + c;
      const x0 = Math.max(0, Math.floor(left / cs));
      const x1 = Math.min(this.wCols - 1, Math.floor(right / cs));
      const y0 = Math.max(0, Math.floor(top / cs));
      const y1 = Math.min(this.wRows - 1, Math.floor(bottom / cs));
      for (let gy = y0; gy <= y1; gy++) {
        const cy = (gy + 0.5) * cs;
        if (cy <= top || cy >= bottom) continue;
        const row = gy * this.wCols;
        for (let gx = x0; gx <= x1; gx++) {
          const cx = (gx + 0.5) * cs;
          if (cx > left && cx < right) this.walk[row + gx] = 0;
        }
      }
    }
  }

  isWalkable(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.walk[((y / this.wCell) | 0) * this.wCols + ((x / this.wCell) | 0)] === 1;
  }

  /** Sonde un rayon depuis (x, y) dans la direction (dx, dy) sur `distance`. */
  isRayClear(x, y, dx, dy, distance, step) {
    let d = step;
    for (;;) {
      if (d > distance) d = distance;
      if (!this.isWalkable(x + dx * d, y + dy * d)) return false;
      if (d >= distance) return true;
      d += step;
    }
  }

  /** Point aléatoire situé dans une rue, sans chevauchement de bâtiment. */
  randomSpawnPoint(rng, radius) {
    const buffer = [];
    for (let tries = 0; tries < 500; tries++) {
      const x = rng.range(radius, this.width - radius);
      const y = rng.range(radius, this.height - radius);
      if (this.isWalkable(x, y) && this.isCircleFree(x, y, radius + 1, buffer)) return { x, y };
    }
    // Repli : intersection de deux avenues (toujours libre par construction).
    return {
      x: this.avenuesX[0] ?? this.width / 2,
      y: this.avenuesY[0] ?? this.height / 2,
    };
  }
}
