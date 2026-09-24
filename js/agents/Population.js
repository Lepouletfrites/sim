import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { SpatialHashGrid } from '../core/SpatialHashGrid.js';
import { resolveCircleRect, clampToBounds } from '../physics/Collision.js';
import { Citizen } from './Citizen.js';
import { WanderBehavior } from './WanderBehavior.js';

const COLLISION_PASSES = 2;

/**
 * Ensemble des habitants et pas physique.
 *
 * Chaque pas fixe (1/60 s) :
 *  1. reconstruit la grille spatiale (O(N))
 *  2. décisions lentes pour les agents dont la minuterie est échue (multi-tick)
 *  3. séparation entre voisins proches (cases 3x3 uniquement) + pilotage
 *  4. intégration des positions et collisions contre les bâtiments
 */
export class Population {
  constructor(city, seed) {
    this.city = city;
    this.rng = new Random(seed ^ 0xa5a5a5a5);
    this.citizens = [];
    this.nextId = 0;
    this.behavior = new WanderBehavior(city, this.rng);
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
      this.behavior.initialize(citizen);
      this.citizens.push(citizen);
    }
    if (this.citizens.length > count) this.citizens.length = count;
  }

  step(dt) {
    const cfg = CONFIG.citizens;
    const citizens = this.citizens;
    const n = citizens.length;
    const grid = this.grid;
    const neighbors = this.neighborBuffer;

    grid.clear();
    for (let i = 0; i < n; i++) grid.insert(i, citizens[i].x, citizens[i].y);

    // --- Passe 1 : décisions + forces -> vitesses
    const steer = Math.min(1, cfg.steering * dt);
    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      c.px = c.x;
      c.py = c.y;

      c.turnCooldown -= dt;
      c.decisionTimer -= dt;
      if (c.decisionTimer <= 0) {
        this.behavior.decide(c);
        c.decisionTimer += this.behavior.nextDecisionDelay();
      }

      let fx = 0;
      let fy = 0;
      const count = grid.query(c.x, c.y, neighbors);
      for (let k = 0; k < count; k++) {
        const j = neighbors[k];
        if (j === i) continue;
        const o = citizens[j];
        const dx = c.x - o.x;
        const dy = c.y - o.y;
        const minDist = c.radius + o.radius + cfg.separationPadding;
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

      const desiredVx = c.dirX * c.speed;
      const desiredVy = c.dirY * c.speed;
      c.vx += (desiredVx - c.vx) * steer + fx * cfg.separationStrength * dt;
      c.vy += (desiredVy - c.vy) * steer + fy * cfg.separationStrength * dt;

      const maxSpeed = c.speed * cfg.maxSpeedFactor;
      const v2 = c.vx * c.vx + c.vy * c.vy;
      if (v2 > maxSpeed * maxSpeed) {
        const k = maxSpeed / Math.sqrt(v2);
        c.vx *= k;
        c.vy *= k;
      }
    }

    // --- Passe 2 : intégration + collisions
    const city = this.city;
    const buildings = this.buildingBuffer;
    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      c.x += c.vx * dt;
      c.y += c.vy * dt;

      for (let pass = 0; pass < COLLISION_PASSES; pass++) {
        const count = city.getBuildingsNear(c.x, c.y, c.radius, buildings);
        let hit = false;
        for (let k = 0; k < count; k++) {
          if (resolveCircleRect(c, buildings[k])) hit = true;
        }
        if (!hit) break;
      }
      clampToBounds(c, city.width, city.height);

      const stuckSpeed = c.speed * cfg.stuckSpeedRatio;
      if (c.vx * c.vx + c.vy * c.vy < stuckSpeed * stuckSpeed) c.stuckTimer += dt;
      else c.stuckTimer = 0;
    }
  }
}
