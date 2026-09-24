import { CONFIG } from '../config.js';

const $ = (selector) => document.querySelector(selector);

/**
 * Panneau latéral : lie le DOM aux callbacks de l'application.
 * Ne contient aucune logique de simulation.
 */
export class UI {
  constructor({ onTimeScale, onTogglePause, onPopulation, onDensity, onRegenerate }) {
    this.el = {
      population: $('#stat-population'),
      fps: $('#stat-fps'),
      buildings: $('#stat-buildings'),
      steps: $('#stat-steps'),
      seed: $('#stat-seed'),
      popSlider: $('#slider-population'),
      popValue: $('#value-population'),
      densitySlider: $('#slider-density'),
      densityValue: $('#value-density'),
      regenerate: $('#btn-regenerate'),
      pauseBadge: $('#pause-badge'),
      timeButtons: [...document.querySelectorAll('[data-scale]')],
    };

    this.setupSliders();

    for (const button of this.el.timeButtons) {
      button.addEventListener('click', () => onTimeScale(Number(button.dataset.scale)));
    }

    this.el.popSlider.addEventListener('input', () => {
      const value = Number(this.el.popSlider.value);
      this.el.popValue.textContent = value;
      onPopulation(value);
    });

    this.el.densitySlider.addEventListener('input', () => {
      this.el.densityValue.textContent = this.el.densitySlider.value;
    });
    // La régénération est coûteuse : on attend le relâchement du slider.
    this.el.densitySlider.addEventListener('change', () => {
      onDensity(Number(this.el.densitySlider.value));
    });

    this.el.regenerate.addEventListener('click', onRegenerate);

    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
      if (event.code === 'Space') {
        event.preventDefault();
        onTogglePause();
      } else if (event.key === '1' || event.key === '2' || event.key === '5') {
        onTimeScale(Number(event.key));
      }
    });
  }

  setupSliders() {
    const { citizens, city } = CONFIG;
    Object.assign(this.el.popSlider, {
      min: citizens.min,
      max: citizens.max,
      step: citizens.step,
      value: citizens.default,
    });
    this.el.popValue.textContent = citizens.default;

    Object.assign(this.el.densitySlider, {
      min: city.density.min,
      max: city.density.max,
      step: 1,
      value: city.density.default,
    });
    this.el.densityValue.textContent = city.density.default;
  }

  get population() {
    return Number(this.el.popSlider.value);
  }

  get density() {
    return Number(this.el.densitySlider.value);
  }

  setTimeScale(scale) {
    for (const button of this.el.timeButtons) {
      button.classList.toggle('is-active', Number(button.dataset.scale) === scale);
    }
    this.el.pauseBadge.hidden = scale !== 0;
  }

  setCityInfo(city) {
    this.el.buildings.textContent = city.buildings.length;
    this.el.seed.textContent = city.seed;
  }

  updateStats({ population, fps, steps }) {
    this.el.population.textContent = population;
    this.el.fps.textContent = Math.round(fps);
    this.el.steps.textContent = steps;
  }
}
