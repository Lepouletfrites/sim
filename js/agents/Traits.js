import { CONFIG } from '../config.js';
import { PlaceType } from '../world/PlaceTypes.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Tire le profil d'un habitant : âge, emploi, horaires et personnalité.
 * C'est cette variance individuelle qui fait qu'à réglages égaux,
 * deux habitants ne réagissent jamais de la même façon.
 */
export function rollTraits(citizen, rng, city) {
  const cfg = CONFIG.routine;
  const range = ([min, max]) => rng.range(min, max);

  // Tranche d'âge
  let r = rng.next();
  citizen.age = 'senior';
  for (const [age, profile] of Object.entries(cfg.ages)) {
    if (r < profile.share) {
      citizen.age = age;
      break;
    }
    r -= profile.share;
  }
  const profile = cfg.ages[citizen.age];

  // Personnalité
  citizen.civism = rng.next();
  citizen.caution = clamp01(range(profile.caution));
  citizen.sociability = clamp01(range(profile.sociability));
  citizen.frailty = range(profile.frailty);
  // Infectiosité très dispersée : la plupart émettent peu, quelques-uns énormément
  // (moyenne 1, ~10 % des porteurs émettent plus de 2,5 fois la moyenne).
  citizen.infectivity = (0.3 + rng.next() ** 3 * 4) / 1.3;

  // Logement, emploi, horaires
  citizen.home = city.pickPlace(PlaceType.HOME, rng);
  citizen.work = rng.chance(profile.employment) ? city.pickPlace(PlaceType.WORK, rng) : -1;
  citizen.workStart = range(cfg.workStart);
  citizen.workEnd = citizen.workStart + range(cfg.workDuration);
  citizen.worksSaturday = rng.chance(cfg.saturdayWork);
  citizen.wake = range(profile.wake);
  citizen.bedtime = range(profile.bedtime);
  citizen.nightOwl = citizen.age !== 'senior' && citizen.sociability > cfg.nightOwlSociability;
}
