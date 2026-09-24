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

const viewport = document.getElementById('viewport');
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
  onDensity: () => buildWorld(),
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
});

// Clic sur la carte : infecte l'habitant sain le plus proche.
canvas.addEventListener('click', (event) => {
  if (simulation.epidemic && simulation.epidemic.infectAt(event.offsetX, event.offsetY, 30)) {
    refreshStats();
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
  const city = new City(generateCity(width, height, state.seed, ui.density));
  simulation.load(city, ui.population, state.seed);
  renderer.setCity(city);
  ui.setCityInfo(city);
  refreshStats();
}

// --- Redimensionnement : le canvas suit son conteneur, la ville est régénérée
// avec la même graine une fois le redimensionnement terminé.
let resizeTimer = 0;
let firstResize = true;
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  renderer.resize(Math.floor(width), Math.floor(height));
  clearTimeout(resizeTimer);
  if (firstResize) {
    firstResize = false;
    buildWorld();
  } else {
    resizeTimer = setTimeout(buildWorld, RESIZE_DEBOUNCE);
  }
}).observe(viewport);

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
