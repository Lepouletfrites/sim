/**
 * Paramètres globaux de la simulation.
 * Toutes les distances sont en pixels CSS, les durées en secondes.
 */
export const CONFIG = {
  simulation: {
    fixedDt: 1 / 60,          // pas physique fixe (sub-stepping)
    maxStepsPerFrame: 12,     // garde-fou contre la "spirale de la mort"
    maxFrameDt: 0.1,          // clamp du deltaTime (onglet en arrière-plan, lag)
    timeScales: [0, 1, 2, 5],
    defaultTimeScale: 1,
  },

  city: {
    avenueWidth: 36,          // avenues entre super-blocs
    alleyWidth: 18,           // ruelles à l'intérieur des super-blocs
    minLot: 26,               // taille minimale d'une parcelle
    maxDepth: 8,              // profondeur max de subdivision BSP
    density: { min: 1, max: 10, default: 5 },
    // Valeurs interpolées selon la densité (low = densité 1, high = densité 10)
    blockSize: { low: 130, high: 280 },
    maxLot: { low: 55, high: 110 },
    setback: { low: 7, high: 1 },
    plazaChance: { low: 0.18, high: 0.03 },
    buildingGridCell: 64,     // grille statique d'accélération des collisions
    walkCell: 2,              // résolution de la grille de marche
    walkClearance: 1.5,       // marge autour des bâtiments dans la grille de marche
  },

  citizens: {
    min: 100,
    max: 1500,
    default: 500,
    step: 50,
    radiusMin: 3,
    radiusMax: 4,
    speedMin: 26,
    speedMax: 46,
    maxSpeedFactor: 1.5,
    steering: 4,              // réactivité vers la vitesse désirée
    separationPadding: 3,     // distance de confort entre deux disques
    separationStrength: 110,
    passRightBias: 0.6,       // décalage vers la droite quand on se croise
    gridCellSize: 16,         // doit être >= distance max de séparation
    decisionInterval: { min: 0.2, max: 0.45 }, // multi-tick
    lookAhead: 22,
    sideProbe: 34,
    probeStep: 5,
    turnChance: 0.4,
    turnCooldown: 1.1,
    wobble: 0.12,
    stuckSpeedRatio: 0.2,
    stuckTime: 0.8,
  },

  colors: {
    background: '#1a1a1a',
    plaza: '#1f2328',
    roadMark: 'rgba(255, 255, 255, 0.05)',
    buildingFill: '#2c3e50',
    buildingStroke: '#34495e',
    citizen: '#3498db',
  },
};
