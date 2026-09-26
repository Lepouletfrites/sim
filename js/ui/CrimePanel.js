import { CONFIG } from '../config.js';
import { EpidemicChart } from './EpidemicChart.js';
import { renderLog } from './LogList.js';
import {
  CRIME_SLIDERS, CRIME_TOGGLES, CRIME_TYPES, CRIME_LABELS, crimeSliderToSetting,
} from '../crime/Crime.js';

const $ = (selector) => document.querySelector(selector);
const euros = (v) => `${Math.round(v).toLocaleString('fr-FR')} €`;
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function formatValue(slider, value) {
  switch (slider.unit) {
    case '%': return `${value} %`;
    case 'j': return `${value.toLocaleString('fr-FR')} j`;
    default: return String(value);
  }
}

const CRIME_BANDS = CRIME_TYPES.map((type) => ({
  key: type, label: CRIME_LABELS[type], color: CONFIG.colors.crimeMarks[type] === '#ffffff' ? '#b8c2cc' : CONFIG.colors.crimeMarks[type],
}));
const WEALTH = [
  { key: 'poor', label: 'Précaires', color: '#e74c3c' },
  { key: 'modest', label: 'Modestes', color: '#f39c12' },
  { key: 'comfortable', label: 'Aisés', color: '#3498db' },
  { key: 'rich', label: 'Riches', color: '#2ecc71' },
];

