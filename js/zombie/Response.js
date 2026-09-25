import { CONFIG } from '../config.js';
import { resolveCircleRect, clampToBounds } from '../physics/Collision.js';
import { SourceField } from '../world/NavigationField.js';
import { ZombieState } from './ZombieState.js';

const UNIT_NAME = { police: 'policier', army: 'soldat' };
const EDGE_NAME = { west: 'l\'ouest', east: 'l\'est', north: 'le nord', south: 'le sud' };

/**
 * Riposte à l'apocalypse, par paliers selon la part de la population transformée :
 *
 *  1. Police    : des agents partent du commissariat, rejoignent les zombies par
 *                 les rues et tirent à distance. Vulnérables aux morsures.
 *  2. Barricades: les habitants barrent les rues étroites au contact du front,
 *                 là où il y a le plus de monde à protéger. Les zombies s'y
 *                 heurtent et les usent ; les humains passent.
 *  3. Armée     : des soldats entrent par le bord de carte le plus proche de
 *                 l'invasion. Portée, cadence et blindage supérieurs.
 *
 * Toutes les unités suivent un même champ de distances vers les zombies
 * (un seul BFS par tick), et tirent sur le zombie le plus proche en vue.
 */
export class Response {
  constructor(zombies) {
    this.zombies = zombies;
    this.city = zombies.city;
    this.population = zombies.population;
    this.clock = zombies.clock;
    this.settings = zombies.settings;
    this.rng = zombies.rng;
    this.field = new SourceField(this.city.navGrid);
    this.buffer = new Int32Array(512);
    this.buildingBuffer = [];
    this.zombieList = [];
    this.reset();
  }

  reset() {
    this.units = [];
    this.walls = [];
    this.tracers = [];
    this.police = { deployed: false, sent: 0, lost: 0, kills: 0 };
    this.army = { deployed: false, sent: 0, lost: 0, kills: 0, edge: null };
    this.wallState = { deployed: false, built: 0, broken: 0, nextRebuild: 0 };
  }

  get active() {
    return this.units.length > 0 || this.walls.length > 0;
  }

  alive(kind) {
    let n = 0;
    for (const u of this.units) if (u.kind === kind) n++;
    return n;
  }

  // ------------------------------------------------------------------ Tick

  /** Décisions lentes : déclenchements, cibles, tirs, morsures, usure des barricades. */
  tick(dt, share) {
    const s = this.settings;
    const counts = this.zombies.counts;

    if (counts.zombies === 0 && counts.bitten === 0) {
      if (this.active) {
        this.zombies.log('Menace écartée : les forces de l\'ordre se retirent, les barricades sont démontées.', 'good');
      }
      const keep = { police: this.police, army: this.army, walls: this.wallState };
      this.reset();
      // On garde le bilan, mais une nouvelle vague pourra relancer la riposte.
      Object.assign(this.police, keep.police, { deployed: false });
      Object.assign(this.army, keep.army, { deployed: false });
      Object.assign(this.wallState, keep.walls, { deployed: false });
      return;
    }

    if (s.policeOn && !this.police.deployed && counts.zombies > 0 && share >= s.policeThreshold) this.deployPolice();
    if (s.wallsOn && counts.zombies > 0 && share >= s.wallThreshold) this.maintainWalls();
    if (s.armyOn && !this.army.deployed && counts.zombies > 0 && share >= s.armyThreshold) this.deployArmy();

    this.wearWalls();
    if (this.units.length > 0) {
      this.collectZombies();
      this.field.update(this.zombieList);
      this.fight(dt);
    }
  }

  collectZombies() {
    const list = this.zombieList;
    list.length = 0;
    for (const c of this.population.citizens) {
      if (c.alive && c.zombie === ZombieState.ZOMBIE) list.push(c);
    }
  }

  fight(dt) {
    const cfg = CONFIG.zombie;
    const citizens = this.population.citizens;
    const grid = this.population.grid;

    for (const u of this.units) {
      const spec = cfg[u.kind];
      u.target = this.nearestZombie(u, spec.range, true);
      u.chase = u.target ?? this.nearestZombie(u, 160, false);

      // Tir
      if (u.target && this.rng.chance(1 - Math.exp(-spec.fireRate * dt))) {
        this.tracers.push({ x1: u.x, y1: u.y, x2: u.target.x, y2: u.target.y, kind: u.kind, start: performance.now() });
        this.zombies.destroy(u.target);
        this[u.kind].kills++;
        u.target = null;
      }

      // Morsures au corps à corps (le blindage de l'armée protège)
      const count = grid.query(u.x, u.y, this.buffer);
      for (let k = 0; k < count; k++) {
        const z = citizens[this.buffer[k]];
        if (!z || !z.alive || z.zombie !== ZombieState.ZOMBIE) continue;
        const reach = z.radius + u.radius + cfg.contactExtra;
        if ((z.x - u.x) ** 2 + (z.y - u.y) ** 2 > reach * reach) continue;
        if (this.rng.chance(1 - Math.exp(-cfg.biteRate * spec.armor * dt))) {
          u.dead = true;
          this[u.kind].lost++;
          this.zombies.marks.push({ x: u.x, y: u.y, age: 0, kind: 'human' });
          this.zombies.logThrottled(`lost-${u.kind}`, 6, `Un ${UNIT_NAME[u.kind]} est tombé au combat.`, 'bad');
          break;
        }
      }
    }
    if (this.units.some((u) => u.dead)) this.units = this.units.filter((u) => !u.dead);
  }

