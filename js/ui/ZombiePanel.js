import { CONFIG } from '../config.js';
import { EpidemicChart } from './EpidemicChart.js';
import { renderLog } from './LogList.js';
import { ZOMBIE_SLIDERS, ZOMBIE_TOGGLES, sliderToSetting } from '../zombie/Zombies.js';

const $ = (selector) => document.querySelector(selector);

/** Bandes de la courbe, de bas en haut. */
const ZOMBIE_BANDS = [
  { key: 'lost', label: 'Pertes', color: CONFIG.colors.humanLoss },
  { key: 'zombies', label: 'Zombies', color: CONFIG.colors.zombie },
  { key: 'bitten', label: 'Mordus', color: CONFIG.colors.bittenRing },
  { key: 'humans', label: 'Humains', color: CONFIG.colors.health[0] },
];

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Texte affiché pour la valeur d'un curseur selon son unité. */
function formatValue(slider, value) {
  switch (slider.unit) {
    case '%': return `${value} %`;
    case 'h': return value === 0 ? 'immédiat' : `${value} h`;
    case 'j': return value === 0 ? 'jamais' : `${value.toLocaleString('fr-FR')} j`;
    case 'n': return String(value);
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
      stats: {},
    };
    for (const key of ['humans', 'zombies', 'bitten', 'lost', 'barricaded', 'looting', 'invaded', 'fighters', 'destroyed', 'devoured', 'killed', 'cured']) {
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
      const { min, max, default: value, step = 1 } = cfg[slider.key];
      Object.assign(input, { min, max, step, value });
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
    this.eventsVersion = -1;
  }

  update(zombies) {
    const c = zombies.counts;
    const s = this.el.stats;
    s.humans.textContent = c.humans;
    s.zombies.textContent = c.zombies;
    s.bitten.textContent = c.bitten;
    s.lost.textContent = c.devoured + c.killed;
    s.barricaded.textContent = c.barricaded;
    s.looting.textContent = c.looting;
    s.invaded.textContent = c.invaded;
    s.fighters.textContent = zombies.alarm ? c.fighters : '—';
    s.destroyed.textContent = c.destroyed;
    s.devoured.textContent = c.devoured;
    s.killed.textContent = c.killed;
    s.cured.textContent = zombies.totalCured;

    const cure = Math.round(zombies.cure * 100);
    this.el.cure.textContent = zombies.cureReady ? 'prêt' : `${cure} %`;
    this.el.cureMeter.style.width = `${cure}%`;

    this.updateStatus(zombies);
    this.updateResponse(zombies);
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
        text = `${plural(c.zombies, 'zombie')} (dont ${c.invaded} dans des bâtiments), ` +
          `${plural(c.barricaded, 'barricadé')}, ${c.looting} en train de piller, remède à ${Math.round(zombies.cure * 100)} %.`;
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

  /** Jauges de riposte : part transformée, repère du seuil, état et bilan de chaque force. */
  updateResponse(zombies) {
    const s = zombies.settings;
    const r = zombies.response;
    const share = zombies.share;
    $('#zstat-share').textContent = `${Math.round(share * 100)} %`;

    const units = (kind, stock) => {
      const alive = r.alive(kind);
      return {
        alive,
        text: `${alive}/${stock.sent} sur le terrain · ${plural(stock.kills, 'zombie')} neutralisé${stock.kills > 1 ? 's' : ''}` +
          ` · ${stock.lost} tombé${stock.lost > 1 ? 's' : ''} · ${stock.withdrawn} replié${stock.withdrawn > 1 ? 's' : ''} (munitions)`,
      };
    };

    const rows = {
      police: { on: s.policeOn, threshold: s.policeThreshold, deployed: r.police.deployed, ...units('police', r.police) },
      army: { on: s.armyOn, threshold: s.armyThreshold, deployed: r.army.deployed, ...units('army', r.army) },
      walls: {
        on: s.wallsOn,
        threshold: s.wallThreshold,
        deployed: r.wallState.deployed,
        alive: r.walls.length,
        text: `${plural(r.walls.length, 'barricade')} debout · ${r.wallState.built} dressée${r.wallState.built > 1 ? 's' : ''} · ${r.wallState.broken} ${r.wallState.broken > 1 ? 'ont' : 'a'} cédé`,
      },
    };

    for (const [key, row] of Object.entries(rows)) {
      const fill = $(`#resp-${key}-fill`);
      fill.style.width = `${Math.min(100, share * 100)}%`;
      fill.classList.toggle('is-reached', row.on && share >= row.threshold && zombies.counts.zombies > 0);
      $(`#resp-${key}-mark`).style.left = `${row.threshold * 100}%`;

      const badge = $(`#resp-${key}-state`);
      let label = 'en attente';
      let style = 'badge--closed';
      if (!row.on) label = 'désactivée';
      else if (row.deployed && row.alive > 0) {
        label = key === 'walls' ? 'en place' : 'déployée';
        style = 'badge--open';
      } else if (row.deployed) {
        label = key === 'walls' ? 'toutes tombées' : 'décimée';
        style = 'badge--alert';
      }
      badge.textContent = label;
      badge.className = `badge ${style}`;

      if (row.deployed || row.alive > 0 || (key !== 'walls' && r[key].sent > 0) || (key === 'walls' && r.wallState.built > 0)) {
        $(`#resp-${key}-stats`).textContent = row.text;
      }
    }
  }

  updateLog(zombies) {
    if (zombies.eventsVersion === this.eventsVersion) return;
    this.eventsVersion = zombies.eventsVersion;
    renderLog(this.el.log, zombies.events);
  }
}
