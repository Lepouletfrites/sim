import { NEWS_SOURCES, NEWS_LABELS } from '../core/News.js';
import { renderLog } from './LogList.js';

const $ = (selector) => document.querySelector(selector);
const pct = (v) => `${Math.round(v * 100)} %`;
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Onglet de chaque source du fil d'actualité (data-tab des boutons). */
const SOURCE_TAB = { virus: 'virus', zombies: 'zombies', cult: 'cult', crime: 'crime', city: 'city' };
const SOURCE_COLOR = {
  virus: '#e74c3c', zombies: '#7bd13a', cult: '#d35cff', crime: '#ff4d6d', city: '#3498db',
};
const DEATH_CAUSES = [
  { key: 'virus', label: 'Virus', color: '#9b59b6' },
  { key: 'zombies', label: 'Zombies et frappes aériennes', color: '#7bd13a' },
  { key: 'cult', label: 'Sectes (agressions, incendies, rixes)', color: '#d35cff' },
  { key: 'crime', label: 'Délinquance (agressions, fusillades)', color: '#ff4d6d' },
];
const MOOD_LEVELS = [
  [0.8, 'calm', 'Serein'],
  [0.6, 'sect', 'Préoccupé'],
  [0.4, 'outbreak', 'Inquiet'],
  [0.2, 'alarm', 'Tendu'],
  [-1, 'fallen', 'En crise'],
];
const TOAST_LIFE = 5500;   // ms
const TOAST_GAP = 700;     // ms entre deux notifications
const TOAST_MAX = 3;

/**
 * Vue d'ensemble de la ville (onglet Ville) et fil d'actualité commun :
 *  - moral des habitants, qui combine tout ce qui pèse sur la ville ;
 *  - une carte par module, cliquable pour ouvrir son onglet ;
 *  - décès par cause ;
 *  - fil d'actualité filtrable, pastilles de non-lus sur les onglets,
 *    notifications des événements marquants sur la carte.
 */
export class OverviewPanel {
  constructor({ onOpenTab }) {
    this.onOpenTab = onOpenTab;
    this.filter = 'all';
    this.feedKey = '';
    this.seen = Object.fromEntries(NEWS_SOURCES.map((s) => [s, 0]));
    this.lastToastId = 0;
    this.toastQueue = [];
    this.lastToastAt = 0;
    this.toastsOn = true;
    this.newsVersion = -1;

    this.buildSystems();
    this.buildDeaths();
    this.buildFilters();
    this.buildBadges();

    const toggle = $('#toggle-toasts');
    toggle.addEventListener('change', () => {
      this.toastsOn = toggle.checked;
      if (!this.toastsOn) this.clearToasts();
    });
  }

  // ------------------------------------------------------------ Construction

  buildSystems() {
    const grid = $('#systems');
    const items = [
      ['virus', 'Virus'], ['zombies', 'Zombies'], ['cult', 'Sectes'], ['crime', 'Crime'], ['economy', 'Économie'], ['population', 'Population'],
    ];
    this.systems = {};
    for (const [key, title] of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'system';
      button.dataset.system = key;
      button.style.setProperty('--system-color', SOURCE_COLOR[key] ?? (key === 'economy' ? '#f1c40f' : '#8a939e'));
      button.innerHTML = `
        <span class="system__title">${title}</span>
        <strong class="system__value">—</strong>
        <span class="system__sub"></span>`;
      const tab = key === 'economy' ? 'crime' : key === 'population' ? 'city' : SOURCE_TAB[key];
      button.addEventListener('click', () => this.onOpenTab(tab, key === 'economy' ? 'crime-economy' : null));
      grid.appendChild(button);
      this.systems[key] = {
        el: button,
        value: button.querySelector('.system__value'),
        sub: button.querySelector('.system__sub'),
      };
    }
  }

  buildDeaths() {
    const bar = $('#deaths-bar');
    const rows = $('#deaths-rows');
    this.deaths = {};
    for (const cause of DEATH_CAUSES) {
      const span = document.createElement('span');
      span.style.background = cause.color;
      span.hidden = true;
      bar.appendChild(span);
      const li = document.createElement('li');
      li.innerHTML = `<i class="dot" style="background:${cause.color}"></i>${cause.label}<b>0</b>`;
      rows.appendChild(li);
      this.deaths[cause.key] = { span, value: li.querySelector('b') };
    }
  }

  buildFilters() {
    const group = $('#news-filters');
    this.filterButtons = [];
    for (const key of ['all', ...NEWS_SOURCES]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filters__btn';
      button.dataset.filter = key;
      button.textContent = key === 'all' ? 'Tout' : NEWS_LABELS[key];
      if (key !== 'all') button.style.setProperty('--filter-color', SOURCE_COLOR[key]);
      button.addEventListener('click', () => {
        this.filter = key;
        this.feedKey = '';
        this.syncFilters();
      });
      group.appendChild(button);
      this.filterButtons.push(button);
    }
    this.syncFilters();
  }

