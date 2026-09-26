import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { Health } from '../agents/Citizen.js';
import { PlaceType, PLACE_LABELS } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/ZombieState.js';
import { CrimePolice } from './CrimePolice.js';

/** Curseurs de l'onglet Crime et leur unité (les % sont stockés en 0..1). */
export const CRIME_SLIDERS = [
  { key: 'criminality', unit: '%' },
  { key: 'unemployment', unit: '%' },
  { key: 'welfare', unit: '%' },
  { key: 'wages', unit: '%' },
  { key: 'patrols', unit: 'n' },
  { key: 'lighting', unit: '%' },
  { key: 'cameras', unit: '%' },
  { key: 'sentence', unit: 'j' },
  { key: 'bankSecurity', unit: '%' },
];
export const CRIME_TOGGLES = ['bankHeists', 'neighborhoodWatch', 'recidivism'];

export const CRIME_TYPES = ['pickpocket', 'mugging', 'burglary', 'robbery', 'heist'];
export const CRIME_LABELS = {
  pickpocket: 'Vols à la tire',
  mugging: 'Agressions',
  burglary: 'Cambriolages',
  robbery: 'Braquages de commerces',
  heist: 'Braquages de banque',
};

export const crimeSliderToSetting = (slider, value) => (slider.unit === '%' ? value / 100 : value);

export function defaultCrimeSettings() {
  const cfg = CONFIG.crime;
  const settings = {};
  for (const slider of CRIME_SLIDERS) settings[slider.key] = crimeSliderToSetting(slider, cfg[slider.key].default);
  for (const key of CRIME_TOGGLES) settings[key] = cfg[key];
  return settings;
}

const inNight = (h) => h >= 21 || h < 3;
const euros = (v) => `${Math.round(v).toLocaleString('fr-FR')} €`;
/** Lieux où l'on peut braquer la caisse. */
const TILLS = [PlaceType.SHOP, PlaceType.BAR, PlaceType.RESTAURANT];
/** Lieux où l'on peut se faire faire les poches. */
const CROWDS = new Set([PlaceType.MALL, PlaceType.BAR, PlaceType.NIGHTCLUB, PlaceType.RESTAURANT, PlaceType.SHOP, 'street']);

/**
 * Délinquance, sur la même population.
 *
 * Qui : chaque jour, une part des habitants bascule (ou non) dans la délinquance selon
 * la tendance de fond (curseur), son civisme, sa précarité (compte à sec, chômage),
 * les aides sociales et la récidive. Les plus durs (violents) braquent et agressent.
 *
 * Quoi :
 *  - vol à la tire  : dans la foule (centre co., bars, boîte, rue animée)
 *  - agression      : la nuit, un rôdeur file un passant isolé (sortie de bar, distributeur)
 *  - cambriolage    : en journée, un logement vide
 *  - braquage       : la caisse d'une boutique ou d'un bar, en fin de journée
 *  - braquage de banque : un gang de 3 à 5, rarement, avec fusillade possible
 *
 * Qui paie : les victimes (liquide, épargne), les commerces (caisse), les banques (coffre).
 * Riposte : patrouilles, éclairage (moins d'agressions la nuit), vidéosurveillance
 * (identification), peines de prison. L'insécurité vide les rues le soir.
 */
export class Crime {
  constructor(population, city, clock, routine, seed, settings, economy) {
    this.population = population;
    this.city = city;
    this.clock = clock;
    this.routine = routine;
    this.settings = settings;
    this.economy = economy;
    this.rng = new Random(seed ^ 0x2c1b3c6d);
    this.buffer = new Int32Array(512);
    this.police = new CrimePolice(this);
    routine.crime = this;
    this.resetState();
    this.updateRoster();
  }

