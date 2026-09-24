/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 * Une même graine produit toujours la même ville.
 */
export class Random {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.state = this.seed || 1;
  }

  static randomSeed() {
    return (Math.random() * 0xffffffff) >>> 0;
  }

  /** Nombre dans [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** Entier dans [min, max] inclus. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(array) {
    return array[Math.floor(this.next() * array.length)];
  }
}
