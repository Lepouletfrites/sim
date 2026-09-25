import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { Health, Care } from '../agents/Citizen.js';
import { PlaceType, PLACE_LABELS, isOpen } from '../world/PlaceTypes.js';

/** Statut d'un habitant vis-à-vis de l'apocalypse. */
export const ZombieState = Object.freeze({
  HUMAN: 0,
  BITTEN: 1,    // mordu : encore humain, se transformera
  ZOMBIE: 2,
  DESTROYED: 3, // zombie neutralisé (combat, décomposition, frappe)
  DEVOURED: 4,  // humain dévoré
  KILLED: 5,    // civil tué par une frappe aérienne
});

/** Curseurs du mode zombie et leur unité (les % sont stockés en 0..1). */
export const ZOMBIE_SLIDERS = [
  { key: 'biteInfect', unit: '%' },
  { key: 'turnDelay', unit: 'h' },
  { key: 'speed', unit: '%' },
  { key: 'smell', unit: 'px' },
  { key: 'lifespan', unit: 'j' },
  { key: 'defense', unit: '%' },
  { key: 'fighters', unit: '%' },
  { key: 'barricade', unit: '%' },
  { key: 'barricadeStrength', unit: '%' },
  { key: 'research', unit: '%' },
];
export const ZOMBIE_TOGGLES = ['sunFear', 'music', 'fortressHospital'];

/** Valeur interne d'un curseur à partir de sa valeur affichée. */
export const sliderToSetting = (slider, value) => (slider.unit === '%' ? value / 100 : value);

export function defaultZombieSettings() {
  const cfg = CONFIG.zombie;
  const settings = {};
  for (const slider of ZOMBIE_SLIDERS) settings[slider.key] = sliderToSetting(slider, cfg[slider.key].default);
  for (const key of ZOMBIE_TOGGLES) settings[key] = cfg[key];
  return settings;
}

const NOISY_VENUES = [PlaceType.NIGHTCLUB, PlaceType.MALL];

function distanceToRect(x, y, r) {
  const cx = x < r.x ? r.x : x > r.x + r.w ? r.x + r.w : x;
  const cy = y < r.y ? r.y : y > r.y + r.h ? r.y + r.h : y;
  return Math.hypot(x - cx, y - cy);
}

/**
 * Apocalypse zombie, sur la même population que l'épidémie.
 *
 *  Humain ──morsure──┬──> Mordu ──(délai)──> Zombie ──> Neutralisé (combat, décomposition, frappe)
 *                    └──> Dévoré                 └──(remède)──> Humain
 *
 * - Les zombies errent, flairent l'humain le plus proche dans la rue et le
 *   pourchassent. Sans proie, ils rôdent et assiègent les bâtiments occupés.
 * - Les humains fuient ; les survivalistes attaquent. Au contact, chacun a
 *   une chance par seconde de neutraliser l'autre ou d'être mordu.
 * - À l'alerte générale, une partie de la population se barricade chez elle.
 *   Un mordu qui se transforme à l'intérieur déclenche un foyer.
 * - L'hôpital cherche un remède ; une fois prêt, les zombies guérissent peu à peu.
 *
 * Décisions lentes (tick) : cibles, combats, sièges, transformations.
 * Chaque pas physique : simple lecture de la cible (steer), en O(1).
 */
export class Zombies {
  /**
   * @param {object} settings réglages du mode zombie (valeurs 0..1, px, h, jours, booléens)
   * @param {object} policies réglages de la Simulation (fermetures) pour savoir ce qui est ouvert
   */
  constructor(population, city, clock, routine, seed, settings, policies) {
    this.population = population;
    this.city = city;
    this.clock = clock;
    this.routine = routine;
    this.settings = settings;
    this.policies = policies;
    this.rng = new Random(seed ^ 0x1b873593);
    this.buffer = new Int32Array(512);
    this.buildingBuffer = [];
    this.occupants = new Map();
    this.counts = {};
    this.resetState();
    this.recount();
  }