  resetState() {
    this.events = [];          // délits des dernières 24 h : { t, type, amount }
    this.totals = { stolen: 0, arrests: 0, solved: 0, killed: 0, officers: 0, jailed: 0 };
    for (const type of CRIME_TYPES) this.totals[type] = 0;
    this.counts = { criminals: 0, active: 0, wanted: 0, jailed: 0 };
    this.recent = {};
    this.stolenToday = 0;
    this.alarms = [];
    this.heat = new Map();     // bâtiment -> chaleur (délits récents), pour les patrouilles
    this.marks = [];
    this.heist = null;
    this.score = 0;
    this.insecurity = 0;
    this.routine.crimeInsecurity = 0;
    this.lastRoster = this.clock.time;
    this.lastHeistDay = -1;
    this.history = [];
    this.historyVersion = (this.historyVersion || 0) + 1;
    this.sampleTimer = 0;
    this.sampleInterval = CONFIG.crime.sampleInterval;
    this.log_ = [];
    this.eventsVersion = (this.eventsVersion || 0) + 1;
    this.lastLog = {};
    this.startTime = this.clock.time;
    this.police.reset();
    this.sample();
  }

  get journal() {
    return this.log_;
  }

  // ------------------------------------------------------------ Actions externes

  /** Clic "Délinquant" : l'habitant le plus proche bascule, et pour de bon. */
  makeCriminal(x, y) {
    let best = null;
    let bestD2 = 30 * 30;
    for (const c of this.population.citizens) {
      if (!this.eligible(c)) continue;
      const d2 = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    if (!best) return false;
    best.crimeRoll = 0;
    best.criminal = true;
    best.violent = true;
    this.log('Un habitant bascule dans la délinquance (et il n\'a pas froid aux yeux).', 'crime');
    this.routine.replan(best);
    return true;
  }

  /** Bouton : un gang tente de braquer une banque dès maintenant. */
  forceHeist() {
    if (this.heist) return false;
    return this.startHeist(true);
  }

  /** Remise à zéro : casiers vierges, prisons vidées (celles des délinquants), compteurs à zéro. */
  reset() {
    for (const c of this.population.citizens) {
      if (c.jailReason === 'crime' && c.jailUntil > 0) {
        c.jailUntil = this.clock.time;
        c.jailReason = '';
      }
      if (!c.alive && c.killedBy && ['mugging', 'shootout'].includes(c.killedBy)) {
        c.health = Health.SUSCEPTIBLE;
        c.killedBy = '';
        c.place = -1;
        if (c.home >= 0) this.routine.enter(c, c.home, true);
      }
      c.wantedUntil = 0;
      c.convictions = 0;
      c.mark = null;
      c.heist = null;
      c.robber = false;
      c.crimeTarget = -1;
      if (c.alive && c.zombie === ZombieState.HUMAN) this.routine.replan(c);
    }
    this.resetState();
    this.updateRoster();
  }

  // ------------------------------------------------------------ Qui est délinquant

  eligible(c) {
    return c.alive && c.zombie === ZombieState.HUMAN && c.age !== 'child';
  }

  /** Tous les 6 h : la précarité et la tendance de fond font basculer (ou sortir) les gens. */
  updateRoster() {
    const cfg = CONFIG.crime;
    const s = this.settings;
    for (const c of this.population.citizens) {
      if (!this.eligible(c)) {
        c.criminal = false;
        continue;
      }
      if (c.crimeRoll === 0) {
        c.criminal = true; // désigné à la main
        continue;
      }
      const poor = this.economy.isPoor(c);
      const jobless = c.job >= 0 && c.work < 0;
      let p = cfg.baseRate * s.criminality * (0.3 + 1.4 * (1 - c.civism));
      if (poor) p *= cfg.poorFactor;
      if (jobless) p *= cfg.unemployedFactor;
      if (poor || jobless) p *= 1 - cfg.welfareRelief * s.welfare;
      if (s.recidivism && c.convictions > 0) p *= cfg.recidivismFactor;
      if (c.age === 'senior') p *= cfg.seniorFactor;
      c.criminal = c.crimeRoll < p;
      c.violent = c.crimeRoll < p * cfg.violentShare;
    }
    this.lastRoster = this.clock.time;
  }

  // ------------------------------------------------------------ Emploi du temps

  /** Activité dictée par la délinquance, ou null. */
  plan(c, h) {
    if (!c.criminal || !this.eligible(c)) return null;
    const cfg = CONFIG.crime;
    const s = this.settings;
    const clock = this.clock;
    const rng = this.rng;
    const now = clock.time;

    if (c.heist) return { building: c.heist.bank, until: c.heist.end, activity: 'heist' };

    // La nuit : sortir rôder (moins quand les rues sont bien éclairées).
    if (inNight(h) && rng.chance(cfg.lurkChance * (1 - 0.6 * s.lighting))) {
      c.mark = null;
      return { building: -1, until: now + rng.range(1, 2.5), activity: 'lurk' };
    }
    // Fin de journée : un violent braque une caisse bien remplie.
    if (c.violent && ((h >= 17.5 && h < 19.5) || h >= 23 || h < 1) && rng.chance(cfg.robberyChance)) {
      const target = this.pickTill(c);
      if (target >= 0) {
        c.crimeTarget = target;
        return { building: target, until: now + 2, activity: 'rob' };
      }
    }
    // En journée, sans emploi : cambrioler un logement vide.
    if (c.work < 0 && clock.weekday < 6 && h >= 9.5 && h < 17 && rng.chance(cfg.burglaryChance)) {
      const target = this.pickHome(c);
      if (target >= 0) {
        c.crimeTarget = target;
        c.crimeDoneAt = 0;
        return { building: target, until: now + 2, activity: 'burgle' };
      }
    }
    return null;
  }

  pickTill(c) {
    const city = this.city;
    let best = -1;
    let bestTill = CONFIG.crime.minTill;
    for (const type of TILLS) {
      for (const i of city.byType[type]) {
        const b = city.buildings[i];
        if (!this.routine.isOpen(b.type) || !(b.till > bestTill)) continue;
        const d = Math.hypot(b.x - c.x, b.y - c.y);
        if (d > 450) continue;
        bestTill = b.till;
        best = i;
      }
    }
    return best;
  }

  /** Un logement vide (personne dedans), pas le sien, pas trop loin. */
  pickHome(c) {
    const city = this.city;
    const homes = city.byType[PlaceType.HOME];
    const occupancy = this.routine.occupancy;
    for (let k = 0; k < 12; k++) {
      const i = homes[this.rng.int(0, homes.length - 1)];
      if (i === c.home || occupancy[i] > 0) continue;
      const b = city.buildings[i];
      if (Math.hypot(b.x - c.x, b.y - c.y) < 450) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ Tick

  step(dt) {
    this.police.step(dt);
  }

  tick(dt) {
    const hours = dt / CONFIG.time.secondsPerHour;
    const now = this.clock.time;
    this.economy.tick();
    if (now - this.lastRoster >= 6) this.updateRoster();
    this.releasePrisoners(now);
    this.alarms = this.alarms.filter((a) => a.until > now);

    for (const c of this.population.citizens) {
      if (!c.criminal || !this.eligible(c) || c.jailUntil > now) {
        if (c.mark !== null && (!c.criminal || c.jailUntil > now)) c.mark = null;
        continue;
      }
      switch (c.activity) {
        case 'lurk': this.lurk(c, hours); break;
        case 'burgle': this.burgle(c, now); break;
        case 'rob': if (c.place === c.crimeTarget) this.rob(c); break;
        default:
          if (c.mark !== null) c.mark = null;
          if (c.heist === null) this.pickpocket(c, hours);
      }
    }
    if (this.heist) this.updateHeist(now);
    else this.maybeHeist();

    this.homeArrests(hours);
    this.police.tick(dt);
    this.updateInsecurity(hours, now);
    this.ageMarks(hours);
    this.recount(now);

    this.sampleTimer += hours;
    if (this.sampleTimer >= this.sampleInterval) {
      this.sampleTimer -= this.sampleInterval;
      this.sample();
    }
  }

  releasePrisoners(now) {
    for (const c of this.population.citizens) {
      if (c.jailUntil > 0 && now >= c.jailUntil && c.jailReason === 'crime') {
        c.jailUntil = 0;
        c.jailReason = '';
        if (c.alive && c.zombie === ZombieState.HUMAN) this.routine.replan(c);
      }
    }
  }

  // ------------------------------------------------------------ Délits

  /** Vol à la tire : dans la foule, une main dans le sac d'un voisin. */
  pickpocket(c, hours) {
    const cfg = CONFIG.crime;
    const type = this.city.typeOf(c.place);
    if (!CROWDS.has(type)) return;
    if (!this.rng.chance(1 - Math.exp(-cfg.pickpocketRate * hours))) return;
    if (c.place < 0 && this.police.near(c.x, c.y, cfg.deterrence)) return;
    const citizens = this.population.citizens;
    const count = this.population.grid.queryRadius(c.x, c.y, cfg.crowdRadius, this.buffer);
    let crowd = 0;
    let victim = null;
    let bestD2 = 14 * 14;
    for (let k = 0; k < count; k++) {
      const o = citizens[this.buffer[k]];
      if (!o || o === c || !o.alive || o.place !== c.place || o.zombie !== ZombieState.HUMAN) continue;
      crowd++;
      const d2 = (o.x - c.x) ** 2 + (o.y - c.y) ** 2;
      if (!o.criminal && o.cash > 5 && d2 < bestD2) {
        bestD2 = d2;
        victim = o;
      }
    }
    if (crowd < 3 || victim === null) return;
    const amount = victim.cash * this.rng.range(0.4, 1);
    victim.cash -= amount;
    c.cash += amount;
    const noticed = this.rng.chance(cfg.witnessReport);
    const seen = noticed && this.rng.chance(0.25 + 0.5 * this.settings.cameras);
    this.record('pickpocket', c, amount, seen, c.place);
    this.logThrottled('pickpocket', 8, `Vol à la tire (${this.where(c.place)}) : ${euros(amount)} envolés.`, 'crime');
  }

  /** Rôde nocturne : repérer un passant isolé, le suivre, le dépouiller. */
  lurk(c, hours) {
    const cfg = CONFIG.crime;
    const s = this.settings;
    if (c.place >= 0) return;
    if (this.police.near(c.x, c.y, cfg.deterrence)) {
      c.mark = null; // une patrouille : on se fait discret
      return;
    }
    const m = c.mark;
    if (m === null || !m.alive || m.place >= 0 || m.zombie !== ZombieState.HUMAN) {
      c.mark = this.findMark(c);
      return;
    }
    const reach = c.radius + m.radius + 5;
    if ((m.x - c.x) ** 2 + (m.y - c.y) ** 2 > reach * reach) return;
    const light = inNight(this.clock.hour) ? 1 - 0.6 * s.lighting : 1;
    if (!this.rng.chance(1 - Math.exp(-cfg.muggingRate * light * hours))) return;

    // Agression
    const amount = m.cash;
    m.cash = 0;
    c.cash += amount;
    c.mark = null;
    m.caution = Math.min(1, m.caution + 0.15); // on ne rentrera plus seul si tard
    m.cashHabit *= 0.7;
    const seen = this.rng.chance(0.3 + 0.6 * s.cameras * (0.4 + 0.6 * s.lighting));
    if (this.rng.chance(cfg.muggingDeath)) {
      this.killVictim(m, 'mugging');
      this.record('mugging', c, amount, true, -1, true);
      this.log(`Une agression tourne mal : un passant est tué pour ${euros(amount)}.`, 'bad');
      return;
    }
    this.record('mugging', c, amount, seen, -1);
    if (this.rng.chance(cfg.muggingInjury)) {
      this.routine.replan(m); // blessé, il rentre
      this.logThrottled('mugging-hurt', 6, `Agression nocturne : un passant est blessé et dépouillé de ${euros(amount)}.`, 'bad');
    } else {
      this.routine.replan(m);
      this.logThrottled('mugging', 6, `Agression nocturne : ${euros(amount)} arrachés à un passant isolé.`, 'crime');
    }
  }

  /** Passant seul dans la rue, de préférence qui sort du distributeur. */
  findMark(c) {
    const cfg = CONFIG.crime;
    const citizens = this.population.citizens;
    const now = this.clock.time;
    const count = this.population.grid.queryRadius(c.x, c.y, cfg.preyRadius, this.buffer);
    let best = null;
    let bestScore = 0;
    for (let k = 0; k < count; k++) {
      const o = citizens[this.buffer[k]];
      if (!o || o === c || !o.alive || o.place >= 0 || o.criminal || o.age === 'child' || o.zombie !== ZombieState.HUMAN) continue;
      if (!this.isolated(o, c)) continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      const score = (1 + (now - (o.atmAt ?? -99) < 0.5 ? 3 : 0) + o.cash / 50) / (1 + d / 30);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  isolated(o, except) {
    const r = CONFIG.crime.isolation;
    const citizens = this.population.citizens;
    const count = this.population.grid.queryRadius(o.x, o.y, r, this.buffer);
    for (let k = 0; k < count; k++) {
      const p = citizens[this.buffer[k]];
      if (p && p !== o && p !== except && p.alive && p.place < 0 && !p.criminal) return false;
    }
    return true;
  }

  /** Cambriolage : quelques dizaines de minutes dans un logement vide… si personne ne rentre. */
  burgle(c, now) {
    const cfg = CONFIG.crime;
    if (c.place !== c.crimeTarget) return;
    if (c.crimeDoneAt === 0) {
      c.crimeDoneAt = now + this.rng.range(...cfg.burglaryTime);
      return;
    }
    // Un habitant rentre : le voleur détale, l'habitant appelle la police.
    const residentBack = this.population.citizens.some(
      (o) => o !== c && o.alive && o.place === c.place && o.home === c.place,
    );
    if (residentBack) {
      this.record('burglary', c, 0, true, c.place);
      this.alarm(c.place, false);
      this.log('Cambriolage interrompu : l\'habitant rentre, le voleur s\'enfuit. La police est prévenue.', 'crime');
      this.endCrime(c);
      return;
    }
    if (now < c.crimeDoneAt) return;

    // Butin : bijoux, électronique… revendus à perte (40 %).
    let loot = 0;
    const touched = new Set();
    for (const o of this.population.citizens) {
      if (o.home !== c.place || o.age === 'child' || touched.has(o.household)) continue;
      touched.add(o.household);
      const loss = Math.min(Math.max(0, o.bank * 0.25), this.rng.range(...cfg.burglaryLoot));
      o.bank -= loss;
      loot += loss;
      for (const m of this.population.householdOf(o)) m.caution = Math.min(1, m.caution + 0.1);
    }
    c.cash += loot * 0.4;
    // Voisins vigilants : quelqu'un a vu un inconnu forcer la porte.
    const seen = this.settings.neighborhoodWatch && this.neighborsHome(c.place) && this.rng.chance(0.5);
    this.record('burglary', c, loot, seen || this.rng.chance(0.15), c.place);
    if (seen) this.alarm(c.place, false);
    this.logThrottled('burglary', 6, `Cambriolage : un logement vidé (${euros(loot)} de préjudice)${seen ? ', un voisin a donné l\'alerte' : ''}.`, 'crime');
    this.endCrime(c);
  }

  neighborsHome(index) {
    const b = this.city.buildings[index];
    const occupancy = this.routine.occupancy;
    for (const i of this.city.byType[PlaceType.HOME]) {
      if (i === index || occupancy[i] === 0) continue;
      const o = this.city.buildings[i];
      const dx = Math.max(0, b.x - (o.x + o.w), o.x - (b.x + b.w));
      const dy = Math.max(0, b.y - (o.y + o.h), o.y - (b.y + b.h));
      if (Math.hypot(dx, dy) < 30) return true;
    }
    return false;
  }

  /** Braquage d'une caisse : témoins, alarme, suspect recherché. */
  rob(c) {
    const b = this.city.buildings[c.place];
    const loot = b.till || 0;
    b.till = 0;
    c.cash += loot;
    this.record('robbery', c, loot, this.rng.chance(0.6 + 0.4 * this.settings.cameras), c.place);
    this.alarm(c.place, false);
    this.log(`Braquage (${PLACE_LABELS[b.type].toLowerCase()}) : la caisse est vidée, ${euros(loot)}. La police arrive.`, 'bad');
    this.endCrime(c);
  }

  endCrime(c) {
    c.crimeTarget = -1;
    c.crimeDoneAt = 0;
    c.activity = 'walk';
    this.routine.replan(c);
  }

  // ------------------------------------------------------------ Braquage de banque

  maybeHeist() {
    const s = this.settings;
    const clock = this.clock;
    if (!s.bankHeists || clock.weekday >= 5 || clock.hour < 10 || clock.hour >= 15) return;
    if (this.lastHeistDay === clock.day) return;
    this.lastHeistDay = clock.day;
    if (this.rng.chance(Math.min(1, CONFIG.crime.heistChance * s.criminality * 4))) this.startHeist(false);
  }

  startHeist(forced) {
    const cfg = CONFIG.crime;
    const banks = this.city.byType[PlaceType.BANK];
    if (banks.length === 0) return false;
    const now = this.clock.time;
    let gang = this.population.citizens.filter(
      (c) => c.criminal && c.violent && this.eligible(c) && c.jailUntil <= now && c.heist === null,
    );
    if (forced && gang.length < cfg.heistGang[0]) {
      // Un gang se forme parmi les plus tentés.
      gang = this.population.citizens
        .filter((c) => this.eligible(c) && c.jailUntil <= now && c.heist === null && c.place >= 0)
        .sort((a, b) => a.crimeRoll - b.crimeRoll)
        .slice(0, cfg.heistGang[1]);
      for (const c of gang) {
        c.criminal = true;
        c.violent = true;
      }
    }
    if (gang.length < cfg.heistGang[0]) return false;
    const bank = this.rng.pick(banks);
    const b = this.city.buildings[bank];
    gang = gang
      .sort((a, c) => Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(c.x - b.x, c.y - b.y))
      .slice(0, this.rng.int(cfg.heistGang[0], cfg.heistGang[1]));
    const heist = { bank, members: gang, start: now, end: now + 4, done: false };
    this.heist = heist;
    for (const c of gang) {
      c.heist = heist;
      this.routine.replan(c);
    }
    this.log(`Un gang de ${gang.length} se donne rendez-vous devant la banque…`, 'bad');
    return true;
  }

  updateHeist(now) {
    const h = this.heist;
    const b = this.city.buildings[h.bank];
    const members = h.members.filter((c) => c.alive && c.heist === h && c.jailUntil <= now);
    if (members.length === 0 || now > h.end) {
      this.endHeist();
      return;
    }
    const present = members.filter((c) => c.place < 0 && c.hold && Math.hypot(
      Math.max(0, b.x - c.x, c.x - (b.x + b.w)), Math.max(0, b.y - c.y, c.y - (b.y + b.h)),
    ) < 18).length;
    if (present < Math.ceil(members.length * 0.6) && now - h.start < 2) return;
    if (present === 0) return;

    // Passage à l'acte
    const s = this.settings;
    const success = this.rng.chance(1 - 0.75 * s.bankSecurity);
    let loot = 0;
    if (success) {
      loot = (b.vault || 0) * this.rng.range(...CONFIG.crime.heistLoot);
      b.vault -= loot;
      for (const c of members) c.cash += loot / members.length;
    }
    // Un seul braquage, plusieurs auteurs : tous recherchés, et armés.
    this.record('heist', members[0], loot, true, h.bank, false, true);
    for (const c of members) {
      c.robber = true;
      c.wantedUntil = members[0].wantedUntil;
    }
    this.alarm(h.bank, true);
    this.log(success
      ? `BRAQUAGE DE BANQUE : le gang repart avec ${euros(loot)} ! Toutes les patrouilles convergent.`
      : 'BRAQUAGE DE BANQUE raté : l\'alarme se déclenche, le gang s\'enfuit les mains vides.', 'bad');
    this.endHeist();
  }

  endHeist() {
    const h = this.heist;
    this.heist = null;
    for (const c of h.members) {
      if (c.heist !== h) continue;
      c.heist = null;
      if (this.eligible(c) && c.jailUntil <= this.clock.time) this.routine.replan(c);
    }
  }

  // ------------------------------------------------------------ Justice

  /** Enregistre un délit ; s'il y a identification, le suspect est recherché. */
  record(type, c, amount, identified, place, murder = false, heist = false) {
    const now = this.clock.time;
    this.events.push({ t: now, type, amount });
    this.totals[type]++;
    this.totals.stolen += amount;
    const weight = CONFIG.crime.weights[type] + (murder ? CONFIG.crime.weights.murder : 0);
    this.score += weight;
    if (identified) c.wantedUntil = now + CONFIG.crime.wantedFor * (heist ? 2 : 1);
    if (place >= 0) this.heat.set(place, (this.heat.get(place) ?? 0) + weight);
    this.marks.push({ x: c.x, y: c.y, type, age: 0 });
    c.lastCrime = now;
  }

  alarm(building, heist) {
    const b = this.city.buildings[building];
    this.alarms.push({ building, x: b.x + b.w / 2, y: b.y + b.h / 2, until: this.clock.time + CONFIG.crime.alarmFor, heist });
  }

  /** Interpellation : direction le commissariat, pour une durée qui dépend des peines. */
  arrest(c, how) {
    const station = this.city.policeStation;
    if (station < 0) return;
    const now = this.clock.time;
    const days = this.settings.sentence * this.rng.range(0.7, 1.3) * (c.robber ? 3 : 1);
    c.jailUntil = now + days * 24;
    c.jailTotal = days * 24;
    c.jailReason = 'crime';
    c.convictions++;
    c.wantedUntil = 0;
    c.mark = null;
    c.robber = false;
    c.crimeTarget = -1;
    c.cash = 0; // butin saisi
    if (c.heist) c.heist = null;
    c.hold = false;
    if (c.place !== station) {
      c.place = -1;
      this.routine.enter(c, station, true);
    }
    c.activity = 'jail';
    c.activityEnd = c.jailUntil;
    this.totals.arrests++;
    this.totals.jailed++;
    this.logThrottled(`arrest-${how}`, 4, how === 'home'
      ? 'Enquête bouclée : un suspect est cueilli à son domicile.'
      : 'Flagrant délit : la patrouille interpelle un suspect.', 'good');
  }

  /** Les enquêteurs retrouvent les suspects identifiés (plus vite avec plus de patrouilles). */
  homeArrests(hours) {
    const now = this.clock.time;
    const rate = (CONFIG.crime.homeArrest * Math.max(1, this.settings.patrols)) / 4 / 24;
    const p = 1 - Math.exp(-rate * hours);
    for (const c of this.population.citizens) {
      if (c.wantedUntil > now && c.jailUntil <= now && this.eligible(c) && c.place >= 0 && this.rng.chance(p)) {
        this.arrest(c, 'home');
      }
    }
  }

  killRobber(c) {
    this.killVictim(c, 'shootout');
    this.log('Fusillade avec la police : un braqueur est abattu.', 'bad');
  }

  officerDown(u) {
    this.totals.officers++;
    this.marks.push({ x: u.x, y: u.y, type: 'heist', age: 0 });
    this.log('Fusillade : un policier est touché.', 'bad');
  }

  killVictim(c, cause) {
    this.totals.killed++;
    c.health = Health.DEAD;
    c.killedBy = cause;
    c.place = -1;
    c.destination = -1;
    c.field = null;
    c.mark = null;
    c.hold = false;
    c.vx = 0;
    c.vy = 0;
  }

  // ------------------------------------------------------------ État global

  updateInsecurity(hours, now) {
    const cfg = CONFIG.crime;
    this.score *= 0.5 ** (hours / cfg.insecurityMemory);
    this.insecurity = 1 - Math.exp(-this.score / cfg.insecurityScale);
    this.routine.crimeInsecurity = this.insecurity;
    const decay = 0.5 ** (hours / 24);
    for (const [k, v] of this.heat) {
      if (v * decay < 0.05) this.heat.delete(k);
      else this.heat.set(k, v * decay);
    }
    const limit = now - 24;
    if (this.events.length > 0 && this.events[0].t < limit) this.events = this.events.filter((e) => e.t >= limit);
  }

  ageMarks(hours) {
    const life = CONFIG.crime.markLife;
    let kept = 0;
    for (const m of this.marks) {
      m.age += hours;
      if (m.age < life) this.marks[kept++] = m;
    }
    this.marks.length = kept;
  }

  recount(now) {
    const counts = this.counts;
    counts.criminals = 0;
    counts.active = 0;
    counts.wanted = 0;
    counts.jailed = 0;
    for (const c of this.population.citizens) {
      if (!c.alive) continue;
      if (c.jailUntil > now && c.jailReason === 'crime') counts.jailed++;
      if (!c.criminal) continue;
      counts.criminals++;
      if (c.wantedUntil > now) counts.wanted++;
      if (['lurk', 'burgle', 'rob', 'heist'].includes(c.activity) && c.jailUntil <= now) counts.active++;
    }
    const recent = this.recent;
    for (const type of CRIME_TYPES) recent[type] = 0;
    let stolen = 0;
    for (const e of this.events) {
      recent[e.type]++;
      stolen += e.amount;
    }
    recent.total = this.events.length;
    this.stolenToday = stolen;
  }

  onPopulationChanged() {
    const present = new Set(this.population.citizens);
    for (const c of this.population.citizens) if (c.mark && !present.has(c.mark)) c.mark = null;
    if (this.heist) this.heist.members = this.heist.members.filter((c) => present.has(c));
    this.economy.onPopulationChanged();
    this.updateRoster();
  }

  sample() {
    const point = { t: this.clock.time - this.startTime };
    for (const type of CRIME_TYPES) point[type] = this.recent[type] ?? 0;
    this.history.push(point);
    if (this.history.length > CONFIG.crime.maxSamples) {
      this.history = this.history.filter((_, i) => i % 2 === 0 || i === this.history.length - 1);
      this.sampleInterval *= 2;
    }
    this.historyVersion++;
  }

  // ------------------------------------------------------------ Journal

  where(place) {
    return place < 0 ? 'dans la rue' : PLACE_LABELS[this.city.buildings[place].type].toLowerCase();
  }

  log(text, kind = 'info') {
    const clock = this.clock;
    this.log_.unshift({ when: `J${clock.day} ${clock.format().split(' ')[1]}`, text, kind });
    if (this.log_.length > CONFIG.crime.maxEvents) this.log_.length = CONFIG.crime.maxEvents;
    this.eventsVersion++;
  }

  logThrottled(key, hours, text, kind) {
    const now = this.clock.time;
    if (now - (this.lastLog[key] ?? -Infinity) < hours) return;
    this.lastLog[key] = now;
    this.log(text, kind);
  }
}
