import { CONFIG } from '../config.js';
import { Population } from '../agents/Population.js';

/**
 * Orchestre le temps simulé : timeScale + accumulateur à pas fixe.
 * À x5, la physique exécute 5 sous-étapes de 1/60 s par frame au lieu
 * d'un seul grand pas, ce qui empêche les agents de traverser les murs.
 */
export class Simulation {
  constructor() {
    this.city = null;
    this.population = null;
    this.timeScale = CONFIG.simulation.defaultTimeScale;
    this.accumulator = 0;
    this.alpha = 0;           // fraction du pas restant, pour l'interpolation du rendu
    this.lastSteps = 0;
  }

  load(city, count, seed) {
    this.city = city;
    this.population = new Population(city, seed);
    this.population.setCount(count);
    this.accumulator = 0;
    this.alpha = 0;
  }

  setTimeScale(scale) {
    this.timeScale = scale;
  }

  setPopulation(count) {
    if (this.population) this.population.setCount(count);
  }

  update(frameDt) {
    if (!this.population || this.timeScale <= 0) {
      this.lastSteps = 0;
      return;
    }

    const { fixedDt, maxStepsPerFrame } = CONFIG.simulation;
    this.accumulator += frameDt * this.timeScale;

    let steps = 0;
    while (this.accumulator >= fixedDt && steps < maxStepsPerFrame) {
      this.population.step(fixedDt);
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
