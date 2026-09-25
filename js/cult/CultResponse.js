import { CONFIG } from '../config.js';
import { resolveCircleRect, clampToBounds } from '../physics/Collision.js';
import { SourceField } from '../world/NavigationField.js';
import { ZombieState } from '../zombie/ZombieState.js';

const UNIT_RADIUS = { police: 3.5, firefighter: 4 };

/**
 * Secours face aux sectes :
 *  - Police : dès que l'insécurité dépasse son seuil, des agents quittent le commissariat
 *    et interpellent les fanatiques qui traînent dehors la nuit (raids, rôdes).
 *    Quand une secte accumule trop de méfaits, descente au QG : on embarque tout le monde.
 *  - Pompiers : partent de la caserne vers les incendies et les éteignent sur place.
 */
export class CultResponse {
  constructor(cult) {
    this.cult = cult;
    this.city = cult.city;
    this.population = cult.population;
    this.clock = cult.clock;
    this.settings = cult.settings;
    this.rng = cult.rng;
    this.field = new SourceField(this.city.navGrid);
    this.buffer = new Int32Array(512);
    this.buildingBuffer = [];
    this.targets = [];
    this.reset();
  }

  reset() {
    this.units = [];
    this.police = { deployed: false, sent: 0, arrests: 0, lost: 0 };
    this.firefighters = { sent: 0 };
    this.raidOrder = null; // { cult, building }
  }

  count(kind) {
    let n = 0;
    for (const u of this.units) if (u.kind === kind) n++;
    return n;
  }

  // ------------------------------------------------------------------ Tick

  tick(dt) {
    this.tickPolice(dt);
    this.tickFirefighters(dt / CONFIG.time.secondsPerHour);
    if (this.units.some((u) => u.dead)) this.units = this.units.filter((u) => !u.dead);
  }

