import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { Health, Care } from '../agents/Citizen.js';
import { PlaceType, STREET } from '../world/PlaceTypes.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Lieux où l'on peut être contaminé (pour la répartition "où se contamine-t-on"). */
export const CONTAGION_PLACES = [STREET, PlaceType.WORK, PlaceType.MALL, PlaceType.RESTAURANT, PlaceType.NIGHTCLUB];

/**
 * Épidémie et réactions humaines. Toutes les durées sont en heures de jeu.
 *
 *  Sain ──contact──> Latence ──> Porteur contagieux ──(asymptomatique)──> Guéri
 *                                        └──> Malade ──┬── léger ──> Guéri
 *                                                      └── grave ──> Guéri ou Décès
 *
 * Transmission : uniquement entre deux personnes proches (< contactRadius) dans
 * le MÊME lieu. Probabilité par heure de contact :
 *   curseur × facteur du lieu × infectiosité de l'émetteur × masques
 *  - lieu : nul à domicile et à l'hôpital, réduit dans la rue, élevé en boîte
 *  - infectiosité individuelle très dispersée (superpropagateurs), réduite chez
 *    les asymptomatiques
 *  - masque : réduit l'émission et, dans une moindre mesure, la réception
 *
 * Face aux symptômes, chaque habitant hésite (selon son civisme) puis :
 *  - responsable, forme légère -> quarantaine chez lui
 *  - responsable, forme grave  -> hôpital (létalité fortement réduite)
 *  - irresponsable, légère     -> continue sa vie, travail compris (présentéisme)
 *  - irresponsable, grave      -> alité chez lui, parfois finit par consulter
 */
export class Epidemic {
  /**
   * @param {object} settings réglages partagés avec la Simulation (valeurs 0..1 + mesures),
   *   lus à chaque tick : un curseur agit immédiatement.
   */
  constructor(population, city, clock, routine, seed, settings) {
    this.population = population;
    this.city = city;
    this.clock = clock;
    this.routine = routine;
    this.settings = settings;
    this.rng = new Random(seed ^ 0x5bd1e995);
    this.neighbors = new Int32Array(256);
    this.pending = [];
    this.pendingPlace = [];

    const cfg = CONFIG.places.transmission;
    this.placeFactor = city.buildings.map((b) => cfg[b.type] ?? 1);

    routine.onEnter = (c, b) => {
      if (b === city.hospitalIndex && c.health === Health.SYMPTOMATIC) {
        const [min, max] = CONFIG.epidemic.treatment;
        c.healthTimer = Math.min(c.healthTimer, this.rng.range(min, max));
      }
    };

    this.counts = {};
    this.byPlace = {};
    this.resetState();
    this.recount();
  }

  get hospitalCapacity() {
    return CONFIG.epidemic.hospitalCapacity;
  }

  /** Part des personnes sorties de la maladie qui en sont mortes. */
  get lethality() {
    const outcomes = this.counts.dead + this.counts.recovered;
    return outcomes > 0 ? this.counts.dead / outcomes : 0;
  }

  // ------------------------------------------------------------ Actions externes

  infect(c, place = null) {
    if (c.health !== Health.SUSCEPTIBLE) return false;
    const cfg = CONFIG.epidemic;
    const range = ([min, max]) => this.rng.range(min, max);
    c.health = Health.INCUBATING;
    c.latent = range(cfg.latent);
    c.asymptomatic = this.rng.chance(cfg.asymptomaticChance);
    c.healthTimer = Math.max(range(cfg.incubation), c.latent + 12);
    // Un asymptomatique reste porteur plus longtemps, sans jamais le savoir.
    if (c.asymptomatic) c.healthTimer = c.latent + range(cfg.asymptomaticCarriage);
    if (place !== null && place in this.infectionsByPlace) this.infectionsByPlace[place]++;
    if (!this.started) {
      this.started = true;
      this.startTime = this.clock.time;
      this.recount();
      this.sample();
    }
    return true;
  }

