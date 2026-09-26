import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { PlaceType, isOpen } from '../world/PlaceTypes.js';
import { Care, Health } from './Citizen.js';
import { ZombieState } from '../zombie/Zombies.js';

/**
 * Emploi du temps des habitants (décisions lentes, 4 fois par seconde simulée).
 *
 * Chaque habitant a une activité (dormir, travailler, faire les courses...)
 * associée à un lieu et une heure de fin. Quand elle se termine, ou quand
 * son lieu ferme, on en planifie une nouvelle selon :
 *  - l'heure et le jour (sommeil, horaires de travail, ouverture des lieux)
 *  - son profil (âge, emploi, sociabilité)
 *  - sa santé et sa prudence (quarantaine, confinement, moins de sorties)
 *  - les mesures sanitaires (fermetures, télétravail)
 */
export class Routine {
  constructor(population, city, clock, settings, seed) {
    this.population = population;
    this.city = city;
    this.clock = clock;
    this.settings = settings;
    this.rng = new Random(seed ^ 0x68e31da4);
    this.awareness = 0;       // tenu à jour par l'Epidemic
    this.zombieAlarm = false; // tenu à jour par Zombies
    this.cultInsecurity = 0;  // tenu à jour par Cult : méfaits récents, 0..1
    this.crimeInsecurity = 0; // tenu à jour par Crime : délits récents, 0..1
    this.cult = null;         // planificateur des sectes (prêches, réunions, raids, prison)
    this.crime = null;        // planificateur des délinquants (vols, cambriolages, braquages)
    this.economy = null;      // paiements à l'entrée des lieux, distributeurs
    this.onEnter = null;      // callback (citoyen, bâtiment) à l'entrée d'un bâtiment
    this.onRefused = null;    // callback (citoyen, bâtiment) -> true si le refus est pris en charge
    this.occupancy = new Uint16Array(city.buildings.length);
    this.openCache = new Map();
  }

  /** Sentiment d'insécurité : le pire des deux (sectes, délinquance). */
  get insecurity() {
    return Math.max(this.cultInsecurity, this.crimeInsecurity);
  }

  isOpen(type) {
    let open = this.openCache.get(type);
    if (open === undefined) {
      open = isOpen(type, this.clock, this.settings);
      this.openCache.set(type, open);
    }
    return open;
  }

  /** Premier placement : chacun démarre chez soi. */
  initialize(c) {
    if (c.home >= 0) this.enter(c, c.home, true);
    this.replan(c);
  }

  // ------------------------------------------------------------------ Tick

  tick() {
    const cfg = CONFIG.routine;
    const now = this.clock.time;
    const city = this.city;
    this.openCache.clear();
    this.recountOccupancy();

    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie === ZombieState.ZOMBIE) continue; // un zombie n'a plus d'emploi du temps