function fillLegend(list, bands) {
  for (const band of [...bands].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<i style="background:${band.color}"></i>${band.label}`;
    list.appendChild(li);
  }
}

/**
 * Onglet "Crime" : état de la délinquance, courbe des délits, main courante,
 * économie de la ville (épargne, niveaux de vie, flux) et réglages.
 */
export class CrimePanel {
  constructor({ onSetting, onHeist, onReset }) {
    this.stat = (id) => $(`#${id}`);
    this.chart = new EpidemicChart($('#crime-chart'), $('#crime-chart-tooltip'), {
      bands: CRIME_BANDS, emptyText: 'Aucun délit pour l\'instant',
    });
    fillLegend($('#crime-chart-legend'), CRIME_BANDS);
    this.wealthChart = new EpidemicChart($('#wealth-chart'), $('#wealth-chart-tooltip'), {
      bands: WEALTH, emptyText: 'En attente de données',
    });
    fillLegend($('#wealth-chart-legend'), WEALTH);

    // Lignes du bilan par type de délit, et barre des niveaux de vie
    this.rows = {};
    const rows = $('#crime-rows');
    for (const band of CRIME_BANDS) {
      const li = document.createElement('li');
      li.innerHTML = `<i class="dot" style="background:${band.color}"></i>${band.label}<b>0</b>`;
      rows.appendChild(li);
      this.rows[band.key] = li.querySelector('b');
    }
    this.wealth = {};
    const bar = $('#wealth-bar');
    const wealthRows = $('#wealth-rows');
    for (const w of WEALTH) {
      const span = document.createElement('span');
      span.style.background = w.color;
      bar.appendChild(span);
      const li = document.createElement('li');
      li.innerHTML = `<i class="dot" style="background:${w.color}"></i>${w.label}<b>0</b>`;
      wealthRows.appendChild(li);
      this.wealth[w.key] = { span, value: li.querySelector('b') };
    }

    const cfg = CONFIG.crime;
    for (const slider of CRIME_SLIDERS) {
      const input = $(`#crslider-${slider.key}`);
      const output = $(`#crvalue-${slider.key}`);
      const { min, max, default: value, step = 1 } = cfg[slider.key];
      Object.assign(input, { min, max, step, value });
      output.textContent = formatValue(slider, value);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        output.textContent = formatValue(slider, v);
        onSetting(slider.key, crimeSliderToSetting(slider, v));
      });
    }
    for (const key of CRIME_TOGGLES) {
      const checkbox = $(`#crtoggle-${key}`);
      checkbox.checked = cfg[key];
      checkbox.addEventListener('change', () => onSetting(key, checkbox.checked));
    }
    $('#btn-heist').addEventListener('click', onHeist);
    $('#btn-reset-crime').addEventListener('click', onReset);
    this.eventsVersion = -1;
  }

  update(crime, economy) {
    const t = crime.totals;
    const c = crime.counts;
    const recent = crime.recent;
    this.stat('crstat-recent').textContent = recent.total ?? 0;
    this.stat('crstat-stolen').textContent = euros(crime.stolenToday);
    this.stat('crstat-criminals').textContent = c.criminals;
    this.stat('crstat-jailed').textContent = c.jailed;
    this.stat('crstat-stolenTotal').textContent = euros(t.stolen);
    this.stat('crstat-arrests').textContent = t.arrests;
    const all = CRIME_TYPES.reduce((sum, type) => sum + t[type], 0);
    this.stat('crstat-clearance').textContent = all > 0 ? `${Math.round((100 * Math.min(all, t.arrests)) / all)} %` : '—';
    this.stat('crstat-wanted').textContent = c.wanted;
    this.stat('crstat-active').textContent = c.active;
    this.stat('crstat-killed').textContent = t.killed;
    this.stat('crstat-officers').textContent = t.officers;
    for (const type of CRIME_TYPES) this.rows[type].textContent = `${t[type]} (${recent[type] ?? 0} en 24 h)`;

    const insecurity = Math.round(crime.insecurity * 100);
    this.stat('crstat-insecurity').textContent = `${insecurity} %`;
    this.stat('meter-crime-insecurity').style.width = `${insecurity}%`;

    this.updateStatus(crime);
    this.updateLog(crime);
    this.chart.setData(crime.history, crime.historyVersion);
    this.updateEconomy(economy);
  }

  updateStatus(crime) {
    const n = crime.recent.total ?? 0;
    let level = 'calm';
    let title = 'Ville tranquille';
    let text = 'Quelques incivilités, rien de plus.';
    if (crime.heist) {
      level = 'alarm';
      title = 'Braquage en préparation';
      text = 'Un gang se rassemble devant une banque.';
    } else if ((crime.recent.heist ?? 0) > 0 || n >= 25) {
      level = 'alarm';
      title = 'Ville sous tension';
      text = `${plural(n, 'délit')} en 24 h, ${plural(crime.counts.wanted, 'suspect')} en fuite.`;
    } else if (n >= 10) {
      level = 'outbreak';
      title = 'Vague de délinquance';
      text = `${plural(n, 'délit')} en 24 h. Les habitants sortent moins le soir.`;
    } else if (n >= 3) {
      level = 'sect';
      title = 'Petite délinquance';
      text = `${plural(n, 'délit')} en 24 h, surtout des vols.`;
    }
    const box = this.stat('crime-status');
    box.dataset.level = level;
    this.stat('crime-status-title').textContent = title;
    this.stat('crime-status-text').textContent = text;
  }

  updateEconomy(economy) {
    const st = economy.stats;
    this.stat('ecstat-bank').textContent = euros(st.bank);
    this.stat('ecstat-cash').textContent = euros(st.cash);
    this.stat('ecstat-revenue').textContent = euros(economy.revenue.yesterday);
    this.stat('ecstat-unemployed').textContent = st.unemployed;
    this.stat('ecstat-wage').textContent = st.meanWage > 0 ? `${euros(st.meanWage)} / jour` : '—';
    this.stat('ecstat-wages').textContent = euros(economy.paid.wages);
    this.stat('ecstat-welfare').textContent = euros(economy.paid.welfare);
    this.stat('ecstat-pensions').textContent = euros(economy.paid.pensions);
    this.stat('ecstat-sickLeave').textContent = euros(economy.paid.sickLeave ?? 0);
    this.stat('ecstat-furlough').textContent = euros(economy.paid.furlough ?? 0);
    this.stat('ecstat-today').textContent = euros(economy.revenue.day === economy.clock.day ? economy.revenue.today : 0);
    this.stat('ecstat-tills').textContent = euros(st.tills);
    this.stat('ecstat-vaults').textContent = euros(st.vaults);
    for (const w of WEALTH) {
      const v = st[w.key] ?? 0;
      this.wealth[w.key].span.style.flexGrow = v;
      this.wealth[w.key].span.hidden = v === 0;
      this.wealth[w.key].value.textContent = v;
    }
    this.wealthChart.setData(economy.history, economy.historyVersion);
  }

  updateLog(crime) {
    if (crime.eventsVersion === this.eventsVersion) return;
    this.eventsVersion = crime.eventsVersion;
    renderLog(this.stat('crime-log'), crime.journal);
  }
}
