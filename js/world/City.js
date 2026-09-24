import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { NavGrid, FlowField } from './NavigationField.js';
import { PlaceType } from './PlaceTypes.js';

/**
 * Représentation runtime d'une ville générée.
 * Fournit des structures d'accélération statiques :
 *  - buildingGrid : bâtiments indexés par case (collisions cercle/rectangle)
 *  - walkGrid     : masque de cases praticables (spawn, sondes de direction)
 *  - navGrid      : grille grossière pour les champs de flux
 *  - fieldTo()    : champ de flux vers n'importe quel bâtiment (calculé à la demande)
 *
 * Chaque bâtiment reçoit un type (logement, bureaux, commerce...) et une capacité.
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
    this.blocks = layout.blocks;
    this.avenuesX = layout.avenuesX;
    this.avenuesY = layout.avenuesY;

    this.buildBuildingGrid();
    this.buildWalkGrid();
    this.navGrid = new NavGrid(this);
    this.fields = new Map(); // index du bâtiment -> FlowField (calcul paresseux)
    this.setupHospital();
    this.assignPlaces();
  }

  // ------------------------------------------------------------------ Lieux

  /** Choisit un grand bâtiment proche du centre comme hôpital. */
  setupHospital() {
    this.hospital = null;
    this.hospitalIndex = -1;
    this.hospitalField = null;
    if (this.buildings.length === 0) return;

    const cx = this.width / 2;
    const cy = this.height / 2;
    const large = this.buildings.filter((b) => b.w >= 36 && b.h >= 36);
    const candidates = large.length > 0 ? large : this.buildings;
    let best = null;
    let bestScore = Infinity;
    for (const b of candidates) {
      const score =
        Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy) - Math.sqrt(b.w * b.h) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }

    const hospitalIndex = this.buildings.indexOf(best);
    const field = this.fieldTo(hospitalIndex);
    if (field) {
      this.hospital = best;
      this.hospitalIndex = hospitalIndex;
      this.hospitalField = field;
    }
  }

  /**
   * Répartit les types de bâtiments (déterministe pour une graine donnée) :
   *  - centres commerciaux : les plus grands bâtiments
   *  - boîtes de nuit      : bâtiments moyens
   *  - restaurants         : petits bâtiments
   *  - bureaux             : tirés au hasard, en favorisant les grands
   *  - le reste            : logements
   */
  assignPlaces() {
    const cfg = CONFIG.places;
    const rng = new Random(this.seed ^ 0x2545f491);
    const area = (i) => this.buildings[i].w * this.buildings[i].h;

    for (const b of this.buildings) b.type = PlaceType.HOME;
    if (this.hospital) this.hospital.type = PlaceType.HOSPITAL;

    const free = this.buildings
      .map((_, i) => i)
      .filter((i) => i !== this.hospitalIndex && this.fieldTo(i) !== null)
      .sort((a, b) => area(b) - area(a));
    const n = free.length;
    const count = (every) => Math.max(1, Math.min(3, Math.round(n / every)));
    const take = (list, k, type) => {
      for (let j = 0; j < k && list.length > 0; j++) {
        const i = list.splice(Math.floor(rng.next() * list.length), 1)[0];
        this.buildings[i].type = type;
        free.splice(free.indexOf(i), 1);
      }
    };

    if (n >= 8) {
      // Les plus grands pour les centres commerciaux
      for (let k = count(cfg.mallEvery); k > 0; k--) this.buildings[free.shift()].type = PlaceType.MALL;
      const third = Math.floor(free.length / 3);
      take(free.slice(third, 2 * third), count(cfg.nightclubEvery), PlaceType.NIGHTCLUB);
      take(free.slice(Math.floor(free.length / 2)), Math.max(2, Math.round(n * cfg.restaurantShare)), PlaceType.RESTAURANT);
      // Bureaux : tirage pondéré par la surface
      const weighted = [...free].sort((a, b) => area(b) * rng.range(0.3, 1.7) - area(a) * rng.range(0.3, 1.7));
      take(weighted.slice(0, Math.round(n * cfg.workShare * 1.5)), Math.round(n * cfg.workShare), PlaceType.WORK);
    }

    this.byType = {};
    for (const type of Object.values(PlaceType)) this.byType[type] = [];
    this.buildings.forEach((b, i) => {
      // Logements et bureaux accueillent toujours leurs occupants attitrés ;
      // seuls les lieux ouverts au public ont une jauge.
      b.capacity =
        b.type === PlaceType.HOME || b.type === PlaceType.WORK ? Infinity
          : b.type === PlaceType.HOSPITAL ? CONFIG.epidemic.hospitalCapacity
            : Math.max(6, Math.floor(b.w * b.h * cfg.capacityPerArea));
      // Un bâtiment enclavé (inaccessible depuis la rue) reste décoratif.
      if (this.fieldTo(i) !== null) this.byType[b.type].push(i);
    });

    // Tirages pondérés par la surface (un grand immeuble loge plus de monde).
    this.cumulative = {};
    for (const [type, list] of Object.entries(this.byType)) {
      let sum = 0;
      this.cumulative[type] = list.map((i) => (sum += area(i)));
    }
  }

  /** Bâtiment d'un type donné, tiré au hasard proportionnellement à sa surface (-1 si aucun). */
  pickPlace(type, rng) {
    const list = this.byType[type];
    if (!list || list.length === 0) return -1;
    const cumulative = this.cumulative[type];
    const r = rng.next() * cumulative[cumulative.length - 1];
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return list[lo];
  }

  typeOf(place) {
    return place < 0 ? 'street' : this.buildings[place].type;
  }

  /**
   * Champ de flux vers un bâtiment, calculé à la première demande puis mis en cache.
   * @returns {FlowField|null} null si le bâtiment est inaccessible
   */
  fieldTo(buildingIndex) {
    if (buildingIndex < 0) return null;
    let field = this.fields.get(buildingIndex);
    if (field === undefined) {
      field = new FlowField(this.navGrid, this.buildings[buildingIndex]);
      if (!field.isValid) field = null;
      this.fields.set(buildingIndex, field);
    }
    return field;
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
