import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { Health } from '../agents/Citizen.js';
import { PlaceType, PLACE_LABELS } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/ZombieState.js';
import { Fires } from './Fires.js';
import { CultResponse } from './CultResponse.js';

/** Place d'un habitant dans une secte. */
export const CultRank = Object.freeze({ NONE: 0, FOLLOWER: 1, ZEALOT: 2, GURU: 3 });

/** Étapes de croissance d'une secte. */
export const CultStage = Object.freeze({ PREACH: 0, COMMUNITY: 1, GANG: 2 });
export const STAGE_LABELS = ['Prédication', 'Communauté', 'Gang'];

/** Curseurs de l'onglet Secte et leur unité (les % sont stockés en 0..1). */
export const CULT_SLIDERS = [
  { key: 'charisma', unit: '%' },
  { key: 'wordOfMouth', unit: '%' },
  { key: 'credulity', unit: '%' },
  { key: 'hold', unit: '%' },
  { key: 'tithe', unit: '%' },
  { key: 'hqMembers', unit: 'n' },
  { key: 'gangMembers', unit: 'n' },
  { key: 'radicalization', unit: '%' },
  { key: 'arson', unit: '%' },
  { key: 'violence', unit: '%' },
  { key: 'fireSpread', unit: '%' },
  { key: 'vigilance', unit: '%' },
  { key: 'policeThreshold', unit: '%' },
  { key: 'policeCount', unit: 'n' },
  { key: 'firefighterCount', unit: 'n' },
  { key: 'raidThreshold', unit: 'n' },
];
export const CULT_TOGGLES = ['policeOn', 'firefightersOn', 'raidOn', 'fearBoost', 'prophecy', 'martyr', 'rivalry'];

export const cultSliderToSetting = (slider, value) => (slider.unit === '%' ? value / 100 : value);

export function defaultCultSettings() {
  const cfg = CONFIG.cult;
  const settings = {};
  for (const slider of CULT_SLIDERS) settings[slider.key] = cultSliderToSetting(slider, cfg[slider.key].default);
  for (const key of CULT_TOGGLES) settings[key] = cfg[key];
  return settings;
}

// Noms tirés au sort : chaque secte a sa personnalité.
const PREFIXES = [
  'L\'Ordre', 'L\'Église', 'Les Enfants', 'La Fraternité', 'Le Temple', 'Les Gardiens',
  'Le Cercle', 'La Confrérie', 'Les Éveillés', 'La Communauté',
];
const SUFFIXES = [
  'de l\'Aube Écarlate', 'du Néon Sacré', 'du Grand Pigeon', 'de la Dernière Heure',
  'du Soleil Noir', 'de la Lune Mauve', 'du Rond-Point Éternel', 'du Saint Parking',
  'de la Vibration Cosmique', 'du Wifi Céleste', 'de la Pyramide Inversée', 'du Troisième Œil',
];
const TITLES = ['Frère', 'Sœur', 'Maître', 'le Prophète', 'Mère', 'le Grand Hiérophante', 'Père', 'le Guide Suprême'];
const NAMES = [
  'Gérard', 'Mireille', 'Kevin', 'Jean-Luc', 'Solange', 'Bruno', 'Ginette', 'Patrick',
  'Brigitte', 'Maximilien', 'Josiane', 'Dylan', 'Huguette', 'Enzo',
];
const PREACH_VENUES = [
  [PlaceType.MALL, 3],
  [PlaceType.RESTAURANT, 1.5],
  [PlaceType.WORK, 1],
  [PlaceType.NIGHTCLUB, 1],
  [PlaceType.HOSPITAL, 0.5],
];
const RAID_TARGETS = { mall: 3, restaurant: 2, nightclub: 2, work: 1.5, home: 1 };
/** Activités qu'on interrompt volontiers pour une réunion. */
const FREE_TIME = new Set(['home', 'walk', 'mall', 'restaurant', 'visit', 'sleep', 'preach']);

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** L'heure h est-elle dans [a, b[ (créneau qui peut passer minuit) ? */
function inWindow(h, [a, b]) {
  return a < b ? h >= a && h < b : h >= a || h < b;
}

function distanceToRect(x, y, r) {
  const cx = x < r.x ? r.x : x > r.x + r.w ? r.x + r.w : x;
  const cy = y < r.y ? r.y : y > r.y + r.h ? r.y + r.h : y;
  return Math.hypot(x - cx, y - cy);
}

/**
 * Sectes, sur la même population que l'épidémie et les zombies.
 *
 *   Passant ──prêche / bouche-à-oreille──> Curieux ──réunions──> Fidèle ──(gang)──> Fanatique
 *                                                 ↑ doute                ↓ emprise faible : apostasie
 *
 * 1. Prédication : le gourou prêche devant les lieux fréquentés. Les passants
 *    crédules s'arrêtent pour l'écouter ; les fidèles recrutent leurs proches.
 * 2. Communauté  : assez de fidèles (et de dîmes) pour acheter un QG. Le gourou
 *    y emménage, les réunions du soir s'y tiennent, puis viennent les annexes.
 * 3. Gang        : les plus radicaux deviennent fanatiques. La nuit ils rôdent,
 *    agressent, taguent, et lancent des raids qui finissent souvent en incendie.
 *    Les sectes rivales se font la guerre.
 * Riposte : police (interpellations, descente au QG), pompiers.
 */
export class Cult {
  constructor(population, city, clock, routine, seed, settings, epidemic, zombies) {
    this.population = population;
    this.city = city;
    this.clock = clock;
    this.routine = routine;
    this.settings = settings;
    this.epidemic = epidemic;
    this.zombies = zombies;
    this.rng = new Random(seed ^ 0x3c6ef372);
    this.buffer = new Int32Array(512);
    this.fires = new Fires(this);
    this.response = new CultResponse(this);
    routine.cult = this;
    this.resetState();
  }

  resetState() {
    this.cults = [];
    this.active = false;
    this.tickId = 0;
    this.insecurity = 0;
    this.incidentScore = 0;
    this.routine.insecurity = 0;
    this.totals = {
      fires: 0, ruins: 0, saved: 0, assaults: 0, vandalism: 0, raids: 0,
      killed: { assault: 0, fire: 0, brawl: 0 }, arrests: 0, policeRaids: 0,
      investigations: 0, moved: 0,
    };
    this.counts = { members: 0, followers: 0, zealots: 0, curious: 0, jailed: 0, burning: 0 };
    this.startTime = this.clock.time;
    this.sampleTimer = 0;
    this.sampleInterval = CONFIG.cult.sampleInterval;
    this.history = [];
    this.historyVersion = (this.historyVersion || 0) + 1;
    this.events = [];
    this.eventsVersion = (this.eventsVersion || 0) + 1;
    this.logged = new Set();
    this.lastLog = {};
    this.marks = [];
    this.tags = [];
    this.fires.reset();
    this.response.reset();
  }

  get anyActive() {
    return this.cults.some((k) => !k.dissolved);
  }

  // ------------------------------------------------------------ Actions externes

