import { CONFIG } from '../config.js';
import { EpidemicChart, CHART_BANDS } from './EpidemicChart.js';
import { ZombiePanel } from './ZombiePanel.js';
import { CultPanel } from './CultPanel.js';
import { CrimePanel } from './CrimePanel.js';
import { OverviewPanel } from './OverviewPanel.js';
import { renderLog } from './LogList.js';
import { PlaceType, STREET, PLACE_LABELS, describeSchedule, isOpen } from '../world/PlaceTypes.js';
import { CONTAGION_PLACES } from '../epidemic/Epidemic.js';
import { Health } from '../agents/Citizen.js';

const $ = (selector) => document.querySelector(selector);
const percent = (v) => `${Math.round(v)} %`;

/** Curseurs de l'épidémie : clé du réglage = suffixe de l'id du slider. */
const EPIDEMIC_SLIDERS = ['transmission', 'virulence', 'responsibility', 'prudence'];
const POLICIES = ['closeNightclubs', 'closeCommerce', 'closeSchools', 'telework', 'tracing'];
const formatDays = (v) => (v === 0 ? 'à vie' : `${v} j`);
const CITY_SLIDERS = ['density', 'chaos', 'green'];
const PLACES_SHOWN = [
  PlaceType.HOME, PlaceType.WORK, PlaceType.SCHOOL, PlaceType.MALL, PlaceType.SHOP, PlaceType.RESTAURANT,
  PlaceType.BAR, PlaceType.BANK,
  PlaceType.NIGHTCLUB, PlaceType.HOSPITAL, PlaceType.TEMPLE, STREET,
];
/** Action du clic sur la carte (les boutons [data-click] de tous les onglets restent synchronisés). */
const CLICK_HINTS = {
  infect: 'Clic sur la carte : infecter l\'habitant le plus proche (virus)',
  zombie: 'Clic sur la carte : transformer l\'habitant le plus proche en zombie',
  strike: 'Clic sur la carte : frappe aérienne (rayon 45 px, humains compris)',
  guru: 'Clic sur la carte : l\'habitant le plus proche fonde une secte',
  fire: 'Clic sur la carte : mettre le feu au bâtiment',
  thief: 'Clic sur la carte : l\'habitant le plus proche bascule dans la délinquance',
};
/** Compteurs affichés tels quels : clé de `epidemic.counts` = suffixe de l'id. */
const COUNTS = [
  'susceptible', 'carriers', 'sickOut', 'recovered', 'toHospital',
  'quarantined', 'bedridden', 'waitingBed', 'severe', 'masked', 'confined', 'tracedIsolated', 'reinfected',
];
/** Segments de la barre d'état de santé, dans l'ordre d'évolution de la maladie. */
const HEALTH_SEGMENTS = [
  { health: Health.SUSCEPTIBLE, value: (c) => c.susceptible },
  { health: Health.INCUBATING, value: (c) => c.carriers },
  { health: Health.SYMPTOMATIC, value: (c) => c.symptomatic },
  { health: Health.RECOVERED, value: (c) => c.recovered },
  { health: Health.DEAD, value: (c) => c.dead },
];
const SPEED_KEYS = { 1: 1, 2: 5, 3: 10, 4: 25, 5: 50 };
const TAB_STORAGE_KEY = 'citysim.tab';

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // stockage indisponible (navigation privée...) : valeur par défaut
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // sans importance
    }
  },
};

/**
 * Groupe d'onglets accessible : clic, flèches gauche/droite, onglet actif mémorisé.
 * Chaque bouton désigne son panneau par aria-controls ; `dataKey` est l'attribut data-* qui le nomme.
 */
function setupTabGroup(buttons, storageKey, dataKey) {
  const select = (tab, remember = true) => {
    for (const t of buttons) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    }
    if (remember) storage.set(storageKey, tab.dataset[dataKey]);
  };

  const saved = storage.get(storageKey);
  select(buttons.find((t) => t.dataset[dataKey] === saved) ?? buttons[0], false);

  buttons.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      select(next);
      next.focus();
    });
  });
}

/**
 * Interface : barre d'outils au-dessus de la carte, légende de la carte et
 * panneau latéral à onglets. Lie le DOM aux callbacks de l'application,
 * sans aucune logique de simulation.
 */
