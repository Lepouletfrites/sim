/**
 * Grille spatiale uniforme (spatial hash) à base de listes chaînées
 * dans des tableaux typés : zéro allocation pendant la simulation.
 *
 * - insert : O(1)
 * - query  : ne parcourt que les 3x3 cases autour du point
 */
export class SpatialHashGrid {
  constructor(width, height, cellSize, capacity) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(capacity);
  }

  ensureCapacity(capacity) {
    if (capacity > this.next.length) {
      this.next = new Int32Array(capacity);
    }
  }

  clear() {
    this.head.fill(-1);
  }

  cellX(x) {
    const cx = Math.floor(x / this.cellSize);
    return cx < 0 ? 0 : cx >= this.cols ? this.cols - 1 : cx;
  }

  cellY(y) {
    const cy = Math.floor(y / this.cellSize);
    return cy < 0 ? 0 : cy >= this.rows ? this.rows - 1 : cy;
  }

  insert(index, x, y) {
    const cell = this.cellY(y) * this.cols + this.cellX(x);
    this.next[index] = this.head[cell];
    this.head[cell] = index;
  }

  /**
   * Remplit `out` avec les indices des éléments des cases adjacentes.
   * @returns {number} nombre d'indices écrits
   */
  query(x, y, out) {
    const cx = this.cellX(x);
    const cy = this.cellY(y);
    const x0 = cx > 0 ? cx - 1 : 0;
    const x1 = cx < this.cols - 1 ? cx + 1 : cx;
    const y0 = cy > 0 ? cy - 1 : 0;
    const y1 = cy < this.rows - 1 ? cy + 1 : cy;
    const max = out.length;
    let count = 0;

    for (let gy = y0; gy <= y1; gy++) {
      const row = gy * this.cols;
      for (let gx = x0; gx <= x1; gx++) {
        let i = this.head[row + gx];
        while (i !== -1 && count < max) {
          out[count++] = i;
          i = this.next[i];
        }
      }
    }
    return count;
  }

  /**
   * Comme `query`, mais sur toutes les cases qui recouvrent le disque (x, y, r) :
   * pour les recherches à longue portée (flair des zombies).
   */
  queryRadius(x, y, r, out) {
    const x0 = this.cellX(x - r);
    const x1 = this.cellX(x + r);
    const y0 = this.cellY(y - r);
    const y1 = this.cellY(y + r);
    const max = out.length;
    let count = 0;

    for (let gy = y0; gy <= y1; gy++) {
      const row = gy * this.cols;
      for (let gx = x0; gx <= x1; gx++) {
        let i = this.head[row + gx];
        while (i !== -1 && count < max) {
          out[count++] = i;
          i = this.next[i];
        }
      }
    }
    return count;
  }
}
