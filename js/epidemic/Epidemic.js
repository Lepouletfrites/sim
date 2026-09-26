import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { Health, Care } from '../agents/Citizen.js';
import { PlaceType, STREET } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/Zombies.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Lieux où l'on peut être contaminé (pour la répartition "où se contamine-t-on"). */
export const CONTAGION_PLACES = [
  PlaceType.HOME, PlaceType.SCHOOL, PlaceType.WORK, PlaceType.MALL, PlaceType.RESTAURANT, PlaceType.BAR,
  PlaceType.NIGHTCLUB, STREET,
];

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
 *  - lieu : nul à l'hôpital, réduit dans la rue, élevé en boîte
 *  - à domicile : seulement entre membres du même foyer, sans condition de distance
 *  - un malade n'est contagieux que les premiers jours de ses symptômes
 *  - infectiosité individuelle très dispersée (superpropagateurs), réduite chez
 *    les asymptomatiques
 *  - masque : réduit l'émission et, dans une moindre mesure, la réception
 *
 * Face aux symptômes, chaque habitant hésite (selon son civisme) puis :
 *  - responsable, forme légère -> quarantaine chez lui
 *  - responsable, forme grave  -> hôpital (létalité fortement réduite)
 *  - irresponsable, légère     -> continue sa vie, travail compris (présentéisme)
 *  - irresponsable, grave      -> alité chez lui, parfois finit par consulter
 * Hôpital saturé : les cas graves restent alités chez eux, sans soins, et
 * prennent un lit dès qu'il s'en libère un.
 *
 * Virulence : augmente à la fois la part de formes graves ET leur létalité.
 * Le risque de décès est réparti tout au long de la maladie (taux horaire),
 * plus faible à l'hôpital, plus fort chez les personnes fragiles.
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

    this.refreshPlaceFactors();

    routine.onEnter = (c, b) => {
      if (b === city.hospitalIndex && c.health === Health.SYMPTOMATIC) {
        const [min, max] = CONFIG.epidemic.treatment;
        c.healthTimer = Math.min(c.healthTimer, this.rng.range(min, max));
        c.illnessDuration = c.healthTimer; // le risque hospitalier s'étale sur le séjour
      }
    };
    // Hôpital plein à l'arrivée : retour à la maison en attendant un lit.
    routine.onRefused = (c, b) => {
      if (b !== city.hospitalIndex) return false;
      this.waitForBed(c);
      return true;
    };

    this.counts = {};
    this.byPlace = {};
    this.news = null; // fil d'actualité (branché par la Simulation)
    this.resetState();
    this.recount();
  }

  log(text, kind = 'info') {
    if (this.news) this.news.push('virus', text, kind);
  }

  /** Moments clés de l'épidémie, publiés dans le fil d'actualité. */
  watchMilestones() {
    const c = this.counts;
    const w = this.watch;
    const active = c.carriers + c.symptomatic;
    const share = active / Math.max(1, c.alive);

    if (active > 0 && !w.wave) {
      w.wave = true;
      w.waves++;
      w.level = 0;
      if (w.waves > 1) this.log(`Nouvelle vague : le virus circule de nouveau (vague n° ${w.waves}).`, 'bad');
    } else if (active === 0 && w.wave) {
      w.wave = false;
      this.log(`Plus aucun cas actif : la vague s'éteint (${c.dead} décès au total).`, 'good');
    }
    const levels = [0.05, 0.15, 0.3];
    while (w.level < levels.length && share >= levels[w.level]) {
      this.log(`${Math.round(levels[w.level] * 100)} % de la ville est infectée.`, 'bad');
      w.level++;
    }

    const full = c.hospitalized + c.toHospital >= this.hospitalCapacity;
    if (full && !w.hospitalFull) {
      w.hospitalFull = true;
      this.log('L\'hôpital est saturé : les cas graves restent alités chez eux, sans soins.', 'bad');
    } else if (!full && w.hospitalFull && c.hospitalized < this.hospitalCapacity * 0.8) {
      w.hospitalFull = false;
      this.log('L\'hôpital respire : des lits se libèrent.', 'good');
    }

    for (const n of [1, 10, 50, 100]) {
      if (c.dead >= n && w.deaths < n) {
        w.deaths = n;
        this.log(n === 1 ? 'Premier décès lié au virus.' : `${n} décès liés au virus.`, 'bad');
      }
    }

    if (this.awareness > 0.5 && !w.worried) {
      w.worried = true;
      this.log('Inquiétude générale : masques, distanciation et confinements volontaires se généralisent.', 'info');
    } else if (this.awareness < 0.2 && w.worried) {
      w.worried = false;
    }
  }

  /** Lits d'hôpital : proportionnels à la population (une petite ville a un petit hôpital). */
  get hospitalCapacity() {
    const cfg = CONFIG.epidemic;
    return Math.max(cfg.minBeds, Math.round(this.population.count * cfg.bedsPerCapita));
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
      this.log('Premier cas : un habitant est contaminé, le virus commence à circuler.', 'bad');
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
    const candidates = this.population.citizens.filter(
      (c) => c.health === Health.SUSCEPTIBLE && c.zombie < ZombieState.ZOMBIE,
    );
    if (candidates.length === 0) return false;
    return this.infectIndexCase(this.rng.pick(candidates));
  }

  /** Infecte l'habitant sain le plus proche du point (x, y), dehors ou dedans. */
  infectAt(x, y, maxDistance) {
    let best = null;
    let bestD2 = maxDistance * maxDistance;
    for (const c of this.population.citizens) {
      if (c.health !== Health.SUSCEPTIBLE || c.zombie >= ZombieState.ZOMBIE) continue;
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
      c.killedBy = '';
      c.healthTimer = 0;
      c.latent = 0;
      c.asymptomatic = false;
      c.severe = false;
      c.care = Care.NONE;
      c.pendingDecision = false;
      c.waitingBed = false;
      c.masked = false;
      c.speedFactor = 1;
      c.extraSpace = 0;
      c.infections = 0;
      c.immuneUntil = Infinity;
      c.testAt = 0;
      c.confirmed = false;
      c.traced = false;
      c.tracedAt = -Infinity;
      c.contactLog = null;
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
    if (this.started) this.watchMilestones();

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
    // Lits libres, en comptant ceux déjà promis aux malades en route.
    this.freeBeds = this.city.hospitalIndex < 0 ? 0
      : this.hospitalCapacity - this.counts.hospitalized - this.counts.toHospital;

    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie >= ZombieState.ZOMBIE) continue;
      c.extraSpace = spacing * c.caution;
      c.masked = c.caution > 1 - maskIntent; // les plus prudents s'y mettent en premier

      if (c.testAt > 0 && now >= c.testAt) this.runTest(c);

      // --- Évolution de la maladie
      if (c.health === Health.RECOVERED) {
        if (now >= c.immuneUntil) {
          c.health = Health.SUSCEPTIBLE; // l'immunité s'est estompée
          this.lostImmunity++;
        }
      } else if (c.health === Health.INCUBATING) {
        c.latent -= hours;
        c.healthTimer -= hours;
        if (c.healthTimer <= 0) {
          if (c.asymptomatic) this.recover(c);
          else this.onSymptoms(c);
        }
      } else if (c.health === Health.SYMPTOMATIC) {
        c.healthTimer -= hours;
        c.contagiousLeft -= hours;
        // Forme grave : risque de décès réparti sur toute la durée de la maladie.
        if (c.severe && rng.chance(this.deathChance(c, hours))) {
          this.die(c);
          continue;
        }
        if (c.healthTimer <= 0) {
          this.recover(c);
          continue;
        }
        if (c.pendingDecision) {
          c.hesitation -= hours;
          if (c.hesitation <= 0) this.decideCare(c);
        }
        // Un lit s'est libéré : le premier malade en attente y va.
        if (c.waitingBed && this.freeBeds > 0) {
          this.freeBeds--;
          c.waitingBed = false;
          c.care = Care.HOSPITAL;
          c.speedFactor = cfg.sickSpeedFactor;
          this.routine.replan(c);
        }
      }

      // --- Confinement volontaire (sains, porteurs qui s'ignorent)
      if (c.care === Care.CONFINED) {
        if (now >= c.careUntil) {
          c.care = Care.NONE;
          c.traced = false;
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

  /** Risque de contagion propre à chaque bâtiment (à refaire si un bâtiment change de type). */
  refreshPlaceFactors() {
    const cfg = CONFIG.places.transmission;
    this.placeFactor = this.city.buildings.map((b) => cfg[b.type] ?? 1);
    this.placeVersion = this.city.version;
  }

  /** Contagion entre personnes proches dans le même lieu. */
  transmit(hours) {
    if (this.placeVersion !== this.city.version) this.refreshPlaceFactors();
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

    const household = CONFIG.places.transmission.household;
    const isolated = CONFIG.places.transmission.isolatedAtHome;
    const visit = CONFIG.places.transmission.visit;
    const tracing = this.settings.tracing;
    const now = this.clock.time;

    for (let i = 0; i < n; i++) {
      const c = citizens[i];
      if (!c.alive || !c.isContagious || c.zombie >= ZombieState.ZOMBIE) continue;
      const own = c.infectivity * (c.asymptomatic ? cfg.asymptomaticInfectivity : 1);

      // À la maison : on contamine son foyer (repas, salle de bains…), à toute distance,
      // un peu moins si l'on s'isole dans sa chambre. Jamais les voisins de palier.
      if (c.place >= 0 && c.place === c.home && household > 0) {
        const dose = household * own * (c.care === Care.QUARANTINE ? isolated : 1);
        for (const o of this.population.householdOf(c)) {
          if (o === c || o.place !== c.place || o.health !== Health.SUSCEPTIBLE || o.zombie >= ZombieState.ZOMBIE) continue;
          if (rng.chance(1 - Math.exp(logKeep * dose))) {
            pending.push(o);
            pendingPlace.push(PlaceType.HOME);
          }
        }
      }

      // Dans un logement, seuls les visiteurs (amis de passage) se contaminent à proximité ;
      // entre voisins de palier, rien.
      const atHome = c.place >= 0 && city.buildings[c.place].type === PlaceType.HOME;
      const placeFactor = c.place < 0 ? streetFactor : atHome ? visit : this.placeFactor[c.place];
      if (placeFactor <= 0 && !tracing) continue;
      const emission = placeFactor * own * (c.masked ? cfg.maskEmission : 1);

      const count = grid.query(c.x, c.y, neighbors);
      for (let k = 0; k < count; k++) {
        const j = neighbors[k];
        if (j >= n) continue;
        const o = citizens[j];
        if (o === c || !o.alive || o.place !== c.place || o.zombie >= ZombieState.ZOMBIE) continue;
        const dx = o.x - c.x;
        const dy = o.y - c.y;
        if (dx * dx + dy * dy >= r2) continue;
        if (tracing) this.logContact(c, o, now, hours);
        if (o.health !== Health.SUSCEPTIBLE || placeFactor <= 0) continue;
        if (atHome && c.place === c.home && o.place === o.home) continue; // deux résidents
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

  // ------------------------------------------------------------ Dépistage et traçage

  /**
   * Carnet de contacts d'un porteur contagieux : qui a-t-il approché, quand, et combien
   * de temps au total (seul un contact prolongé fait un "cas contact").
   */
  logContact(c, o, now, hours) {
    const log = c.contactLog ?? (c.contactLog = new Map());
    const entry = log.get(o);
    if (entry) {
      entry.t = now;
      entry.h += hours;
      return;
    }
    log.set(o, { t: now, h: hours });
    if (log.size > CONFIG.epidemic.tracing.maxContacts) {
      const limit = now - CONFIG.epidemic.tracing.memory;
      for (const [who, e] of log) if (e.t < limit) log.delete(who);
      // Toujours trop : on oublie les plus anciens (ordre d'insertion).
      for (const who of log.keys()) {
        if (log.size <= CONFIG.epidemic.tracing.maxContacts * 0.75) break;
        log.delete(who);
      }
    }
  }

  /** Capacité du laboratoire, proportionnelle à la population. */
  get testsPerDay() {
    const cfg = CONFIG.epidemic.testing;
    return Math.max(cfg.minPerDay, Math.round(this.population.count * cfg.perCapitaPerDay));
  }

  scheduleTest(c) {
    if (c.testAt > 0 || c.confirmed) return;
    c.testAt = this.clock.time + this.rng.range(...CONFIG.epidemic.testing.delay);
    this.testing.pending++;
  }

  /** Résultat d'un test : positif -> isolement et recherche de ses contacts. */
  runTest(c) {
    const t = this.testing;
    if (this.clock.day !== t.day) {
      t.day = this.clock.day;
      t.today = 0;
    }
    if (t.today >= this.testsPerDay) {
      c.testAt = this.clock.time + CONFIG.epidemic.testing.backlogDelay; // labo saturé
      t.saturated = true;
      if (this.watch.labDay !== t.day) {
        this.watch.labDay = t.day;
        this.log('Laboratoire saturé : les résultats des tests prennent du retard.', 'bad');
      }
      return;
    }
    t.today++;
    t.done++;
    t.pending = Math.max(0, t.pending - 1);
    c.testAt = 0;
    const positive = (c.health === Health.INCUBATING && c.latent <= 0) || c.health === Health.SYMPTOMATIC;
    if (!positive) return;
    t.confirmed++;
    c.confirmed = true;
    // Un porteur sans symptômes qui se sait positif s'isole (s'il est civique).
    if (c.health === Health.INCUBATING && this.complies(c) && (c.care === Care.NONE || c.care === Care.CONFINED)) {
      c.care = Care.QUARANTINE;
      this.routine.replan(c);
    }
    this.trace(c);
  }

  /** Nouvelle durée d'immunité : recalcule la fin de protection des guéris. */
  rescheduleImmunity() {
    const days = this.settings.immunity;
    const now = this.clock.time;
    for (const c of this.population.citizens) {
      if (c.health !== Health.RECOVERED) continue;
      c.immuneUntil = days > 0 ? now + days * 24 * this.rng.range(0.3, 1) : Infinity;
    }
  }

  complies(c) {
    return c.civism > 1 - this.settings.responsibility;
  }

  /** Cas contacts : le foyer et les personnes croisées de près ces derniers jours. */
  trace(c) {
    const now = this.clock.time;
    const cfg = CONFIG.epidemic.tracing;
    const contacts = new Set(this.population.householdOf(c));
    if (c.contactLog) {
      for (const [o, e] of c.contactLog) if (now - e.t <= cfg.memory && e.h >= cfg.minExposure) contacts.add(o);
      c.contactLog.clear();
    }
    contacts.delete(c);
    for (const o of contacts) {
      if (!o.alive || o.zombie >= ZombieState.ZOMBIE || o.tracedAt > now - 24) continue;
      o.tracedAt = now;
      this.testing.contacts++;
      this.scheduleTest(o);
      if (!this.complies(o) || o.care !== Care.NONE) continue;
      o.care = Care.CONFINED;
      o.careUntil = now + cfg.quarantine;
      o.traced = true;
      this.routine.replan(o);
    }
  }

  // ------------------------------------------------------------ Transitions

  onSymptoms(c) {
    const cfg = CONFIG.epidemic;
    const range = ([min, max]) => this.rng.range(min, max);
    c.health = Health.SYMPTOMATIC;
    // Une infection passée protège en partie des formes graves.
    const protection = cfg.reinfectionSeverity ** c.infections;
    c.severe = this.rng.chance(clamp01(this.settings.virulence * c.frailty * protection));
    if (this.settings.tracing && this.rng.chance(cfg.testing.chance * (0.5 + 0.5 * c.civism))) this.scheduleTest(c);
    c.healthTimer = range(c.severe ? cfg.severeIllness : cfg.illness);
    c.illnessDuration = c.healthTimer;
    c.contagiousLeft = range(cfg.symptomaticContagious);
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
    if (care === Care.NONE && c.care === Care.CONFINED) return; // déjà confiné : il y reste

    if (care === Care.HOSPITAL) {
      if (this.freeBeds <= 0) {
        this.waitForBed(c); // hôpital saturé (ou inexistant) : alité chez soi
        return;
      }
      this.freeBeds--;
      c.speedFactor = cfg.sickSpeedFactor;
    }
    c.care = care;
    this.routine.replan(c);
  }

  /** Pas de lit disponible : le malade reste alité chez lui, sans soins, en attendant. */
  waitForBed(c) {
    c.care = Care.BEDRIDDEN;
    c.waitingBed = this.city.hospitalIndex >= 0;
    this.routine.replan(c);
  }

  /**
   * Létalité d'une forme grave sur toute la maladie :
   *   (base + pente × virulence) × fragilité, divisée à l'hôpital.
   * Convertie en probabilité sur `hours` (taux horaire constant).
   */
  deathChance(c, hours) {
    const { lethality } = CONFIG.epidemic;
    const frailty = Math.min(lethality.frailtyMax, Math.max(lethality.frailtyMin, 0.6 + 0.3 * c.frailty));
    let total = clamp01((lethality.base + lethality.perVirulence * this.settings.virulence) * frailty);
    if (c.place >= 0 && c.place === this.city.hospitalIndex) total *= lethality.hospitalFactor;
    if (total <= 0) return 0;
    if (total >= 1) total = 0.999;
    return 1 - Math.pow(1 - total, hours / Math.max(1, c.illnessDuration));
  }

  recover(c) {
    c.health = Health.RECOVERED;
    c.infections++;
    c.confirmed = false;
    // Immunité temporaire, plus ou moins durable selon les personnes (0 = à vie).
    const days = this.settings.immunity;
    c.immuneUntil = days > 0 ? this.clock.time + days * 24 * this.rng.range(0.6, 1.4) : Infinity;
    c.healthTimer = 0;
    c.severe = false;
    c.waitingBed = false;
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
    c.waitingBed = false;
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
      'hospitalized', 'quarantined', 'bedridden', 'waitingBed', 'confined', 'severe', 'masked',
      'recovered', 'dead', 'tracedIsolated', 'reinfected',
    ]) counts[key] = 0;
    const byPlace = this.byPlace;
    for (const key of [STREET, ...Object.values(PlaceType)]) byPlace[key] = 0;
    const hospital = this.city.hospitalIndex;

    for (const c of this.population.citizens) {
      if (c.zombie >= ZombieState.ZOMBIE) continue; // zombies et leurs victimes : comptés par Zombies
      if (!c.alive) {
        if (c.killedBy) continue; // victimes des sectes : comptées par Cult
        counts.dead++;
        continue;
      }
      counts.alive++;
      byPlace[this.city.typeOf(c.place)]++;
      if (c.masked) counts.masked++;
      if (c.care === Care.CONFINED) {
        if (c.traced) counts.tracedIsolated++;
        else counts.confined++;
      }
      if (c.infections > 0 && (c.health === Health.INCUBATING || c.health === Health.SYMPTOMATIC)) counts.reinfected++;

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
          else if (c.care === Care.BEDRIDDEN) {
            counts.bedridden++;
            if (c.waitingBed) counts.waitingBed++;
          }
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
    this.lostImmunity = 0;
    this.testing = { done: 0, confirmed: 0, contacts: 0, pending: 0, today: 0, day: -1, saturated: false };
    this.watch = { wave: false, waves: 0, level: 0, hospitalFull: false, deaths: 0, worried: false, labDay: -1 };
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
