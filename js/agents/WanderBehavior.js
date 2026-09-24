import { CONFIG } from '../config.js';
import { DIRECTIONS } from './Citizen.js';

/**
 * Comportement d'errance (décisions "lentes", exécutées toutes les 0,2–0,45 s).
 *
 * L'agent suit un cap cardinal. À chaque décision il sonde la grille de marche :
 *  - mur devant        -> tourne vers un côté libre (ou fait demi-tour)
 *  - carrefour latéral -> tourne avec une certaine probabilité
 *  - bloqué trop longtemps -> choisit n'importe quelle direction libre
 */
export class WanderBehavior {
  constructor(city, rng) {
    this.city = city;
    this.rng = rng;
    this.options = [];
  }

  initialize(citizen) {
    const cfg = CONFIG.citizens;
    const open = this.openDirections(citizen, cfg.lookAhead, -1);
    const heading = open.length > 0 ? this.rng.pick(open) : this.rng.int(0, 3);
    citizen.setHeading(heading, this.rng.range(-cfg.wobble, cfg.wobble));
    citizen.vx = citizen.dirX * citizen.speed * 0.5;
    citizen.vy = citizen.dirY * citizen.speed * 0.5;
    // Étale les décisions dans le temps pour lisser la charge CPU.
    citizen.decisionTimer = this.rng.range(0, cfg.decisionInterval.max);
  }

  nextDecisionDelay() {
    const { min, max } = CONFIG.citizens.decisionInterval;
    return this.rng.range(min, max);
  }

  decide(citizen) {
    const cfg = CONFIG.citizens;
    const rng = this.rng;
    const h = citizen.heading;
    const right = (h + 1) & 3;
    const left = (h + 3) & 3;
    const back = (h + 2) & 3;
    let next = h;

    if (citizen.stuckTimer > cfg.stuckTime) {
      const open = this.openDirections(citizen, cfg.lookAhead, h);
      next = open.length > 0 ? rng.pick(open) : back;
      citizen.stuckTimer = 0;
    } else if (!this.probe(citizen, h, cfg.lookAhead)) {
      const options = this.options;
      options.length = 0;
      if (this.probe(citizen, left, cfg.lookAhead)) options.push(left);
      if (this.probe(citizen, right, cfg.lookAhead)) options.push(right);
      next = options.length > 0 ? rng.pick(options) : back;
    } else if (citizen.turnCooldown <= 0) {
      // Une sonde latérale longue ne passe qu'à un vrai carrefour,
      // pas simplement parce que l'avenue est large.
      const options = this.options;
      options.length = 0;
      if (this.probe(citizen, left, cfg.sideProbe)) options.push(left);
      if (this.probe(citizen, right, cfg.sideProbe)) options.push(right);
      if (options.length > 0 && rng.chance(cfg.turnChance)) next = rng.pick(options);
    }

    if (next !== h) citizen.turnCooldown = cfg.turnCooldown;
    citizen.setHeading(next, rng.range(-cfg.wobble, cfg.wobble));
  }

  probe(citizen, heading, distance) {
    const [dx, dy] = DIRECTIONS[heading];
    return this.city.isRayClear(citizen.x, citizen.y, dx, dy, distance, CONFIG.citizens.probeStep);
  }

  openDirections(citizen, distance, exclude) {
    const open = [];
    for (let h = 0; h < 4; h++) {
      if (h !== exclude && this.probe(citizen, h, distance)) open.push(h);
    }
    return open;
  }
}
