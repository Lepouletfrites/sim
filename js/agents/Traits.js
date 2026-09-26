import { CONFIG } from '../config.js';
import { PlaceType } from '../world/PlaceTypes.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Tire la composition d'un foyer : liste des tranches d'âge de ses membres. */
export function rollHousehold(rng) {
  const options = CONFIG.routine.households;
  let r = rng.next();
  for (const option of options) {
    if ((r -= option.weight) <= 0) return option.members;
  }
  return options[options.length - 1].members;
}

/**
 * Tire le profil d'un habitant : emploi (ou école), horaires et personnalité.
 * C'est cette variance individuelle qui fait qu'à réglages égaux,
 * deux habitants ne réagissent jamais de la même façon.
 * Le domicile et l'âge sont fixés avant, par le foyer (voir Population).
 */
export function rollTraits(citizen, rng, city, age) {
  const cfg = CONFIG.routine;
  const range = ([min, max]) => rng.range(min, max);
  citizen.age = age;
  const profile = cfg.ages[age];

  // Personnalité
  citizen.civism = rng.next();
  citizen.bravery = rng.next();
  citizen.caution = clamp01(range(profile.caution));
  citizen.sociability = clamp01(range(profile.sociability));
  citizen.frailty = range(profile.frailty);
  // Infectiosité très dispersée : la plupart émettent peu, quelques-uns énormément
  // (moyenne 1, ~10 % des porteurs émettent plus de 2,5 fois la moyenne).
  citizen.infectivity = (0.3 + rng.next() ** 3 * 4) / 1.3;

  citizen.wake = range(profile.wake);
  citizen.bedtime = range(profile.bedtime);
  citizen.worksSaturday = false;

  if (age === 'child') {
    // L'école la plus proche à pied de la maison ; pas de sorties nocturnes.
    citizen.work = citizen.home >= 0 ? city.nearestPlaceByPath(PlaceType.SCHOOL, citizen.home) : -1;
    const [start, end] = cfg.schoolHours;
    citizen.workStart = start + rng.range(-0.15, 0.1);
    citizen.workEnd = end + rng.range(0, 0.25);
    citizen.nightOwl = false;
    citizen.gullibility = 0; // les enfants ne rejoignent pas les sectes
    return;
  }

  // Actif (emploi attitré) ou non (étudiant, retraité, au foyer). Le chômage, réglable,
  // prive d'emploi une part des actifs : ceux dont le `jobRank` est le plus bas (voir Economy).
  citizen.job = rng.chance(profile.employment) ? city.pickPlace(PlaceType.WORK, rng) : -1;
  citizen.jobRank = rng.next();
  citizen.work = citizen.job;
  citizen.workStart = range(cfg.workStart);
  citizen.workEnd = citizen.workStart + range(cfg.workDuration);
  citizen.worksSaturday = rng.chance(cfg.saturdayWork);
  citizen.nightOwl = age !== 'senior' && citizen.sociability > cfg.nightOwlSociability;
  citizen.crimeRoll = rng.next();
  citizen.cashHabit = age === 'senior' ? rng.range(0.4, 0.9) : rng.range(0.1, 0.7);
  // Crédulité : les jeunes et les isolés (peu sociables) se laissent plus facilement embrigader.
  citizen.gullibility = clamp01(rng.next() * 0.85 + (age === 'young' ? 0.12 : 0) + (0.5 - citizen.sociability) * 0.1);
}