  nearestZombie(u, range, needSight) {
    const citizens = this.population.citizens;
    const count = this.population.grid.queryRadius(u.x, u.y, range, this.buffer);
    let best = null;
    let bestD2 = range * range;
    for (let k = 0; k < count; k++) {
      const z = citizens[this.buffer[k]];
      if (!z || !z.alive || z.zombie !== ZombieState.ZOMBIE) continue;
      const d2 = (z.x - u.x) ** 2 + (z.y - u.y) ** 2;
      if (d2 >= bestD2) continue;
      if (needSight && !this.lineOfSight(u.x, u.y, z.x, z.y)) continue;
      bestD2 = d2;
      best = z;
    }
    return best;
  }

  /** Pas de tir à travers les bâtiments. */
  lineOfSight(x1, y1, x2, y2) {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(d / 4);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.city.isWalkable(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ Pas physique

  step(dt) {
    const units = this.units;
    if (units.length === 0) return;
    const cfg = CONFIG.zombie;
    const city = this.city;
    const steer = Math.min(1, 4 * dt);

    for (const u of units) {
      const spec = cfg[u.kind];
      u.px = u.x;
      u.py = u.y;
      let speed = spec.speed;

      const t = u.target;
      if (t && t.alive && t.zombie === ZombieState.ZOMBIE && (t.x - u.x) ** 2 + (t.y - u.y) ** 2 < (spec.range * 0.75) ** 2) {
        speed = 0; // à portée : on s'arrête pour tirer
      } else if (!this.field.steer(u)) {
        const c = u.chase;
        if (c && c.alive && c.zombie === ZombieState.ZOMBIE) {
          const dx = c.x - u.x;
          const dy = c.y - u.y;
          const d = Math.hypot(dx, dy) || 1;
          u.dirX = dx / d;
          u.dirY = dy / d;
        } else {
          speed = 0;
        }
      }

      // Garder ses distances avec les collègues
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

  /** Les zombies butent sur les barricades (les humains, eux, passent). */
  collideWalls(z, dt) {
    for (const w of this.walls) {
      const r = z.radius;
      if (z.x + r < w.x || z.x - r > w.x + w.w || z.y + r < w.y || z.y - r > w.y + w.h) continue;
      if (resolveCircleRect(z, w)) w.damage += dt;
    }
  }

  /** Frappe aérienne : les unités dans le rayon sont touchées elles aussi. */
  strike(x, y, r) {
    let hit = 0;
    for (const u of this.units) {
      if ((u.x - x) ** 2 + (u.y - y) ** 2 <= r * r) {
        u.dead = true;
        this[u.kind].lost++;
        hit++;
      }
    }
    if (hit > 0) this.units = this.units.filter((u) => !u.dead);
    return hit;
  }

  // ------------------------------------------------------------ Déploiements

  spawnUnit(kind, x, y) {
    const spec = CONFIG.zombie[kind];
    this.units.push({
      kind, x, y, px: x, py: y, vx: 0, vy: 0, dirX: 0, dirY: 0,
      radius: spec.radius, target: null, chase: null, dead: false,
    });
    this[kind].sent++;
  }

  deployPolice() {
    const count = this.settings.policeCount;
    const station = this.city.policeStation;
    const field = station >= 0 ? this.city.fieldTo(station) : null;
    for (let i = 0; i < count; i++) {
      const p = field ? field.exits[i % field.exits.length] : this.city.randomSpawnPoint(this.rng, 4);
      this.spawnUnit('police', p.x + this.rng.range(-2, 2), p.y + this.rng.range(-2, 2));
    }
    this.police.deployed = true;
    this.zombies.log(`La police intervient : ${count} agents quittent le commissariat.`, 'good');
  }

  /** L'armée arrive par le bord de carte le plus proche du gros de l'invasion. */
  deployArmy() {
    const city = this.city;
    this.collectZombies();
    let cx = city.width / 2;
    let cy = city.height / 2;
    if (this.zombieList.length > 0) {
      cx = this.zombieList.reduce((s, z) => s + z.x, 0) / this.zombieList.length;
      cy = this.zombieList.reduce((s, z) => s + z.y, 0) / this.zombieList.length;
    }
    const edges = [
      ['west', cx], ['east', city.width - cx], ['north', cy], ['south', city.height - cy],
    ].sort((a, b) => a[1] - b[1]);
    const edge = edges[0][0];

    const count = this.settings.armyCount;
    const lane = CONFIG.city.avenueWidth / 2; // l'avenue de ceinture longe tout le bord
    const vertical = edge === 'west' || edge === 'east';
    const span = vertical ? city.height : city.width;
    for (let i = 0; i < count; i++) {
      const along = span * (0.1 + (0.8 * (i + 0.5)) / count);
      const depth = lane + (i % 2) * 8; // deux rangs
      const x = edge === 'west' ? depth : edge === 'east' ? city.width - depth : along;
      const y = edge === 'north' ? depth : edge === 'south' ? city.height - depth : along;
      const p = city.isCircleFree(x, y, 4) ? { x, y } : this.nearestFree(x, y);
      this.spawnUnit('army', p.x, p.y);
    }
    this.army.deployed = true;
    this.army.edge = edge;
    this.zombies.log(`L'armée entre dans la ville par ${EDGE_NAME[edge]} : ${count} soldats.`, 'good');
  }

  nearestFree(x, y) {
    for (let r = 4; r < 80; r += 4) {
      for (let a = 0; a < 8; a++) {
        const px = x + Math.cos((a * Math.PI) / 4) * r;
        const py = y + Math.sin((a * Math.PI) / 4) * r;
        if (this.city.isCircleFree(px, py, 4)) return { x: px, y: py };
      }
    }
    return this.city.randomSpawnPoint(this.rng, 4);
  }

  // ------------------------------------------------------------ Barricades

  maintainWalls() {
    const ws = this.wallState;
    const now = this.clock.time;
    const wanted = this.settings.wallCount;
    if (!ws.deployed) {
      const built = this.buildWalls(wanted);
      ws.deployed = true;
      ws.nextRebuild = now + CONFIG.zombie.wall.rebuildEvery;
      this.zombies.log(`Les habitants barrent les rues : ${built} barricades dressées.`, 'good');
    } else if (now >= ws.nextRebuild) {
      ws.nextRebuild = now + CONFIG.zombie.wall.rebuildEvery;
      const missing = wanted - this.walls.length;
      if (missing > 0) {
        const built = this.buildWalls(missing);
        if (built > 0) this.zombies.log(`${built} barricade${built > 1 ? 's' : ''} reconstruite${built > 1 ? 's' : ''}.`, 'good');
      }
    }
  }

  /**
   * Place jusqu'à `n` barricades en travers des rues étroites, au contact du front :
   * beaucoup d'humains à protéger, des zombies dans les parages, mais pas au pied du mur.
   */
  buildWalls(n) {
    const cfg = CONFIG.zombie.wall;
    const city = this.city;
    const citizens = this.population.citizens;
    const candidates = [];

    for (let tries = 0; tries < 400; tries++) {
      const x = this.rng.range(0, city.width);
      const y = this.rng.range(0, city.height);
      if (!city.isWalkable(x, y)) continue;
      const rect = this.crossSection(x, y);
      if (!rect) continue;

      let humans = 0;
      let zombies = 0;
      let tooClose = false;
      for (const c of citizens) {
        if (!c.alive) continue;
        const d2 = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (c.zombie === ZombieState.ZOMBIE) {
          if (d2 < 30 * 30) {
            tooClose = true;
            break;
          }
          if (d2 < 250 * 250) zombies++;
        } else if (c.zombie === ZombieState.HUMAN && d2 < 120 * 120) {
          humans++;
        }
      }
      if (tooClose) continue;
      const score = zombies > 0 ? humans + 0.5 * zombies : humans * 0.3;
      candidates.push({ rect, x, y, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    let built = 0;
    for (const cand of candidates) {
      if (built >= n) break;
      const clash = this.walls.some((w) => (w.cx - cand.x) ** 2 + (w.cy - cand.y) ** 2 < cfg.spacing ** 2);
      if (clash) continue;
      this.walls.push({ ...cand.rect, cx: cand.x, cy: cand.y, hp: cfg.hp, maxHp: cfg.hp, damage: 0 });
      built++;
    }
    this.wallState.built += built;
    return built;
  }

  /** Segment qui barre la rue en (x, y), ou null si ce n'est pas une rue étroite. */
  crossSection(x, y) {
    const { maxLength, thickness } = CONFIG.zombie.wall;
    const limit = 90;
    const scan = (dx, dy) => {
      let d = 0;
      while (d <= limit && this.city.isWalkable(x + dx * d, y + dy * d)) d += 2;
      return d;
    };
    const left = scan(-1, 0);
    const right = scan(1, 0);
    const up = scan(0, -1);
    const down = scan(0, 1);
    const across = left + right;
    const along = up + down;
    if (across <= maxLength && along >= limit) {
      // Rue nord-sud : barricade horizontale, prolongée jusqu'aux façades
      return { x: x - left - 2, y: y - thickness / 2, w: across + 4, h: thickness };
    }
    if (along <= maxLength && across >= limit) {
      return { x: x - thickness / 2, y: y - up - 2, w: thickness, h: along + 4 };
    }
    return null;
  }

  wearWalls() {
    let broken = 0;
    for (const w of this.walls) {
      w.hp -= w.damage;
      w.damage = 0;
      if (w.hp <= 0) broken++;
    }
    if (broken === 0) return;
    this.walls = this.walls.filter((w) => w.hp > 0);
    this.wallState.broken += broken;
    this.zombies.logThrottled('wall-broken', 4, 'Une barricade de rue a cédé sous la pression des zombies.', 'bad');
  }
}
