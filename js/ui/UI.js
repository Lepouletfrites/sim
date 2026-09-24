import { CONFIG } from '../config.js';
import { EpidemicChart } from './EpidemicChart.js';
import { PlaceType, STREET, PLACE_LABELS, describeSchedule, isOpen } from '../world/PlaceTypes.js';
import { CONTAGION_PLACES } from '../epidemic/Epidemic.js';

const $ = (selector) => document.querySelector(selector);
const percent = (v) => `${Math.round(v)} %`;

/** Curseurs de l'épidémie : clé du réglage = suffixe de l'id du slider. */
const EPIDEMIC_SLIDERS = ['transmission', 'virulence', 'responsibility', 'prudence'];
const POLICIES = ['closeNightclubs', 'closeCommerce', 'telework'];
const PLACES_SHOWN = [
  PlaceType.HOME, PlaceType.WORK, PlaceType.MALL, PlaceType.RESTAURANT,
  PlaceType.NIGHTCLUB, PlaceType.HOSPITAL, STREET,
];
const EPIDEMIC_COUNTS = [
  'susceptible', 'carriers', 'sickOut', 'toHospital', 'hospitalized',
  'quarantined', 'bedridden', 'recovered', 'dead', 'masked', 'confined', 'severe',
];
const SPEED_KEYS = { 1: 1, 2: 5, 3: 10, 4: 25, 5: 50 };

/**
 * Panneau latéral : lie le DOM aux callbacks de l'application.
 * Ne contient aucune logique de simulation.
 */
export class UI {
  constructor({
    onTimeScale,
    onTogglePause,
    onPopulation,
    onDensity,
    onRegenerate,
    onSetting,
    onInfect,
    onResetEpidemic,
  }) {
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
      clock: $('#hud-clock'),
      day: $('#hud-day'),
      sky: $('#hud-sky'),
      timeButtons: [...document.querySelectorAll('[data-scale]')],
      infect: $('#btn-infect'),
      resetEpidemic: $('#btn-reset-epidemic'),
      awarenessValue: $('#value-awareness'),
      awarenessMeter: $('#meter-awareness'),
      lethality: $('#stat-lethality'),
      counts: Object.fromEntries(EPIDEMIC_COUNTS.map((key) => [key, $(`#stat-${key}`)])),
    };

    this.chart = new EpidemicChart($('#epidemic-chart'), $('#chart-tooltip'));
    this.buildPlacesList();
    this.buildContagionBars();
    this.applyLegendColors();
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

    for (const key of EPIDEMIC_SLIDERS) {
      const slider = $(`#slider-${key}`);
      const output = $(`#value-${key}`);
      slider.addEventListener('input', () => {
        const value = Number(slider.value);
        output.textContent = percent(value);
        onSetting(key, value / 100);
      });
    }

    for (const key of POLICIES) {
      const checkbox = $(`#policy-${key}`);
      checkbox.addEventListener('change', () => onSetting(key, checkbox.checked));
    }