  /** Patient zéro : contagieux tout de suite pour que l'épidémie démarre visiblement. */
  infectIndexCase(c) {
    if (!this.infect(c)) return false;
    c.latent = 0;
    this.recount();
    return true;
  }

  infectRandom() {
    const candidates = this.population.citizens.filter((c) => c.health === Health.SUSCEPTIBLE);
    if (candidates.length === 0) return false;
    return this.infectIndexCase(this.rng.pick(candidates));
  }

  /** Infecte l'habitant sain le plus proche du point (x, y), dehors ou dedans. */
  infectAt(x, y, maxDistance) {
    let best = null;
    let bestD2 = maxDistance * maxDistance;
    for (const c of this.population.citizens) {
      if (c.health !== Health.SUSCEPTIBLE) continue;
      const d2 = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best ? this.infectIndexCase(best) : false;
  }

  /** Remet tout le monde en bonne santé (les défunts reviennent chez eux). */
  reset() {
    for (const c of this.population.citizens) {
      if (!c.alive && c.home >= 0) this.routine.enter(c, c.home, true);
      c.health = Health.SUSCEPTIBLE;
      c.healthTimer = 0;
      c.latent = 0;
      c.asymptomatic = false;
      c.severe = false;
      c.care = Care.NONE;
      c.pendingDecision = false;
      c.masked = false;
      c.speedFactor = 1;
      c.extraSpace = 0;
      this.routine.replan(c);
    }
    this.resetState();
    this.recount();
  }

  // ------------------------------------------------------------------ Simulation

  /** Appelé à chaque tick lent (dt en secondes simulées). */
  tick(dt) {
    const hours = dt / CONFIG.time.secondsPerHour;
    this.recount();
    this.updateAwareness(hours);
    this.progress(hours);
    this.transmit(hours);
    this.ageDeathMarks(hours);
    this.recount();

    if (this.started) {
      this.sampleTimer += hours;
      if (this.sampleTimer >= this.sampleInterval) {
        this.sampleTimer -= this.sampleInterval;
        this.sample();
      }
    }
  }

  /** Inquiétude collective : malades connus + choc des décès récents, lissée dans le temps. */
  updateAwareness(hours) {
    const cfg = CONFIG.epidemic;
    const c = this.counts;
    this.recentDeaths *= Math.pow(0.5, hours / cfg.deathMemory);
    const known = c.symptomatic + this.recentDeaths * cfg.deathShock;
    const target = clamp01((known / Math.max(1, c.alive)) * cfg.awarenessGain);
    this.awareness += (target - this.awareness) * Math.min(1, hours / cfg.awarenessSmoothing);
    this.routine.awareness = this.awareness;
  }

  progress(hours) {
    const cfg = CONFIG.epidemic;
    const s = this.settings;
    const rng = this.rng;
    const now = this.clock.time;
    const spacing = s.prudence * this.awareness * cfg.maxExtraSpace;
    const maskIntent = clamp01(s.prudence * this.awareness * cfg.maskGain);
    const confineChance = s.prudence * this.awareness * cfg.confineRate * hours;

    for (const c of this.population.citizens) {
      if (!c.alive) continue;
      c.extraSpace = spacing * c.caution;
      c.masked = c.caution > 1 - maskIntent; // les plus prudents s'y mettent en premier

      // --- Évolution de la maladie
      if (c.health === Health.INCUBATING) {
        c.latent -= hours;
        c.healthTimer -= hours;
        if (c.healthTimer <= 0) {
          if (c.asymptomatic) this.recover(c);
          else this.onSymptoms(c);
        }
      } else if (c.health === Health.SYMPTOMATIC) {
        c.healthTimer -= hours;
        if (c.healthTimer <= 0) {
          this.endIllness(c);
          continue;
        }
        if (c.pendingDecision) {
          c.hesitation -= hours;
          if (c.hesitation <= 0) this.decideCare(c);
        }
      }

      // --- Confinement volontaire (sains, porteurs qui s'ignorent)
      if (c.care === Care.CONFINED) {
        if (now >= c.careUntil) {
          c.care = Care.NONE;
          this.routine.replan(c);
        }
      } else if (
        c.care === Care.NONE &&
        (c.health === Health.SUSCEPTIBLE || c.health === Health.INCUBATING) &&
        confineChance > 0 &&
        rng.chance(confineChance * c.caution)
      ) {
        const [min, max] = cfg.confineDuration;
        c.care = Care.CONFINED;
        c.careUntil = now + rng.range(min, max);
        this.routine.replan(c);
      }
    }
  }

  /** Contagion entre personnes proches dans le même lieu. */
  transmit(hours) {
    const beta = Math.min(this.settings.transmission, 0.999);
    if (beta <= 0) return;
    const cfg = CONFIG.epidemic;
    const streetFactor = CONFIG.places.transmission.street;
    const logKeep = Math.log(1 - beta) * hours;
    const r2 = cfg.contactRadius ** 2;
    const citizens = this.population.citizens;
    const n = citizens.length;
    const grid = this.population.grid;
    const neighbors = this.neighbors;
    const pending = this.pending;
    const pendingPlace = this.pendingPlace;
    const rng = this.rng;
    const city = this.city;
    pending.length = 0;
    pendingPlace.length = 0;

    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      if (!c.alive || !c.isContagious) continue;
      const placeFactor = c.place < 0 ? streetFactor : this.placeFactor[c.place];
      if (placeFactor <= 0) continue;
      const emission =
        placeFactor * c.infectivity *
        (c.asymptomatic ? cfg.asymptomaticInfectivity : 1) *
        (c.masked ? cfg.maskEmission : 1);

      const count = grid.query(c.x, c.y, neighbors);
      for (let k = 0; k < count; k++) {
        const j = neighbors[k];
        if (j >= n) continue;
        const o = citizens[j];
        if (o.health !== Health.SUSCEPTIBLE || o.place !== c.place) continue;
        const dx = o.x - c.x;
        const dy = o.y - c.y;
        if (dx * dx + dy * dy >= r2) continue;
        const dose = emission * (o.masked ? cfg.maskReception : 1);
        if (rng.chance(1 - Math.exp(logKeep * dose))) {
          pending.push(o);
          pendingPlace.push(city.typeOf(c.place));
        }
      }
    }
    // Appliqué après coup : un agent contaminé à ce tick ne contamine pas au même tick.
    for (let k = 0; k < pending.length; k++) this.infect(pending[k], pendingPlace[k]);
  }

