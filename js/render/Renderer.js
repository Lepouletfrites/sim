import { CONFIG } from '../config.js';
import { Health, Care } from '../agents/Citizen.js';
import { PlaceType, MAP_LABELS, isOpen } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/Zombies.js';

const TAU = Math.PI * 2;
const HEALTH_DRAW_ORDER = [Health.SUSCEPTIBLE, Health.RECOVERED, Health.INCUBATING, Health.SYMPTOMATIC];
const VENUES = [PlaceType.WORK, PlaceType.MALL, PlaceType.RESTAURANT, PlaceType.NIGHTCLUB];

/** Mélange deux couleurs "#rrggbb" (t = 0 -> a, t = 1 -> b). */
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = (shift) => {
    const ca = (pa >> shift) & 255;
    const cb = (pb >> shift) & 255;
    return Math.round(ca + (cb - ca) * t);
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/**
 * Rendu Canvas 2D.
 * La ville (statique) est dessinée une seule fois dans un calque hors écran.
 * Chaque frame : drawImage + voile de nuit + lieux fermés + un fill() par état de santé.
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
    this.venues = city.buildings.filter((b) => VENUES.includes(b.type));
    this.homes = city.buildings.map((b, i) => (b.type === PlaceType.HOME ? i : -1)).filter((i) => i >= 0);
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

    // Sol des îlots : vert à la campagne, gris en ville
    ctx.fillStyle = mixHex(colors.groundRural, colors.groundUrban, city.params.t);
    for (const b of city.blocks) ctx.fillRect(b.x, b.y, b.w, b.h);

    // Parcelles non bâties : parcs et prés
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

    // Bâtiments, colorés par type
    ctx.lineWidth = 1.5;
    for (const b of city.buildings) {
      const style = colors.places[b.type];
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = style.stroke;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x + 0.75, b.y + 0.75, b.w - 1.5, b.h - 1.5);
    }

    // Étiquettes des lieux de sortie
    ctx.font = '600 8px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const b of city.buildings) {
      const label = MAP_LABELS[b.type];
      if (!label || b.w < ctx.measureText(label).width + 6 || b.h < 14) continue;
      ctx.fillStyle = colors.places[b.type].stroke;
      ctx.fillText(label, b.x + 3, b.y + 3);
    }

    if (city.hospital) this.drawHospitalCross(ctx, city.hospital);
  }

  drawHospitalCross(ctx, h) {
    const colors = CONFIG.colors;
    const cx = h.x + h.w / 2;
    const cy = h.y + h.h / 2;
    const size = Math.min(h.w, h.h) * 0.14;
    ctx.globalAlpha = 0.5; // discrète : les patients sont visibles par-dessus
    ctx.fillStyle = colors.hospitalCross;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 1.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = colors.places.hospital.stroke;
    ctx.fillRect(cx - size, cy - size / 3, size * 2, (size * 2) / 3);
    ctx.fillRect(cx - size / 3, cy - size, (size * 2) / 3, size * 2);
    ctx.globalAlpha = 1;
  }

  render(citizens, alpha, simulation) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticLayer, 0, 0);
    if (!this.city) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const colors = CONFIG.colors;
    const clock = simulation.clock;
    const night = 1 - clock.daylight;

    // Voile de nuit
    if (night > 0.01) {
      ctx.fillStyle = colors.night.replace('ALPHA', (night * colors.nightMaxAlpha).toFixed(3));
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Lieux fermés assombris
    ctx.fillStyle = colors.closedVenue;
    for (const b of this.venues) {
      if (!isOpen(b.type, clock, simulation.settings)) ctx.fillRect(b.x, b.y, b.w, b.h);
    }

    // Fenêtres éclairées la nuit dans les logements occupés
    if (night > 0.3 && simulation.routine) {
      const occupancy = simulation.routine.occupancy;
      const buildings = this.city.buildings;
      for (const i of this.homes) {
        if (occupancy[i] === 0) continue;
        const b = buildings[i];
        const a = (Math.min(0.25, 0.05 + occupancy[i] * 0.02) * night).toFixed(3);
        ctx.fillStyle = colors.homeLight.replace('ALPHA', a);
        ctx.fillRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
      }
    }

    if (simulation.epidemic) this.drawDeathMarks(ctx, simulation.epidemic.deathMarks);
    if (!citizens || citizens.length === 0) return;

    // Un fill() par état de santé ; les malades sont dessinés en dernier (au-dessus).
    for (const health of HEALTH_DRAW_ORDER) {
      ctx.fillStyle = colors.health[health];
      ctx.beginPath();
      for (let i = 0; i < citizens.length; i++) {
        const c = citizens[i];
        if (c.health !== health || c.zombie === ZombieState.ZOMBIE) continue;
        const x = c.px + (c.x - c.px) * alpha;
        const y = c.py + (c.y - c.py) * alpha;
        ctx.moveTo(x + c.radius, y);
        ctx.arc(x, y, c.radius, 0, TAU);
      }
      ctx.fill();
    }

    // Anneaux : en route vers l'hôpital (blanc), ou rentrant s'isoler / se confiner (jaune)
    this.drawRings(ctx, citizens, alpha, (c) => c.care === Care.HOSPITAL, colors.hospitalRing);
    this.drawRings(
      ctx, citizens, alpha,
      (c) => c.care === Care.QUARANTINE || c.care === Care.BEDRIDDEN || c.care === Care.CONFINED,
      colors.homeRing,
    );

    if (simulation.zombies && simulation.zombies.active) this.drawZombies(ctx, citizens, alpha, simulation.zombies);
  }

  /** Apocalypse : traces, zombies, mordus, survivalistes et frappes aériennes. */
  drawZombies(ctx, citizens, alpha, zombies) {
    const colors = CONFIG.colors;

    // Traces : vert pour un zombie neutralisé, rouge sombre pour un humain tué
    const life = CONFIG.zombie.markLife;
    for (const m of zombies.marks) {
      ctx.globalAlpha = 0.8 * (1 - m.age / life);
      ctx.fillStyle = m.kind === 'zombie' ? colors.zombieStroke : colors.humanLoss;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 4.5, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Zombies : un peu plus gros, cerclés de sombre
    ctx.fillStyle = colors.zombie;
    ctx.strokeStyle = colors.zombieStroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < citizens.length; i++) {
      const c = citizens[i];
      if (c.zombie !== ZombieState.ZOMBIE || !c.alive) continue;
      const x = c.px + (c.x - c.px) * alpha;
      const y = c.py + (c.y - c.py) * alpha;
      const r = c.radius + 0.6;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();

    // Mordus (partout, même à l'intérieur) et survivalistes pendant l'alerte
    this.drawRingsWhere(ctx, citizens, alpha, (c) => c.zombie === ZombieState.BITTEN, colors.bittenRing);
    if (zombies.alarm) {
      this.drawRings(ctx, citizens, alpha, (c) => c.fighter && c.zombie === ZombieState.HUMAN, colors.fighterRing);
    }

    // Frappes aériennes : onde de choc (temps réel, visible même en pause)
    const now = performance.now();
    const duration = 900;
    zombies.effects = zombies.effects.filter((e) => now - e.start < duration);
    for (const e of zombies.effects) {
      const t = (now - e.start) / duration;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = colors.strike;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * t), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Comme drawRings, mais aussi pour les habitants à l'intérieur des bâtiments. */
  drawRingsWhere(ctx, citizens, alpha, predicate, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < citizens.length; i++) {
      const c = citizens[i];
      if (!c.alive || !predicate(c)) continue;
      const x = c.px + (c.x - c.px) * alpha;
      const y = c.py + (c.y - c.py) * alpha;
      const r = c.radius + 1.8;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.stroke();
  }

  /** Anneau autour des habitants dans la rue qui répondent au prédicat. */
  drawRings(ctx, citizens, alpha, predicate, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < citizens.length; i++) {
      const c = citizens[i];
      if (c.place >= 0 || !c.alive || !predicate(c)) continue;
      const x = c.px + (c.x - c.px) * alpha;
      const y = c.py + (c.y - c.py) * alpha;
      const r = c.radius + 1.8;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.stroke();
  }

  /** Croix à l'endroit d'un décès, qui s'efface avec le temps. */
  drawDeathMarks(ctx, marks) {
    if (marks.length === 0) return;
    const life = CONFIG.epidemic.deathMarkLife;
    ctx.strokeStyle = CONFIG.colors.health[Health.DEAD];
    ctx.lineWidth = 1.6;
    for (const m of marks) {
      ctx.globalAlpha = 1 - m.age / life;
      ctx.beginPath();
      ctx.moveTo(m.x - 3.5, m.y - 3.5);
      ctx.lineTo(m.x + 3.5, m.y + 3.5);
      ctx.moveTo(m.x + 3.5, m.y - 3.5);
      ctx.lineTo(m.x - 3.5, m.y + 3.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