    this.el.infect.addEventListener('click', onInfect);
    this.el.resetEpidemic.addEventListener('click', onResetEpidemic);

    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
      if (event.code === 'Space') {
        event.preventDefault();
        onTogglePause();
      } else if (SPEED_KEYS[event.key]) {
        onTimeScale(SPEED_KEYS[event.key]);
      } else if (event.key === 'i' || event.key === 'I') {
        onInfect();
      }
    });
  }

  // ------------------------------------------------------------ Construction

  buildPlacesList() {
    const list = $('#places-list');
    this.placeRows = {};
    for (const type of PLACES_SHOWN) {
      const li = document.createElement('li');
      const hours = type === STREET ? 'Promenades et trajets' : describeSchedule(type);
      li.innerHTML = `
        <i class="swatch" data-place="${type}"></i>
        <span class="places__name">${PLACE_LABELS[type]} <span class="badge"></span></span>
        <b>0</b>
        <span class="places__hours">${hours}</span>`;
      list.appendChild(li);
      this.placeRows[type] = { count: li.querySelector('b'), badge: li.querySelector('.badge') };
    }
  }

  buildContagionBars() {
    const list = $('#contagion-bars');
    this.bars = {};
    for (const type of CONTAGION_PLACES) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${PLACE_LABELS[type]}</span>
        <span class="bars__track"><span class="bars__fill"></span></span>
        <b>0</b>`;
      const fill = li.querySelector('.bars__fill');
      fill.style.display = 'block';
      fill.style.background = CONFIG.colors.places[type].stroke;
      list.appendChild(li);
      this.bars[type] = { fill, value: li.querySelector('b') };
    }
  }

  /** Les couleurs de la légende viennent de la config : une seule source de vérité. */
  applyLegendColors() {
    const colors = CONFIG.colors;
    for (const dot of document.querySelectorAll('.dot[data-health]')) {
      const color = colors.health[Number(dot.dataset.health)];
      dot.style.background = color;
      dot.style.setProperty('--cross-color', color);
    }
    for (const dot of document.querySelectorAll('.dot--ring-hospital')) {
      dot.style.setProperty('--ring-color', colors.hospitalRing);
    }
    for (const dot of document.querySelectorAll('.dot--ring-home')) {
      dot.style.setProperty('--ring-color', colors.homeRing);
    }
    for (const swatch of document.querySelectorAll('.swatch[data-place]')) {
      const style = colors.places[swatch.dataset.place];
      swatch.style.background = style.fill;
      swatch.style.borderColor = style.stroke;
    }
  }

  setupSliders() {
    const { citizens, city, epidemic } = CONFIG;
    const init = (slider, output, { min, max, default: value }, step, format = (v) => v) => {
      Object.assign(slider, { min, max, step, value });
      output.textContent = format(value);
    };

    init(this.el.popSlider, this.el.popValue, citizens, citizens.step);
    init(this.el.densitySlider, this.el.densityValue, city.density, 1);
    for (const key of EPIDEMIC_SLIDERS) {
      init($(`#slider-${key}`), $(`#value-${key}`), epidemic[key], 1, percent);
    }
  }

  // ------------------------------------------------------------ Mises à jour

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

  /** Horloge : mise à jour à chaque frame (texte court, peu coûteux). */
  updateClock(clock) {
    this.el.clock.textContent = clock.format();
    this.el.day.textContent = `Jour ${clock.day}`;
    this.el.sky.textContent = clock.daylight > 0.5 ? '☀' : '☾';
  }

  updateStats({ fps, steps, simulation }) {
    this.el.fps.textContent = Math.round(fps);
    this.el.steps.textContent = steps;
    const epidemic = simulation.epidemic;
    if (!epidemic) return;

    const counts = epidemic.counts;
    this.el.population.textContent = counts.alive;
    for (const key of EPIDEMIC_COUNTS) this.el.counts[key].textContent = counts[key];
    this.el.counts.hospitalized.textContent = `${counts.hospitalized} / ${epidemic.hospitalCapacity}`;
    this.el.lethality.textContent = percent(epidemic.lethality * 100);

    const awareness = epidemic.awareness * 100;
    this.el.awarenessValue.textContent = percent(awareness);
    this.el.awarenessMeter.style.width = `${awareness}%`;

    // Occupation des lieux et ouverture
    for (const type of PLACES_SHOWN) {
      const row = this.placeRows[type];
      row.count.textContent = epidemic.byPlace[type];
      if (type === STREET || !CONFIG.places.schedule[type]) {
        row.badge.hidden = true;
        continue;
      }
      const open = isOpen(type, simulation.clock, simulation.settings);
      row.badge.hidden = false;
      row.badge.textContent = open ? 'ouvert' : 'fermé';
      row.badge.className = `badge ${open ? 'badge--open' : 'badge--closed'}`;
    }

    // Répartition des contaminations par lieu
    const infections = epidemic.infectionsByPlace;
    let total = 0;
    for (const type of CONTAGION_PLACES) total += infections[type];
    for (const type of CONTAGION_PLACES) {
      const share = total > 0 ? infections[type] / total : 0;
      this.bars[type].fill.style.width = `${share * 100}%`;
      this.bars[type].value.textContent = total > 0 ? percent(share * 100) : '—';
    }

    this.chart.setData(epidemic.history, epidemic.historyVersion);
  }
}