  // ------------------------------------------------------------ Transitions

  onSymptoms(c) {
    const cfg = CONFIG.epidemic;
    const range = ([min, max]) => this.rng.range(min, max);
    c.health = Health.SYMPTOMATIC;
    c.severe = this.rng.chance(clamp01(this.settings.virulence * c.frailty));
    c.healthTimer = range(c.severe ? cfg.severeIllness : cfg.illness);
    c.speedFactor = c.severe ? cfg.severeSpeedFactor : cfg.sickSpeedFactor;
    // Les plus civiques réagissent vite, les autres temporisent.
    c.pendingDecision = true;
    c.hesitation = (1 - c.civism) * cfg.maxHesitation * this.rng.range(0.5, 1.5);
  }

  decideCare(c) {
    const cfg = CONFIG.epidemic;
    c.pendingDecision = false;
    const responsible = c.civism > 1 - this.settings.responsibility;

    let care = Care.NONE;
    if (responsible) care = c.severe ? Care.HOSPITAL : Care.QUARANTINE;
    else if (c.severe) care = this.rng.chance(cfg.irresponsibleSevereCare) ? Care.HOSPITAL : Care.BEDRIDDEN;
    if (care === Care.HOSPITAL && this.city.hospitalIndex < 0) care = Care.BEDRIDDEN;
    if (care === Care.NONE && c.care === Care.CONFINED) return; // déjà confiné : il y reste

    if (care === Care.HOSPITAL) c.speedFactor = cfg.sickSpeedFactor;
    c.care = care;
    this.routine.replan(c);
  }

