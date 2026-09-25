import { CONFIG } from '../config.js';
import { Health } from '../agents/Citizen.js';

const AXIS_HEIGHT = 14;

/** Bandes empilées de bas en haut. */
export const CHART_BANDS = [
  { key: 'dead', label: 'Décès', color: CONFIG.colors.health[Health.DEAD] },
  { key: 'infected', label: 'Infectés', color: CONFIG.colors.health[Health.SYMPTOMATIC] },
  { key: 'recovered', label: 'Guéris', color: CONFIG.colors.health[Health.RECOVERED] },
  { key: 'susceptible', label: 'Sains', color: CONFIG.colors.health[Health.SUSCEPTIBLE] },
];

/**
 * Courbe en aires empilées (temps en heures de jeu) dessinée sur un petit canvas,
 * avec réticule + info-bulle au survol. Ne se redessine que si les données changent.
 */
export class EpidemicChart {
  /**
   * @param {object} [options]
   * @param {Array} [options.bands] bandes empilées de bas en haut ({ key, label, color })
   * @param {string} [options.emptyText] message quand il n'y a pas encore de données
   */
  constructor(canvas, tooltip, { bands = CHART_BANDS, emptyText = 'Aucune épidémie en cours' } = {}) {
    this.canvas = canvas;
    this.bands = bands;
    this.emptyText = emptyText;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.history = [];
    this.version = -1;
    this.hoverIndex = -1;
    this.width = 0;
    this.height = 0;

    const styles = getComputedStyle(document.documentElement);
    this.surface = styles.getPropertyValue('--bg-card').trim() || '#1b1f24';
    this.muted = styles.getPropertyValue('--text-muted').trim() || '#8a939e';

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => this.onHover(e.offsetX));
    canvas.addEventListener('pointerleave', () => this.onHover(null));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setData(history, version) {
    if (version === this.version) return;
    this.version = version;
    this.history = history;
    if (this.hoverIndex >= history.length) this.hoverIndex = -1;
    this.draw();
    this.updateTooltip();
  }

  onHover(offsetX) {
    const n = this.history.length;
    if (offsetX === null || n < 2) {
      this.hoverIndex = -1;
    } else {
      const tMax = this.history[n - 1].t || 1;
      const t = (offsetX / this.width) * tMax;
      // Échantillon le plus proche (historique trié par t).
      let best = 0;
      for (let i = 1; i < n; i++) {
        if (Math.abs(this.history[i].t - t) < Math.abs(this.history[best].t - t)) best = i;
      }
      this.hoverIndex = best;
    }
    this.draw();
    this.updateTooltip();
  }

  draw() {
    const { ctx, width: w, height: h } = this;
    if (w === 0) return;
    ctx.clearRect(0, 0, w, h);
    const plotH = h - AXIS_HEIGHT;
    const history = this.history;
    const n = history.length;

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = this.muted;

    if (n < 2) {
      ctx.textAlign = 'center';
      ctx.fillText(this.emptyText, w / 2, plotH / 2 + 4);
      return;
    }

    const tMax = history[n - 1].t || 1;
    let yMax = 1;
    for (const s of history) {
      yMax = Math.max(yMax, this.bands.reduce((sum, band) => sum + s[band.key], 0));
    }
    const x = (t) => (t / tMax) * w;
    const y = (v) => plotH - (v / yMax) * plotH;

    // Aires empilées
    const lower = new Float32Array(n);
    const upper = new Float32Array(n);
    for (const band of this.bands) {
      for (let i = 0; i < n; i++) upper[i] = lower[i] + history[i][band.key];
      ctx.fillStyle = band.color;
      ctx.beginPath();
      ctx.moveTo(x(history[0].t), y(upper[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(x(history[i].t), y(upper[i]));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(history[i].t), y(lower[i]));
      ctx.closePath();
      ctx.fill();
      lower.set(upper);
    }

    // Séparation de 2 px entre les bandes (couleur de la surface)
    ctx.strokeStyle = this.surface;
    ctx.lineWidth = 2;
    lower.fill(0);
    for (let b = 0; b < this.bands.length - 1; b++) {
      const key = this.bands[b].key;
      // Pas de séparateur tant qu'une bande est vide (évite un trait au ras de l'axe).
      if (history.every((s) => s[key] === 0)) continue;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        lower[i] += history[i][key];
        const px = x(history[i].t);
        const py = y(lower[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Axe du temps
    ctx.fillStyle = this.muted;
    ctx.textAlign = 'left';
    // En heures tant que la courbe couvre moins de deux jours, en jours ensuite.
    const short = tMax < 48;
    ctx.fillText(short ? '0 h' : 'Jour 0', 0, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(short ? `${Math.round(tMax)} h` : `Jour ${Math.floor(tMax / 24)}`, w, h - 2);

    // Réticule
    if (this.hoverIndex >= 0) {
      const px = Math.round(x(history[this.hoverIndex].t)) + 0.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, plotH);
      ctx.stroke();
    }
  }

  updateTooltip() {
    const tip = this.tooltip;
    if (this.hoverIndex < 0) {
      tip.hidden = true;
      return;
    }
    const s = this.history[this.hoverIndex];
    const rows = [...this.bands]
      .reverse()
      .map(
        (b) =>
          `<span class="chart__row"><i style="background:${b.color}"></i>${b.label}<b>${s[b.key]}</b></span>`,
      )
      .join('');
    const day = Math.floor(s.t / 24);
    const hour = Math.floor(s.t % 24);
    tip.innerHTML = `<span class="chart__time">Jour ${day}, +${hour} h</span>${rows}`;
    tip.hidden = false;

    const tMax = this.history[this.history.length - 1].t || 1;
    const px = (s.t / tMax) * this.width;
    const tipWidth = tip.offsetWidth;
    const left = px + 10 + tipWidth > this.width ? px - 10 - tipWidth : px + 10;
    tip.style.left = `${Math.max(0, left)}px`;
  }
}
