import { CONFIG } from '../config.js';
import { EpidemicChart } from './EpidemicChart.js';
import { ZOMBIE_SLIDERS, ZOMBIE_TOGGLES, sliderToSetting } from '../zombie/Zombies.js';

const $ = (selector) => document.querySelector(selector);

/** Bandes de la courbe, de bas en haut. */
const ZOMBIE_BANDS = [
  { key: 'lost', label: 'Pertes', color: CONFIG.colors.humanLoss },
  { key: 'zombies', label: 'Zombies', color: CONFIG.colors.zombie },
  { key: 'bitten', label: 'Mordus', color: CONFIG.colors.bittenRing },
  { key: 'humans', label: 'Humains', color: CONFIG.colors.health[0] },
];

const CLICK_HINTS = {
  infect: 'Clic sur la carte : infecter l\'habitant le plus proche (virus)',
  zombie: 'Clic sur la carte : transformer l\'habitant le plus proche en zombie',
  strike: 'Clic sur la carte : frappe aérienne (rayon 45 px, humains compris)',
};

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Texte affiché pour la valeur d'un curseur selon son unité. */
function formatValue(slider, value) {
  switch (slider.unit) {
    case '%': return `${value} %`;
    case 'h': return value === 0 ? 'immédiat' : `${value} h`;
    case 'j': return value === 0 ? 'jamais' : `${value} j`;
    default: return `${value} ${slider.unit}`;
  }
}

/**
 * Onglet "Zombies" : déclencheurs, action du clic, état de l'apocalypse,
 * courbe, remède, journal et réglages.
 */
export class ZombiePanel {
  constructor({ onSetting, onRelease, onHorde, onReset }) {
    this.el = {
      status: $('#zombie-status'),
      statusTitle: $('#zombie-status-title'),
      statusText: $('#zombie-status-text'),
      cure: $('#zstat-cure'),
      cureMeter: $('#meter-cure'),
      log: $('#zombie-log'),
      hint: $('#legend-hint'),
      stats: {},
    };
    for (const key of ['humans', 'zombies', 'bitten', 'lost', 'barricaded', 'fighters', 'destroyed', 'devoured', 'killed', 'cured']) {
      this.el.stats[key] = $(`#zstat-${key}`);
    }

    this.chart = new EpidemicChart($('#zombie-chart'), $('#zombie-chart-tooltip'), {
      bands: ZOMBIE_BANDS,
      emptyText: 'Aucun zombie pour l\'instant',
    });
    const legend = $('#zombie-chart-legend');
    for (const band of [...ZOMBIE_BANDS].reverse()) {
      const li = document.createElement('li');
      li.innerHTML = `<i style="background:${band.color}"></i>${band.label}`;
      legend.appendChild(li);
    }

    // Curseurs et interrupteurs
    const cfg = CONFIG.zombie;
    for (const slider of ZOMBIE_SLIDERS) {
      const input = $(`#zslider-${slider.key}`);
      const output = $(`#zvalue-${slider.key}`);
      const { min, max, default: value } = cfg[slider.key];
      Object.assign(input, { min, max, step: 1, value });
      output.textContent = formatValue(slider, value);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        output.textContent = formatValue(slider, v);
        onSetting(slider.key, sliderToSetting(slider, v));
      });
    }
    for (const key of ZOMBIE_TOGGLES) {
      const checkbox = $(`#ztoggle-${key}`);
      checkbox.checked = cfg[key];
      checkbox.addEventListener('change', () => onSetting(key, checkbox.checked));
    }

    $('#btn-zombie').addEventListener('click', onRelease);
    $('#btn-horde').addEventListener('click', onHorde);
    $('#btn-reset-zombies').addEventListener('click', onReset);

    // Action du clic sur la carte
    this.clickButtons = [...document.querySelectorAll('[data-click]')];
    for (const button of this.clickButtons) {
      button.addEventListener('click', () => this.setClickMode(button.dataset.click));
    }
    this.setClickMode('infect');
    this.eventsVersion = -1;
  }

  setClickMode(mode) {
    this.clickMode = mode;
    for (const button of this.clickButtons) {
      button.setAttribute('aria-checked', String(button.dataset.click === mode));
    }
    this.el.hint.textContent = CLICK_HINTS[mode];
  }

  update(zombies) {
    const c = zombies.counts;
    const s = this.el.stats;
    s.humans.textContent = c.humans;
    s.zombies.textContent = c.zombies;
    s.bitten.textContent = c.bitten;
    s.lost.textContent = c.devoured + c.killed;
    s.barricaded.textContent = c.barricaded;
    s.fighters.textContent = zombies.alarm ? c.fighters : '—';
    s.destroyed.textContent = c.destroyed;
    s.devoured.textContent = c.devoured;
    s.killed.textContent = c.killed;
    s.cured.textContent = zombies.totalCured;

    const cure = Math.round(zombies.cure * 100);
    this.el.cure.textContent = zombies.cureReady ? 'prêt' : `${cure} %`;
    this.el.cureMeter.style.width = `${cure}%`;

    this.updateStatus(zombies);
    this.updateLog(zombies);
    this.chart.setData(zombies.history, zombies.historyVersion);
  }

  updateStatus(zombies) {
    const c = zombies.counts;
    let level = 'calm';
    let title = 'Ville épargnée';
    let text = 'Aucun zombie. Lâchez-en un pour commencer.';
    if (zombies.active) {
      if (c.humans === 0 && c.bitten === 0) {
        level = 'fallen';
        title = 'La ville est tombée';
        text = 'Il ne reste plus un seul humain.';
      } else if (zombies.cureReady && c.zombies > 0) {
        level = 'cure';
        title = 'Remède déployé';
        text = `Les zombies guérissent peu à peu. Encore ${plural(c.zombies, 'zombie')}.`;
      } else if (zombies.alarm) {
        level = 'alarm';
        title = 'Alerte générale';
        text = `${plural(c.zombies, 'zombie')}, ${plural(c.bitten, 'mordu')}, ` +
          `${plural(c.barricaded, 'barricadé')}, remède à ${Math.round(zombies.cure * 100)} %.`;
      } else if (c.zombies > 0 || c.bitten > 0) {
        level = 'outbreak';
        title = 'Premiers cas';
        text = 'Quelques zombies rôdent. L\'alerte n\'a pas encore été donnée.';
      } else {
        level = 'freed';
        title = 'Ville libérée';
        text = `Plus aucun zombie. Pertes humaines : ${c.devoured + c.killed}.`;
      }
    }
    this.el.status.dataset.level = level;
    this.el.statusTitle.textContent = title;
    this.el.statusText.textContent = text;
  }

  updateLog(zombies) {
    if (zombies.eventsVersion === this.eventsVersion) return;
    this.eventsVersion = zombies.eventsVersion;
    const list = this.el.log;
    list.replaceChildren();
    if (zombies.events.length === 0) {
      const li = document.createElement('li');
      li.className = 'log__empty';
      li.textContent = 'Rien à signaler… pour l\'instant.';
      list.appendChild(li);
      return;
    }
    for (const event of zombies.events) {
      const li = document.createElement('li');
      li.dataset.kind = event.kind;
      const time = document.createElement('time');
      time.textContent = event.when;
      const text = document.createElement('span');
      text.textContent = event.text;
      li.append(time, text);
      list.appendChild(li);
    }
  }
}
