import { CONFIG } from '../config.js';
import { Health, Care } from '../agents/Citizen.js';
import { PlaceType, MAP_LABELS, isOpen } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/Zombies.js';
import { CultRank } from '../cult/Cult.js';

const TAU = Math.PI * 2;

/** "#rrggbb" -> "rgba(r, g, b, a)". */
function hexAlpha(hex, a) {
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255}, ${(p >> 8) & 255}, ${p & 255}, ${a})`;
}

/** Pseudo-aléatoire stable (flammes, tags) : même entrée, même sortie. */
function hash(a, b) {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
const HEALTH_DRAW_ORDER = [Health.SUSCEPTIBLE, Health.RECOVERED, Health.INCUBATING, Health.SYMPTOMATIC];
const VENUES = [PlaceType.WORK, PlaceType.SCHOOL, PlaceType.MALL, PlaceType.RESTAURANT, PlaceType.NIGHTCLUB];

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
    this.cityVersion = city.version;

    // Marquage central des avenues (sous les îlots : il disparaît là où deux îlots ont fusionné)
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

    // Sol des îlots : vert à la campagne, gris en ville
    ctx.fillStyle = mixHex(colors.groundRural, colors.groundUrban, city.params.t);
    for (const b of city.blocks) ctx.fillRect(b.x, b.y, b.w, b.h);

    // Parcelles non bâties : parcs et prés
    ctx.fillStyle = colors.plaza;
    for (const p of city.plazas) ctx.fillRect(p.x, p.y, p.w, p.h);

    this.drawRiver(ctx, city);

    // Bâtiments, colorés par type
    ctx.lineWidth = 1.5;
    for (const b of city.buildings) {
      const style = colors.places[b.type];
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = style.stroke;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x + 0.75, b.y + 0.75, b.w - 1.5, b.h - 1.5);
      if (b.type === PlaceType.RUIN) this.drawRuin(ctx, b);
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

    if (city.policeStation >= 0) {
      const b = city.buildings[city.policeStation];
      if (b.w >= 34 && b.h >= 14) {
        ctx.fillStyle = colors.police;
        ctx.fillText('POLICE', b.x + 3, b.y + 3);
      }
    }
    if (city.fireStation >= 0) {
      const b = city.buildings[city.fireStation];
      if (b.w >= 50 && b.h >= 14) {
        ctx.fillStyle = colors.firefighter;
        ctx.fillText('POMPIERS', b.x + 3, b.y + 3);
      }
    }

    if (city.hospital) this.drawHospitalCross(ctx, city.hospital);
  }

  /** Rivière (tracé lisse : berge puis eau), tabliers et parapets des ponts. */
  drawRiver(ctx, city) {
    const river = city.river;
    if (!river) return;
    const colors = CONFIG.colors;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    river.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = colors.riverBank;
    ctx.lineWidth = river.width + 5;
    ctx.stroke();
    ctx.strokeStyle = colors.water;
    ctx.lineWidth = river.width;
    ctx.stroke();

    // Tabliers : la chaussée passe par-dessus l'eau
    ctx.fillStyle = colors.background;
    for (const b of city.bridges) ctx.fillRect(b.x, b.y, b.w, b.h);

    ctx.strokeStyle = colors.bridgeRail;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const b of city.bridges) {
      if (b.w > b.h) {
        // Pont horizontal : parapets le long des bords haut et bas
        ctx.moveTo(b.x, b.y + 1);
        ctx.lineTo(b.x + b.w, b.y + 1);
        ctx.moveTo(b.x, b.y + b.h - 1);
        ctx.lineTo(b.x + b.w, b.y + b.h - 1);
      } else {
        ctx.moveTo(b.x + 1, b.y);
        ctx.lineTo(b.x + 1, b.y + b.h);
        ctx.moveTo(b.x + b.w - 1, b.y);
        ctx.lineTo(b.x + b.w - 1, b.y + b.h);
      }
    }
    ctx.stroke();
  }

  /** Ruine : murs noircis, gravats. */
  drawRuin(ctx, b) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 70, 40, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = Math.max(2, Math.round((b.w + b.h) / 16));
    for (let k = 0; k < n; k++) {
      const x = b.x + 2 + hash(b.index, k) * (b.w - 4);
      const y = b.y + 2 + hash(k, b.index) * (b.h - 4);
      const len = 3 + hash(b.index + k, 7) * 6;
      const a = hash(k, b.index + 3) * TAU;
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    }
    ctx.stroke();
    ctx.restore();
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
    this.lastAlpha = alpha;
    // Un bâtiment a changé de type (acheté, en ruine…) : on redessine le calque statique.
    if (this.city && this.city.version !== this.cityVersion) this.renderStatic();
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

    const cult = simulation.cult && simulation.cult.active ? simulation.cult : null;
    if (cult) this.drawCultGround(ctx, cult);

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
    if (cult) this.drawCultAgents(ctx, citizens, alpha, cult);
  }

  // ------------------------------------------------------------------ Sectes

  /** Sous les habitants : locaux des sectes, tags, incendies et fumée. */
  drawCultGround(ctx, cult) {
    const colors = CONFIG.colors;
    const buildings = this.city.buildings;
    const t = performance.now() / 1000;

    // Locaux : teinte et liseré aux couleurs de la secte, "QG" sur le siège
    ctx.font = '700 8px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const k of cult.cults) {
      if (k.dissolved || k.hq < 0) continue;
      for (const index of [k.hq, ...k.annexes]) {
        const b = buildings[index];
        const hq = index === k.hq;
        ctx.fillStyle = hexAlpha(k.color, hq ? 0.2 : 0.12);
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = k.color;
        ctx.lineWidth = hq ? 2 : 1.2;
        ctx.setLineDash(hq ? [] : [3, 3]);
        ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
        ctx.setLineDash([]);
        if (b.w >= 18 && b.h >= 12) {
          ctx.fillStyle = k.color;
          ctx.fillText(hq ? 'QG' : 'ANNEXE', b.x + 3, b.y + 3);
        }
        if (hq) this.drawSigil(ctx, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.18, k.color);
      }
    }

    // Tags sur les façades
    ctx.lineWidth = 1.3;
    for (const tag of cult.tags) {
      ctx.strokeStyle = tag.color;
      ctx.beginPath();
      ctx.moveTo(tag.x - 3, tag.y + 1);
      for (let k = 1; k <= 4; k++) {
        ctx.lineTo(tag.x - 3 + k * 1.6, tag.y + (k % 2 ? -1.5 : 1.5) * (0.6 + tag.seed));
      }
      ctx.stroke();
    }

    // Incendies : lueur vacillante, flammes, noircissement, fumée
    for (const index of cult.fires.burning) {
      const b = buildings[index];
      const f = b.fire;
      const flicker = 0.75 + 0.25 * Math.sin(t * 13 + index * 1.7) * Math.sin(t * 7.3 + index);
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.5 * Math.min(1, b.burn)).toFixed(3)})`;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = `rgba(255, 96, 20, ${((0.2 + 0.4 * f) * flicker).toFixed(3)})`;
      ctx.fillRect(b.x, b.y, b.w, b.h);

      const flames = Math.round(Math.min(16, Math.max(3, (b.w * b.h) / 220)) * (0.4 + 0.6 * f));
      for (let k = 0; k < flames; k++) {
        const fx = b.x + 2 + hash(index, k) * (b.w - 4);
        const phase = t * (2 + hash(k, index) * 3) + k;
        const fy = b.y + 2 + hash(k, index + 1) * (b.h - 4) - (phase % 1) * 4;
        const r = (1.5 + 2.5 * f) * (1 - (phase % 1) * 0.6);
        ctx.fillStyle = k % 3 === 0 ? colors.fireCore : colors.fire;
        ctx.beginPath();
        ctx.arc(fx, fy, r, 0, TAU);
        ctx.fill();
      }
      // Fumée qui monte et s'étale
      for (let k = 0; k < 4; k++) {
        const life = (t * 0.35 + k / 4 + hash(index, k + 9)) % 1;
        const sx = b.x + b.w * (0.3 + 0.4 * hash(index, k + 5)) + Math.sin(t + k) * 3;
        const sy = b.y + b.h / 2 - life * 26;
        ctx.fillStyle = colors.smoke.replace('ALPHA', (0.35 * f * (1 - life)).toFixed(3));
        ctx.beginPath();
        ctx.arc(sx, sy, 3 + life * 7, 0, TAU);
        ctx.fill();
      }
    }
  }

  /** Symbole de secte : un œil dans un triangle. */
  drawSigil(ctx, x, y, size, color) {
    if (size < 3) return;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size * 0.95, y + size * 0.65);
    ctx.lineTo(x - size * 0.95, y + size * 0.65);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x, y + size * 0.1, size * 0.42, size * 0.22, 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y + size * 0.1, size * 0.1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Au-dessus des habitants : curieux, fidèles, fanatiques, gourous, secours, victimes. */
  drawCultAgents(ctx, citizens, alpha, cult) {
    const colors = CONFIG.colors;
    const t = performance.now() / 1000;
    const pos = (c) => [c.px + (c.x - c.px) * alpha, c.py + (c.y - c.py) * alpha];

    // Victimes
    const life = CONFIG.zombie.markLife;
    ctx.fillStyle = colors.humanLoss;
    for (const m of cult.marks) {
      ctx.globalAlpha = 0.8 * (1 - m.age / life);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 4, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const curiousAt = CONFIG.cult.curiousAt;
    for (const k of cult.cults) {
      if (k.dissolved) continue;
      // Curieux : anneau pâle
      ctx.strokeStyle = hexAlpha(k.color, 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of citizens) {
        if (c.cult >= 0 || c.leaning !== k.id || c.conviction < curiousAt || !c.alive) continue;
        const [x, y] = pos(c);
        ctx.moveTo(x + c.radius + 1.5, y);
        ctx.arc(x, y, c.radius + 1.5, 0, TAU);
      }
      ctx.stroke();

      // Fidèles : anneau plein
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const c of citizens) {
        if (c.cult !== k.id || c.cultRank !== CultRank.FOLLOWER || !c.alive) continue;
        const [x, y] = pos(c);
        ctx.moveTo(x + c.radius + 1.6, y);
        ctx.arc(x, y, c.radius + 1.6, 0, TAU);
      }
      ctx.stroke();

      // Fanatiques : losange
      ctx.fillStyle = k.color;
      ctx.strokeStyle = '#1a0d12';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of citizens) {
        if (c.cult !== k.id || c.cultRank !== CultRank.ZEALOT || !c.alive) continue;
        const [x, y] = pos(c);
        const s = c.radius + 1.8;
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();

      // Gourou : halo pulsant ; en plein prêche, sa portée
      const g = k.guru;
      if (g && g.alive) {
        const [x, y] = pos(g);
        if (g.activity === 'preach' && g.hold) {
          ctx.strokeStyle = hexAlpha(k.color, 0.28);
          ctx.setLineDash([4, 5]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, CONFIG.cult.preachRadius, 0, TAU);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const pulse = 0.5 + 0.5 * Math.sin(t * 4 + k.id);
        ctx.fillStyle = colors.guruGlow.replace('ALPHA', (0.25 + 0.3 * pulse).toFixed(3));
        ctx.beginPath();
        ctx.arc(x, y, g.radius + 4 + 2 * pulse, 0, TAU);
        ctx.fill();
        ctx.fillStyle = k.color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, g.radius + 1.5, 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
    }

    this.drawCultUnits(ctx, cult.response);
  }

  /** Police (ronds bleus) et pompiers (carrés rouges, avec leur jet d'eau). */
  drawCultUnits(ctx, response) {
    const units = response.units;
    if (units.length === 0) return;
    const colors = CONFIG.colors;
    const alpha = this.lastAlpha ?? 1;
    const buildings = this.city.buildings;
    const t = performance.now() / 1000;

    ctx.strokeStyle = colors.spray;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 3]);
    ctx.lineDashOffset = -t * 20;
    ctx.beginPath();
    for (const u of units) {
      if (u.kind !== 'firefighter' || !u.spraying || u.goal < 0) continue;
      const b = buildings[u.goal];
      const tx = Math.min(Math.max(u.x, b.x + 4), b.x + b.w - 4);
      const ty = Math.min(Math.max(u.y, b.y + 4), b.y + b.h - 4);
      ctx.moveTo(u.x, u.y);
      ctx.lineTo(tx, ty);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    ctx.fillStyle = colors.police;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const u of units) {
      if (u.kind !== 'police') continue;
      const x = u.px + (u.x - u.px) * alpha;
      const y = u.py + (u.y - u.py) * alpha;
      ctx.moveTo(x + u.radius, y);
      ctx.arc(x, y, u.radius, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors.firefighter;
    ctx.strokeStyle = colors.firefighterStroke;
    for (const u of units) {
      if (u.kind !== 'firefighter') continue;
      const x = u.px + (u.x - u.px) * alpha;
      const y = u.py + (u.y - u.py) * alpha;
      const s = u.radius * 1.8;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    }
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

    const response = zombies.response;
    this.drawWalls(ctx, response.walls);

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

    this.drawUnits(ctx, response);

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

  /** Barricades de rue : planches qui pâlissent à mesure qu'elles s'usent. */
  drawWalls(ctx, walls) {
    if (walls.length === 0) return;
    const colors = CONFIG.colors;
    ctx.lineWidth = 1;
    for (const w of walls) {
      ctx.globalAlpha = 0.45 + 0.55 * (w.hp / w.maxHp);
      ctx.fillStyle = colors.wall;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = colors.wallStroke;
      ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
    }
    ctx.globalAlpha = 1;
  }

  /** Police (ronds bleus cerclés de blanc), armée (carrés kaki), et traçantes des tirs. */
  drawUnits(ctx, response) {
    const colors = CONFIG.colors;
    const units = response.units;
    const alpha = this.lastAlpha ?? 1;

    // Traçantes (temps réel)
    const now = performance.now();
    response.tracers = response.tracers.filter((t) => now - t.start < 160);
    ctx.lineWidth = 1.2;
    for (const t of response.tracers) {
      ctx.strokeStyle = t.kind === 'army' ? colors.armyTracer : colors.policeTracer;
      ctx.beginPath();
      ctx.moveTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
    if (units.length === 0) return;

    ctx.fillStyle = colors.police;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const u of units) {
      if (u.kind !== 'police') continue;
      const x = u.px + (u.x - u.px) * alpha;
      const y = u.py + (u.y - u.py) * alpha;
      ctx.moveTo(x + u.radius, y);
      ctx.arc(x, y, u.radius, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors.army;
    ctx.strokeStyle = colors.armyStroke;
    for (const u of units) {
      if (u.kind !== 'army') continue;
      const x = u.px + (u.x - u.px) * alpha;
      const y = u.py + (u.y - u.py) * alpha;
      const s = u.radius * 1.8;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    }
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