  endIllness(c) {
    const cfg = CONFIG.epidemic;
    if (c.severe) {
      const treated = c.place >= 0 && c.place === this.city.hospitalIndex;
      if (this.rng.chance(treated ? cfg.deathHospital : cfg.deathUntreated)) {
        this.die(c);
        return;
      }
    }
    this.recover(c);
  }

  recover(c) {
    c.health = Health.RECOVERED;
    c.healthTimer = 0;
    c.severe = false;
    c.pendingDecision = false;
    c.speedFactor = 1;
    if (c.care !== Care.NONE && c.care !== Care.CONFINED) {
      c.care = Care.NONE;
      this.routine.replan(c);
    }
  }

  die(c) {
    this.deathMarks.push({ x: c.x, y: c.y, age: 0 });
    c.health = Health.DEAD;
    c.care = Care.NONE;
    c.place = -1;
    c.destination = -1;
    c.field = null;
    c.vx = 0;
    c.vy = 0;
    this.recentDeaths++;
  }

  ageDeathMarks(hours) {
    const life = CONFIG.epidemic.deathMarkLife;
    const marks = this.deathMarks;
    let kept = 0;
    for (const mark of marks) {
      mark.age += hours;
      if (mark.age < life) marks[kept++] = mark;
    }
    marks.length = kept;
  }

  // ------------------------------------------------------------ Statistiques

  recount() {
    const counts = this.counts;
    for (const key of [
      'alive', 'susceptible', 'carriers', 'symptomatic', 'sickOut', 'toHospital',
      'hospitalized', 'quarantined', 'bedridden', 'confined', 'severe', 'masked',
      'recovered', 'dead',
    ]) counts[key] = 0;
    const byPlace = this.byPlace;
    for (const key of [STREET, ...Object.values(PlaceType)]) byPlace[key] = 0;
    const hospital = this.city.hospitalIndex;

    for (const c of this.population.citizens) {
      if (!c.alive) {
        counts.dead++;
        continue;
      }
      counts.alive++;
      byPlace[this.city.typeOf(c.place)]++;
      if (c.masked) counts.masked++;
      if (c.care === Care.CONFINED) counts.confined++;

      switch (c.health) {
        case Health.SUSCEPTIBLE: counts.susceptible++; break;
        case Health.INCUBATING: counts.carriers++; break;
        case Health.SYMPTOMATIC:
          counts.symptomatic++;
          if (c.severe) counts.severe++;
          if (c.care === Care.HOSPITAL) {
            if (c.place === hospital) counts.hospitalized++;
            else counts.toHospital++;
          } else if (c.care === Care.QUARANTINE) counts.quarantined++;
          else if (c.care === Care.BEDRIDDEN) counts.bedridden++;
          else counts.sickOut++;
          break;
        default: counts.recovered++;
      }
    }
  }

  resetState() {
    this.started = false;
    this.startTime = this.clock.time;
    this.sampleTimer = 0;
    this.sampleInterval = CONFIG.epidemic.sampleInterval;
    this.history = [];
    this.historyVersion = (this.historyVersion || 0) + 1;
    this.awareness = 0;
    this.routine.awareness = 0;
    this.recentDeaths = 0;
    this.deathMarks = [];
    this.infectionsByPlace = {};
    for (const place of CONTAGION_PLACES) this.infectionsByPlace[place] = 0;
  }

  sample() {
    const c = this.counts;
    this.history.push({
      t: this.clock.time - this.startTime, // heures depuis le début de l'épidémie
      susceptible: c.susceptible,
      infected: c.carriers + c.symptomatic,
      recovered: c.recovered,
      dead: c.dead,
    });
    // Historique borné : on garde une courbe complète en divisant la résolution par 2.
    if (this.history.length > CONFIG.epidemic.maxSamples) {
      this.history = this.history.filter((_, i) => i % 2 === 0 || i === this.history.length - 1);
      this.sampleInterval *= 2;
    }
    this.historyVersion++;
  }
}