export class UI {
  constructor({
    onTimeScale,
    onTogglePause,
    onPopulation,
    onCityOptions,
    onRegenerate,
    onSeed,
    onSetting,
    onInfect,
    onResetEpidemic,
    onZombieSetting,
    onReleaseZombie,
    onHorde,
    onResetZombies,
    onCultSetting,
    onGuru,
    onPoliceRaid,
    onResetCult,
    onCrimeSetting,
    onHeist,
    onResetCrime,
  }) {
    this.crimePanel = new CrimePanel({ onSetting: onCrimeSetting, onHeist, onReset: onResetCrime });
    this.overview = new OverviewPanel({ onOpenTab: (tab, subtab) => this.openTab(tab, subtab) });
    this.virusLogVersion = -1;
    this.zombiePanel = new ZombiePanel({
      onSetting: onZombieSetting,
      onRelease: onReleaseZombie,
      onHorde,
      onReset: onResetZombies,
    });
    this.cultPanel = new CultPanel({
      onSetting: onCultSetting,
      onGuru,
      onPoliceRaid,
      onReset: onResetCult,
    });
    this.el = {
      clock: $('#hud-clock'),
      day: $('#hud-day'),
      sky: $('#hud-sky'),
      speedButtons: [...document.querySelectorAll('[data-scale]')],
      kpiAlive: $('#kpi-alive'),
      kpiInfected: $('#kpi-infected'),
      kpiDead: $('#kpi-dead'),
      kpiZombies: $('#kpi-zombies'),
      kpiZombiesBox: $('#kpi-zombies-box'),
      kpiCult: $('#kpi-cult'),
      kpiCultBox: $('#kpi-cult-box'),
      kpiCrime: $('#kpi-crime'),
      kpiCrimeBox: $('#kpi-crime-box'),
      hint: $('#legend-hint'),
      pauseBadge: $('#pause-badge'),
      active: $('#stat-active'),
      dead: $('#stat-dead'),
      deadRow: $('#stat-dead-row'),
      lethality: $('#stat-lethality'),
      hospitalized: $('#stat-hospitalized'),
      hospitalMeter: $('#meter-hospital'),
      awarenessValue: $('#value-awareness'),
      awarenessMeter: $('#meter-awareness'),
      counts: Object.fromEntries(COUNTS.map((key) => [key, $(`#stat-${key}`)])),
      popSlider: $('#slider-population'),
      popValue: $('#value-population'),
      fps: $('#stat-fps'),
      steps: $('#stat-steps'),
      buildings: $('#stat-buildings'),
      seed: $('#stat-seed'),
    };

    this.chart = new EpidemicChart($('#epidemic-chart'), $('#chart-tooltip'));
    this.setupTabs();
    this.buildChartLegend();
    this.buildHealthBar();
    this.buildPlacesList();
    this.buildContagionBars();
    this.applyLegendColors();
    this.setupSliders();

    this.clickButtons = [...document.querySelectorAll('[data-click]')];
    for (const button of this.clickButtons) {
      button.addEventListener('click', () => this.setClickMode(button.dataset.click));
    }
    this.setClickMode('infect');

    // Sur petit écran, la légende repliée laisse la carte visible.
    if (window.matchMedia('(max-width: 860px)').matches) $('#map-legend').open = false;

    for (const button of this.el.speedButtons) {
      button.addEventListener('click', () => onTimeScale(Number(button.dataset.scale)));
    }

    this.el.popSlider.addEventListener('input', () => {
      const value = Number(this.el.popSlider.value);
      this.el.popValue.textContent = value;
      onPopulation(value);
    });

    // Forme de la ville : la régénération est coûteuse, on attend le relâchement du curseur.
    for (const key of CITY_SLIDERS) {
      const slider = $(`#slider-${key}`);
      const output = $(`#value-${key}`);
      const format = key === 'density' ? (v) => v : percent;
      slider.addEventListener('input', () => {
        output.textContent = format(Number(slider.value));
      });
      slider.addEventListener('change', () => onCityOptions());
    }
    $('#toggle-river').addEventListener('change', () => onCityOptions());

    $('#btn-regenerate').addEventListener('click', onRegenerate);
    const seedInput = $('#seed-input');
    const applySeed = () => {
      const value = Number.parseInt(seedInput.value, 10);
      if (Number.isFinite(value) && value >= 0) onSeed(value >>> 0);
    };
    $('#btn-seed').addEventListener('click', applySeed);
    seedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') applySeed();
    });
    $('#btn-infect').addEventListener('click', onInfect);
    $('#btn-reset-epidemic').addEventListener('click', onResetEpidemic);

    for (const key of EPIDEMIC_SLIDERS) {
      const slider = $(`#slider-${key}`);
      const output = $(`#value-${key}`);
      slider.addEventListener('input', () => {
        const value = Number(slider.value);
        output.textContent = percent(value);
        onSetting(key, value / 100);
      });
    }

    const immunity = $('#slider-immunity');
    immunity.addEventListener('input', () => {
      const value = Number(immunity.value);
      $('#value-immunity').textContent = formatDays(value);
      onSetting('immunity', value);
    });

    for (const key of POLICIES) {
      const checkbox = $(`#policy-${key}`);
      checkbox.addEventListener('change', () => onSetting(key, checkbox.checked));
    }

    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
      if (event.code === 'Space') {
        event.preventDefault();
        onTogglePause();
      } else if (SPEED_KEYS[event.key]) {
        onTimeScale(SPEED_KEYS[event.key]);
      } else if (event.key === 'i' || event.key === 'I') {
        onInfect();
      } else if (event.key === 'g' || event.key === 'G') {
        onGuru();
      }
    });
  }

  // ------------------------------------------------------------ Construction

  /** Ouvre un onglet principal (et, au besoin, un de ses sous-onglets). */
  openTab(tab, subtab = null) {
    document.querySelector(`.tabs [data-tab="${tab}"]`)?.click();
    if (subtab) document.querySelector(`.subtabs [data-subtab="${subtab}"]`)?.click();
  }

  /** Onglets principaux et sous-onglets de chaque section. */
  setupTabs() {
    setupTabGroup([...document.querySelectorAll('.tabs [role="tab"]')], TAB_STORAGE_KEY, 'tab');
    for (const group of document.querySelectorAll('.subtabs')) {
      const buttons = [...group.querySelectorAll('[role="tab"]')];
      setupTabGroup(buttons, `${TAB_STORAGE_KEY}.${group.getAttribute('aria-label')}`, 'subtab');
    }
  }

  buildChartLegend() {
    const list = $('#chart-legend');
    for (const band of [...CHART_BANDS].reverse()) {
      const li = document.createElement('li');
      li.innerHTML = `<i style="background:${band.color}"></i>${band.label}`;
      list.appendChild(li);
    }
  }

  buildHealthBar() {
    const bar = $('#health-bar');
    this.healthSegments = HEALTH_SEGMENTS.map((segment) => {
      const span = document.createElement('span');
      span.style.background = CONFIG.colors.health[segment.health];
      bar.appendChild(span);
      return { ...segment, span };
    });
  }

  buildPlacesList() {
    const list = $('#places-list');
    this.placeRows = {};
    for (const type of PLACES_SHOWN) {
      const li = document.createElement('li');
      const hours = type === STREET ? 'Promenades et trajets' : describeSchedule(type);
      li.innerHTML = `
        <i class="swatch" data-place="${type}"></i>
        <span class="places__name">${PLACE_LABELS[type]} <span class="badge" hidden></span></span>
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
        <b>—</b>`;
      const fill = li.querySelector('.bars__fill');
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
    for (const dot of document.querySelectorAll('.dot--ring-bitten')) {
      dot.style.background = colors.health[0];
      dot.style.setProperty('--ring-color', colors.bittenRing);
    }
    for (const dot of document.querySelectorAll('.dot--ring-fighter')) {
      dot.style.background = colors.health[0];
      dot.style.setProperty('--ring-color', colors.fighterRing);
    }
    for (const swatch of document.querySelectorAll('.swatch[data-place]')) {
      const style = colors.places[swatch.dataset.place];
      swatch.style.background = style.fill;
      swatch.style.borderColor = style.stroke;
    }
  }

  setupSliders() {
    const { citizens, city, epidemic } = CONFIG;
    const init = (key, { min, max, default: value }, step, format = (v) => v) => {
      Object.assign($(`#slider-${key}`), { min, max, step, value });
      $(`#value-${key}`).textContent = format(value);
    };
    init('population', citizens, citizens.step);
    init('density', city.density, 1);
    init('chaos', city.chaos, 5, percent);
    init('green', city.green, 5, percent);
    $('#toggle-river').checked = city.river;
    for (const key of EPIDEMIC_SLIDERS) init(key, epidemic[key], 1, percent);
    init('immunity', epidemic.immunity, epidemic.immunity.step, formatDays);
  }

  /** Réglages de forme de la ville (densité 1..10, désordre et verdure 0..1, rivière). */
  get cityOptions() {
    return {
      density: Number($('#slider-density').value),
      chaos: Number($('#slider-chaos').value) / 100,
      green: Number($('#slider-green').value) / 100,
      river: $('#toggle-river').checked,
    };
  }

  // ------------------------------------------------------------ Mises à jour

  get population() {
    return Number(this.el.popSlider.value);
  }

  setTimeScale(scale) {
    for (const button of this.el.speedButtons) {
      const active = Number(button.dataset.scale) === scale;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    this.el.pauseBadge.hidden = scale !== 0;
  }

  setCityInfo(city) {
    this.el.buildings.textContent = city.buildings.length;
    this.el.seed.textContent = city.seed;
    $('#seed-input').value = city.seed;
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

    const c = epidemic.counts;
    const infected = c.carriers + c.symptomatic;

    // Barre d'outils
    this.el.kpiAlive.textContent = c.alive;
    this.el.kpiInfected.textContent = infected;
    this.el.kpiDead.textContent = c.dead;

    // Onglet Situation
    this.el.active.textContent = infected;
    this.el.dead.textContent = c.dead;
    this.el.deadRow.textContent = c.dead;
    this.el.lethality.textContent = percent(epidemic.lethality * 100);
    for (const key of COUNTS) this.el.counts[key].textContent = c[key];
    for (const segment of this.healthSegments) {
      const value = segment.value(c);
      segment.span.style.flexGrow = value;
      segment.span.hidden = value === 0; // pas d'espacement pour un segment vide
    }

    const capacity = epidemic.hospitalCapacity;
    this.el.hospitalized.textContent = `${c.hospitalized} / ${capacity}`;
    this.el.hospitalMeter.style.width = `${Math.min(100, (100 * c.hospitalized) / capacity)}%`;
    this.el.hospitalMeter.classList.toggle('is-full', c.hospitalized >= capacity);

    // Dépistage et immunité
    const t = epidemic.testing;
    $('#stat-testsDone').textContent = t.done;
    $('#stat-testsConfirmed').textContent = t.confirmed;
    $('#stat-testsContacts').textContent = t.contacts;
    $('#stat-testsCapacity').textContent = `${epidemic.testsPerDay} tests / jour`;
    $('#stat-lostImmunity').textContent = epidemic.lostImmunity;
    $('#testing-note').textContent = !simulation.settings.tracing
      ? 'Activez « Dépistage et traçage » dans les réglages.'
      : t.day === simulation.clock.day && t.today >= epidemic.testsPerDay ? 'Laboratoire saturé : les résultats prennent du retard.'
        : `${t.pending} test${t.pending > 1 ? 's' : ''} en attente de résultat.`;

    // Onglet Réglages
    const awareness = epidemic.awareness * 100;
    this.el.awarenessValue.textContent = percent(awareness);
    this.el.awarenessMeter.style.width = `${awareness}%`;

    // Onglet Ville : occupation et ouverture des lieux
    for (const type of PLACES_SHOWN) {
      const row = this.placeRows[type];
      row.count.textContent = epidemic.byPlace[type];
      if (type === STREET || !CONFIG.places.schedule[type]) continue;
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

    // Apocalypse
    const zombies = simulation.zombies;
    if (zombies) {
      this.el.kpiZombiesBox.hidden = !zombies.active;
      this.el.kpiZombies.textContent = zombies.counts.zombies;
      this.zombiePanel.update(zombies);
    }

    // Sectes
    const cult = simulation.cult;
    if (cult) {
      this.el.kpiCultBox.hidden = !cult.active;
      this.el.kpiCult.textContent = cult.counts.members;
      this.cultPanel.update(cult);
    }

    // Crime et économie
    const crime = simulation.crime;
    if (crime) {
      const recent = crime.recent.total ?? 0;
      this.el.kpiCrimeBox.hidden = recent === 0;
      this.el.kpiCrime.textContent = recent;
      this.crimePanel.update(crime, simulation.economy);
    }

    // Journal de l'épidémie, vue d'ensemble et fil d'actualité commun
    const news = simulation.news;
    if (news && simulation.population) {
      if (news.version !== this.virusLogVersion) {
        this.virusLogVersion = news.version;
        renderLog($('#virus-log'), news.items.filter((n) => n.source === 'virus').slice(0, 40));
      }
      this.overview.update(simulation);
    }
  }

  setClickMode(mode) {
    this.clickMode = mode;
    for (const button of this.clickButtons) {
      button.setAttribute('aria-checked', String(button.dataset.click === mode));
    }
    this.el.hint.textContent = CLICK_HINTS[mode];
  }
}
