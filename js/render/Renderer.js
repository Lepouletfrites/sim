import { CONFIG } from '../config.js';

const TAU = Math.PI * 2;

/**
 * Rendu Canvas 2D.
 * La ville (statique) est dessinée une seule fois dans un calque hors écran ;
 * chaque frame ne fait qu'un drawImage + un unique fill() pour tous les agents.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.staticLayer = document.createElement('canvas');
    this.staticCtx = this.staticLayer.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.city = null;
  }

  resize(width, height) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    const pw = Math.max(1, Math.round(width * this.dpr));
    const ph = Math.max(1, Math.round(height * this.dpr));
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.staticLayer.width = pw;
    this.staticLayer.height = ph;
    this.renderStatic();
  }

  setCity(city) {
    this.city = city;
    this.renderStatic();
  }

  renderStatic() {
    const ctx = this.staticCtx;
    const colors = CONFIG.colors;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, this.width, this.height);

    const city = this.city;
    if (!city) return;

    // Places / espaces ouverts
    ctx.fillStyle = colors.plaza;
    for (const p of city.plazas) ctx.fillRect(p.x, p.y, p.w, p.h);

    // Marquage central des avenues
    ctx.strokeStyle = colors.roadMark;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    for (const x of city.avenuesX) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, city.height);
    }
    for (const y of city.avenuesY) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(city.width, y + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Bâtiments
    ctx.fillStyle = colors.buildingFill;
    ctx.strokeStyle = colors.buildingStroke;
    ctx.lineWidth = 1.5;
    for (const b of city.buildings) {
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x + 0.75, b.y + 0.75, b.w - 1.5, b.h - 1.5);
    }
  }

  render(citizens, alpha) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticLayer, 0, 0);

    if (!citizens || citizens.length === 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = CONFIG.colors.citizen;
    ctx.beginPath();
    for (let i = 0; i < citizens.length; i++) {
      const c = citizens[i];
      const x = c.px + (c.x - c.px) * alpha;
      const y = c.py + (c.y - c.py) * alpha;
      ctx.moveTo(x + c.radius, y);
      ctx.arc(x, y, c.radius, 0, TAU);
    }
    ctx.fill();
  }
}