  /** Fanatiques visibles dans la rue : en raid ou en train de rôder. */
  collectTargets() {
    const list = this.targets;
    list.length = 0;
    const now = this.clock.time;
    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN || c.place >= 0 || c.jailUntil > now) continue;
      if (c.activity === 'raid' || c.activity === 'prowl') list.push(c);
    }
    return list;
  }

  tickPolice(dt) {
    const s = this.settings;
    const cult = this.cult;
    const cfg = CONFIG.cult;
    const targets = this.collectTargets();

    // Descente au QG d'une secte qui accumule les méfaits
    if (this.raidOrder && cult.cults[this.raidOrder.cult.id].hq !== this.raidOrder.building) this.raidOrder = null;
    if (!this.raidOrder && s.raidOn && s.policeOn) {
      const guilty = cult.cults
        .filter((k) => !k.dissolved && k.hq >= 0 && k.incidents >= s.raidThreshold)
        .sort((a, b) => b.incidents - a.incidents)[0];
      if (guilty) this.orderRaid(guilty);
    }

    const wanted = s.policeOn && cult.anyActive && (cult.insecurity >= s.policeThreshold || this.raidOrder !== null);
    if (wanted && !this.police.deployed) this.deployPolice();
    if (this.police.deployed && !wanted && targets.length === 0 && cult.insecurity < s.policeThreshold * 0.6) {
      this.units = this.units.filter((u) => u.kind !== 'police');
      this.police.deployed = false;
      cult.log('Le calme revient : la police lève son dispositif.', 'good');
      return;
    }
    if (!this.police.deployed) return;

    this.field.update(targets);
    const citizens = this.population.citizens;
    const grid = this.population.grid;
    let atDoor = 0;
    // Personne à interpeller : on surveille le QG de la secte la plus remuante.
    const watched = cult.cults
      .filter((k) => !k.dissolved && k.hq >= 0)
      .sort((a, b) => b.incidents - a.incidents)[0];

    for (const u of this.units) {
      if (u.kind !== 'police') continue;
      if (this.raidOrder) {
        u.goal = this.raidOrder.building;
        const field = this.city.fieldTo(u.goal);
        if (field && field.distanceTo(u) <= 14) atDoor++;
        continue;
      }
      u.goal = targets.length === 0 && watched ? watched.hq : -1;

      // Interpellations au contact (le fanatique se débat parfois)
      const count = grid.query(u.x, u.y, this.buffer);
      for (let k = 0; k < count; k++) {
        const z = citizens[this.buffer[k]];
        if (!z || !targets.includes(z)) continue;
        const reach = z.radius + u.radius + 6;
        if ((z.x - u.x) ** 2 + (z.y - u.y) ** 2 > reach * reach) continue;
        if (this.rng.chance(1 - Math.exp(-cfg.resistRate * s.violence * dt))) {
          u.dead = true;
          this.police.lost++;
          cult.marks.push({ x: u.x, y: u.y, age: 0 });
          cult.logThrottled('cop-down', 6, 'Un policier est grièvement blessé lors d\'une interpellation.', 'bad');
          break;
        }
        if (this.rng.chance(1 - Math.exp(-cfg.arrestRate * dt))) {
          const [min, max] = cfg.jailTime;
          cult.jail(z, this.rng.range(min, max));
          this.police.arrests++;
          cult.logThrottled('arrest', 3, 'La police interpelle des fanatiques en pleine nuit.', 'good');
          break;
        }
      }
    }

    if (this.raidOrder && atDoor >= Math.min(2, this.count('police'))) {
      const { cult: target } = this.raidOrder;
      this.raidOrder = null;
      cult.policeRaid(target);
    }
  }

  orderRaid(target) {
    if (target.hq < 0) return false;
    this.raidOrder = { cult: target, building: target.hq };
    if (!this.police.deployed) this.deployPolice();
    this.cult.log(`Le parquet ordonne une descente au QG de « ${target.name} ».`, 'good');
    return true;
  }

  deployPolice() {
    const count = this.settings.policeCount;
    this.spawnAt('police', this.city.policeStation, count);
    this.police.deployed = true;
    this.police.sent += count;
    this.cult.log(`Insécurité : ${count} policiers patrouillent pour contenir les fanatiques.`, 'good');
  }

  tickFirefighters(hours) {
    const s = this.settings;
    const fires = this.cult.fires;
    if (!s.firefightersOn || fires.burning.size === 0) {
      if (this.count('firefighter') > 0) this.units = this.units.filter((u) => u.kind !== 'firefighter');
      return;
    }
    const missing = s.firefighterCount - this.count('firefighter');
    if (missing > 0) {
      this.spawnAt('firefighter', this.city.fireStation, missing);
      this.firefighters.sent += missing;
      this.cult.logThrottled('trucks', 6, 'Les pompiers quittent la caserne.', 'good');
    }

    // Chaque équipe prend le feu le plus proche, en se répartissant entre les foyers.
    const load = new Map();
    const buildings = this.city.buildings;
    for (const u of this.units) {
      if (u.kind !== 'firefighter') continue;
      if (!fires.burning.has(u.goal)) {
        let best = -1;
        let bestScore = Infinity;
        for (const index of fires.burning) {
          const b = buildings[index];
          const score = Math.hypot(b.x + b.w / 2 - u.x, b.y + b.h / 2 - u.y) + 120 * (load.get(index) ?? 0);
          if (score < bestScore) {
            bestScore = score;
            best = index;
          }
        }
        u.goal = best;
      }
      load.set(u.goal, (load.get(u.goal) ?? 0) + 1);
      const field = this.city.fieldTo(u.goal);
      u.spraying = !!field && field.distanceTo(u) <= 16;
      if (u.spraying) fires.douse(u.goal, CONFIG.cult.extinguishRate * hours);
    }
  }

  spawnAt(kind, building, count) {
    const field = building >= 0 ? this.city.fieldTo(building) : null;
    for (let i = 0; i < count; i++) {
      const p = field ? field.exits[i % field.exits.length] : this.city.randomSpawnPoint(this.rng, 4);
      const x = p.x + this.rng.range(-2, 2);
      const y = p.y + this.rng.range(-2, 2);
      this.units.push({
        kind, x, y, px: x, py: y, vx: 0, vy: 0, dirX: 0, dirY: 0,
        radius: UNIT_RADIUS[kind], goal: -1, spraying: false, dead: false,
      });
    }
  }

  // ------------------------------------------------------------ Pas physique

  step(dt) {
    const units = this.units;
    if (units.length === 0) return;
    const city = this.city;
    const steer = Math.min(1, 4 * dt);
    const speedBase = CONFIG.cult.unitSpeed;

    for (const u of units) {
      u.px = u.x;
      u.py = u.y;
      let speed = speedBase;
      if (u.goal >= 0) {
        const field = city.fieldTo(u.goal);
        if (!field || field.distanceTo(u) <= (u.kind === 'firefighter' ? 12 : 8) || !field.steer(u)) speed = 0;
      } else if (u.kind !== 'police' || !this.field.steer(u)) {
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
