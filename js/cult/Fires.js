import { CONFIG } from '../config.js';
import { PlaceType, PLACE_LABELS } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/ZombieState.js';

/** Distance entre deux rectangles (0 s'ils se touchent). */
function rectGap(a, b) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

/**
 * Incendies : départ (raid, clic, propagation), montée en puissance,
 * propagation aux bâtiments voisins, extinction par les pompiers ou ruine.
 *
 * État porté par le bâtiment : `fire` (intensité 0..1, 0 = éteint),
 * `burn` (dégâts cumulés, 1 = ruine), `fireCult` (secte responsable, -1 sinon).
 */
export class Fires {
  constructor(cult) {
    this.cult = cult;
    this.city = cult.city;
    this.rng = cult.rng;
    this.burning = new Set();
    this.neighbors = new Map(); // index -> voisins assez proches pour que le feu saute
  }

  reset() {
    for (const b of this.city.buildings) {
      b.fire = 0;
      b.burn = 0;
      b.fireCult = -1;
    }
    this.burning.clear();
  }

  canBurn(index) {
    const city = this.city;
    const b = city.buildings[index];
    return !!b && !(b.fire > 0) && b.type !== PlaceType.RUIN && index !== city.hospitalIndex &&
      index !== city.policeStation && index !== city.fireStation;
  }

  /** Met le feu au bâtiment. @returns {boolean} false s'il ne peut pas brûler */
  ignite(index, cult = null) {
    if (!this.canBurn(index)) return false;
    const b = this.city.buildings[index];
    b.fire = 0.25;
    b.burn = b.burn || 0;
    b.fireCult = cult ? cult.id : -1;
    this.burning.add(index);
    this.cult.totals.fires++;
    if (cult) cult.stats.fires++;
    this.evacuate(index);
    return true;
  }

  /** Tout le monde sort ; les moins chanceux restent coincés. */
  evacuate(index) {
    const cult = this.cult;
    const routine = cult.routine;
    for (const c of cult.population.citizens) {
      if (!c.alive || c.place !== index) continue;
      if (c.zombie === ZombieState.ZOMBIE) {
        routine.leave(c);
        c.siegeTarget = -1;
        c.field = null;
        continue;
      }
      if (c.jailUntil > 0) continue;
      if (this.rng.chance(CONFIG.cult.fireDeath)) {
        cult.kill(c, 'fire');
        continue;
      }
      routine.leave(c);
      routine.replan(c);
    }
  }

  tick(hours) {
    if (this.burning.size === 0) return;
    const cfg = CONFIG.cult;
    const spread = this.cult.settings.fireSpread;
    const buildings = this.city.buildings;

    for (const index of [...this.burning]) {
      const b = buildings[index];
      if (!this.burning.has(index)) continue;
      // Arrosé au tick précédent : le feu ne gagne plus de terrain.
      if (b.dousedTick !== this.cult.tickId - 1) b.fire = Math.min(1, b.fire + cfg.fireGrowth * hours);
      b.burn += (b.fire * hours) / this.burnTime(b);

      if (spread > 0) {
        const p = 1 - Math.exp(-cfg.spreadRate * spread * b.fire * hours);
        for (const n of this.neighborsOf(index)) {
          if (!this.rng.chance(p)) continue;
          const cult = b.fireCult >= 0 ? this.cult.cults[b.fireCult] : null;
          if (this.ignite(n, cult)) {
            this.cult.logThrottled('spread', 3, `Le feu se propage (${PLACE_LABELS[buildings[n].type].toLowerCase()}).`, 'fire');
          }
        }
      }
      if (b.burn >= 1) this.destroy(index);
    }
  }

  /** Plus le bâtiment est grand, plus il met de temps à brûler entièrement. */
  burnTime(b) {
    const [min, max] = CONFIG.cult.burnTime;
    return Math.min(max, Math.max(min, Math.sqrt(b.w * b.h) / 12));
  }

  neighborsOf(index) {
    let list = this.neighbors.get(index);
    if (list) return list;
    const gap = CONFIG.cult.spreadGap;
    const b = this.city.buildings[index];
    list = [];
    for (const o of this.city.buildings) {
      if (o !== b && rectGap(b, o) <= gap) list.push(o.index);
    }
    this.neighbors.set(index, list);
    return list;
  }

  /** Les pompiers arrosent : @returns {boolean} true si le feu est éteint. */
  douse(index, amount) {
    const b = this.city.buildings[index];
    if (!(b.fire > 0)) return true;
    b.dousedTick = this.cult.tickId;
    b.fire -= amount;
    if (b.fire > 0) return false;
    b.fire = 0;
    this.burning.delete(index);
    this.cult.totals.saved++;
    this.cult.logThrottled('saved', 4, 'Les pompiers maîtrisent un incendie.', 'good');
    return true;
  }

  /** Il ne reste que des murs noircis : le bâtiment devient une ruine. */
  destroy(index) {
    const b = this.city.buildings[index];
    b.fire = 0;
    this.burning.delete(index);
    const label = PLACE_LABELS[b.type].toLowerCase();
    this.cult.loseBuilding(index);
    if (b.originalType === undefined) b.originalType = b.type;
    this.city.convertPlace(index, PlaceType.RUIN);
    this.cult.relocate(index);
    this.cult.totals.ruins++;
    this.cult.logThrottled('ruin', 2, `Un bâtiment part en fumée (${label}) : il n'en reste que des ruines.`, 'fire');
  }
}
