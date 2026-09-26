import { CONFIG } from '../config.js';
import { resolveCircleRect, clampToBounds } from '../physics/Collision.js';
import { PlaceType } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/ZombieState.js';

const RADIUS = 3.5;
const CHASE_RANGE = 140; // px : un suspect recherché repéré dans la rue est pris en chasse

/**
 * Police de proximité : des patrouilles (effectif réglable) sillonnent les points
 * chauds (lieux des derniers délits, bars et banques la nuit), foncent sur les
 * alarmes (braquages), prennent en chasse les suspects recherchés qu'elles croisent
 * et les interpellent au contact. Leur simple présence dissuade.
 */
export class CrimePolice {
  constructor(crime) {
    this.crime = crime;
    this.city = crime.city;
    this.population = crime.population;
    this.rng = crime.rng;
    this.buffer = new Int32Array(512);
    this.buildingBuffer = [];
    this.units = [];
  }

  reset() {
    this.units = [];
  }

  /** Aucun délit à portée de vue d'une patrouille. */
  near(x, y, range) {
    const r2 = range * range;
    for (const u of this.units) if ((u.x - x) ** 2 + (u.y - y) ** 2 < r2) return true;
    return false;
  }

  // ------------------------------------------------------------------ Tick

  tick(dt) {
    this.adjustCount();
    const crime = this.crime;
    const citizens = this.population.citizens;
    const now = crime.clock.time;
    const alarms = crime.alarms;

    // Qui va où : alarmes d'abord (les plus proches y vont), puis poursuites, puis patrouille.
    const free = [];
    for (const u of this.units) {
      u.chase = null;
      free.push(u);
    }
    for (const alarm of alarms) {
      const wanted = alarm.heist ? free.length : Math.min(free.length, 2);
      free.sort((a, b) => (a.x - alarm.x) ** 2 + (a.y - alarm.y) ** 2 - ((b.x - alarm.x) ** 2 + (b.y - alarm.y) ** 2));
      for (const u of free.splice(0, wanted)) {
        u.goal = alarm.building;
        u.responding = true;
      }
    }
    for (const u of free) {
      u.responding = false;
      u.chase = this.nearestSuspect(u, now);
      if (u.chase === null && (u.goal < 0 || this.arrived(u))) u.goal = this.pickHotspot();
    }

    // Interpellations au contact (dans la rue)
    for (const u of this.units) {
      const count = this.population.grid.query(u.x, u.y, this.buffer);
      for (let k = 0; k < count; k++) {
        const c = citizens[this.buffer[k]];
        if (!c || !c.alive || c.place >= 0 || c.zombie !== ZombieState.HUMAN || c.wantedUntil <= now) continue;
        const reach = c.radius + RADIUS + 6;
        if ((c.x - u.x) ** 2 + (c.y - u.y) ** 2 > reach * reach) continue;
        if (c.robber && this.rng.chance(1 - Math.exp(-CONFIG.crime.shootout * dt))) {
          // Braqueurs armés : ça tire.
          if (this.rng.chance(0.5)) crime.killRobber(c);
          else {
            u.dead = true;
            crime.officerDown(u);
          }
          break;
        }
        if (this.rng.chance(1 - Math.exp(-CONFIG.crime.arrestRate * dt))) {
          crime.arrest(c, 'street');
          break;
        }
      }
    }
    if (this.units.some((u) => u.dead)) this.units = this.units.filter((u) => !u.dead);
  }

  adjustCount() {
    const wanted = this.crime.settings.patrols;
    if (this.units.length > wanted) this.units.length = wanted;
    const station = this.city.policeStation;
    const field = station >= 0 ? this.city.fieldTo(station) : null;
    while (this.units.length < wanted) {
      const p = field ? field.exits[this.units.length % field.exits.length] : this.city.randomSpawnPoint(this.rng, 4);
      this.units.push({
        x: p.x, y: p.y, px: p.x, py: p.y, vx: 0, vy: 0, dirX: 0, dirY: 0,
        radius: RADIUS, goal: -1, chase: null, responding: false, dead: false,
      });
    }
  }

  arrived(u) {
    const field = this.city.fieldTo(u.goal);
    return !field || field.distanceTo(u) <= 12;
  }

  nearestSuspect(u, now) {
    const citizens = this.population.citizens;
    const count = this.population.grid.queryRadius(u.x, u.y, CHASE_RANGE, this.buffer);
    let best = null;
    let bestD2 = CHASE_RANGE * CHASE_RANGE;
    for (let k = 0; k < count; k++) {
      const c = citizens[this.buffer[k]];
      if (!c || !c.alive || c.place >= 0 || c.wantedUntil <= now || c.zombie !== ZombieState.HUMAN) continue;
      const d2 = (c.x - u.x) ** 2 + (c.y - u.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best;
  }

  /** Point chaud : là où ça s'est passé récemment, sinon bars (le soir) et banques. */
  pickHotspot() {
    const city = this.city;
    const heat = this.crime.heat;
    const night = this.crime.clock.hour >= 20 || this.crime.clock.hour < 4;
    let best = -1;
    let bestScore = -1;
    for (let k = 0; k < 8; k++) {
      const b = city.buildings[this.rng.int(0, city.buildings.length - 1)];
      if (city.fieldTo(b.index) === null) continue;
      const lure = b.type === PlaceType.BANK ? 1.5 : b.type === PlaceType.BAR && night ? 2 : b.type === PlaceType.MALL ? 1 : 0.3;
      const score = (lure + 4 * (heat.get(b.index) ?? 0)) * this.rng.range(0.5, 1.5);
      if (score > bestScore) {
        bestScore = score;
        best = b.index;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ Pas physique

  step(dt) {
    const units = this.units;
    if (units.length === 0) return;
    const city = this.city;
    const steer = Math.min(1, 4 * dt);
    const cfg = CONFIG.crime;
    for (const u of units) {
      u.px = u.x;
      u.py = u.y;
      let speed = cfg.unitSpeed * (u.responding || u.chase ? 1.3 : 0.7);
      const c = u.chase;
      if (c !== null && c.alive && c.place < 0) {
        const dx = c.x - u.x;
        const dy = c.y - u.y;
        const d = Math.hypot(dx, dy) || 1;
        u.dirX = dx / d;
        u.dirY = dy / d;
      } else if (u.goal >= 0) {
        const field = city.fieldTo(u.goal);
        if (!field || field.distanceTo(u) <= 10 || !field.steer(u)) speed = 0;
      } else {
        speed = 0;
      }

      let fx = 0;
      let fy = 0;
      for (const o of units) {
        if (o === u) continue;
        const dx = u.x - o.x;
        const dy = u.y - o.y;
        const min = u.radius + o.radius + 4;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        fx += (dx / d) * (1 - d / min);
        fy += (dy / d) * (1 - d / min);
      }
      u.vx += (u.dirX * speed - u.vx) * steer + fx * 110 * dt;
      u.vy += (u.dirY * speed - u.vy) * steer + fy * 110 * dt;
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      for (let pass = 0; pass < 2; pass++) {
        const n = city.getBuildingsNear(u.x, u.y, u.radius, this.buildingBuffer);
        let hit = false;
        for (let k = 0; k < n; k++) if (resolveCircleRect(u, this.buildingBuffer[k])) hit = true;
        if (!hit) break;
      }
      clampToBounds(u, city.width, city.height);
    }
  }
}