  syncFilters() {
    for (const b of this.filterButtons) b.setAttribute('aria-pressed', String(b.dataset.filter === this.filter));
  }

  /** Pastille de non-lus sur chaque onglet principal. */
  buildBadges() {
    this.badges = {};
    for (const source of NEWS_SOURCES) {
      const tab = document.querySelector(`.tabs [data-tab="${SOURCE_TAB[source]}"]`);
      const badge = document.createElement('span');
      badge.className = 'tabs__badge';
      badge.hidden = true;
      tab.appendChild(badge);
      this.badges[source] = badge;
    }
  }

  // ------------------------------------------------------------ Mise à jour

  update(simulation) {
    const news = simulation.news;
    this.updateMood(simulation);
    this.updateSystems(simulation);
    this.updateDeaths(simulation);
    this.updateFeed(news);
    this.updateBadges(news);
    this.collectToasts(news);
    this.flushToasts();
  }

  /** Moral : 1 - (ce qui pèse), les poids se cumulant sans dépasser 100 %. */
  updateMood(sim) {
    const e = sim.epidemic;
    const z = sim.zombies;
    const st = sim.economy.stats;
    const adults = st.poor + st.modest + st.comfortable + st.rich;
    const factors = [
      ['l\'épidémie', 0.7 * e.awareness],
      ['les zombies', z.alarm ? 0.9 : z.counts.zombies > 0 ? 0.35 : 0],
      ['l\'insécurité', sim.routine.insecurity],
      ['la précarité', adults > 0 ? Math.min(1, (2 * st.poor) / adults) * 0.5 : 0],
    ];
    const burden = 1 - factors.reduce((keep, [, x]) => keep * (1 - Math.min(1, x)), 1);
    const mood = 1 - burden;
    const [, level, label] = MOOD_LEVELS.find(([min]) => mood > min);
    const box = $('#mood');
    box.dataset.level = level;
    $('#mood-label').textContent = `${label} · ${Math.round(mood * 100)} %`;
    $('#mood-fill').style.width = `${mood * 100}%`;
    const weights = factors.filter(([, x]) => x >= 0.12).sort((a, b) => b[1] - a[1]).map(([name]) => name);
    $('#mood-why').textContent = weights.length === 0
      ? 'Rien ne pèse sur la ville.'
      : `Ce qui pèse : ${weights.join(', ')}.`;
  }

  updateSystems(sim) {
    const s = this.systems;
    const set = (key, value, sub, level) => {
      s[key].value.textContent = value;
      s[key].sub.textContent = sub;
      s[key].el.dataset.level = level;
    };

    const e = sim.epidemic;
    const c = e.counts;
    const active = c.carriers + c.symptomatic;
    const share = active / Math.max(1, c.alive);
    set('virus',
      e.started ? plural(active, 'infecté') : 'Aucun cas',
      `Hôpital ${c.hospitalized} / ${e.hospitalCapacity}${e.started && active === 0 ? ' · vague terminée' : ''}`,
      share > 0.15 ? 'alarm' : active > 0 ? 'warn' : 'calm');

    const z = sim.zombies;
    set('zombies',
      z.active ? plural(z.counts.zombies, 'zombie') : 'Aucun',
      z.alarm ? `Alerte · ${z.counts.barricaded} barricadés` : z.active ? 'Pas d\'alerte' : 'Ville épargnée',
      z.alarm ? 'alarm' : z.counts.zombies > 0 ? 'warn' : 'calm');

    const cult = sim.cult;
    const cults = cult.cults.filter((k) => !k.dissolved).length;
    set('cult',
      cult.active ? plural(cult.counts.members, 'fidèle') : 'Aucune secte',
      cult.active ? `${plural(cults, 'secte')} · ${cult.counts.zealots} fanatiques · ${plural(cult.fires.burning.size, 'incendie')}` : 'Pas de gourou',
      cult.fires.burning.size > 0 || cult.counts.zealots > 0 ? 'alarm' : cult.counts.members > 0 ? 'warn' : 'calm');

    const crime = sim.crime;
    const recent = crime.recent.total ?? 0;
    set('crime',
      `${plural(recent, 'délit')} / 24 h`,
      `Insécurité ${pct(crime.insecurity)} · ${crime.counts.jailed} en prison`,
      recent >= 25 || crime.heist ? 'alarm' : recent >= 10 ? 'warn' : 'calm');

    const st = sim.economy.stats;
    const workforce = st.workers + st.unemployed;
    const unemployment = workforce > 0 ? st.unemployed / workforce : 0;
    const adults = st.poor + st.modest + st.comfortable + st.rich;
    const poverty = adults > 0 ? st.poor / adults : 0;
    set('economy',
      `Chômage ${pct(unemployment)}`,
      `${pct(poverty)} de précaires${st.furloughed ? ` · ${st.furloughed} en chômage partiel` : ''}${z.alarm ? ' · salaires suspendus' : ''}`,
      z.alarm || poverty > 0.25 || unemployment > 0.2 ? 'alarm' : poverty > 0.15 || unemployment > 0.12 ? 'warn' : 'calm');

    const total = sim.population.count;
    const alive = sim.population.citizens.filter((p) => p.alive).length;
    set('population',
      `${alive} / ${total}`,
      `${plural(total - alive, 'mort')} · Jour ${sim.clock.day}`,
      alive < total * 0.8 ? 'alarm' : alive < total ? 'warn' : 'calm');
  }

