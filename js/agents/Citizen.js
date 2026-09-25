const HALF_PI = Math.PI / 2;

/** Directions cardinales, dans le sens horaire à l'écran : E, S, O, N. */
export const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** États de santé (modèle SEIR simplifié + décès). */
export const Health = Object.freeze({
  SUSCEPTIBLE: 0, // sain, peut être contaminé
  INCUBATING: 1,  // contaminé : latence puis contagieux sans symptômes (ou asymptomatique)
  SYMPTOMATIC: 2, // malade, contagieux
  RECOVERED: 3,   // guéri et immunisé
  DEAD: 4,
});

/** Contrainte imposée à la routine par l'état de santé ou la prudence. */
export const Care = Object.freeze({
  NONE: 0,
  QUARANTINE: 1, // malade léger responsable : reste chez lui jusqu'à guérison
  BEDRIDDEN: 2,  // cas grave qui ne consulte pas : alité chez lui
  HOSPITAL: 3,   // cas grave pris en charge
  CONFINED: 4,   // non malade, se confine par prudence jusqu'à `careUntil`
});

/**
 * Un habitant : physique, profil (âge, emploi, horaires, personnalité),
 * activité en cours et état de santé.
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
    this.speedFactor = 1;
    this.extraSpace = 0; // distanciation physique volontaire

    // Errance dans la rue
    this.heading = 0;   // index dans DIRECTIONS
    this.dirX = 1;      // direction désirée (unitaire)
    this.dirY = 0;
    this.decisionTimer = 0;
    this.turnCooldown = 0;
    this.stuckTimer = 0;

    // Déplacement à l'intérieur d'un bâtiment
    this.tx = x;
    this.ty = y;
    this.pause = 0;

    // Profil (tiré à la naissance, voir Traits.js)
    this.age = 'adult';
    this.civism = 0;      // plus il est haut, plus l'habitant suit les consignes, et vite
    this.caution = 0;     // distanciation, masque, confinement
    this.sociability = 0; // sorties, restaurants, vie nocturne
    this.frailty = 1;     // multiplicateur du risque de forme grave
    this.infectivity = 1; // quantité de virus émise (quelques superpropagateurs)
    this.home = -1;
    this.work = -1;
    this.workStart = 9;
    this.workEnd = 17;
    this.worksSaturday = false;
    this.wake = 7;
    this.bedtime = 23;    // peut dépasser 24 (couche-tard)
    this.nightOwl = false;

    // Activité (voir Routine.js)
    this.place = -1;        // bâtiment où il se trouve, -1 = dans la rue
    this.destination = -1;  // bâtiment visé
    this.field = null;      // champ de flux suivi pour l'atteindre
    this.activity = 'sleep';
    this.activityEnd = 0;   // heure de jeu (absolue) de fin d'activité
    this.travelStart = 0;

    // Santé (voir Epidemic.js) — durées en heures de jeu
    this.health = Health.SUSCEPTIBLE;
    this.healthTimer = 0;
    this.latent = 0;        // temps restant avant d'être contagieux
    this.asymptomatic = false;
    this.severe = false;
    this.care = Care.NONE;
    this.careUntil = 0;
    this.waitingBed = false; // cas grave alité faute de lit à l'hôpital
    this.illnessDuration = 1;
    this.pendingDecision = false;
    this.hesitation = 0;
    this.masked = false;

    // Mode zombie (voir Zombies.js)
    this.zombie = 0;        // ZombieState
    this.bravery = 0;       // les plus braves deviennent survivalistes
    this.fighter = false;
    this.barricaded = false;
    this.biteTimer = 0;     // h avant transformation
    this.zombieAge = 0;     // h depuis la transformation
    this.rotFactor = 1;
    this.target = null;     // zombie : humain pourchassé
    this.threat = null;     // humain : zombie qu'il fuit (ou attaque)
    this.musicVenue = -1;   // zombie : lieu bruyant qui l'attire
  }

  get alive() {
    return this.health !== Health.DEAD;
  }

  get isContagious() {
    return (
      (this.health === Health.INCUBATING && this.latent <= 0) || this.health === Health.SYMPTOMATIC
    );
  }

  /** Oriente l'agent vers un cap cardinal, avec une légère déviation angulaire. */
  setHeading(heading, wobble = 0) {
    this.heading = heading;
    const angle = heading * HALF_PI + wobble;
    this.dirX = Math.cos(angle);
    this.dirY = Math.sin(angle);
  }
}
