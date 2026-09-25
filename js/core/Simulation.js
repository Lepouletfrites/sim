import { CONFIG } from '../config.js';
import { Clock } from './Clock.js';
import { Population } from '../agents/Population.js';
import { Routine } from '../agents/Routine.js';
import { Epidemic } from '../epidemic/Epidemic.js';
import { Zombies, defaultZombieSettings } from '../zombie/Zombies.js';
import { Cult, defaultCultSettings } from '../cult/Cult.js';

/**
 * Orchestre le temps simulé : timeScale + accumulateur à pas fixe.
 *
 * - Physique à pas fixe de 1/60 s : à x50, 50 sous-étapes par frame au lieu
 *   d'un grand pas, ce qui empêche les agents de traverser les murs.
 * - Décisions lentes (épidémie, zombies, routine) toutes les `tickInterval` secondes simulées.
 */
export class Simulation {
  constructor() {
    this.city = null;
    this.clock = new Clock();
    this.population = null;
    this.routine = null;
    this.epidemic = null;
    this.zombies = null;
    this.zombieSettings = defaultZombieSettings();
    this.cult = null;
    this.cultSettings = defaultCultSettings();
    this.timeScale = CONFIG.simulation.defaultTimeScale;
    this.accumulator = 0;
    this.tickTimer = 0;
    this.alpha = 0;           // fraction du pas restant, pour l'interpolation du rendu
    this.lastSteps = 0;

    // Partagé par référence avec Routine et Epidemic : survit à la régénération de la ville.
    const e = CONFIG.epidemic;
    this.settings = {
      transmission: e.transmission.default / 100,
      virulence: e.virulence.default / 100,
      responsibility: e.responsibility.default / 100,
      prudence: e.prudence.default / 100,
      closeNightclubs: false,
      closeCommerce: false,
      telework: false,
    };
  }

  load(city, count, seed) {
    this.city = city;
    this.clock = new Clock();
    this.population = new Population(city, seed);
    this.routine = new Routine(this.population, city, this.clock, this.settings, seed);
    this.population.routine = this.routine;
    this.population.setCount(count);
    this.epidemic = new Epidemic(this.population, city, this.clock, this.routine, seed, this.settings);
    this.zombies = new Zombies(
      this.population, city, this.clock, this.routine, seed, this.zombieSettings, this.settings,
    );
    this.population.zombies = this.zombies;
    this.cult = new Cult(
      this.population, city, this.clock, this.routine, seed, this.cultSettings, this.epidemic, this.zombies,
    );
    this.population.cult = this.cult;
    this.accumulator = 0;
    this.tickTimer = 0;
    this.alpha = 0;
  }

  setTimeScale(scale) {
    this.timeScale = scale;
  }

  setPopulation(count) {
    if (!this.population) return;
    this.population.setCount(count);
    this.epidemic.recount();
    this.zombies.recount();
    this.cult.onPopulationChanged();
  }

  /** Réglage des sectes (déjà converti : 0..1, nombre ou booléen). */
  setCultSetting(name, value) {
    this.cultSettings[name] = value;
  }

  /** Curseur (valeur 0..1) ou mesure sanitaire (booléen). */
  setSetting(name, value) {
    this.settings[name] = value;
    // Une fermeture fait sortir les occupants sans attendre la fin de leur activité.
    if (this.routine && typeof value === 'boolean') this.routine.tick();
  }

  /** Réglage du mode zombie (déjà converti : 0..1, px, h, jours ou booléen). */
  setZombieSetting(name, value) {
    this.zombieSettings[name] = value;
  }

  update(frameDt) {
    if (!this.population || this.timeScale <= 0) {
      this.lastSteps = 0;
      return;
    }

    const { fixedDt, maxStepsPerFrame, tickInterval } = CONFIG.simulation;
    this.accumulator += frameDt * this.timeScale;

    let steps = 0;
    while (this.accumulator >= fixedDt && steps < maxStepsPerFrame) {
      this.clock.advance(fixedDt);
      this.population.step(fixedDt);
      this.zombies.step(fixedDt);
      this.cult.step(fixedDt);
      this.tickTimer += fixedDt;
      if (this.tickTimer >= tickInterval) {
        this.tickTimer -= tickInterval;
        this.epidemic.tick(tickInterval);
        this.zombies.tick(tickInterval);
        this.cult.tick(tickInterval);
        this.routine.tick();
      }
      this.accumulator -= fixedDt;
      steps++;
    }
    // Si la machine ne suit pas, on abandonne le retard plutôt que de l'accumuler.
    if (steps === maxStepsPerFrame && this.accumulator > fixedDt) {
      this.accumulator = fixedDt * 0.5;
    }

    this.alpha = this.accumulator / fixedDt;
    this.lastSteps = steps;
  }
}