  updateDeaths(sim) {
    const values = {
      virus: sim.epidemic.counts.dead,
      zombies: sim.zombies.counts.devoured + sim.zombies.counts.killed,
      cult: sim.cult.totals.killed.assault + sim.cult.totals.killed.fire + sim.cult.totals.killed.brawl,
      crime: sim.crime.totals.killed,
    };
    for (const cause of DEATH_CAUSES) {
      const v = values[cause.key];
      this.deaths[cause.key].value.textContent = v;
      this.deaths[cause.key].span.style.flexGrow = v;
      this.deaths[cause.key].span.hidden = v === 0;
    }
  }

  updateFeed(news) {
    const key = `${news.version}|${this.filter}`;
    if (key === this.feedKey) return;
    this.feedKey = key;
    const items = this.filter === 'all' ? news.items : news.items.filter((n) => n.source === this.filter);
    renderLog($('#news-feed'), items.slice(0, 80), { withSource: this.filter === 'all' });
  }

  /** Non-lus : ce qui est arrivé depuis la dernière visite de l'onglet (le fil compte comme une visite). */
  updateBadges(news) {
    if (news.generation !== this.generation) {
      this.generation = news.generation;
      for (const source of NEWS_SOURCES) this.seen[source] = 0;
      this.clearToasts();
    }
    const active = document.querySelector('.tabs [aria-selected="true"]')?.dataset.tab;
    const feedOpen = active === 'city' && !$('#sub-city-overview').hidden;
    for (const source of NEWS_SOURCES) {
      if (feedOpen || SOURCE_TAB[source] === active) this.seen[source] = news.counts[source];
      const unread = news.counts[source] - this.seen[source];
      const badge = this.badges[source];
      badge.hidden = unread <= 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
  }

  // ------------------------------------------------------------ Notifications

  /** Les événements marquants (bons ou mauvais) arrivés depuis le dernier passage. */
  collectToasts(news) {
    if (news.items.length === 0) {
      this.lastToastId = 0;
      return;
    }
    const fresh = [];
    for (const item of news.items) {
      if (item.id <= this.lastToastId) break;
      if (item.kind === 'bad' || item.kind === 'good') fresh.push(item);
    }
    this.lastToastId = news.items[0].id;
    if (!this.toastsOn || fresh.length === 0) return;
    // Plus récents en dernier ; on n'en garde que quelques-uns (à x50, ça va vite).
    this.toastQueue.push(...fresh.reverse());
    if (this.toastQueue.length > TOAST_MAX + 1) this.toastQueue.splice(0, this.toastQueue.length - TOAST_MAX - 1);
  }

  flushToasts() {
    const now = performance.now();
    if (this.toastQueue.length === 0 || now - this.lastToastAt < TOAST_GAP) return;
    this.lastToastAt = now;
    const item = this.toastQueue.shift();
    const box = $('#toasts');
    while (box.children.length >= TOAST_MAX) box.firstElementChild.remove();

    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'toast';
    toast.dataset.kind = item.kind;
    toast.style.setProperty('--toast-color', SOURCE_COLOR[item.source]);
    const tag = document.createElement('b');
    tag.textContent = NEWS_LABELS[item.source];
    const text = document.createElement('span');
    text.textContent = item.text;
    toast.append(tag, text);
    toast.addEventListener('click', () => {
      this.onOpenTab(SOURCE_TAB[item.source]);
      toast.remove();
    });
    box.appendChild(toast);
    setTimeout(() => toast.classList.add('is-leaving'), TOAST_LIFE - 400);
    setTimeout(() => toast.remove(), TOAST_LIFE);
  }

  clearToasts() {
    this.toastQueue.length = 0;
    $('#toasts').replaceChildren();
  }
}
