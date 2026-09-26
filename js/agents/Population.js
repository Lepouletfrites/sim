import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { SpatialHashGrid } from '../core/SpatialHashGrid.js';
import { resolveCircleRect, clampToBounds } from '../physics/Collision.js';
import { Citizen } from './Citizen.js';
import { rollTraits, rollHousehold } from './Traits.js';
import { PlaceType } from '../world/PlaceTypes.js';
import { WanderBehavior } from './WanderBehavior.js';
import { ZombieState } from '../zombie/ZombieState.js';

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
    this.cult = null;    // idem
    this.grid = new SpatialHashGrid(
      city.width,
      city.height,
      CONFIG.citizens.gridCellSize,
      CONFIG.citizens.max,
    );
    this.neighborBuffer = new Int32Array(256);
    this.buildingBuffer = [];
    this.households = new Map(); // id -> membres
    this.nextHousehold = 0;
  }

  get count() {
    return this.citizens.length;
  }

  /**
   * Ajoute des foyers entiers (même logement) jusqu'à atteindre `count` ;
   * en réduisant, on retire les derniers arrivés.
   */
  setCount(count) {
    const cfg = CONFIG.citizens;
    const rng = this.rng;
    this.grid.ensureCapacity(count);
    const firstNew = this.citizens.length;

    while (this.citizens.length < count) {
      const home = this.city.pickPlace(PlaceType.HOME, rng);
      const id = this.nextHousehold++;
      const members = [];
      let ages = rollHousehold(rng);
      // Le dernier foyer est tronqué : on garde toujours un adulte avec les enfants.
      const room = count - this.citizens.length;
      if (ages.length > room) ages = ages.filter((a) => a !== 'child').slice(0, room);
      for (const age of ages) {
        const child = age === 'child';
        const radius = child ? rng.range(...cfg.childRadius) : rng.range(cfg.radiusMin, cfg.radiusMax);
        const speed = child ? rng.range(...cfg.childSpeed) : rng.range(cfg.speedMin, cfg.speedMax);
        const { x, y } = this.city.randomSpawnPoint(rng, radius);
        const citizen = new Citizen(this.nextId++, x, y, radius, speed);
        citizen.home = home;
        citizen.household = id;
        rollTraits(citizen, rng, this.city, age);
        this.behavior.initialize(citizen);
        this.citizens.push(citizen);
        members.push(citizen);
        if (this.routine) this.routine.initialize(citizen);
      }
      this.households.set(id, members);
    }
    if (this.citizens.length > firstNew) this.assignFriends(this.citizens.slice(firstNew));
    if (this.citizens.length > count) {
      for (const c of this.citizens.slice(count)) {
        const members = this.households.get(c.household);
        if (members) members.splice(members.indexOf(c), 1);
      }
      this.citizens.length = count;
      const present = new Set(this.citizens);
      for (const c of this.citizens) c.friends = c.friends.filter((f) => present.has(f));
    }
  }

  /**
   * Amitiés (réciproques) : parmi quelques dizaines de candidats tirés au hasard, on
   * garde ceux du même âge, qui habitent près de chez soi, ou qui travaillent
   * (étudient) au même endroit.
   */
  assignFriends(newcomers) {
    const cfg = CONFIG.routine.friends;
    const rng = this.rng;
    const all = this.citizens;
    const buildings = this.city.buildings;
    const ageRank = { child: 0, young: 1, adult: 2, senior: 3 };
    const center = (c) => {
      const b = buildings[c.home];
      return b ? [b.x + b.w / 2, b.y + b.h / 2] : [c.x, c.y];
    };
    for (const c of newcomers) {
      const wanted = rng.int(cfg.count[0], cfg.count[1]);
      if (c.friends.length >= wanted) continue;
      const [cx, cy] = center(c);
      const scored = [];
      for (let k = 0; k < cfg.sample; k++) {
        const o = all[rng.int(0, all.length - 1)];
        if (o === c || o.household === c.household || c.friends.includes(o) || o.friends.length >= cfg.max) continue;
        const gap = Math.abs(ageRank[o.age] - ageRank[c.age]);
        if ((c.age === 'child') !== (o.age === 'child')) continue; // les enfants entre eux
        const [ox, oy] = center(o);
        const near = 1 / (1 + Math.hypot(ox - cx, oy - cy) / 200);
        const together = c.work >= 0 && c.work === o.work ? 2 : 0;
        scored.push([o, (gap === 0 ? 2 : gap === 1 ? 1 : 0.2) + 2 * near + together + rng.next()]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      for (const [o] of scored) {
        if (c.friends.length >= wanted) break;
        if (c.friends.includes(o)) continue;
        c.friends.push(o);
        o.friends.push(c);
      }
    }
  }

  /** Membres du foyer de l'habitant (lui compris). */
  householdOf(c) {
    return this.households.get(c.household) ?? [c];
  }

  step(dt) {
    const cfg = CONFIG.citizens;
    const { indoorSpeedFactor, indoorPause } = CONFIG.routine;
    const { panicBoost, indoorChase } = CONFIG.zombie;
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
        if (this.zombies !== null && this.zombies.steer(c)) {
          // Zombie qui traque dans la pièce, ou humain qui s'enfuit / se défend.
          speed *= c.zombie === ZombieState.ZOMBIE ? indoorChase : indoorSpeedFactor * 3;
        } else if (c.pause > 0) {
          // Flânerie intérieure : aller à un point, s'y arrêter, repartir.
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
        } else if (c.prey !== null && this.cult !== null && this.cult.steer(c)) {
          // Fanatique qui suit un passant dans la nuit.
        } else if (c.mark !== null && c.mark.alive && c.mark.place < 0) {
          // Voleur qui file sa victime.
          const dx = c.mark.x - c.x;
          const dy = c.mark.y - c.y;
          const d = Math.hypot(dx, dy);
          if (d > 1e-6) {
            c.dirX = dx / d;
            c.dirY = dy / d;
          }
        } else if (c.hold) {
          speed = 0; // prêche, écoute, attroupement devant la cible d'un raid
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
      // Les barricades de rue n'arrêtent que les zombies.
      if (c.zombie === ZombieState.ZOMBIE && this.zombies !== null) this.zombies.response.collideWalls(c, dt);
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
