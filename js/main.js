import { CONFIG } from './config.js';
import { Random } from './core/Random.js';
import { GameLoop } from './core/GameLoop.js';
import { Simulation } from './core/Simulation.js';
import { generateCity } from './world/CityGenerator.js';
import { City } from './world/City.js';
import { Renderer } from './render/Renderer.js';
import { UI } from './ui/UI.js';

const STATS_INTERVAL = 0.25; // secondes entre deux mises à jour du DOM
const RESIZE_DEBOUNCE = 150; // ms

const mapContainer = document.getElementById('map');
const canvas = document.getElementById('city-canvas');

const state = {
  seed: Random.randomSeed(),
  lastActiveScale: CONFIG.simulation.defaultTimeScale,
};

const renderer = new Renderer(canvas);
const simulation = new Simulation();

const ui = new UI({
  onTimeScale: setTimeScale,
  onTogglePause: () => setTimeScale(simulation.timeScale > 0 ? 0 : state.lastActiveScale),
  onPopulation: (count) => simulation.setPopulation(count),
  onCityOptions: () => buildWorld(),
  onSeed: (seed) => {
    state.seed = seed;
    buildWorld();
  },
  onRegenerate: () => {
    state.seed = Random.randomSeed();
    buildWorld();
  },
  onSetting: (name, value) => {
    simulation.setSetting(name, value);
    refreshStats();
  },
  onInfect: () => {
    if (simulation.epidemic) simulation.epidemic.infectRandom();
    refreshStats();
  },
  onResetEpidemic: () => {
    if (simulation.epidemic) simulation.epidemic.reset();
    refreshStats();
  },
  onZombieSetting: (name, value) => simulation.setZombieSetting(name, value),
  onReleaseZombie: () => zombieAction((z) => z.releaseZombie()),
  onHorde: () => zombieAction((z) => z.releaseHorde(10)),
  onResetZombies: () => zombieAction((z) => z.reset()),
});

function zombieAction(action) {
  if (!simulation.zombies) return;
  action(simulation.zombies);
  refreshStats();
}

// Clic sur la carte : selon le mode choisi dans l'onglet Zombies.
canvas.addEventListener('click', (event) => {
  const { offsetX: x, offsetY: y } = event;
  switch (ui.clickMode) {
    case 'zombie':
      zombieAction((z) => z.zombieAt(x, y, 30));
      break;
    case 'strike':
      zombieAction((z) => z.airStrike(x, y));
      break;
    default:
      if (simulation.epidemic && simulation.epidemic.infectAt(x, y, 30)) refreshStats();
  }
});

function refreshStats() {
  ui.updateStats({
    fps: loop.fps,
    steps: simulation.lastSteps,
    simulation,
  });
}

function setTimeScale(scale) {
  if (scale > 0) state.lastActiveScale = scale;
  simulation.setTimeScale(scale);
  ui.setTimeScale(scale);
}

/** (Re)génère la ville aux dimensions actuelles du canvas. */
function buildWorld() {
  const { width, height } = renderer;
  if (width < 50 || height < 50) return;
  const { density, ...options } = ui.cityOptions;
  const city = new City(generateCity(width, height, state.seed, density, options));
  simulation.load(city, ui.population, state.seed);
  renderer.setCity(city);
  ui.setCityInfo(city);
  refreshStats();
}

// --- Redimensionnement : le canvas suit son conteneur. La ville n'est régénérée
// (même graine) que si la taille change vraiment : quelques pixels (barre de
// défilement qui apparaît) ne doivent pas effacer la partie en cours.
const RESIZE_REBUILD_MIN = 40; // px
let resizeTimer = 0;
let builtSize = null;
new ResizeObserver(([entry]) => {
  const width = Math.floor(entry.contentRect.width);
  const height = Math.floor(entry.contentRect.height);
  renderer.resize(width, height);
  clearTimeout(resizeTimer);
  if (builtSize === null) {
    builtSize = { width, height };
    buildWorld();
    return;
  }
  const changed =
    Math.abs(width - builtSize.width) >= RESIZE_REBUILD_MIN ||
    Math.abs(height - builtSize.height) >= RESIZE_REBUILD_MIN;
  if (!changed) return;
  resizeTimer = setTimeout(() => {
    builtSize = { width: renderer.width, height: renderer.height };
    buildWorld();
  }, RESIZE_DEBOUNCE);
}).observe(mapContainer);

// --- Boucle principale
let statsTimer = 0;
const loop = new GameLoop({
  maxFrameDt: CONFIG.simulation.maxFrameDt,
  update(dt) {
    simulation.update(dt);
    statsTimer += dt;
    if (statsTimer >= STATS_INTERVAL) {
      statsTimer = 0;
      refreshStats();
    }
  },
  render() {
    const citizens = simulation.population ? simulation.population.citizens : null;
    renderer.render(citizens, simulation.alpha, simulation);
    ui.updateClock(simulation.clock);
  },
});

setTimeScale(CONFIG.simulation.defaultTimeScale);
loop.start();
