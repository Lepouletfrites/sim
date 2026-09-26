import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { Health, Care } from '../agents/Citizen.js';
import { PlaceType, PLACE_LABELS, isOpen } from '../world/PlaceTypes.js';

import { ZombieState } from './ZombieState.js';
import { Response } from './Response.js';

export { ZombieState };

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
  { key: 'supplies', unit: 'j' },
  { key: 'research', unit: '%' },
  { key: 'policeThreshold', unit: '%' },
  { key: 'policeCount', unit: 'n' },
  { key: 'wallThreshold', unit: '%' },
  { key: 'wallCount', unit: 'n' },
  { key: 'armyThreshold', unit: '%' },
  { key: 'armyCount', unit: 'n' },
];
export const ZOMBIE_TOGGLES = ['sunFear', 'music', 'fortressHospital', 'policeOn', 'wallsOn', 'armyOn'];

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
    this.zombiesInside = new Map();
    this.tickId = 0;
    this.counts = {};
    this.share = 0;
    this.response = new Response(this);
    this.resetState();
    this.recount();
  }

  resetState() {
    this.response.reset();
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
    const edge = ['l\'ouest', 'l\'est', 'le nord', 'le sud'][side];
    this.log(`Une horde de ${candidates.length} zombies surgit par ${edge} !`, 'zombie');
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
    const troops = this.response.strike(x, y, r);
    this.effects.push({ x, y, r, start: performance.now() });
    this.activate();
    this.log(
      `Frappe aérienne : ${zombies} zombie${zombies > 1 ? 's' : ''} neutralisé${zombies > 1 ? 's' : ''}, ` +
        `${civilians} civil${civilians > 1 ? 's' : ''} tué${civilians > 1 ? 's' : ''}` +
        (troops > 0 ? `, ${troops} membre${troops > 1 ? 's' : ''} des forces de l'ordre.` : '.'),
      civilians + troops > zombies ? 'bad' : 'good',
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
      c.looting = false;
      c.lootTarget = -1;
      c.fetching = null;
      c.awaitingParent = null;
      c.siegeTarget = -1;
      c.target = null;
      c.threat = null;
      c.musicVenue = -1;
      if (c.alive) this.routine.replan(c);
    }
    for (const b of this.city.buildings) {
      b.siege = 0;
      b.breached = false;
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
      if (t !== null && t.alive && t.zombie === ZombieState.HUMAN && t.place === c.place) {
        const dx = t.x - c.x;
        const dy = t.y - c.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          c.dirX = dx / d;
          c.dirY = dy / d;
        }
        return true;
      }
      return c.place < 0 && c.field !== null && c.field.steer(c);
    }

    const z = c.threat;
    if (z === null) return false;
    if (!z.alive || z.zombie !== ZombieState.ZOMBIE || z.place !== c.place) {
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

  /** Pas physique des forces de l'ordre (appelé à chaque sous-étape). */
  step(dt) {
    if (this.active) this.response.step(dt);
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

    this.tickId++;
    this.buildOccupants();
    for (let i = 0; i < citizens.length; i++) {
      const c = citizens[i];
      if (!c.alive) continue;
      if (c.zombie === ZombieState.ZOMBIE) this.updateZombie(c, env);
      else this.updateHuman(c, hours);
    }
    this.updateBuildings(hours);

    this.recount();
    this.updateAlarm();
    this.response.tick(dt, this.share);
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
    c.fighter = c.age !== 'child' && c.bravery < s.fighters; // les enfants ne chassent pas le zombie

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

    if (c.fetching !== null || c.awaitingParent !== null) this.updateFetch(c);

    // Se barricader chez soi à l'alerte (les survivalistes restent dehors).
    // Les enfants sont gardés à la maison par leurs parents.
    const hide = this.alarm && !c.fighter && (c.age === 'child' || c.caution > 1 - s.barricade);
    if (hide !== c.barricaded) {
      c.barricaded = hide;
      c.looting = false;
      c.lootTarget = -1;
      if (hide) c.supplies = s.supplies * 24 * this.rng.range(0.6, 1.4);
      this.routine.replan(c);
    }
    if (c.barricaded) this.updateSupplies(c, hours);

    // Repérer le zombie le plus proche (dans le même lieu) : on le fuit ou on l'attaque.
    // Avant l'alerte, les passants se font surprendre ; mais un zombie dans le salon, ça se voit.
    c.threat = null;
    if (c.place < 0 && !this.alarm) return;
    if (c.place >= 0 && (this.zombiesInside.get(c.place) ?? 0) === 0) return;
    const radius = c.place >= 0 ? 200 : c.fighter ? Math.max(cfg.fearRadius, s.smell) : cfg.fearRadius;
    c.threat = this.nearest(c, radius, (o) => o.zombie === ZombieState.ZOMBIE);
  }

  /** Vivres des barricadés : une fois épuisés, on sort piller, puis on rentre. */
  updateSupplies(c, hours) {
    const s = this.settings;
    if (!c.looting) {
      c.supplies -= hours;
      if (c.supplies > 0) return;
      const target = this.lootTargetFor(c);
      if (target < 0) {
        c.supplies = 24; // rien à piller : on se rationne
        return;
      }
      c.looting = true;
      c.lootTarget = target;
      const [min, max] = CONFIG.zombie.lootDuration;
      c.lootTimer = this.rng.range(min, max);
      this.routine.replan(c);
      this.logThrottled('loot', 12, `Les vivres manquent : des habitants sortent piller ${this.lootName(target)}.`, 'bad');
    } else if (c.place === c.lootTarget) {
      c.lootTimer -= hours;
      if (c.lootTimer > 0) return;
      c.looting = false;
      c.lootTarget = -1;
      c.supplies = s.supplies * 24 * this.rng.range(0.6, 1.4);
      this.routine.replan(c); // retour à la maison, barricadé
    }
  }

  /** Centre commercial le plus proche du domicile, à défaut un restaurant. */
  lootTargetFor(c) {
    const city = this.city;
    const from = c.home >= 0 ? city.buildings[c.home] : { x: c.x, y: c.y, w: 0, h: 0 };
    for (const type of [PlaceType.MALL, PlaceType.SHOP, PlaceType.RESTAURANT]) {
      let best = -1;
      let bestD2 = Infinity;
      for (const i of city.byType[type]) {
        const b = city.buildings[i];
        const d2 = (b.x + b.w / 2 - from.x - from.w / 2) ** 2 + (b.y + b.h / 2 - from.y - from.h / 2) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  lootName(b) {
    return this.city.buildings[b].type === PlaceType.MALL ? 'le centre commercial' : 'les restaurants';
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

    // Proie la plus proche dans le même lieu (les mordus ne les intéressent plus).
    const range = z.place >= 0 ? 200 : env.smell;
    z.target = this.nearest(z, range, (o) => o.zombie === ZombieState.HUMAN);

    // Contacts : combat ou morsure.
    const citizens = this.population.citizens;
    const count = this.population.grid.query(z.x, z.y, this.buffer);
    for (let k = 0; k < count; k++) {
      const h = citizens[this.buffer[k]];
      if (!h || !h.alive || h.zombie !== ZombieState.HUMAN || h.place !== z.place) continue;
      const reach = z.radius + h.radius + cfg.contactExtra;
      if ((h.x - z.x) ** 2 + (h.y - z.y) ** 2 > reach * reach) continue;
      if (this.fight(z, h, env.dt)) return; // zombie neutralisé
    }

    // À l'intérieur : quand il n'y a plus personne à mordre, on ressort.
    if (z.place >= 0) {
      if (z.target === null) {
        this.routine.leave(z);
        z.siegeTarget = -1;
        z.field = null;
      }
      return;
    }
    if (z.target !== null) return;

    // Sans proie dans la rue : on flaire les humains cachés dans les bâtiments…
    if (this.chooseSiege(z, env.smell * cfg.occupiedSmell)) {
      this.siege(z, env.hours);
      return;
    }

    // … ou, à défaut, on suit la musique.
    if (env.noisy && env.noisy.length > 0) {
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
  }

  /** Garde (ou choisit) le bâtiment occupé le plus proche à assiéger. @returns {boolean} */
  chooseSiege(z, range) {
    const fortress = this.settings.fortressHospital ? this.city.hospitalIndex : -2;
    const current = z.siegeTarget;
    if (current >= 0 && current !== fortress && this.hasHumans(current)) return true;

    let best = -1;
    let bestD = range;
    for (const [index, list] of this.occupants) {
      if (index === fortress || !list.some((c) => c.zombie === ZombieState.HUMAN)) continue;
      const d = distanceToRect(z.x, z.y, this.city.buildings[index]);
      if (d < bestD) {
        bestD = d;
        best = index;
      }
    }
    if (best < 0) {
      if (current >= 0) {
        z.siegeTarget = -1;
        z.field = null;
      }
      return false;
    }
    z.siegeTarget = best;
    z.field = this.city.fieldTo(best);
    z.musicVenue = -1;
    return true;
  }

  hasHumans(index) {
    const list = this.occupants.get(index);
    return !!list && list.some((c) => c.zombie === ZombieState.HUMAN);
  }

  /** @returns {boolean} true si le zombie a été neutralisé */
  fight(z, h, dt) {
    const cfg = CONFIG.zombie;
    const s = this.settings;
    // Avant l'alerte, même un survivaliste est pris par surprise.
    const ready = h.fighter && this.alarm;
    const surprise = this.alarm ? 1 : cfg.surpriseDefense;
    const shelter = this.alarm && h.place >= 0 ? cfg.shelterDefense : 1;
    // Frapper son conjoint, son enfant ou un ami transformé ? On hésite, souvent trop longtemps.
    const relative = z.household === h.household || h.friends.includes(z);
    if (relative) {
      this.logThrottled('hesitate', 12, 'Face à un proche transformé, un habitant n\'ose pas frapper…', 'bad');
    }
    const defense = s.defense * cfg.defenseRate * surprise * shelter *
      (ready ? cfg.fighterDefense : cfg.civilianDefense) * (relative ? cfg.familyHesitation : 1);
    if (defense > 0 && this.rng.chance(1 - Math.exp(-defense * dt))) {
      this.destroy(z);
      if (ready) this.logThrottled('fighter', 12, 'Des survivalistes repoussent les zombies.', 'good');
      return true;
    }
    const bite = cfg.biteRate * (ready ? 0.6 : 1);
    if (this.rng.chance(1 - Math.exp(-bite * dt))) {
      if (this.rng.chance(s.biteInfect)) this.bite(h);
      else this.kill(h, ZombieState.DEVOURED);
    }
    return false;
  }

  /**
   * Siège : collé au bâtiment, le zombie use la barricade. Plus ils sont nombreux,
   * plus elle cède vite. Une fois l'entrée forcée, les zombies entrent.
   */
  siege(z, hours) {
    const cfg = CONFIG.zombie;
    const b = this.city.buildings[z.siegeTarget];
    if (distanceToRect(z.x, z.y, b) > z.radius + 8) return; // encore en route

    if (!b.breached) {
      b.siege = (b.siege ?? 0) + hours;
      b.siegeTick = this.tickId;
      const threshold = cfg.breachMin + cfg.breachRange * this.settings.barricadeStrength;
      if (b.siege < threshold) return;
      b.breached = true;
      b.sealTimer = 0;
      this.logThrottled(
        `breach-${b.type}`, 6,
        `Les zombies forcent l'entrée (${PLACE_LABELS[b.type].toLowerCase()}) !`,
        'bad',
      );
    }
    this.routine.enter(z, b.index);
    z.siegeTarget = -1;
    z.field = null;
  }

  /** Barricades des bâtiments : réparation sans assaillant, fermeture une fois les zombies partis. */
  updateBuildings(hours) {
    const cfg = CONFIG.zombie;
    for (const b of this.city.buildings) {
      if (b.siege > 0 && b.siegeTick !== this.tickId) {
        b.siege = Math.max(0, b.siege - cfg.siegeDecay * hours);
      }
      if (!b.breached) continue;
      if ((this.zombiesInside.get(b.index) ?? 0) > 0) {
        b.sealTimer = 0;
      } else if ((b.sealTimer += hours) >= cfg.reseal) {
        b.breached = false;
        b.siege = 0;
      }
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

    c.looting = false;
    c.lootTarget = -1;
    c.siegeTarget = -1;
    c.destination = -1;
    c.field = null;
    c.musicVenue = -1;
    c.hold = false;
    c.holdUntil = 0;
    c.raid = null;
    c.prey = null;
    c.jailUntil = 0;
    c.fetching = null;
    c.awaitingParent = null;

    // Transformation à l'intérieur : le zombie reste dans la pièce, avec les occupants.
    if (where >= 0) {
      this.zombiesInside.set(where, (this.zombiesInside.get(where) ?? 0) + 1);
      const others = (this.occupants.get(where) ?? []).filter((o) => o !== c && o.zombie === ZombieState.HUMAN).length;
      if (others > 0) {
        const type = this.city.buildings[where].type;
        this.logThrottled(`outbreak-${type}`, 6,
          `Foyer : un mordu se transforme (${PLACE_LABELS[type].toLowerCase()}), ${others} personne${others > 1 ? 's' : ''} prise${others > 1 ? 's' : ''} au piège.`,
          'bad');
      }
    }
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
    c.fetching = null;
    c.awaitingParent = null;
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
      this.organizeFetch();
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

  /**
   * Alerte : les enfants hors de la maison (école, chez un ami…) attendent sur place
   * qu'un parent vienne les chercher, quitte à traverser une ville infestée.
   */
  organizeFetch() {
    const now = this.clock.time;
    let fetched = 0;
    for (const members of this.population.households.values()) {
      for (const child of members) {
        if (child.age !== 'child' || !child.alive || child.zombie !== ZombieState.HUMAN) continue;
        if (child.place < 0 || child.place === child.home) continue;
        const parent = members.find((m) => m.age !== 'child' && m.alive && m.zombie === ZombieState.HUMAN &&
          m.fetching === null && m.care === Care.NONE && m.jailUntil <= now);
        if (!parent) continue;
        parent.fetching = child;
        child.awaitingParent = parent;
        child.awaitSince = now;
        this.routine.replan(child);
        this.routine.replan(parent);
        fetched++;
      }
    }
    if (fetched > 0) {
      this.log(`Des parents foncent chercher leurs ${fetched > 1 ? `${fetched} enfants` : 'enfant'} à travers la ville.`, 'bad');
    }
  }

  /** Suivi des retrouvailles : parent arrivé, parent perdu, ou attente trop longue. */
  updateFetch(c) {
    const now = this.clock.time;
    if (c.awaitingParent !== null) {
      const p = c.awaitingParent;
      const lost = !p.alive || p.zombie !== ZombieState.HUMAN || p.fetching !== c;
      if (lost || now - c.awaitSince > CONFIG.zombie.fetchTimeout || p.place === c.place) {
        if (!lost && p.place === c.place) {
          p.fetching = null;
          this.logThrottled('reunited', 6, 'Des parents ont retrouvé leur enfant : ils rentrent se barricader ensemble.', 'good');
          this.routine.replan(p);
        }
        c.awaitingParent = null;
        this.routine.replan(c);
      }
    }
    if (c.fetching !== null) {
      const k = c.fetching;
      if (!k.alive || k.zombie !== ZombieState.HUMAN || k.awaitingParent !== c) {
        c.fetching = null;
        this.routine.replan(c);
      }
    }
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

  /** Humains (et nombre de zombies) présents dans chaque bâtiment. */
  buildOccupants() {
    const occupants = this.occupants;
    for (const list of occupants.values()) list.length = 0;
    this.zombiesInside.clear();
    for (const c of this.population.citizens) {
      if (!c.alive || c.place < 0) continue;
      if (c.zombie === ZombieState.ZOMBIE) {
        this.zombiesInside.set(c.place, (this.zombiesInside.get(c.place) ?? 0) + 1);
        continue;
      }
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

  /** Voisin le plus proche, dans le même lieu (rue ou bâtiment), qui vérifie `accept`. */
  nearest(c, radius, accept) {
    const citizens = this.population.citizens;
    const count = this.population.grid.queryRadius(c.x, c.y, radius, this.buffer);
    let best = null;
    let bestD2 = radius * radius;
    for (let k = 0; k < count; k++) {
      const o = citizens[this.buffer[k]];
      if (!o || o === c || !o.alive || o.place !== c.place || !accept(o)) continue;
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
    counts.looting = 0;
    counts.invaded = 0;
    counts.fighters = 0;
    for (const c of this.population.citizens) {
      switch (c.zombie) {
        case ZombieState.HUMAN:
          if (!c.alive) break;
          counts.humans++;
          if (c.looting) counts.looting++;
          else if (c.barricaded) counts.barricaded++;
          if (c.fighter) counts.fighters++;
          break;
        case ZombieState.BITTEN: if (c.alive) counts.bitten++; break;
        case ZombieState.ZOMBIE:
          counts.zombies++;
          if (c.place >= 0) counts.invaded++;
          break;
        case ZombieState.DESTROYED: counts.destroyed++; break;
        case ZombieState.DEVOURED: counts.devoured++; break;
        default: counts.killed++;
      }
    }
    // Part de la population "vivante" (humains, mordus, zombies) passée zombie : pilote la riposte.
    this.share = counts.zombies / Math.max(1, counts.humans + counts.bitten + counts.zombies);
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
    if (this.news) this.news.push('zombies', text, kind);
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
