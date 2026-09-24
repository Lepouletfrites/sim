const HALF_PI = Math.PI / 2;

/** Directions cardinales, dans le sens horaire à l'écran : E, S, O, N. */
export const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * Un habitant : état physique (position, vitesse) + état de décision
 * (cap cardinal, direction désirée, minuteries du multi-tick).
 */
export class Citizen {
  constructor(id, x, y, radius, speed) {
    this.id = id;

    // Physique
    this.x = x;
    this.y = y;
    this.px = x;        // position au pas précédent (interpolation du rendu)
    this.py = y;
    this.vx = 0;
    this.vy = 0;
    this.radius = radius;
    this.speed = speed;

    // Décision
    this.heading = 0;   // index dans DIRECTIONS
    this.dirX = 1;      // direction désirée (unitaire)
    this.dirY = 0;
    this.decisionTimer = 0;
    this.turnCooldown = 0;
    this.stuckTimer = 0;
  }

  /** Oriente l'agent vers un cap cardinal, avec une légère déviation angulaire. */
  setHeading(heading, wobble = 0) {
    this.heading = heading;
    const angle = heading * HALF_PI + wobble;
    this.dirX = Math.cos(angle);
    this.dirY = Math.sin(angle);
  }
}