  resetState() {
    this.active = false;
    this.alarm = false;
    this.routine.zombieAlarm = false;
    this.cure = 0;
    this.cureReady = false;
    this.startTime = this.clock.time;
    this.sampleTimer = 0;
    this.sampleInterval = CONFIG.zombie.sampleInterval;
    this.history = [];
    this.historyVersion = (this.historyVersion || 0) + 1;
    this.events = [];
    this.eventsVersion = (this.eventsVersion || 0) + 1;
    this.logged = new Set();
    this.lastLog = {};
    this.marks = [];
    this.effects = [];
    this.totalCured = 0;
  }

  // ------------------------------------------------------------ Actions externes

  /** Transforme un humain au hasard (dans la rue de préférence). */
  releaseZombie() {
    const humans = this.population.citizens.filter((c) => c.alive && c.zombie === ZombieState.HUMAN);
    if (humans.length === 0) return false;
    const outside = humans.filter((c) => c.place < 0);
    const victim = this.rng.pick(outside.length > 0 ? outside : humans);
    const where = this.placeName(victim);
    this.turn(victim);
    this.log(`Patient zéro : un habitant se transforme (${where}).`, 'zombie');
    return true;
  }

  /** Une horde surgit d'un bord de la carte : les passants les plus proches sont transformés. */
  releaseHorde(size = 10) {
    const city = this.city;
    const side = this.rng.int(0, 3);
    const along = this.rng.next();
    const x = side === 0 ? 0 : side === 1 ? city.width : along * city.width;
    const y = side === 2 ? 0 : side === 3 ? city.height : along * city.height;
    const candidates = this.population.citizens
      .filter((c) => c.alive && c.zombie === ZombieState.HUMAN && c.place < 0)
      .sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2))
      .slice(0, size);
    if (candidates.length === 0) return false;
    for (const c of candidates) this.turn(c);
    const edge = ['ouest', 'est', 'nord', 'sud'][side];
    this.log(`Une horde de ${candidates.length} zombies surgit par le ${edge} !`, 'zombie');
    return true;
  }

  /** Transforme l'humain le plus proche du point (x, y), dehors ou dedans. */
  zombieAt(x, y, maxDistance) {
    let best = null;
    let bestD2 = maxDistance * maxDistance;
    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN) continue;
      const d2 = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    if (!best) return false;
    const where = this.placeName(best);
    this.turn(best);
    this.logThrottled('click', 2, `Un zombie apparaît (${where}).`, 'zombie');
    return true;
  }

  /** Frappe aérienne : tout ce qui est dans la rue dans le rayon est touché. Les bâtiments protègent. */
  airStrike(x, y) {
    const r = CONFIG.zombie.strikeRadius;
    let zombies = 0;
    let civilians = 0;
    for (const c of this.population.citizens) {
      if (!c.alive || c.place >= 0) continue;
      if ((c.x - x) ** 2 + (c.y - y) ** 2 > r * r) continue;
      if (c.zombie === ZombieState.ZOMBIE) {
        this.destroy(c);
        zombies++;
      } else {
        this.kill(c, ZombieState.KILLED);
        civilians++;
      }
    }
    this.effects.push({ x, y, r, start: performance.now() });
    this.activate();
    this.log(
      `Frappe aérienne : ${zombies} zombie${zombies > 1 ? 's' : ''} neutralisé${zombies > 1 ? 's' : ''}, ` +
        `${civilians} civil${civilians > 1 ? 's' : ''} tué${civilians > 1 ? 's' : ''}.`,
      civilians > zombies ? 'bad' : 'good',
    );
    this.recount();
  }

  /** Fin de l'apocalypse : tout le monde redevient humain, chez soi. */
  reset() {
    for (const c of this.population.citizens) {
      if (c.zombie >= ZombieState.DESTROYED) {
        c.health = Health.SUSCEPTIBLE;
        c.zombie = ZombieState.HUMAN;
        c.place = -1;
        if (c.home >= 0) this.routine.enter(c, c.home, true);
      } else if (c.zombie !== ZombieState.HUMAN) {
        c.zombie = ZombieState.HUMAN;
      }
      c.speedFactor = c.health === Health.SYMPTOMATIC ? CONFIG.epidemic.sickSpeedFactor : 1;
      c.barricaded = false;
      c.target = null;
      c.threat = null;
      c.musicVenue = -1;
      if (c.alive) this.routine.replan(c);
    }
    this.resetState();
    this.recount();
  }

  // ------------------------------------------------------------ Pilotage (chaque pas)

  /** Direction imposée par l'apocalypse. @returns {boolean} true si la direction a été fixée. */
  steer(c) {
    if (!this.active) return false;

    if (c.zombie === ZombieState.ZOMBIE) {
      const t = c.target;
      if (t !== null && t.alive && t.zombie === ZombieState.HUMAN && t.place < 0) {
        const dx = t.x - c.x;
        const dy = t.y - c.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          c.dirX = dx / d;
          c.dirY = dy / d;
        }
        return true;
      }
      return c.field !== null && c.field.steer(c);
    }

    const z = c.threat;
    if (z === null) return false;
    if (!z.alive || z.zombie !== ZombieState.ZOMBIE) {
      c.threat = null;
      return false;
    }
    const dx = c.x - z.x;
    const dy = c.y - z.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return false;
    const sign = c.fighter ? -1 : 1; // le survivaliste fonce sur le zombie
    c.dirX = (sign * dx) / d;
    c.dirY = (sign * dy) / d;
    return true;
  }

  // ------------------------------------------------------------------ Tick

  tick(dt) {
    if (!this.active) return;
    const cfg = CONFIG.zombie;
    const s = this.settings;
    const hours = dt / CONFIG.time.secondsPerHour;
    const citizens = this.population.citizens;

    // Soleil : léthargiques le jour, déchaînés la nuit.
    const daylight = this.clock.daylight;
    const sunSpeed = s.sunFear ? 1.2 - 0.75 * daylight : 1;
    const sunSmell = s.sunFear ? 1.2 - 0.7 * daylight : 1;
    const env = {
      dt,
      hours,
      speed: s.speed * sunSpeed,
      smell: s.smell * sunSmell,
      noisy: s.music ? this.openNoisyVenues() : null,
    };

    this.buildOccupants();
    for (let i = 0; i < citizens.length; i++) {
      const c = citizens[i];
      if (!c.alive) continue;
      if (c.zombie === ZombieState.ZOMBIE) this.updateZombie(c, env);
      else this.updateHuman(c, hours);
    }

    this.recount();
    this.updateAlarm();
    this.updateResearch(hours);
    this.ageMarks(hours);

    this.sampleTimer += hours;
    if (this.sampleTimer >= this.sampleInterval) {
      this.sampleTimer -= this.sampleInterval;
      this.sample();
    }
  }

  updateHuman(c, hours) {
    const cfg = CONFIG.zombie;
    const s = this.settings;
    c.fighter = c.bravery < s.fighters;

    if (c.zombie === ZombieState.BITTEN) {
      if (this.cureReady) {
        c.zombie = ZombieState.HUMAN;
        this.totalCured++;
      } else {
        c.biteTimer -= hours;
        if (c.biteTimer <= 0) {
          this.turn(c);
          return;
        }
      }
    }

    // Se barricader chez soi à l'alerte (les survivalistes restent dehors).
    const hide = this.alarm && !c.fighter && c.caution > 1 - s.barricade;
    if (hide !== c.barricaded) {
      c.barricaded = hide;
      this.routine.replan(c);
    }

    // Repérer le zombie le plus proche : on le fuit (ou on l'attaque).
    // Avant l'alerte, personne ne sait : les passants se font surprendre.
    c.threat = null;
    if (c.place >= 0 || !this.alarm) return;
    const radius = c.fighter ? Math.max(cfg.fearRadius, s.smell) : cfg.fearRadius;
    c.threat = this.nearest(c, radius, (o) => o.zombie === ZombieState.ZOMBIE);
  }

  updateZombie(z, env) {
    const cfg = CONFIG.zombie;
    const s = this.settings;
    const rng = this.rng;
    z.speedFactor = env.speed;
    z.zombieAge += env.hours;

    if (s.lifespan > 0 && z.zombieAge > s.lifespan * 24 * z.rotFactor) {
      this.destroy(z);
      this.logThrottled('rot', 24, 'Les premiers zombies tombent en poussière.', 'good');
      return;
    }
    if (this.cureReady && rng.chance(1 - Math.exp(-cfg.cureRate * env.hours))) {
      this.cureZombie(z);
      return;
    }

    // Proie la plus proche dans la rue (les mordus ne les intéressent plus).
    z.target = this.nearest(z, env.smell, (o) => o.zombie === ZombieState.HUMAN && o.place < 0);

    // Contacts : combat ou morsure.
    const citizens = this.population.citizens;
    const count = this.population.grid.query(z.x, z.y, this.buffer);
    for (let k = 0; k < count; k++) {
      const h = citizens[this.buffer[k]];
      if (!h || !h.alive || h.zombie !== ZombieState.HUMAN || h.place >= 0) continue;
      const reach = z.radius + h.radius + cfg.contactExtra;
      if ((h.x - z.x) ** 2 + (h.y - z.y) ** 2 > reach * reach) continue;
      if (this.fight(z, h, env.dt)) return; // zombie neutralisé
    }

    // Sans proie : attiré par la musique, et assiège ce qui est occupé.
    if (z.target === null && env.noisy && env.noisy.length > 0) {
      let best = -1;
      let bestD2 = Infinity;
      for (const b of env.noisy) {
        const d2 = (b.x + b.w / 2 - z.x) ** 2 + (b.y + b.h / 2 - z.y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = b.index;
        }
      }
      if (z.musicVenue !== best) {
        z.musicVenue = best;
        z.field = this.city.fieldTo(best);
      }
    } else if (z.musicVenue !== -1) {
      z.musicVenue = -1;
      z.field = null;
    }
    if (z.target === null) this.siege(z, env.hours);
  }

  /** @returns {boolean} true si le zombie a été neutralisé */
  fight(z, h, dt) {
    const cfg = CONFIG.zombie;
    const s = this.settings;
    const defense = s.defense * cfg.defenseRate * (h.fighter ? cfg.fighterDefense : cfg.civilianDefense);
    if (defense > 0 && this.rng.chance(1 - Math.exp(-defense * dt))) {
      this.destroy(z);
      if (h.fighter) this.logThrottled('fighter', 12, 'Des survivalistes repoussent les zombies.', 'good');
      return true;
    }
    const bite = cfg.biteRate * (h.fighter ? 0.6 : 1);
    if (this.rng.chance(1 - Math.exp(-bite * dt))) {
      if (this.rng.chance(s.biteInfect)) this.bite(h);
      else this.kill(h, ZombieState.DEVOURED);
    }
    return false;
  }

  /** Un zombie collé à un bâtiment occupé tente d'enfoncer la barricade. */
  siege(z, hours) {
    const cfg = CONFIG.zombie;
    const s = this.settings;
    const n = this.city.getBuildingsNear(z.x, z.y, z.radius + 8, this.buildingBuffer);
    for (let k = 0; k < n; k++) {
      const b = this.buildingBuffer[k];
      if (distanceToRect(z.x, z.y, b) > z.radius + 8) continue;
      const inside = this.occupants.get(b.index);
      if (!inside || inside.length === 0) continue;
      if (b.index === this.city.hospitalIndex && s.fortressHospital) continue;
      const rate = cfg.breachRate * (1 - s.barricadeStrength);
      if (!this.rng.chance(1 - Math.exp(-rate * hours))) continue;
      const victims = inside.filter((c) => c.zombie === ZombieState.HUMAN);
      if (victims.length === 0) continue;
      this.bite(this.rng.pick(victims));
      this.logThrottled(
        `breach-${b.type}`, 6,
        `Barricade enfoncée (${PLACE_LABELS[b.type].toLowerCase()}) : les zombies entrent !`,
        'bad',
      );
      return;
    }
  }

  // ------------------------------------------------------------ Transitions

  bite(h) {
    h.zombie = ZombieState.BITTEN;
    const delay = this.settings.turnDelay;
    h.biteTimer = delay * this.rng.range(0.6, 1.4);
    if (delay <= 0) this.turn(h);
  }

  turn(c) {
    this.activate();
    const where = c.place;
    c.zombie = ZombieState.ZOMBIE;
    c.zombieAge = 0;
    c.rotFactor = this.rng.range(0.7, 1.3);
    c.barricaded = false;
    c.threat = null;
    c.target = null;
    c.care = Care.NONE;
    c.pendingDecision = false;
    c.masked = false;
    c.extraSpace = 0;
    c.speedFactor = this.settings.speed;

    // Transformation à l'intérieur : les occupants sont pris au piège.
    if (where >= 0) {
      const inside = this.occupants.get(where) ?? [];
      let bitten = 0;
      for (const o of inside) {
        if (o !== c && o.alive && o.zombie === ZombieState.HUMAN && this.rng.chance(CONFIG.zombie.indoorOutbreak)) {
          this.bite(o);
          bitten++;
        }
      }
      if (bitten > 0) {
        const type = this.city.buildings[where].type;
        this.logThrottled(`outbreak-${type}`, 6,
          `Foyer : un mordu se transforme (${PLACE_LABELS[type].toLowerCase()}), ${bitten} personne${bitten > 1 ? 's' : ''} mordue${bitten > 1 ? 's' : ''}.`,
          'bad');
      }
      this.routine.leave(c);
    }
    c.destination = -1;
    c.field = null;
    c.musicVenue = -1;
  }

  destroy(z) {
    this.marks.push({ x: z.x, y: z.y, age: 0, kind: 'zombie' });
    z.zombie = ZombieState.DESTROYED;
    this.remove(z);
  }

  kill(h, state) {
    this.marks.push({ x: h.x, y: h.y, age: 0, kind: 'human' });
    h.zombie = state;
    this.remove(h);
  }

  remove(c) {
    c.health = Health.DEAD;
    c.place = -1;
    c.destination = -1;
    c.field = null;
    c.target = null;
    c.threat = null;
    c.vx = 0;
    c.vy = 0;
  }

  cureZombie(z) {
    z.zombie = ZombieState.HUMAN;
    z.speedFactor = 1;
    z.target = null;
    z.field = null;
    z.musicVenue = -1;
    this.totalCured++;
    this.routine.replan(z);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.startTime = this.clock.time;
    this.recount();
    this.sample();
  }

  // ------------------------------------------------------------ État global

  updateAlarm() {
    const c = this.counts;
    const cfg = CONFIG.zombie;
    if (!this.alarm && c.zombies >= cfg.alarmThreshold) {
      this.alarm = true;
      this.log('ALERTE GÉNÉRALE : la population se barricade.', 'bad');
    } else if (this.alarm && c.zombies === 0 && c.bitten === 0) {
      this.alarm = false;
      this.log('Plus aucun zombie : fin de l\'alerte, la ville se relève.', 'good');
    }
    this.routine.zombieAlarm = this.alarm;
    for (const n of [25, 100, 250]) {
      if (c.zombies >= n) this.logOnce(`z${n}`, `${n} zombies errent dans les rues.`, 'bad');
    }
    const total = this.population.citizens.length;
    if (c.humans < total / 2) this.logOnce('half', 'La moitié de la population est tombée.', 'bad');
    if (c.humans === 0 && c.bitten === 0) this.logOnce('last', 'Le dernier humain est tombé. La ville appartient aux morts.', 'bad');
  }

  /** Le remède avance tant qu'il reste des humains pour chercher. */
  updateResearch(hours) {
    const s = this.settings;
    if (this.cureReady || !this.alarm || s.research <= 0 || this.city.hospitalIndex < 0) return;
    const share = this.counts.humans / Math.max(1, this.population.citizens.length);
    this.cure = Math.min(1, this.cure + s.research * CONFIG.zombie.researchRate * hours * share);
    if (this.cure >= 0.5) this.logOnce('cure50', 'Recherche : le remède est à moitié prêt.', 'good');
    if (this.cure >= 1) {
      this.cureReady = true;
      this.log('Le remède est prêt ! Les zombies redeviennent humains peu à peu.', 'good');
    }
  }

  buildOccupants() {
    const occupants = this.occupants;
    for (const list of occupants.values()) list.length = 0;
    for (const c of this.population.citizens) {
      if (!c.alive || c.place < 0 || c.zombie > ZombieState.BITTEN) continue;
      let list = occupants.get(c.place);
      if (!list) occupants.set(c.place, (list = []));
      list.push(c);
    }
  }

  openNoisyVenues() {
    const venues = [];
    for (const type of NOISY_VENUES) {
      if (!isOpen(type, this.clock, this.policies)) continue;
      for (const i of this.city.byType[type]) venues.push(this.city.buildings[i]);
    }
    return venues;
  }

  /** Voisin le plus proche (dans la rue) qui vérifie `accept`, dans le rayon. */
  nearest(c, radius, accept) {
    const citizens = this.population.citizens;
    const count = this.population.grid.queryRadius(c.x, c.y, radius, this.buffer);
    let best = null;
    let bestD2 = radius * radius;
    for (let k = 0; k < count; k++) {
      const o = citizens[this.buffer[k]];
      if (!o || o === c || !o.alive || o.place >= 0 || !accept(o)) continue;
      const d2 = (o.x - c.x) ** 2 + (o.y - c.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = o;
      }
    }
    return best;
  }

  ageMarks(hours) {
    const life = CONFIG.zombie.markLife;
    let kept = 0;
    for (const mark of this.marks) {
      mark.age += hours;
      if (mark.age < life) this.marks[kept++] = mark;
    }
    this.marks.length = kept;
  }

  // ------------------------------------------------------------ Statistiques

  recount() {
    const counts = this.counts;
    counts.humans = 0;
    counts.bitten = 0;
    counts.zombies = 0;
    counts.destroyed = 0;
    counts.devoured = 0;
    counts.killed = 0;
    counts.barricaded = 0;
    counts.fighters = 0;
    for (const c of this.population.citizens) {
      switch (c.zombie) {
        case ZombieState.HUMAN:
          if (!c.alive) break;
          counts.humans++;
          if (c.barricaded) counts.barricaded++;
          if (c.fighter) counts.fighters++;
          break;
        case ZombieState.BITTEN: if (c.alive) counts.bitten++; break;
        case ZombieState.ZOMBIE: counts.zombies++; break;
        case ZombieState.DESTROYED: counts.destroyed++; break;
        case ZombieState.DEVOURED: counts.devoured++; break;
        default: counts.killed++;
      }
    }
  }

  sample() {
    const c = this.counts;
    this.history.push({
      t: this.clock.time - this.startTime,
      humans: c.humans,
      bitten: c.bitten,
      zombies: c.zombies,
      lost: c.devoured + c.killed,
    });
    if (this.history.length > CONFIG.zombie.maxSamples) {
      this.history = this.history.filter((_, i) => i % 2 === 0 || i === this.history.length - 1);
      this.sampleInterval *= 2;
    }
    this.historyVersion++;
  }

  // ------------------------------------------------------------ Journal

  log(text, kind = 'info') {
    const clock = this.clock;
    this.events.unshift({ when: `J${clock.day} ${clock.format().split(' ')[1]}`, text, kind });
    if (this.events.length > CONFIG.zombie.maxEvents) this.events.length = CONFIG.zombie.maxEvents;
    this.eventsVersion++;
  }

  logOnce(key, text, kind) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(text, kind);
  }

  /** Au plus un message de ce type toutes les `hours` heures de jeu. */
  logThrottled(key, hours, text, kind) {
    const now = this.clock.time;
    if (now - (this.lastLog[key] ?? -Infinity) < hours) return;
    this.lastLog[key] = now;
    this.log(text, kind);
  }

  placeName(c) {
    return c.place < 0 ? 'dans la rue' : PLACE_LABELS[this.city.buildings[c.place].type].toLowerCase();
  }
}
