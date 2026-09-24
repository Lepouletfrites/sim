import { CONFIG } from '../config.js';

export const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Horloge de jeu. `time` est un nombre d'heures depuis le lundi 0 h du jour 0 :
 * tout le reste (jour, heure, jour de la semaine) en découle.
 */
export class Clock {
  constructor(startHour = CONFIG.time.startHour) {
    this.time = startHour;
  }

  /** Avance l'horloge de `dt` secondes simulées. */
  advance(dt) {
    this.time += dt / CONFIG.time.secondsPerHour;
  }

  get day() {
    return Math.floor(this.time / 24);
  }

  /** 0 = lundi ... 6 = dimanche */
  get weekday() {
    return this.day % 7;
  }

  get hour() {
    return this.time - this.day * 24;
  }

  get isWeekend() {
    return this.weekday >= 5;
  }

  /** Prochain instant (absolu, en heures) où il sera `hourOfDay` h. Accepte des heures > 24. */
  next(hourOfDay) {
    let t = this.day * 24 + (hourOfDay % 24);
    while (t <= this.time) t += 24;
    return t;
  }

  /** Luminosité ambiante : 0 la nuit, 1 en journée, transitions à l'aube et au crépuscule. */
  get daylight() {
    const h = this.hour;
    return smoothstep(5.5, 8, h) * (1 - smoothstep(18.5, 21.5, h));
  }

  format() {
    const h = this.hour;
    const hh = String(Math.floor(h)).padStart(2, '0');
    const mm = String(Math.floor((h % 1) * 60)).padStart(2, '0');
    return `${WEEKDAYS[this.weekday]} ${hh}:${mm}`;
  }
}
