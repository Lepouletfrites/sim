import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { SpatialHashGrid } from '../core/SpatialHashGrid.js';
import { resolveCircleRect, clampToBounds } from '../physics/Collision.js';
import { Citizen } from './Citizen.js';
import { rollTraits } from './Traits.js';
import { WanderBehavior } from './WanderBehavior.js';

const COLLISION_PASSES = 2;

/**
 * Ensemble des habitants et pas physique.
 *
 * Chaque pas fixe (1/60 s) :
 *  1. reconstruit la grille spatiale (O(N)) avec tous les vivants, dehors comme dedans
 *  2. direction : champ de flux vers la destination (O(1)), errance dans la rue
 *     (décisions lentes, multi-tick), ou flânerie à l'intérieur d'un bâtiment
 *  3. séparation entre voisins proches du MÊME lieu (cases 3x3 uniquement)
 *  4. intégration ; collisions contre les bâtiments dehors, murs intérieurs dedans
 */
export class Population {
  constructor(city, seed) {
    this.city = city;
    this.rng = new Random(seed ^ 0xa5a5a5a5);
    this.citizens = [];
    this.nextId = 0;
    this.behavior = new WanderBehavior(city, this.rng);
    this.routine = null; // branché par la Simulation
    this.zombies = null; // idem
    this.grid = new SpatialHashGrid(
      city.width,
      city.height,
      CONFIG.citizens.gridCellSize,
      CONFIG.citizens.max,
    );
    this.neighborBuffer = new Int32Array(256);
    this.buildingBuffer = [];
  }

  get count() {
    return this.citizens.length;
  }

  setCount(count) {
    const cfg = CONFIG.citizens;
    this.grid.ensureCapacity(count);

    while (this.citizens.length < count) {
      const radius = this.rng.range(cfg.radiusMin, cfg.radiusMax);
      const speed = this.rng.range(cfg.speedMin, cfg.speedMax);
      const { x, y } = this.city.randomSpawnPoint(this.rng, radius);
      const citizen = new Citizen(this.nextId++, x, y, radius, speed);
      rollTraits(citizen, this.rng, this.city);
      this.behavior.initialize(citizen);
      this.citizens.push(citizen);
      if (this.routine) this.routine.initialize(citizen);
    }
    if (this.citizens.length > count) this.citizens.length = count;
  }

  step(dt) {
    const cfg = CONFIG.citizens;
    const { indoorSpeedFactor, indoorPause } = CONFIG.routine;
    const { panicBoost } = CONFIG.zombie;
    const citizens = this.citizens;
    const n = citizens.length;
    const grid = this.grid;
    const neighbors = this.neighborBuffer;
    const buildings = this.city.buildings;

    grid.clear();
    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      if (c.alive) grid.insert(i, c.x, c.y);
    }

    // --- Passe 1 : direction + forces -> vitesses
    const steer = Math.min(1, cfg.steering * dt);
    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      if (!c.alive) continue;
      c.px = c.x;
      c.py = c.y;

      let speed = c.speed * c.speedFactor;
      if (c.place >= 0) {
        // Flânerie intérieure : aller à un point, s'y arrêter, repartir.
        if (c.pause > 0) {
          c.pause -= dt;
          speed = 0;
        } else {
          const dx = c.tx - c.x;
          const dy = c.ty - c.y;
          const d = Math.hypot(dx, dy);
          if (d < 2) {
            c.pause = this.rng.range(indoorPause[0], indoorPause[1]);
            this.routine.pickIndoorTarget(c);
            speed = 0;
          } else {
            c.dirX = dx / d;
            c.dirY = dy / d;
            speed *= indoorSpeedFactor;
          }
        }
      } else {
        c.turnCooldown -= dt;
        c.decisionTimer -= dt;
        if (this.zombies !== null && this.zombies.steer(c)) {
          // Chasse (zombie), fuite ou attaque (humain).
          if (c.threat !== null && !c.fighter) speed *= panicBoost;
        } else if (c.field !== null && c.field.steer(c)) {
          // Direction donnée par le champ de flux vers la destination.
        } else if (c.decisionTimer <= 0) {
          this.behavior.decide(c);
          c.decisionTimer += this.behavior.nextDecisionDelay();
        }
      }

      let fx = 0;
      let fy = 0;
      const count = grid.query(c.x, c.y, neighbors);
      for (let k = 0; k < count; k++) {
        const j = neighbors[k];
        if (j === i) continue;
        const o = citizens[j];
        if (o.place !== c.place) continue; // un mur les sépare
        const dx = c.x - o.x;
        const dy = c.y - o.y;
        // Les prudents gardent plus de distance (asymétrique : c'est eux qui s'écartent).
        const minDist = c.radius + o.radius + cfg.separationPadding + c.extraSpace;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) continue;

        if (d2 < 1e-6) {
          // Superposition exacte : poussée arbitraire mais déterministe.
          fx += i < j ? 1 : -1;
          continue;
        }
        const d = Math.sqrt(d2);
        const s = 1 - d / minDist;
        fx += (dx / d) * s;
        fy += (dy / d) * s;

        // Deux agents qui se font face : chacun se décale sur sa droite.
        if (c.dirX * o.dirX + c.dirY * o.dirY < -0.5) {
          fx += -c.dirY * s * cfg.passRightBias;
          fy += c.dirX * s * cfg.passRightBias;
        }
      }

      c.vx += (c.dirX * speed - c.vx) * steer + fx * cfg.separationStrength * dt;
      c.vy += (c.dirY * speed - c.vy) * steer + fy * cfg.separationStrength * dt;

      const maxSpeed = c.speed * c.speedFactor * cfg.maxSpeedFactor;
      const v2 = c.vx * c.vx + c.vy * c.vy;
      if (v2 > maxSpeed * maxSpeed) {
        const k = maxSpeed / Math.sqrt(v2);
        c.vx *= k;
        c.vy *= k;
      }
    }

    // --- Passe 2 : intégration + collisions
    const city = this.city;
    const nearby = this.buildingBuffer;
    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      if (!c.alive) continue;
      c.x += c.vx * dt;
      c.y += c.vy * dt;

      if (c.place >= 0) {
        this.keepInside(c, buildings[c.place]);
        continue;
      }

      for (let pass = 0; pass < COLLISION_PASSES; pass++) {
        const count = city.getBuildingsNear(c.x, c.y, c.radius, nearby);
        let hit = false;
        for (let k = 0; k < count; k++) {
          if (resolveCircleRect(c, nearby[k])) hit = true;
        }
        if (!hit) break;
      }
      clampToBounds(c, city.width, city.height);

      const stuckSpeed = c.speed * c.speedFactor * cfg.stuckSpeedRatio;
      if (c.vx * c.vx + c.vy * c.vy < stuckSpeed * stuckSpeed) c.stuckTimer += dt;
      else c.stuckTimer = 0;
    }
  }

  /** Les murs d'un bâtiment, vus de l'intérieur. */
  keepInside(c, b) {
    const r = c.radius;
    const minX = b.x + r;
    const maxX = b.x + b.w - r;
    const minY = b.y + r;
    const maxY = b.y + b.h - r;
    if (c.x < minX) { c.x = minX; if (c.vx < 0) c.vx = 0; }
    else if (c.x > maxX) { c.x = maxX; if (c.vx > 0) c.vx = 0; }
    if (c.y < minY) { c.y = minY; if (c.vy < 0) c.vy = 0; }
    else if (c.y > maxY) { c.y = maxY; if (c.vy > 0) c.vy = 0; }
  }
}
