import { CONFIG } from '../config.js';

// Voisins orthogonaux d'abord : à distance égale, on préfère aller tout droit.
const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function distanceToRect(x, y, r) {
  const cx = x < r.x ? r.x : x > r.x + r.w ? r.x + r.w : x;
  const cy = y < r.y ? r.y : y > r.y + r.h ? r.y + r.h : y;
  return Math.hypot(x - cx, y - cy);
}

/**
 * Grille de navigation grossière, partagée par tous les champs de flux :
 * une case est praticable si un disque de `clearance` y tient sans toucher de bâtiment.
 */
export class NavGrid {
  constructor(city) {
    const cfg = CONFIG.navigation;
    const cs = cfg.cellSize;
    this.cellSize = cs;
    this.cols = Math.ceil(city.width / cs);
    this.rows = Math.ceil(city.height / cs);
    this.walkable = new Uint8Array(this.cols * this.rows);
    this.queue = new Int32Array(this.cols * this.rows); // tampon BFS réutilisé

    const buffer = [];
    for (let gy = 0; gy < this.rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        const x = (gx + 0.5) * cs;
        const y = (gy + 0.5) * cs;
        if (city.isCircleFree(x, y, cfg.clearance, buffer)) this.walkable[gy * this.cols + gx] = 1;
      }
    }
  }

  isOpen(gx, gy) {
    return gx >= 0 && gy >= 0 && gx < this.cols && gy < this.rows && this.walkable[gy * this.cols + gx] === 1;
  }
}

/**
 * Champ de flux vers un bâtiment cible (hôpital ou domicile).
 *
 * Un BFS unique donne à chaque case praticable sa distance à la porte. Un agent
 * qui veut s'y rendre n'a qu'à regarder la case voisine la plus proche :
 * O(1) par agent et par pas, quel que soit le nombre d'agents en route.
 */
export class FlowField {
  constructor(grid, target) {
    const { sourceReach } = CONFIG.navigation;
    const { cols, rows, cellSize: cs, walkable, queue } = grid;
    this.grid = grid;
    this.target = target;
    this.dist = new Int16Array(cols * rows).fill(-1);
    this.exits = [];

    let head = 0;
    let tail = 0;
    const x0 = Math.max(0, Math.floor((target.x - sourceReach) / cs));
    const x1 = Math.min(cols - 1, Math.floor((target.x + target.w + sourceReach) / cs));
    const y0 = Math.max(0, Math.floor((target.y - sourceReach) / cs));
    const y1 = Math.min(rows - 1, Math.floor((target.y + target.h + sourceReach) / cs));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const i = gy * cols + gx;
        const x = (gx + 0.5) * cs;
        const y = (gy + 0.5) * cs;
        if (walkable[i] && distanceToRect(x, y, target) <= sourceReach) {
          this.dist[i] = 0;
          queue[tail++] = i;
          this.exits.push({ x, y });
        }
      }
    }

    while (head < tail) {
      const i = queue[head++];
      const gx = i % cols;
      const gy = (i / cols) | 0;
      const d = this.dist[i] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = gx + NEIGHBORS[k][0];
        const ny = gy + NEIGHBORS[k][1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx;
        if (walkable[j] && this.dist[j] === -1) {
          this.dist[j] = d;
          queue[tail++] = j;
        }
      }
    }
  }

  get isValid() {
    return this.exits.length > 0;
  }

  distanceTo(agent) {
    return distanceToRect(agent.x, agent.y, this.target);
  }

  /**
   * Oriente la direction désirée de l'agent vers la cible.
   * @returns {boolean} false si l'agent est hors du champ (il reprend alors l'errance)
   */
  steer(agent) {
    const grid = this.grid;
    const cs = grid.cellSize;
    const gx = Math.floor(agent.x / cs);
    const gy = Math.floor(agent.y / cs);
    if (gx < 0 || gy < 0 || gx >= grid.cols || gy >= grid.rows) return false;

    const here = this.dist[gy * grid.cols + gx];
    let tx;
    let ty;

    if (here === 0) {
      // À la porte : on se dirige vers le mur du bâtiment.
      const t = this.target;
      tx = agent.x < t.x ? t.x : agent.x > t.x + t.w ? t.x + t.w : agent.x;
      ty = agent.y < t.y ? t.y : agent.y > t.y + t.h ? t.y + t.h : agent.y;
    } else {
      let best = -1;
      let bestDist = here >= 0 ? here : Infinity;
      for (let k = 0; k < 8; k++) {
        const [dx, dy] = NEIGHBORS[k];
        const nx = gx + dx;
        const ny = gy + dy;
        if (!grid.isOpen(nx, ny)) continue;
        const d = this.dist[ny * grid.cols + nx];
        if (d < 0 || d >= bestDist) continue;
        // Pas de diagonale qui couperait l'angle d'un bâtiment.
        if (k >= 4 && (!grid.isOpen(gx + dx, gy) || !grid.isOpen(gx, gy + dy))) continue;
        best = k;
        bestDist = d;
      }
      if (best === -1) return false;
      tx = (gx + NEIGHBORS[best][0] + 0.5) * cs;
      ty = (gy + NEIGHBORS[best][1] + 0.5) * cs;
    }

    const dx = tx - agent.x;
    const dy = ty - agent.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    agent.dirX = dx / len;
    agent.dirY = dy / len;
    return true;
  }
}