      if (c.place >= 0) {
        const type = city.buildings[c.place].type;
        if (now >= c.activityEnd || !this.isOpen(type)) this.replan(c);
      } else if (c.destination >= 0) {
        const arrived = c.field.distanceTo(c) <= c.radius + cfg.arriveMargin;
        if (arrived || now - c.travelStart > cfg.maxTravel) this.arrive(c);
      } else if (now >= c.activityEnd) {
        this.replan(c);
      }
    }
  }

  recountOccupancy() {
    const occupancy = this.occupancy;
    occupancy.fill(0);
    for (const c of this.population.citizens) {
      if (c.alive && c.place >= 0) occupancy[c.place]++;
    }
  }

  // -------------------------------------------------------------- Planification

  replan(c) {
    c.hold = false;
    let plan = this.plan(c);
    // On ne retourne pas dans un bâtiment en flammes (ni dans des ruines).
    if (plan.building >= 0 && plan.activity !== 'raid' && this.isUnsafe(plan.building)) {
      plan = { building: -1, until: this.clock.time + this.rng.range(0.5, 1.5), activity: 'walk' };
    }
    c.activity = plan.activity;
    c.activityEnd = plan.until;
    this.goTo(c, plan.building);
  }

  plan(c) {
    const cfg = CONFIG.routine;
    const clock = this.clock;
    const rng = this.rng;
    const s = this.settings;
    const h = clock.hour;
    const now = clock.time;
    const city = this.city;

    // 0. En cellule : rien d'autre ne compte
    if (c.jailUntil > now && this.cult !== null) {
      const jail = this.cult.jailPlan(c);
      if (jail) return jail;
    }

    // 1. Contraintes sanitaires
    switch (c.care) {
      case Care.HOSPITAL:
        if (city.hospitalIndex >= 0) return { building: city.hospitalIndex, until: Infinity, activity: 'hospital' };
        break;
      case Care.QUARANTINE:
        return { building: c.home, until: Infinity, activity: 'quarantine' };
      case Care.BEDRIDDEN:
        return { building: c.home, until: Infinity, activity: 'bedridden' };
      case Care.CONFINED:
        return { building: c.home, until: c.careUntil, activity: 'confined' };
      default:
    }

    // Alerte zombie : un parent va chercher son enfant ; l'enfant l'attend là où il est.
    if (c.fetching !== null && c.fetching.place >= 0) {
      return { building: c.fetching.place, until: Infinity, activity: 'fetch' };
    }
    if (c.awaitingParent !== null && c.place >= 0) {
      return { building: c.place, until: Infinity, activity: 'waiting' };
    }

    // Apocalypse : on sort piller quand les vivres manquent, sinon on reste barricadé.
    if (c.looting && c.lootTarget >= 0) return { building: c.lootTarget, until: Infinity, activity: 'loot' };
    if (c.barricaded) return { building: c.home, until: Infinity, activity: 'barricaded' };

    // Envie de sortir : freinée par la prudence face à l'inquiétude, par la maladie et l'insécurité.
    const sick = c.health === Health.SYMPTOMATIC;
    const mood =
      (1 - s.prudence * this.awareness * c.caution) *
      (sick ? cfg.sickLeisureFactor : 1) *
      (this.zombieAlarm ? CONFIG.zombie.alarmLeisure : 1) *
      (1 - CONFIG.cult.insecurityLeisure * this.insecurity * (0.5 + c.caution));

    // Sectes : prêche, réunion, raid ou rôde nocturne
    if (this.cult !== null) {
      const cultPlan = this.cult.plan(c, h);
      if (cultPlan) return cultPlan;
    }

    // Délinquants : vol, rôde nocturne, cambriolage, braquage
    if (this.crime !== null) {
      const crimePlan = this.crime.plan(c, h);
      if (crimePlan) return crimePlan;
    }

    // 2. Nuit : dormir, ou sortir en boîte (ou au bar) pour les couche-tard
    if (!this.isAwake(c, h)) {
      if (c.nightOwl && this.isOpen(PlaceType.NIGHTCLUB) && rng.chance(cfg.nightclubChance * c.sociability * mood)) {
        const club = this.pickNear(PlaceType.NIGHTCLUB, c);
        if (club >= 0) return { building: club, until: clock.next(rng.range(3, 5)), activity: 'nightclub' };
      }
      if (c.nightOwl && this.isOpen(PlaceType.BAR) && rng.chance(cfg.nightBarChance * c.sociability * mood)) {
        const bar = this.pickNear(PlaceType.BAR, c);
        if (bar >= 0) return { building: bar, until: clock.next(1 + rng.next()), activity: 'bar' };
      }
      return { building: c.home, until: clock.next(c.wake), activity: 'sleep' };
    }

    // 3a. École (cantine comprise), sauf fermeture ou alerte zombie
    if (c.age === 'child') {
      // Départ ~45 min avant la sonnerie ; l'école ouvre ses portes à 8 h.
      const leaveAt = c.workStart - cfg.commuteLead;
      const schoolDay = clock.weekday < 5 && !s.closeSchools && !this.zombieAlarm;
      if (c.work >= 0 && schoolDay && h >= leaveAt && h < c.workEnd &&
        (this.isOpen(PlaceType.SCHOOL) || h < c.workStart)) {
        return { building: c.work, until: clock.next(c.workEnd), activity: 'school' };
      }
      const plan = this.leisure(c, mood);
      // Le matin, on ne part pas en balade juste avant l'école.
      if (c.work >= 0 && schoolDay && h < leaveAt) plan.until = Math.min(plan.until, clock.next(leaveAt));
      return plan;
    }

    // 3b. Travail (le présentéisme existe : un malade qui s'ignore y va quand même)
    const workday = clock.weekday < 5 || (clock.weekday === 5 && c.worksSaturday);
    const hasWork = c.work >= 0 && workday;
    const leaveAt = c.workStart - cfg.commuteLead; // on part un peu avant pour arriver à l'heure
    if (hasWork && h >= leaveAt && h < c.workEnd) {
      const end = clock.next(c.workEnd);
      if (s.telework) return { building: c.home, until: end, activity: 'telework' };
      if (h >= 12 && h < 13 && this.isOpen(PlaceType.RESTAURANT) && rng.chance(cfg.lunchOut * mood)) {
        const resto = this.pickNear(PlaceType.RESTAURANT, c);
        if (resto >= 0) return { building: resto, until: Math.min(clock.next(13), end), activity: 'lunch' };
      }
      // Pause à midi pour laisser le choix du déjeuner
      const until = h < 12 ? Math.min(clock.next(12), end) : end;
      return { building: c.work, until, activity: 'work' };
    }

    // 4. Temps libre, qui s'arrête à temps pour partir travailler
    const plan = this.leisure(c, mood);
    if (hasWork && h < leaveAt) plan.until = Math.min(plan.until, clock.next(leaveAt));
    return plan;
  }

  /**
   * Choisit un lieu d'un type donné parmi quelques candidats, en privilégiant le plus
   * proche : on va rarement au restaurant à l'autre bout de la ville.
   */
  pickNear(type, c) {
    let best = -1;
    let bestD2 = Infinity;
    for (let k = 0; k < CONFIG.routine.venueCandidates; k++) {
      const i = this.city.pickPlace(type, this.rng);
      if (i < 0) return -1;
      const b = this.city.buildings[i];
      const d2 = (b.x + b.w / 2 - c.x) ** 2 + (b.y + b.h / 2 - c.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  leisure(c, mood) {
    const { leisure, evening: eve } = CONFIG.routine;
    const clock = this.clock;
    const rng = this.rng;
    const h = clock.hour;
    const weekend = clock.isWeekend;
    const social = 0.5 + c.sociability;
    const sick = c.health === Health.SYMPTOMATIC;
    const child = c.age === 'child';
    // La soirée : apéro, dîner dehors, promenade. Mais l'insécurité vide les rues le soir.
    const evening = h >= eve.from && h < eve.to;
    const late = h >= 22 || h < 7;
    const nightFear = evening || late ? 1 - 0.8 * this.crimeInsecurity * (0.5 + c.caution) : 1;
    const ev = (key) => (evening ? eve[key] * nightFear : 1);

    const options = [
      ['home', leisure.home.weight * (c.age === 'senior' ? 1.5 : 1) * (sick ? 2 : 1) * (evening ? eve.home : 1)],
      ['walk', leisure.walk.weight * mood * (weekend ? 1.5 : 1) * (late ? 0.2 : ev('walk'))],
    ];
    if (this.isOpen(PlaceType.MALL)) {
      options.push(['mall', leisure.mall.weight * mood * social * (weekend ? 2 : 1)]);
    }
    if (this.isOpen(PlaceType.RESTAURANT)) {
      options.push(['restaurant', leisure.restaurant.weight * mood * social * ev('restaurant')]);
    }
    if (!child && this.isOpen(PlaceType.BAR)) {
      const age = c.age === 'young' ? 1.5 : c.age === 'senior' ? 0.4 : 1;
      options.push(['bar', leisure.bar.weight * mood * social * age * ev('bar') * (weekend ? 1.3 : 1)]);
    }
    if (!child && this.isOpen(PlaceType.SHOP)) options.push(['shop', leisure.shop.weight * mood]);
    // Plus de liquide : un saut au distributeur (toujours ouvert).
    if (!child && this.economy !== null && this.economy.needsCash(c)) options.push(['atm', leisure.atm.weight]);
    // Rendre visite à un ami qui est chez lui (pas trop tard le soir).
    const host = h < 22 ? this.friendAtHome(c) : null;
    if (host) options.push(['visit', leisure.visit.weight * mood * social * (weekend ? 1.5 : 1) * ev('visit')]);

    let total = 0;
    for (const [, w] of options) total += w;
    let r = rng.next() * total;
    let choice = 'home';
    for (const [name, w] of options) {
      if ((r -= w) <= 0) {
        choice = name;
        break;
      }
    }

    const [min, max] = leisure[choice].duration;
    const until = Math.min(clock.time + rng.range(min, max), clock.next(c.bedtime));
    const building =
      choice === 'home' ? c.home
        : choice === 'walk' ? -1
          : choice === 'visit' ? host.home
            : choice === 'atm' ? this.economy.nearestBank(c)
              : this.pickNear(choice, c);
    // On sort rarement seul : un ami libre vient aussi.
    if ((choice === 'restaurant' || choice === 'mall' || choice === 'bar') && building >= 0 &&
      rng.chance(CONFIG.routine.joinFriendChance)) {
      const friend = this.friendAtHome(c);
      if (friend) this.bringAlong(friend, building, until, choice);
    }
    return { building, until, activity: choice };
  }

  /** Un ami chez lui, disponible (ni malade isolé, ni barricadé, ni en prison). */
  friendAtHome(c) {
    const friends = c.friends;
    if (friends.length === 0) return null;
    const start = this.rng.int(0, friends.length - 1);
    for (let k = 0; k < friends.length; k++) {
      const f = friends[(start + k) % friends.length];
      if (f.alive && f.zombie === ZombieState.HUMAN && f.place >= 0 && f.place === f.home &&
        f.activity === 'home' && f.care === Care.NONE && !f.barricaded && f.home !== c.home) return f;
    }
    return null;
  }

  bringAlong(friend, building, until, activity) {
    friend.hold = false;
    friend.activity = activity;
    friend.activityEnd = until;
    this.goTo(friend, building);
  }

  isAwake(c, h) {
    if (c.bedtime > 24) return h >= c.wake || h < c.bedtime - 24;
    return h >= c.wake && h < c.bedtime;
  }

  // ---------------------------------------------------------------- Déplacements

  /** Se diriger vers un bâtiment (-1 = se promener dans la rue). */
  goTo(c, building) {
    if (building >= 0 && building === c.place) {
      c.destination = -1;
      c.field = null;
      return;
    }
    if (c.place >= 0) this.leave(c);

    const field = building >= 0 ? this.city.fieldTo(building) : null;
    c.destination = field ? building : -1;
    c.field = field;
    c.travelStart = this.clock.time;
  }

  arrive(c) {
    const b = c.destination;
    const building = this.city.buildings[b];
    if (c.activity === 'preach' || c.activity === 'raid' || c.activity === 'heist') {
      // On ne rentre pas : on s'installe devant la porte (prêche, attroupement du raid ou du braquage).
      c.destination = -1;
      c.field = null;
      c.hold = true;
      return;
    }
    if (c.activity === 'atm') {
      // Distributeur, dans la façade : on retire et on repart.
      c.destination = -1;
      c.field = null;
      if (this.economy !== null) this.economy.withdraw(c);
      c.activityEnd = this.clock.time;
      return;
    }
    if (this.isUnsafe(b)) {
      this.replan(c);
      return;
    }
    if (c.looting || c.activity === 'fetch') {
      // Pillage, ou parent venu chercher son enfant : ni horaires ni jauge.
      this.enter(c, b);
      this.occupancy[b]++;
      return;
    }
    if (!this.isOpen(building.type)) {
      // Fermé entre-temps : on change de programme.
      this.replan(c);
      return;
    }
    if (this.occupancy[b] >= building.capacity) {
      if (this.onRefused && this.onRefused(c, b)) return; // ex. hôpital plein : géré par l'Epidemic
      // Complet : on flâne un moment avant de réessayer (ou de faire autre chose).
      const [min, max] = CONFIG.routine.retryDelay;
      c.destination = -1;
      c.field = null;
      c.activity = 'walk';
      c.activityEnd = Math.min(this.clock.time + this.rng.range(min, max), this.clock.next(c.bedtime));
      return;
    }
    this.enter(c, b);
    this.occupancy[b]++;
    if (this.onEnter) this.onEnter(c, b);
    if (this.economy !== null) this.economy.onEnter(c, building);
  }

  /** Bâtiment en feu ou en ruine : on n'y entre pas. */
  isUnsafe(b) {
    const building = this.city.buildings[b];
    return building.fire > 0 || building.type === PlaceType.RUIN;
  }

  /** Entre dans un bâtiment : l'agent y reste visible et s'y déplace. */
  enter(c, b, anywhere = false) {
    const building = this.city.buildings[b];
    const r = c.radius;
    if (anywhere) {
      c.x = this.rng.range(building.x + r, building.x + building.w - r);
      c.y = this.rng.range(building.y + r, building.y + building.h - r);
    } else {
      c.x = Math.min(Math.max(c.x, building.x + r), building.x + building.w - r);
      c.y = Math.min(Math.max(c.y, building.y + r), building.y + building.h - r);
    }
    c.px = c.x;
    c.py = c.y;
    c.vx = 0;
    c.vy = 0;
    c.place = b;
    c.destination = -1;
    c.field = null;
    c.pause = 0;
    this.pickIndoorTarget(c);
  }

  /** Sort par la porte la plus proche. */
  leave(c) {
    const field = this.city.fieldTo(c.place);
    c.place = -1;
    if (field) {
      let best = field.exits[0];
      let bestD2 = Infinity;
      for (const exit of field.exits) {
        const d2 = (exit.x - c.x) ** 2 + (exit.y - c.y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = exit;
        }
      }
      c.x = c.px = best.x;
      c.y = c.py = best.y;
    }
    this.population.behavior.initialize(c);
  }

  pickIndoorTarget(c) {
    const b = this.city.buildings[c.place];
    const m = c.radius + 1;
    c.tx = b.w > 2 * m ? this.rng.range(b.x + m, b.x + b.w - m) : b.x + b.w / 2;
    c.ty = b.h > 2 * m ? this.rng.range(b.y + m, b.y + b.h - m) : b.y + b.h / 2;
  }
}