  /** Un gourou apparaît : au point (x, y) si donné, sinon un passant au hasard. */
  spawnGuru(x, y) {
    const humans = this.population.citizens.filter(
      (c) => c.alive && c.zombie === ZombieState.HUMAN && c.cult < 0 && c.jailUntil <= this.clock.time,
    );
    if (humans.length === 0) return false;
    let chosen = null;
    if (x !== undefined) {
      let bestD2 = 30 * 30;
      for (const c of humans) {
        const d2 = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          chosen = c;
        }
      }
      if (!chosen) return false;
    } else {
      const outside = humans.filter((c) => c.place < 0);
      chosen = this.rng.pick(outside.length > 0 ? outside : humans);
    }
    return this.found(chosen);
  }

  /** Fonde une nouvelle secte autour de ce gourou. */
  found(c) {
    const cfg = CONFIG.cult;
    const alive = this.cults.filter((k) => !k.dissolved);
    if (alive.length >= cfg.maxCults) {
      this.logThrottled('max', 1, `La ville compte déjà ${cfg.maxCults} sectes : plus de place pour un nouveau gourou.`, 'info');
      return false;
    }
    const usedSlots = new Set(alive.map((k) => k.slot));
    const slot = [0, 1, 2, 3].find((i) => !usedSlots.has(i));
    const usedNames = new Set(this.cults.map((k) => k.name));
    let name;
    do {
      name = `${this.rng.pick(PREFIXES)} ${this.rng.pick(SUFFIXES)}`;
    } while (usedNames.has(name) && usedNames.size < PREFIXES.length * SUFFIXES.length);

    const cult = {
      id: this.cults.length,
      slot,
      color: CONFIG.colors.cults[slot],
      name,
      guru: c,
      guruName: this.guruName(),
      hq: -1,
      annexes: [],
      funds: 0,
      stage: CultStage.PREACH,
      founded: this.clock.time,
      members: 1,
      zealots: 0,
      curious: 0,
      jailed: 0,
      incidents: 0,
      rage: 0,
      reports: 0,       // signalements (témoins, familles, victimes) depuis la dernière enquête
      neighbors: null,  // foyers voisins du QG (cache)
      lockedUntil: 0,   // h : comptes gelés après une descente
      wasGang: false,
      raid: null,
      lastRaidNight: -1,
      prophecy: null,
      prophecyDay: 0,
      prophecyBoost: 1,
      dissolved: false,
      stats: { recruited: 0, apostates: 0, fires: 0, assaults: 0, arrests: 0 },
    };
    this.cults.push(cult);
    // La courbe empile les secte : chaque échantillon passé doit avoir sa clé.
    for (const s of this.history) s[`c${cult.id}`] = 0;

    this.enroll(c, cult, CultRank.GURU);
    c.work = -1; // démissionne pour se consacrer à sa mission
    this.activate();
    this.log(`${capitalize(cult.guruName)} fonde « ${name} » et commence à prêcher.`, 'cult');
    if (this.settings.prophecy) this.announceProphecy(cult);
    this.routine.replan(c);
    this.recount();
    return true;
  }

  guruName() {
    return `${this.rng.pick(TITLES)} ${this.rng.pick(NAMES)}`;
  }

  /** Clic "Incendie" : le bâtiment sous le curseur prend feu. */
  fireAt(x, y) {
    for (const b of this.city.buildings) {
      if (x < b.x - 3 || x > b.x + b.w + 3 || y < b.y - 3 || y > b.y + b.h + 3) continue;
      if (!this.fires.ignite(b.index)) {
        this.logThrottled('nofire', 1, 'Ce bâtiment ne peut pas brûler (hôpital, commissariat, caserne, ruine ou déjà en feu).', 'info');
        return false;
      }
      this.activate();
      this.incident(null, 3);
      this.log(`Un incendie se déclare (${PLACE_LABELS[b.type].toLowerCase()}).`, 'fire');
      return true;
    }
    return false;
  }

  /** Descente de police immédiate au QG de la plus grosse secte. */
  forceRaid() {
    const target = this.cults
      .filter((k) => !k.dissolved && k.hq >= 0)
      .sort((a, b) => b.members - a.members)[0];
    if (!target) {
      this.logThrottled('noraid', 1, 'Aucune secte n\'a encore de QG : rien à perquisitionner.', 'info');
      return false;
    }
    return this.response.orderRaid(target);
  }

  /** Toutes les sectes sont dissoutes, les victimes et les bâtiments rendus à la ville. */
  reset() {
    const routine = this.routine;
    for (const c of this.population.citizens) {
      const revived = !c.alive && c.killedBy !== '';
      if (revived) {
        c.health = Health.SUSCEPTIBLE;
        c.killedBy = '';
        c.place = -1;
      }
      if (c.formerHome >= 0) c.home = c.formerHome;
      c.cult = -1;
      c.cultRank = CultRank.NONE;
      c.conviction = 0;
      c.leaning = -1;
      c.apostate = false;
      c.formerHome = -1;
      c.raid = null;
      c.jailUntil = 0;
      c.hold = false;
      c.holdUntil = 0;
      if (!c.alive || c.zombie === ZombieState.ZOMBIE) continue;
      if (revived && c.home >= 0) routine.enter(c, c.home, true);
      routine.replan(c);
    }
    for (const b of this.city.buildings) {
      if (b.originalType !== undefined) {
        this.city.convertPlace(b.index, b.originalType);
        b.originalType = undefined;
      }
      b.cultId = -1;
    }
    this.resetState();
    this.recount();
  }

  // -------------------------------------------------------------- Emploi du temps

  /** Plan imposé par la prison (appelé par la Routine). */
  jailPlan(c) {
    const station = this.city.policeStation;
    if (station < 0) {
      c.jailUntil = 0;
      return null;
    }
    return { building: station, until: c.jailUntil, activity: 'jail' };
  }

  /** Activité dictée par la secte, ou null pour laisser la routine normale. */
  plan(c, h) {
    if (!this.active) return null;
    const cfg = CONFIG.cult;
    const clock = this.clock;
    const rng = this.rng;
    const now = clock.time;

    const meeting = c.goMeeting && c.meetingDay === clock.day && inWindow(h, cfg.meetingHours);
    if (c.cult < 0) {
      // Curieux : invité à une réunion "découverte"
      if (meeting && c.leaning >= 0) {
        const cult = this.cults[c.leaning];
        const place = cult.dissolved ? -1 : this.meetingPlace(cult, c);
        if (place >= 0) return { building: place, until: clock.next(cfg.meetingHours[1]), activity: 'meeting' };
      }
      return null;
    }

    const cult = this.cults[c.cult];
    if (c.raid) return { building: c.raid.target, until: c.raid.end, activity: 'raid' };

    if (c.cultRank === CultRank.GURU) {
      if (inWindow(h, cfg.preachHours)) {
        const spot = this.pickPreachSpot(c);
        if (spot >= 0) {
          const until = Math.min(now + rng.range(1.5, 3), clock.next(cfg.preachHours[1]));
          return { building: spot, until, activity: 'preach' };
        }
      }
      if (inWindow(h, cfg.meetingHours)) {
        const place = this.meetingPlace(cult, c);
        if (place >= 0) return { building: place, until: clock.next(cfg.meetingHours[1]), activity: 'sermon' };
      }
      return null;
    }

    // Fanatique : rôde la nuit au lieu de dormir
    if (c.cultRank === CultRank.ZEALOT && inWindow(h, cfg.nightHours) &&
      rng.chance(cfg.prowlChance * this.settings.violence + cult.rage)) {
      return { building: -1, until: now + rng.range(1, 2), activity: 'prowl' };
    }
    // Réunion du soir
    if (meeting) {
      const place = this.meetingPlace(cult, c);
      if (place >= 0) return { building: place, until: clock.next(cfg.meetingHours[1]), activity: 'meeting' };
    }
    // Le week-end, les disciples prêchent à leur tour
    if (cult.stage >= CultStage.COMMUNITY && clock.isWeekend && h >= 11 && h < 18 &&
      rng.chance(cfg.proselytize * this.settings.wordOfMouth)) {
      const spot = this.pickPreachSpot(c);
      if (spot >= 0) return { building: spot, until: now + rng.range(1, 2), activity: 'preach' };
    }
    return null;
  }

  /** Bâtiment de la secte le plus proche ; avant le QG, le salon du gourou. */
  meetingPlace(cult, c) {
    const places = cult.hq >= 0 ? [cult.hq, ...cult.annexes] : [];
    if (places.length === 0) {
      const guru = cult.guru;
      return guru && guru.home >= 0 && !this.routine.isUnsafe(guru.home) ? guru.home : -1;
    }
    let best = -1;
    let bestD2 = Infinity;
    for (const i of places) {
      const b = this.city.buildings[i];
      const d2 = (b.x + b.w / 2 - c.x) ** 2 + (b.y + b.h / 2 - c.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  /** Un coin de rue passant : devant un lieu fréquenté, pas trop loin. */
  pickPreachSpot(c) {
    const city = this.city;
    const occupancy = this.routine.occupancy;
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < 6; k++) {
      const [type, weight] = this.pickWeighted(PREACH_VENUES);
      const i = city.pickPlace(type, this.rng);
      if (i < 0 || this.routine.isUnsafe(i)) continue;
      const b = city.buildings[i];
      const d = Math.hypot(b.x + b.w / 2 - c.x, b.y + b.h / 2 - c.y);
      const score = (weight * (2 + Math.min(occupancy[i], 30)) * this.rng.range(0.5, 1.5)) / (1 + d / 350);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  pickWeighted(options) {
    let total = 0;
    for (const [, w] of options) total += w;
    let r = this.rng.next() * total;
    for (const option of options) {
      if ((r -= option[1]) <= 0) return option;
    }
    return options[options.length - 1];
  }

  // ------------------------------------------------------------------ Tick

  step(dt) {
    if (this.active) this.response.step(dt);
  }

  tick(dt) {
    if (!this.active) return;
    const hours = dt / CONFIG.time.secondsPerHour;
    this.tickId++;
    this.updateMembers(hours);
    this.preach(hours);
    this.wordOfMouth(hours);
    this.updateCults(hours);
    this.streetViolence(hours);
    this.fires.tick(hours);
    this.updateInsecurity(hours);
    this.response.tick(dt);
    this.recount();
    this.ageMarks(hours);

    this.sampleTimer += hours;
    if (this.sampleTimer >= this.sampleInterval) {
      this.sampleTimer -= this.sampleInterval;
      this.sample();
    }
  }

  /** Multiplicateur de conversion : peur ambiante, prophétie. */
  boost(cult) {
    let boost = cult.prophecyBoost;
    if (this.settings.fearBoost) {
      boost *= 1 + 1.5 * this.epidemic.awareness + (this.zombies.alarm ? 1.5 : 0) + 0.5 * this.insecurity;
    }
    return boost;
  }

  /** 0 = imperméable, sinon 0,25..1 selon la crédulité de l'habitant. */
  receptivity(o) {
    const credulity = this.settings.credulity;
    const floor = 1 - credulity;
    if (credulity <= 0 || o.gullibility <= floor) return 0;
    const r = 0.25 + (0.75 * (o.gullibility - floor)) / credulity;
    return o.apostate ? r * 0.3 : r;
  }

  /** Validité des membres, doute, ferveur, rangs, sorties de prison, fin des écoutes. */
  updateMembers(hours) {
    const cfg = CONFIG.cult;
    const s = this.settings;
    const now = this.clock.time;
    const day = this.clock.day;
    const meetingTime = inWindow(this.clock.hour, cfg.meetingHours);
    for (const c of this.population.citizens) {
      if (c.hold && c.holdUntil > 0 && now >= c.holdUntil) {
        c.hold = false;
        c.holdUntil = 0;
      }
      if (c.cult >= 0 && (!c.alive || c.zombie !== ZombieState.HUMAN)) {
        this.leave(c, c.alive ? 'zombie' : 'death');
        continue;
      }
      if (!c.alive || c.zombie !== ZombieState.HUMAN) continue;

      if (c.jailUntil > 0 && now >= c.jailUntil) {
        c.jailUntil = 0;
        this.routine.replan(c);
        if (c.cult >= 0 && c === this.cults[c.cult].guru) {
          this.log(`${capitalize(this.cults[c.cult].guruName)} sort de prison, plus inspiré que jamais.`, 'cult');
        }
      }

      // À l'heure des réunions, chacun décide une fois s'il y va ; ceux qui y vont partent tout de suite.
      if (meetingTime && c.meetingDay !== day) {
        c.meetingDay = day;
        const guru = c.cultRank === CultRank.GURU;
        const member = c.cult >= 0 && !guru;
        const curious = c.cult < 0 && c.leaning >= 0 && c.conviction >= cfg.curiousAt;
        c.goMeeting = guru || (member && this.rng.chance(cfg.meetingChance * (0.5 + 0.5 * c.conviction))) ||
          (curious && this.rng.chance(cfg.curiousMeetingChance));
        if (c.goMeeting && FREE_TIME.has(c.activity) && c.jailUntil <= now) this.routine.replan(c);
        if (member && c.goMeeting) this.inviteFriends(c, day, now);
      }

      if (c.cult < 0) {
        // Le doute ronge les curieux qui ne sont plus exposés.
        if (c.conviction > 0 && c.activity !== 'meeting' && !(c.hold && c.holdUntil > 0)) {
          c.conviction -= cfg.doubtRate * hours;
          if (c.conviction <= 0) {
            c.conviction = 0;
            c.leaning = -1;
          }
        }
        continue;
      }

      const cult = this.cults[c.cult];
      if (c.cultRank === CultRank.GURU) continue;
      // Ferveur : entretenue par les réunions, elle s'use sans (vite, sans gourou),
      // et la famille hostile tente de ramener le fidèle à la raison.
      const inMeeting = c.activity === 'meeting' && c.place >= 0;
      if (inMeeting) {
        c.conviction = Math.min(1, c.conviction + cfg.meetingRate * hours);
      } else {
        const orphan = cult.guru === null || cult.guru.jailUntil > now ? 3 : 1;
        c.conviction -= cfg.devotionLoss * (1 - s.hold) * orphan * hours;
        const hostile = this.hostileRelatives(c);
        if (hostile > 0) {
          c.conviction -= cfg.familyPull * s.vigilance * hostile * hours;
          if (this.rng.chance(1 - Math.exp(-cfg.reportRate * s.vigilance * hostile * hours))) cult.reports++;
          if (c.conviction < cfg.apostasyAt) {
            this.logThrottled(`family-${cult.id}`, 12, `Une famille arrache un proche à « ${cult.name} ».`, 'good');
          }
        }
        if (c.conviction < cfg.apostasyAt) {
          this.leave(c, 'apostasy');
          continue;
        }
      }
      // Fanatiques : les moins civiques, une fois la secte devenue un gang.
      const radical = cult.stage >= CultStage.GANG && c.civism < Math.min(1, s.radicalization + cult.rage);
      const rank = radical ? CultRank.ZEALOT : CultRank.FOLLOWER;
      if (rank !== c.cultRank) this.setRank(c, cult, rank);
    }
  }

  /** Proches présents à la maison, lucides et hostiles à la secte. */
  hostileRelatives(c) {
    if (c.place < 0 || c.place !== c.home) return 0;
    let n = 0;
    for (const o of this.population.householdOf(c)) {
      if (o !== c && o.place === c.place && o.cult < 0 && o.alive && o.age !== 'child' &&
        o.civism > 0.5 && this.receptivity(o) === 0) n++;
    }
    return n;
  }

  /** Un fidèle qui va à la réunion y emmène parfois un ami réceptif. */
  inviteFriends(c, day, now) {
    const cfg = CONFIG.cult;
    const cult = this.cults[c.cult];
    for (const f of c.friends) {
      if (f.cult >= 0 || !f.alive || f.zombie !== ZombieState.HUMAN || f.jailUntil > now) continue;
      if (this.receptivity(f) <= 0 || (f.leaning >= 0 && f.leaning !== cult.id)) continue;
      if (!this.rng.chance(cfg.inviteChance * this.settings.wordOfMouth * 2)) continue;
      f.leaning = cult.id;
      f.conviction = Math.max(f.conviction, cfg.curiousAt);
      f.meetingDay = day;
      f.goMeeting = true;
      if (FREE_TIME.has(f.activity)) this.routine.replan(f);
    }
  }

  /** Change de rang ; les fanatiques s'installent dans les locaux de la secte. */
  setRank(c, cult, rank) {
    c.cultRank = rank;
    if (rank === CultRank.ZEALOT) {
      const base = this.meetingPlace(cult, c);
      if (base >= 0 && cult.hq >= 0 && c.home !== base) {
        if (c.formerHome < 0) c.formerHome = c.home;
        c.home = base;
      }
    } else if (c.formerHome >= 0 && c !== cult.guru) {
      c.home = c.formerHome;
      c.formerHome = -1;
    }
  }

  /** Prêches : gourou et disciples, dehors devant la porte ou à l'intérieur d'un lieu. */
  preach(hours) {
    const cfg = CONFIG.cult;
    const s = this.settings;
    const now = this.clock.time;
    const citizens = this.population.citizens;
    const grid = this.population.grid;
    for (const p of citizens) {
      if (p.activity !== 'preach' || p.cult < 0 || !p.alive || p.zombie !== ZombieState.HUMAN) continue;
      if (!p.hold && p.place < 0) continue; // encore en route
      const cult = this.cults[p.cult];
      const strength = s.charisma * (p.cultRank === CultRank.GURU ? 1 : cfg.discipleCharisma) *
        cfg.sermonRate * this.boost(cult) * hours;
      if (strength <= 0) continue;

      const count = grid.queryRadius(p.x, p.y, cfg.preachRadius, this.buffer);
      const r2 = cfg.preachRadius ** 2;
      for (let k = 0; k < count; k++) {
        const o = citizens[this.buffer[k]];
        if (!o || o === p || o.cult >= 0 || !o.alive || o.zombie !== ZombieState.HUMAN || o.place !== p.place) continue;
        if ((o.x - p.x) ** 2 + (o.y - p.y) ** 2 > r2) continue;
        const r = this.receptivity(o);
        if (r <= 0) {
          // Un passant lucide et civique signale ce prêcheur inquiétant.
          if (o.civism > 1 - s.vigilance && this.rng.chance(1 - Math.exp(-cfg.reportRate * hours))) cult.reports++;
          continue;
        }
        let listening = o.hold && o.holdUntil > 0;
        // Un passant réceptif s'arrête pour écouter (pas s'il fuit un zombie ou court à l'hôpital).
        if (!listening && o.place < 0 && o.threat === null && o.activity !== 'hospital' &&
          this.rng.chance(1 - Math.exp(-cfg.listenChance * r * hours))) {
          const [min, max] = cfg.listenDuration;
          o.hold = true;
          o.holdUntil = now + this.rng.range(min, max);
          listening = true;
        }
        this.persuade(o, cult, strength * r * (listening ? cfg.listenBoost : 1));
      }
      if (p.cultRank === CultRank.GURU && p.place < 0) {
        this.logThrottled(`preach-${cult.id}`, 24,
          `${capitalize(cult.guruName)} harangue les passants au coin de la rue.`, 'cult');
      }
    }
  }

  /** Bouche-à-oreille au contact des fidèles, et réunions "découverte" pour les curieux. */
  wordOfMouth(hours) {
    const cfg = CONFIG.cult;
    const s = this.settings;
    const citizens = this.population.citizens;
    const grid = this.population.grid;
    const r2 = cfg.contactRadius ** 2;
    const rate = s.wordOfMouth * cfg.wordRate * hours;

    for (const c of citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN) continue;

      // Curieux en réunion : le gourou (s'il est là) est bien plus convaincant.
      if (c.cult < 0 && c.activity === 'meeting' && c.place >= 0 && c.leaning >= 0) {
        const cult = this.cults[c.leaning];
        if (cult.dissolved) continue;
        const guruHere = cult.guru !== null && cult.guru.place === c.place;
        this.persuade(c, cult, cfg.meetingRate * (0.5 + s.charisma) * (guruHere ? 1.5 : 1) *
          this.receptivity(c) * this.boost(cult) * hours);
        continue;
      }
      if (c.cult < 0 || rate <= 0) continue;

      const cult = this.cults[c.cult];
      const amount = rate * this.boost(cult);
      // En famille, l'emprise passe par les proches : conjoint, parents, colocataires.
      if (c.place >= 0 && c.place === c.home) {
        for (const o of this.population.householdOf(c)) {
          if (o === c || o.cult >= 0 || o.place !== c.place || !o.alive || o.zombie !== ZombieState.HUMAN) continue;
          const r = this.receptivity(o);
          if (r > 0) this.persuade(o, cult, amount * cfg.familyBoost * r);
        }
      }
      // Les amis croisés au même endroit (visite, sortie, bureau) sont travaillés au corps.
      for (const o of c.friends) {
        if (o.cult >= 0 || o.place !== c.place || !o.alive || o.zombie !== ZombieState.HUMAN) continue;
        const r = this.receptivity(o);
        if (r > 0) this.persuade(o, cult, amount * cfg.friendBoost * r);
      }
      const count = grid.query(c.x, c.y, this.buffer);
      for (let k = 0; k < count; k++) {
        const o = citizens[this.buffer[k]];
        if (!o || o.cult >= 0 || !o.alive || o.zombie !== ZombieState.HUMAN || o.place !== c.place) continue;
        if ((o.x - c.x) ** 2 + (o.y - c.y) ** 2 > r2) continue;
        const r = this.receptivity(o);
        if (r > 0) this.persuade(o, cult, amount * r);
      }
    }
  }

  /** Ajoute de la conviction ; une secte concurrente doit d'abord défaire celle de la rivale. */
  persuade(o, cult, amount) {
    if (amount <= 0 || cult.dissolved) return;
    if (o.leaning !== cult.id) {
      if (o.leaning >= 0 && o.conviction > 0) {
        o.conviction -= amount;
        if (o.conviction > 0) return;
        amount = -o.conviction;
      }
      o.leaning = cult.id;
      o.conviction = 0;
    }
    o.conviction += amount;
    if (o.conviction >= 1) this.join(o, cult);
  }

  join(o, cult) {
    this.enroll(o, cult, CultRank.FOLLOWER);
    cult.stats.recruited++;
    o.hold = false;
    o.holdUntil = 0;
    const n = cult.members + 1;
    cult.members = n;
    if (cult.stats.recruited === 1) {
      this.log(`« ${cult.name} » compte son premier fidèle.`, 'cult');
    }
    for (const milestone of [10, 25, 50, 100, 200]) {
      if (n >= milestone) this.logOnce(`m${milestone}-${cult.id}`, `« ${cult.name} » atteint ${milestone} fidèles.`, 'cult');
    }
  }

  enroll(c, cult, rank) {
    c.cult = cult.id;
    c.cultRank = rank;
    c.conviction = 1;
    c.leaning = cult.id;
    c.raid = null;
  }

  /** Quitte la secte : apostasie, mort ou transformation en zombie. */
  leave(c, reason) {
    const cult = this.cults[c.cult];
    const wasGuru = cult && cult.guru === c;
    if (c.formerHome >= 0) {
      c.home = c.formerHome;
      c.formerHome = -1;
    }
    c.cult = -1;
    c.cultRank = CultRank.NONE;
    c.conviction = 0;
    c.leaning = -1;
    c.raid = null;
    c.hold = false;
    c.holdUntil = 0;
    if (!cult) return;
    if (reason === 'apostasy') {
      c.apostate = true;
      cult.stats.apostates++;
      this.logThrottled(`apostasy-${cult.id}`, 12, `Des fidèles quittent « ${cult.name} », désabusés.`, 'good');
      if (c.alive) this.routine.replan(c);
    }
    if (wasGuru) this.loseGuru(cult, reason === 'zombie' ? 'est devenu un zombie' : reason === 'death' ? 'est mort' : 'a renoncé');
  }

  /** Le gourou disparaît : martyr (un successeur, et la colère) ou lent délitement. */
  loseGuru(cult, what) {
    const old = cult.guruName;
    cult.guru = null;
    if (!this.settings.martyr) {
      this.log(`${capitalize(old)} ${what}. Sans gourou, « ${cult.name} » se délite.`, 'good');
      return;
    }
    const heir = this.pickHeir(cult);
    if (!heir) {
      this.log(`${capitalize(old)} ${what}, et personne pour reprendre le flambeau.`, 'good');
      return;
    }
    this.crown(cult, heir);
    cult.rage = Math.min(0.5, cult.rage + 0.25);
    this.log(`${capitalize(old)} ${what} : c'est un martyr ! ${capitalize(cult.guruName)} prend la tête de « ${cult.name} », les fidèles crient vengeance.`, 'bad');
  }

  /** Le plus fervent des membres libres (les fanatiques d'abord). */
  pickHeir(cult) {
    const now = this.clock.time;
    let best = null;
    let bestScore = -Infinity;
    for (const c of this.population.citizens) {
      if (c.cult !== cult.id || !c.alive || c.jailUntil > now || c.cultRank === CultRank.GURU) continue;
      const score = c.conviction + (c.cultRank === CultRank.ZEALOT ? 0.5 : 0) + this.rng.next() * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  crown(cult, c) {
    cult.guru = c;
    cult.guruName = this.guruName();
    if (c.formerHome < 0) c.formerHome = c.home;
    if (cult.hq >= 0) c.home = cult.hq;
    c.cultRank = CultRank.GURU;
    c.conviction = 1;
    c.work = -1;
    c.raid = null;
    this.routine.replan(c);
  }

  // ------------------------------------------------------------ Vie des sectes

  updateCults(hours) {
    const cfg = CONFIG.cult;
    const s = this.settings;
    const clock = this.clock;
    for (const cult of this.cults) {
      if (cult.dissolved) continue;
      if (cult.members === 0) {
        this.dissolve(cult);
        continue;
      }
      // Pas de gourou libre ni de martyr : un fidèle finit par prendre la relève (au bout d'un moment).
      if (cult.guru === null && s.martyr) {
        const heir = this.pickHeir(cult);
        if (heir) {
          this.crown(cult, heir);
          this.log(`${capitalize(cult.guruName)} reprend « ${cult.name} » en main.`, 'cult');
        }
      }

      cult.funds += (cult.members * s.tithe * cfg.titheRate * hours) / 24;
      cult.rage = Math.max(0, cult.rage - cfg.rageDecay * hours);

      // Achat du QG, puis d'annexes (pas tant que la secte est sous surveillance)
      const watched = clock.time < cult.lockedUntil;
      if (watched) {
        // rien : les comptes sont gelés
      } else if (cult.hq < 0 && cult.members >= s.hqMembers) this.buyBuilding(cult, false);
      else if (cult.hq >= 0 && cult.annexes.length < cfg.maxAnnexes &&
        cult.members >= (cult.annexes.length + 2) * s.hqMembers) this.buyBuilding(cult, true);

      const stage = cult.hq < 0 ? CultStage.PREACH
        : cult.members >= s.gangMembers ? CultStage.GANG : CultStage.COMMUNITY;
      if (stage !== cult.stage) {
        if (stage === CultStage.GANG) {
          if (!cult.wasGang) this.log(`« ${cult.name} » se radicalise : les fanatiques forment un gang.`, 'bad');
          else this.log(`« ${cult.name} » a un nouveau repaire : le gang reprend ses activités.`, 'bad');
          cult.wasGang = true;
        }
        cult.stage = stage;
      }

      if (cult.jailed > 0) this.payBail(cult);
      if (cult.reports >= cfg.reportThreshold && s.policeOn) this.investigate(cult);
      if (cult.hq >= 0 && cult.stage >= CultStage.COMMUNITY) this.neighborsFlee(cult, hours);
      this.updateProphecy(cult);
      if (cult.stage === CultStage.GANG) this.planRaid(cult);
      if (cult.raid) this.updateRaid(cult);
    }
  }

  /** Les signalements s'accumulent : enquête pour abus de faiblesse, le gourou en garde à vue. */
  investigate(cult) {
    const cfg = CONFIG.cult;
    const guru = cult.guru;
    const n = cult.reports;
    cult.reports = 0;
    cult.incidents += 2;
    this.totals.investigations++;
    if (!guru || !guru.alive || guru.jailUntil > this.clock.time) {
      this.log(`${n} signalements contre « ${cult.name} » : une enquête est ouverte.`, 'good');
      return;
    }
    const name = cult.guruName;
    this.jail(guru, cfg.investigationJail);
    this.log(`Après ${n} signalements (familles, témoins, victimes), ${name} est placé en garde à vue pour abus de faiblesse.`, 'good');
  }

  /** Les voisins du QG n'en peuvent plus (chants, allées et venues, menaces) : ils déménagent. */
  neighborsFlee(cult, hours) {
    const cfg = CONFIG.cult;
    const city = this.city;
    if (!cult.neighbors || cult.neighbors.hq !== cult.hq) {
      const hq = city.buildings[cult.hq];
      const near = new Set();
      for (const b of city.buildings) {
        if (b.type !== PlaceType.HOME || b === hq) continue;
        const dx = Math.max(0, hq.x - (b.x + b.w), b.x - (hq.x + hq.w));
        const dy = Math.max(0, hq.y - (b.y + b.h), b.y - (hq.y + hq.h));
        if (Math.hypot(dx, dy) <= cfg.neighborRadius) near.add(b.index);
      }
      cult.neighbors = { hq: cult.hq, near };
    }
    const near = cult.neighbors.near;
    if (near.size === 0) return;
    const rate = cfg.moveRate[cult.stage >= CultStage.GANG ? 1 : 0] * (0.5 + this.insecurity);
    const p = 1 - Math.exp(-rate * hours);
    let moved = 0;
    for (const members of this.population.households.values()) {
      const first = members[0];
      if (!first || !near.has(first.home) || members.some((m) => m.cult >= 0) || !this.rng.chance(p)) continue;
      let home = -1;
      for (let k = 0; k < 10 && (home < 0 || near.has(home)); k++) home = city.pickPlace(PlaceType.HOME, this.rng);
      if (home < 0 || near.has(home)) continue;
      for (const m of members) m.home = home;
      moved += members.length;
    }
    if (moved > 0) {
      this.totals.moved += moved;
      this.logThrottled(`move-${cult.id}`, 12, `Excédés, des voisins du QG de « ${cult.name} » déménagent.`, 'info');
    }
  }

  /** Une secte riche paie la caution de ses membres en cellule (au bout de quelques heures). */
  payBail(cult) {
    const bail = CONFIG.cult.bail;
    const now = this.clock.time;
    if (now < cult.lockedUntil) return; // comptes gelés
    let freed = 0;
    for (const c of this.population.citizens) {
      if (c.cult !== cult.id || c.jailUntil <= now || !c.alive) continue;
      const price = c === cult.guru || c.cultRank === CultRank.GURU ? bail * 10 : bail;
      const served = c.jailTotal - (c.jailUntil - now);
      if (cult.funds < price * 2 || served < 6) continue; // 6 h de garde à vue d'abord
      cult.funds -= price;
      c.jailUntil = now + 0.01;
      freed++;
    }
    if (freed > 0) {
      this.logThrottled(`bail-${cult.id}`, 6, `« ${cult.name} » paie la caution de ${plural(freed, 'membre')}.`, 'cult');
    }
  }

  /** Achète le bâtiment le mieux placé, si les caisses le permettent. */
  buyBuilding(cult, annex) {
    const index = this.findProperty(cult);
    if (index < 0) return false;
    const price = this.priceOf(index);
    if (cult.funds < price * (annex ? 1.3 : 1)) {
      if (!annex) {
        this.logThrottled(`save-${cult.id}`, 24,
          `« ${cult.name} » a assez de fidèles pour un QG, mais économise encore (${Math.round(cult.funds)} / ${price} €).`, 'cult');
      }
      return false;
    }
    cult.funds -= price;
    const b = this.city.buildings[index];
    const label = PLACE_LABELS[b.type].toLowerCase();
    b.originalType = b.type;
    b.cultId = cult.id;
    // Les occupants non membres sortent ; locataires et salariés partent ailleurs.
    this.city.convertPlace(index, PlaceType.TEMPLE);
    this.relocate(index);
    for (const c of this.population.citizens) {
      if (c.alive && c.place === index && c.cult !== cult.id && c.zombie === ZombieState.HUMAN) this.routine.replan(c);
    }

    if (annex) {
      cult.annexes.push(index);
      this.log(`« ${cult.name} » achète une annexe pour ${price} € (${label}).`, 'cult');
      return true;
    }
    cult.hq = index;
    const guru = cult.guru;
    if (guru) {
      if (guru.formerHome < 0) guru.formerHome = guru.home;
      guru.home = index;
    }
    this.log(`« ${cult.name} » achète ${label === 'bureaux' ? 'des bureaux' : 'un immeuble'} pour ${price} € : c'est son quartier général.`, 'cult');
    return true;
  }

  /** Près du gourou (ou du QG), assez grand, ni lieu public ni bâtiment officiel. */
  findProperty(cult) {
    const city = this.city;
    const anchor = cult.hq >= 0 ? city.buildings[cult.hq] : cult.guru;
    const ax = anchor ? (anchor.w ? anchor.x + anchor.w / 2 : anchor.x) : city.width / 2;
    const ay = anchor ? (anchor.h ? anchor.y + anchor.h / 2 : anchor.y) : city.height / 2;
    let best = -1;
    let bestScore = Infinity;
    for (const b of city.buildings) {
      if (b.type !== PlaceType.HOME && b.type !== PlaceType.WORK) continue;
      const i = b.index;
      if (i === city.policeStation || i === city.fireStation || b.fire > 0 || city.fieldTo(i) === null) continue;
      const area = b.w * b.h;
      if (area < 500) continue;
      const d = Math.hypot(b.x + b.w / 2 - ax, b.y + b.h / 2 - ay);
      const score = d - Math.sqrt(Math.min(area, 6000)) * 2 + this.rng.range(0, 60);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  priceOf(index) {
    const b = this.city.buildings[index];
    return Math.max(500, Math.round((b.w * b.h * CONFIG.cult.pricePerArea) / 50) * 50);
  }

  /** Habitants et salariés d'un bâtiment qui change de mains (ou brûle) : ils vont ailleurs. */
  relocate(index) {
    const city = this.city;
    const moved = new Map(); // foyer -> nouveau logement : une famille déménage ensemble
    for (const c of this.population.citizens) {
      const member = c.cult >= 0 && this.cults[c.cult].hq >= 0 &&
        city.buildings[index].type === PlaceType.TEMPLE && city.buildings[index].cultId === c.cult;
      if (c.home === index && !member) {
        if (!moved.has(c.household)) moved.set(c.household, city.pickPlace(PlaceType.HOME, this.rng));
        c.home = moved.get(c.household);
      }
      if (c.formerHome === index) c.formerHome = city.pickPlace(PlaceType.HOME, this.rng);
      if (c.work === index) c.work = city.pickPlace(PlaceType.WORK, this.rng);
    }
  }

  /** Un bâtiment de la secte est perdu (incendie, saisie). */
  loseBuilding(index) {
    const b = this.city.buildings[index];
    if (!(b.cultId >= 0)) return;
    const cult = this.cults[b.cultId];
    b.cultId = -1;
    if (!cult) return;
    if (cult.hq === index) {
      cult.hq = cult.annexes.shift() ?? -1; // une annexe devient le QG
      if (cult.guru && cult.hq >= 0) cult.guru.home = cult.hq;
    } else {
      cult.annexes = cult.annexes.filter((i) => i !== index);
    }
    // Ceux qui y vivaient retournent chez eux.
    for (const c of this.population.citizens) {
      if (c.home !== index) continue;
      if (cult.hq >= 0 && c.cult === cult.id) c.home = cult.hq;
      else if (c.formerHome >= 0) {
        c.home = c.formerHome;
        c.formerHome = -1;
      } else c.home = this.city.pickPlace(PlaceType.HOME, this.rng);
    }
    if (cult.hq < 0) cult.stage = CultStage.PREACH;
  }

  dissolve(cult) {
    cult.dissolved = true;
    cult.guru = null;
    cult.raid = null;
    for (const index of [cult.hq, ...cult.annexes]) {
      if (index < 0) continue;
      const b = this.city.buildings[index];
      b.cultId = -1;
      if (b.type === PlaceType.TEMPLE && b.originalType !== undefined) {
        this.city.convertPlace(index, b.originalType);
        b.originalType = undefined;
      }
    }
    cult.hq = -1;
    cult.annexes = [];
    for (const c of this.population.citizens) {
      if (c.leaning === cult.id && c.cult < 0) {
        c.leaning = -1;
        c.conviction = 0;
      }
    }
    this.log(`« ${cult.name} » est dissoute : plus un seul fidèle.`, 'good');
  }

  // ------------------------------------------------------------ Prophétie

  announceProphecy(cult) {
    cult.prophecy = 'pending';
    cult.prophecyDay = this.clock.day + CONFIG.cult.prophecyDelay;
    cult.prophecyBoost = cult.prophecyBoost < 1 ? 0.8 : 1.3;
    this.log(`${capitalize(cult.guruName)} annonce la fin du monde pour le jour ${cult.prophecyDay}.`, 'cult');
  }

  updateProphecy(cult) {
    if (!this.settings.prophecy) {
      cult.prophecy = null;
      cult.prophecyBoost = 1;
      return;
    }
    if (cult.prophecy === null) {
      this.announceProphecy(cult);
      return;
    }
    if (cult.prophecy !== 'pending' || this.clock.day < cult.prophecyDay || this.clock.hour < 12) return;

    const zombies = this.zombies;
    const apocalypse = (zombies.active && zombies.counts.zombies > 0) || this.epidemic.awareness > 0.25 ||
      this.fires.burning.size >= 3;
    if (apocalypse) {
      cult.prophecy = 'fulfilled';
      cult.prophecyBoost = 2.2;
      for (const c of this.population.citizens) if (c.cult === cult.id) c.conviction = 1;
      this.log(`La prophétie de ${cult.guruName} se réalise ! Les fidèles affluent vers « ${cult.name} ».`, 'bad');
      return;
    }
    // Rien ne s'est passé : désillusion, puis nouvelle date.
    for (const c of this.population.citizens) {
      if (c.cult === cult.id && c.cultRank !== CultRank.GURU) c.conviction -= this.rng.range(0.2, 0.7);
    }
    cult.prophecyBoost = 0.7;
    this.log(`Le jour ${cult.prophecyDay} passe sans fin du monde : désillusion chez « ${cult.name} ».`, 'good');
    this.announceProphecy(cult);
    this.log(`${capitalize(cult.guruName)} a « refait ses calculs ».`, 'cult');
  }

  // ------------------------------------------------------------ Raids nocturnes

  /** Une nuit sur deux environ, un commando de fanatiques part semer le chaos. */
  planRaid(cult) {
    const cfg = CONFIG.cult;
    const s = this.settings;
    const clock = this.clock;
    if (cult.raid || !inWindow(clock.hour, cfg.nightHours)) return;
    const night = clock.hour < 12 ? clock.day - 1 : clock.day;
    if (cult.lastRaidNight === night) return;
    cult.lastRaidNight = night;
    if (!this.rng.chance(cfg.raidEvery * Math.max(s.arson, s.violence) + cult.rage)) return;

    const target = this.pickRaidTarget(cult);
    if (target < 0) return;
    const b = this.city.buildings[target];
    const now = clock.time;
    const squad = this.population.citizens
      .filter((c) => c.cult === cult.id && c.cultRank === CultRank.ZEALOT && c.alive && c.jailUntil <= now && !c.raid)
      .sort((a, c) => distanceToRect(a.x, a.y, b) - distanceToRect(c.x, c.y, b))
      .slice(0, this.rng.int(cfg.squad[0], cfg.squad[1]));
    if (squad.length < 2) return;

    const raid = { cult, target, members: squad, start: now, end: now + cfg.raidDuration };
    cult.raid = raid;
    this.totals.raids++;
    for (const c of squad) {
      c.raid = raid;
      this.routine.replan(c);
    }
    const rival = b.cultId >= 0 && b.cultId !== cult.id;
    this.log(rival
      ? `Des fanatiques de « ${cult.name} » marchent sur le QG de « ${this.cults[b.cultId].name} »…`
      : `${plural(squad.length, 'fanatique')} de « ${cult.name} » se rassemblent dans la nuit…`, 'bad');
  }

  pickRaidTarget(cult) {
    const city = this.city;
    const buildings = city.buildings;
    // Guerre des sectes : le QG rival d'abord.
    if (this.settings.rivalry && this.rng.chance(0.6)) {
      const rivals = this.cults.filter((k) => !k.dissolved && k !== cult && k.hq >= 0);
      if (rivals.length > 0) {
        const rival = this.rng.pick(rivals);
        const options = [rival.hq, ...rival.annexes].filter((i) => this.fires.canBurn(i));
        if (options.length > 0) return this.rng.pick(options);
      }
    }
    if (cult.hq < 0) return -1;
    const home = buildings[cult.hq];
    let best = -1;
    let bestScore = 0;
    for (let k = 0; k < 40; k++) {
      const b = buildings[this.rng.int(0, buildings.length - 1)];
      const weight = RAID_TARGETS[b.type];
      if (!weight || b.cultId === cult.id || !this.fires.canBurn(b.index) || city.fieldTo(b.index) === null) continue;
      const d = Math.hypot(b.x - home.x, b.y - home.y);
      const score = (weight * this.rng.range(0.5, 1.5)) / (1 + d / 300);
      if (score > bestScore) {
        bestScore = score;
        best = b.index;
      }
    }
    return best;
  }

  /** Le commando attend d'être rassemblé devant la cible, puis passe à l'acte. */
  updateRaid(cult) {
    const raid = cult.raid;
    const now = this.clock.time;
    const b = this.city.buildings[raid.target];
    const members = raid.members.filter((c) => c.alive && c.raid === raid && c.jailUntil <= now);
    const present = members.filter((c) => c.place < 0 && c.hold && distanceToRect(c.x, c.y, b) < 18).length;
    const ready = present >= Math.max(2, Math.ceil(members.length * 0.6)) || (now > raid.start + 1.5 && present >= 1);

    if (members.length === 0 || now > raid.end) {
      this.endRaid(cult);
      return;
    }
    if (!ready) return;

    this.tag(b, cult);
    const s = this.settings;
    const label = PLACE_LABELS[b.type].toLowerCase();
    if (this.rng.chance(s.arson + cult.rage) && this.fires.ignite(raid.target, cult)) {
      this.incident(cult, 4);
      this.log(`Incendie criminel : « ${cult.name} » met le feu (${label}) !`, 'fire');
    } else {
      this.totals.vandalism++;
      this.incident(cult, 1);
      this.log(`Vitrines brisées et tags (${label}) : la signature de « ${cult.name} ».`, 'bad');
    }
    this.endRaid(cult);
  }

  endRaid(cult) {
    const raid = cult.raid;
    cult.raid = null;
    for (const c of raid.members) {
      if (c.raid !== raid) continue;
      c.raid = null;
      if (c.alive && c.zombie === ZombieState.HUMAN && c.jailUntil <= this.clock.time) this.routine.replan(c);
    }
  }

  /** Graffiti aux couleurs de la secte, sur la façade. */
  tag(b, cult) {
    const tags = this.tags;
    const side = this.rng.int(0, 3);
    const t = this.rng.range(0.15, 0.85);
    const x = side < 2 ? b.x + t * b.w : side === 2 ? b.x + 2 : b.x + b.w - 2;
    const y = side >= 2 ? b.y + t * b.h : side === 0 ? b.y + 2 : b.y + b.h - 2;
    tags.push({ x, y, color: cult.color, seed: this.rng.next() });
    if (tags.length > CONFIG.cult.maxTags) tags.shift();
  }

  // ------------------------------------------------------------ Violence

  /** Pilotage (chaque pas) : le fanatique qui rôde suit sa proie. @returns {boolean} */
  steer(c) {
    const p = c.prey;
    if (!p.alive || p.place >= 0 || p.zombie !== ZombieState.HUMAN || c.place >= 0 || c.activity !== 'prowl') {
      c.prey = null;
      return false;
    }
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return false;
    c.dirX = dx / d;
    c.dirY = dy / d;
    return true;
  }

  /** Une proie : passant (ou fanatique rival) dans la rue, le plus proche. */
  isPrey(z, o) {
    if (!o.alive || o.place >= 0 || o.zombie !== ZombieState.HUMAN || o.cult === z.cult || o.jailUntil > 0) return false;
    return o.cult < 0 || this.settings.rivalry;
  }

  /** Agressions et rixes : fanatiques dehors (raid ou rôde) au contact des passants. */
  streetViolence(hours) {
    const cfg = CONFIG.cult;
    const s = this.settings;
    const citizens = this.population.citizens;
    const grid = this.population.grid;
    const now = this.clock.time;
    for (const z of citizens) {
      if (z.cultRank !== CultRank.ZEALOT || !z.alive || z.place >= 0 || z.jailUntil > now) {
        z.prey = null;
        continue;
      }
      if (z.activity !== 'raid' && z.activity !== 'prowl') {
        z.prey = null;
        continue;
      }
      const cult = this.cults[z.cult];
      // En maraude : repérer un passant et le suivre.
      if (z.activity === 'prowl' && s.violence > 0 && (z.prey === null || !this.isPrey(z, z.prey))) {
        z.prey = null;
        const n = grid.queryRadius(z.x, z.y, cfg.preyRadius, this.buffer);
        let bestD2 = cfg.preyRadius ** 2;
        for (let k = 0; k < n; k++) {
          const o = citizens[this.buffer[k]];
          if (!o || o === z || !this.isPrey(z, o)) continue;
          const d2 = (o.x - z.x) ** 2 + (o.y - z.y) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            z.prey = o;
          }
        }
      }
      const count = grid.query(z.x, z.y, this.buffer);
      for (let k = 0; k < count; k++) {
        const o = citizens[this.buffer[k]];
        if (!o || o === z || !this.isPrey(z, o)) continue;
        const reach = z.radius + o.radius + 5;
        if ((o.x - z.x) ** 2 + (o.y - z.y) ** 2 > reach * reach) continue;

        if (o.cultRank === CultRank.ZEALOT) {
          if (!s.rivalry || !this.rng.chance(1 - Math.exp(-cfg.brawlRate * hours))) continue;
          const loser = this.rng.chance(0.5) ? o : z;
          this.kill(loser, 'brawl');
          this.incident(cult, 2);
          this.logThrottled('brawl', 6, `Rixe entre fanatiques de sectes rivales : un mort.`, 'bad');
          break;
        }
        if (!this.rng.chance(1 - Math.exp(-cfg.assaultRate * s.violence * (1 + cult.rage) * hours))) continue;
        this.totals.assaults++;
        cult.stats.assaults++;
        z.prey = null;
        if (this.rng.chance(cfg.assaultLethality)) {
          this.kill(o, 'assault');
          this.incident(cult, 3);
          this.logThrottled('murder', 6, `Un passant est tué par des fanatiques de « ${cult.name} ».`, 'bad');
        } else {
          this.incident(cult, 1);
          if (o.cult < 0) {
            o.conviction = 0; // on ne rejoint pas ceux qui vous ont tabassé
            o.leaning = -1;
          }
          cult.reports += 2; // la victime porte plainte
          this.routine.replan(o); // la victime rentre en vitesse
          this.logThrottled('assault', 6, `Agression nocturne : des fanatiques de « ${cult.name} » s'en prennent à un passant.`, 'bad');
        }
        break;
      }
    }
  }

  kill(c, cause) {
    this.marks.push({ x: c.x, y: c.y, age: 0 });
    this.totals.killed[cause]++;
    if (c.cult >= 0) this.leave(c, 'death');
    c.health = Health.DEAD;
    c.killedBy = cause;
    c.place = -1;
    c.destination = -1;
    c.field = null;
    c.target = null;
    c.threat = null;
    c.vx = 0;
    c.vy = 0;
    c.hold = false;
    c.prey = null;
  }

  /** Méfait : nourrit l'insécurité et le dossier de la secte. */
  incident(cult, weight) {
    this.incidentScore += weight;
    if (cult) cult.incidents++;
  }

  updateInsecurity(hours) {
    const cfg = CONFIG.cult;
    this.incidentScore *= 0.5 ** (hours / cfg.insecurityMemory);
    this.insecurity = 1 - Math.exp(-this.incidentScore / cfg.insecurityScale);
    this.routine.insecurity = this.insecurity;
  }

  // ------------------------------------------------------------ Police

  /** En cellule au commissariat. */
  jail(c, hours) {
    const station = this.city.policeStation;
    if (station < 0) return;
    const cult = c.cult >= 0 ? this.cults[c.cult] : null;
    c.jailUntil = this.clock.time + hours;
    c.jailTotal = hours;
    c.prey = null;
    if (c.raid) c.raid = null;
    c.hold = false;
    c.holdUntil = 0;
    if (c.place !== station) {
      c.place = -1;
      this.routine.enter(c, station, true);
    }
    c.activity = 'jail';
    c.activityEnd = c.jailUntil;
    this.totals.arrests++;
    if (!cult) return;
    cult.stats.arrests++;
    if (cult.guru === c && this.settings.martyr) {
      c.cultRank = CultRank.FOLLOWER;
      this.loseGuru(cult, 'est jeté en prison');
    }
  }

  /** Descente au QG : on embarque tous les membres présents, les locaux sont saisis. */
  policeRaid(cult) {
    if (cult.dissolved || cult.hq < 0) return;
    const cfg = CONFIG.cult;
    const places = new Set([cult.hq, ...cult.annexes]);
    let arrested = 0;
    let guruCaught = false;
    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN || !places.has(c.place)) continue;
      if (c.cult === cult.id) {
        const isGuru = c === cult.guru;
        const [min, max] = cfg.jailTime;
        this.jail(c, isGuru ? cfg.guruJail : this.rng.range(min, max));
        arrested++;
        if (isGuru) guruCaught = true;
      }
    }
    for (const index of places) {
      const b = this.city.buildings[index];
      this.loseBuilding(index);
      if (b.type === PlaceType.TEMPLE && b.originalType !== undefined) {
        this.city.convertPlace(index, b.originalType);
        b.originalType = undefined;
      }
      for (const c of this.population.citizens) {
        if (c.alive && c.place === index && c.jailUntil <= this.clock.time) this.routine.replan(c);
      }
    }
    cult.hq = -1;
    cult.annexes = [];
    cult.stage = CultStage.PREACH;
    cult.funds *= 0.2;
    cult.incidents = 0;
    cult.lockedUntil = this.clock.time + cfg.seizedFor;
    this.totals.policeRaids++;
    this.log(`Descente de police chez « ${cult.name} » : ${plural(arrested, 'interpellation')}` +
      `${guruCaught ? ', dont le gourou' : ''}. Locaux saisis, comptes gelés pour ${cfg.seizedFor} h.`, 'good');
  }

  // ------------------------------------------------------------ Statistiques

  activate() {
    if (this.active) return;
    this.active = true;
    this.startTime = this.clock.time;
    this.sample();
  }

  recount() {
    const counts = this.counts;
    const now = this.clock.time;
    counts.members = 0;
    counts.followers = 0;
    counts.zealots = 0;
    counts.curious = 0;
    counts.jailed = 0;
    for (const cult of this.cults) {
      cult.members = 0;
      cult.zealots = 0;
      cult.curious = 0;
      cult.jailed = 0;
    }
    const curiousAt = CONFIG.cult.curiousAt;
    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN) continue;
      if (c.jailUntil > now) counts.jailed++;
      if (c.cult < 0) {
        if (c.leaning >= 0 && c.conviction >= curiousAt) {
          counts.curious++;
          this.cults[c.leaning].curious++;
        }
        continue;
      }
      const cult = this.cults[c.cult];
      cult.members++;
      counts.members++;
      if (c.jailUntil > now) cult.jailed++;
      if (c.cultRank === CultRank.ZEALOT) {
        cult.zealots++;
        counts.zealots++;
      } else if (c.cultRank === CultRank.FOLLOWER) counts.followers++;
    }
    counts.burning = this.fires.burning.size;
  }

  /** Après un changement de population : les membres disparus quittent leur secte. */
  onPopulationChanged() {
    const present = new Set(this.population.citizens);
    for (const c of this.population.citizens) {
      if (c.prey && !present.has(c.prey)) c.prey = null;
    }
    for (const cult of this.cults) {
      if (cult.guru && !present.has(cult.guru)) {
        cult.guru = null;
      }
      if (cult.raid) cult.raid.members = cult.raid.members.filter((c) => present.has(c));
    }
    this.recount();
  }

  sample() {
    const point = { t: this.clock.time - this.startTime, curious: this.counts.curious };
    for (const cult of this.cults) point[`c${cult.id}`] = cult.dissolved ? 0 : cult.members;
    this.history.push(point);
    if (this.history.length > CONFIG.cult.maxSamples) {
      this.history = this.history.filter((_, i) => i % 2 === 0 || i === this.history.length - 1);
      this.sampleInterval *= 2;
    }
    this.historyVersion++;
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

  // ------------------------------------------------------------ Journal

  log(text, kind = 'info') {
    const clock = this.clock;
    this.events.unshift({ when: `J${clock.day} ${clock.format().split(' ')[1]}`, text, kind });
    if (this.events.length > CONFIG.cult.maxEvents) this.events.length = CONFIG.cult.maxEvents;
    this.eventsVersion++;
  }

  logOnce(key, text, kind) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(text, kind);
  }

  logThrottled(key, hours, text, kind) {
    const now = this.clock.time;
    if (now - (this.lastLog[key] ?? -Infinity) < hours) return;
    this.lastLog[key] = now;
    this.log(text, kind);
  }
}
