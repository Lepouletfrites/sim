import { CONFIG } from '../config.js';
import { EpidemicChart } from './EpidemicChart.js';
import { CULT_SLIDERS, CULT_TOGGLES, cultSliderToSetting, CultStage, STAGE_LABELS } from '../cult/Cult.js';

const $ = (selector) => document.querySelector(selector);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const euros = (v) => `${Math.round(v).toLocaleString('fr-FR')} €`;

function formatValue(slider, value) {
  return slider.unit === '%' ? `${value} %` : String(value);
}

const CURIOUS_BAND = { key: 'curious', label: 'Curieux', color: '#5d6570' };

/**
 * Onglet "Sectes" : déclencheurs, fiche de chaque secte, courbe des fidèles,
 * bilan, journal, riposte et réglages.
 */
export class CultPanel {
  constructor({ onSetting, onGuru, onPoliceRaid, onReset }) {
    this.el = {
      status: $('#cult-status'),
      statusTitle: $('#cult-status-title'),
      statusText: $('#cult-status-text'),
      list: $('#cult-list'),
      log: $('#cult-log'),
      legend: $('#cult-chart-legend'),
      insecurityMeter: $('#meter-insecurity'),
      stats: {},
    };
    for (const key of [
      'members', 'zealots', 'curious', 'burning', 'insecurity', 'insecurity2', 'fires', 'ruins',
      'assaults', 'killedViolence', 'killedFire', 'arrests', 'jailed', 'investigations', 'moved',
    ]) {
      this.el.stats[key] = $(`#cstat-${key}`);
    }

    this.chart = new EpidemicChart($('#cult-chart'), $('#cult-chart-tooltip'), {
      bands: [CURIOUS_BAND],
      emptyText: 'Aucune secte pour l\'instant',
    });

    const cfg = CONFIG.cult;
    for (const slider of CULT_SLIDERS) {
      const input = $(`#cslider-${slider.key}`);
      const output = $(`#cvalue-${slider.key}`);
      const { min, max, default: value, step = 1 } = cfg[slider.key];
      Object.assign(input, { min, max, step, value });
      output.textContent = formatValue(slider, value);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        output.textContent = formatValue(slider, v);
        onSetting(slider.key, cultSliderToSetting(slider, v));
      });
    }
    for (const key of CULT_TOGGLES) {
      const checkbox = $(`#ctoggle-${key}`);
      checkbox.checked = cfg[key];
      checkbox.addEventListener('change', () => onSetting(key, checkbox.checked));
    }

    $('#btn-guru').addEventListener('click', onGuru);
    $('#btn-police-raid').addEventListener('click', onPoliceRaid);
    $('#btn-reset-cult').addEventListener('click', onReset);

    this.eventsVersion = -1;
    this.bandsKey = '';
    this.listKey = '';
  }

  update(cult) {
    const c = cult.counts;
    const t = cult.totals;
    const s = this.el.stats;
    s.members.textContent = c.members;
    s.zealots.textContent = c.zealots;
    s.curious.textContent = c.curious;
    s.burning.textContent = c.burning;
    const insecurity = `${Math.round(cult.insecurity * 100)} %`;
    s.insecurity.textContent = insecurity;
    s.insecurity2.textContent = insecurity;
    this.el.insecurityMeter.style.width = `${cult.insecurity * 100}%`;
    s.fires.textContent = t.fires;
    s.ruins.textContent = t.ruins;
    s.assaults.textContent = t.assaults;
    s.killedViolence.textContent = t.killed.assault + t.killed.brawl;
    s.killedFire.textContent = t.killed.fire;
    s.arrests.textContent = t.arrests;
    s.jailed.textContent = c.jailed;
    s.investigations.textContent = t.investigations;
    s.moved.textContent = t.moved;

    this.updateStatus(cult);
    this.updateList(cult);
    this.updateResponse(cult);
    this.updateLog(cult);
    this.updateChart(cult);
  }

  updateStatus(cult) {
    const alive = cult.cults.filter((k) => !k.dissolved);
    let level = 'calm';
    let title = 'Aucune secte';
    let text = 'Faites apparaître un gourou pour commencer.';
    if (alive.length > 0) {
      const top = Math.max(...alive.map((k) => k.stage));
      const burning = cult.fires.burning.size;
      if (alive.length > 1 && top >= CultStage.GANG && cult.settings.rivalry) {
        level = 'alarm';
        title = 'Guerre des sectes';
        text = `${plural(alive.length, 'secte')} rivales, ${plural(cult.counts.zealots, 'fanatique')} dans les rues.`;
      } else if (top >= CultStage.GANG) {
        level = 'alarm';
        title = 'Gang';
        text = `Les fanatiques sèment le chaos la nuit${burning > 0 ? ` : ${plural(burning, 'incendie')} en cours` : ''}.`;
      } else if (top >= CultStage.COMMUNITY) {
        level = 'outbreak';
        title = 'Communauté';
        text = 'La secte a son QG et ses réunions du soir. Elle grossit.';
      } else {
        level = 'sect';
        title = 'Prédication';
        text = 'Le gourou prêche au coin des rues et recrute ses premiers fidèles.';
      }
    } else if (cult.cults.length > 0) {
      level = 'freed';
      title = 'Sectes dissoutes';
      text = 'Plus aucune secte en activité.';
    }
    this.el.status.dataset.level = level;
    this.el.statusTitle.textContent = title;
    this.el.statusText.textContent = text;
  }

  /** Fiche de chaque secte : reconstruite seulement si son contenu change. */
  updateList(cult) {
    const now = cult.clock.time;
    const rows = cult.cults.map((k) => {
      const guru = k.guru === null ? 'sans gourou'
        : k.guru.jailUntil > now ? `${k.guruName} (en prison)` : k.guruName;
      const hq = now < k.lockedUntil ? 'locaux saisis, comptes gelés'
        : k.hq < 0 ? 'pas de QG' : `QG${k.annexes.length ? ` + ${plural(k.annexes.length, 'annexe')}` : ''}`;
      let prophecy = '';
      if (k.prophecy === 'pending') prophecy = `Fin du monde annoncée pour le jour ${k.prophecyDay}`;
      else if (k.prophecy === 'fulfilled') prophecy = 'Prophétie réalisée !';
      return {
        k,
        key: [k.name, k.dissolved, guru, k.stage, k.members, k.zealots, k.curious, Math.round(k.funds / 50), hq, k.jailed, prophecy, k.incidents, k.reports].join('|'),
        guru, hq, prophecy,
      };
    });
    const key = rows.map((r) => r.key).join('#');
    if (key === this.listKey) return;
    this.listKey = key;

    const list = this.el.list;
    list.replaceChildren();
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'cults__empty';
      li.textContent = 'Aucune secte pour l\'instant.';
      list.appendChild(li);
      return;
    }
    for (const { k, guru, hq, prophecy } of [...rows].reverse()) {
      const li = document.createElement('li');
      li.className = 'cults__item';
      if (k.dissolved) li.classList.add('is-dissolved');
      li.style.setProperty('--cult-color', k.color);

      const head = document.createElement('div');
      head.className = 'cults__head';
      const name = document.createElement('b');
      name.textContent = k.name;
      const badge = document.createElement('span');
      badge.className = `badge ${k.dissolved ? 'badge--closed' : k.stage >= CultStage.GANG ? 'badge--alert' : 'badge--open'}`;
      badge.textContent = k.dissolved ? 'dissoute' : STAGE_LABELS[k.stage];
      head.append(name, badge);

      const meta = document.createElement('p');
      meta.className = 'cults__meta';
      meta.textContent = k.dissolved
        ? `Recrutés : ${k.stats.recruited} · partis : ${k.stats.apostates}`
        : `${guru} · ${hq} · caisse ${euros(k.funds)}`;

      li.append(head, meta);
      if (!k.dissolved) {
        const numbers = document.createElement('p');
        numbers.className = 'cults__numbers';
        numbers.textContent = `${plural(k.members, 'fidèle')} (${k.zealots} fanatique${k.zealots > 1 ? 's' : ''}` +
          `${k.jailed ? `, ${k.jailed} en prison` : ''}) · ${k.curious} curieux · ${plural(k.incidents, 'méfait')}` +
          ` · ${plural(k.reports, 'signalement')}`;
        li.appendChild(numbers);
      }
      if (prophecy && !k.dissolved) {
        const p = document.createElement('p');
        p.className = 'cults__prophecy';
        p.textContent = prophecy;
        li.appendChild(p);
      }
      list.appendChild(li);
    }
  }

  updateResponse(cult) {
    const s = cult.settings;
    const r = cult.response;
    const fill = $('#cresp-police-fill');
    fill.style.width = `${Math.min(100, cult.insecurity * 100)}%`;
    fill.classList.toggle('is-reached', s.policeOn && cult.insecurity >= s.policeThreshold);
    $('#cresp-police-mark').style.left = `${s.policeThreshold * 100}%`;

    const badge = (id, label, style) => {
      const el = $(id);
      el.textContent = label;
      el.className = `badge ${style}`;
    };
    const police = r.count('police');
    if (!s.policeOn) badge('#cresp-police-state', 'désactivée', 'badge--closed');
    else if (r.police.deployed) badge('#cresp-police-state', `${police} en patrouille`, 'badge--open');
    else badge('#cresp-police-state', 'en attente', 'badge--closed');
    if (r.police.sent > 0) {
      $('#cresp-police-stats').textContent = `${plural(r.police.arrests, 'interpellation')} · ${r.police.lost} blessé${r.police.lost > 1 ? 's' : ''} · ${plural(cult.counts.jailed, 'personne')} en cellule`;
    }

    if (!s.raidOn || !s.policeOn) badge('#cresp-raid-state', 'désactivée', 'badge--closed');
    else if (r.raidOrder) badge('#cresp-raid-state', 'en cours', 'badge--alert');
    else badge('#cresp-raid-state', 'en attente', 'badge--closed');
    if (cult.totals.policeRaids > 0) {
      $('#cresp-raid-stats').textContent = `${plural(cult.totals.policeRaids, 'descente')} au QG. Les méfaits de chaque secte repartent de zéro après une descente.`;
    }

    const trucks = r.count('firefighter');
    if (!s.firefightersOn) badge('#cresp-fire-state', 'désactivés', 'badge--closed');
    else if (trucks > 0) badge('#cresp-fire-state', `${trucks} sur le feu`, 'badge--alert');
    else badge('#cresp-fire-state', 'en caserne', 'badge--closed');
    if (cult.totals.fires > 0) {
      $('#cresp-fire-stats').textContent = `${plural(cult.totals.saved, 'incendie')} maîtrisé${cult.totals.saved > 1 ? 's' : ''} · ${plural(cult.totals.ruins, 'bâtiment')} en ruine`;
    }
  }

  /** Une bande par secte (dans l'ordre de fondation), les curieux au-dessus. */
  updateChart(cult) {
    const key = cult.cults.map((k) => `${k.id}:${k.color}`).join(',');
    if (key !== this.bandsKey) {
      this.bandsKey = key;
      const bands = cult.cults.map((k) => ({ key: `c${k.id}`, label: k.name, color: k.color }));
      this.chart.bands = [...bands, CURIOUS_BAND];
      this.el.legend.replaceChildren();
      for (const band of [...this.chart.bands].reverse()) {
        const li = document.createElement('li');
        li.innerHTML = `<i style="background:${band.color}"></i>`;
        li.append(band.key === 'curious' ? band.label : band.label.split(' ').slice(-1)[0]);
        li.title = band.label;
        this.el.legend.appendChild(li);
      }
      this.chart.version = -1; // force le redessin avec les nouvelles bandes
    }
    this.chart.setData(cult.history, cult.historyVersion);
  }

  updateLog(cult) {
    if (cult.eventsVersion === this.eventsVersion) return;
    this.eventsVersion = cult.eventsVersion;
    const list = this.el.log;
    list.replaceChildren();
    if (cult.events.length === 0) {
      const li = document.createElement('li');
      li.className = 'log__empty';
      li.textContent = 'Rien à signaler… pour l\'instant.';
      list.appendChild(li);
      return;
    }
    for (const event of cult.events) {
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
