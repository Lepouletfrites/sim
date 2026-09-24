/**
 * Paramètres globaux de la simulation.
 * Distances en pixels CSS. Physique en secondes réelles de simulation ;
 * tout ce qui relève de la vie des habitants et de la maladie est en HEURES de jeu.
 */
export const CONFIG = {
  simulation: {
    fixedDt: 1 / 60,          // pas physique fixe (sub-stepping)
    maxStepsPerFrame: 60,     // garde-fou contre la "spirale de la mort" (x50 = 50 pas/frame)
    maxFrameDt: 0.1,          // clamp du deltaTime (onglet en arrière-plan, lag)
    timeScales: [0, 1, 5, 10, 25, 50],
    defaultTimeScale: 10,
    tickInterval: 0.25,       // décisions lentes (routine, épidémie) : 4 fois par seconde simulée
  },

  time: {
    secondsPerHour: 8,        // 1 jour de jeu = 3 min 12 à x1, ~19 s à x10, ~4 s à x50
    startHour: 6,             // la simulation démarre le lundi à 6 h
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

  /** Types de bâtiments, horaires et risque de transmission par lieu. */
  places: {
    mallEvery: 45,            // 1 centre commercial pour ~45 bâtiments (1 à 3)
    nightclubEvery: 50,       // 1 boîte de nuit pour ~50 bâtiments (1 à 3)
    restaurantShare: 0.08,
    workShare: 0.25,
    capacityPerArea: 1 / 70,  // personnes par px² (hors logements, jamais pleins)
    // Jours : 0 = lundi ... 6 = dimanche. Créneaux en heures, fin > 24 = lendemain.
    schedule: {
      work: { days: [0, 1, 2, 3, 4, 5], slots: [[7, 19]] },
      mall: { days: [0, 1, 2, 3, 4, 5], slots: [[9, 20]] },
      restaurant: { days: [0, 1, 2, 3, 4, 5, 6], slots: [[11.5, 14.5], [18.5, 23.5]] },
      nightclub: { days: [4, 5], slots: [[23, 29]] }, // vendredi et samedi, 23 h - 5 h
    },
    // Multiplicateur du risque de contagion selon le lieu du contact
    transmission: {
      street: 0.3,            // air libre : aérosols vite dilués
      home: 0,                // les habitants ne se contaminent pas entre logements
      work: 1,
      mall: 0.7,              // grand volume, contacts brefs
      restaurant: 1.6,        // sans masque, face à face, longue durée
      nightclub: 3,           // foule dense, parole forte, mauvaise ventilation
      hospital: 0,            // protocoles sanitaires
    },
  },

  /** Emplois du temps et profils de la population. */
  routine: {
    ages: {
      young: {
        share: 0.25, label: 'Jeunes', employment: 0.6,
        wake: [7, 9.5], bedtime: [23, 26], frailty: [0.2, 0.6],
        sociability: [0.4, 1], caution: [0, 0.8],
      },
      adult: {
        share: 0.5, label: 'Adultes', employment: 0.85,
        wake: [6, 8], bedtime: [22, 24.5], frailty: [0.5, 1.3],
        sociability: [0.2, 0.8], caution: [0.1, 0.9],
      },
      senior: {
        share: 0.25, label: 'Seniors', employment: 0.05,
        wake: [6, 8.5], bedtime: [21, 23.5], frailty: [1.5, 4],
        sociability: [0.1, 0.5], caution: [0.3, 1],
      },
    },
    workStart: [7.5, 9.5],
    commuteLead: 0.75,        // départ ~45 min avant l'embauche
    venueCandidates: 3,       // on choisit le plus proche parmi 3 lieux tirés au hasard
    workDuration: [7.5, 9],
    saturdayWork: 0.15,
    lunchOut: 0.3,            // part des salariés qui déjeunent au restaurant
    nightOwlSociability: 0.65, // ~ 1 jeune sur 2, 1 adulte sur 4
    nightclubChance: 0.6,     // chance de sortir en boîte (× sociabilité), si ouverte
    // Poids des activités de temps libre, et durées (h)
    leisure: {
      home: { weight: 1, duration: [1, 3] },
      walk: { weight: 0.6, duration: [0.5, 2] },
      mall: { weight: 0.5, duration: [1, 3] },
      restaurant: { weight: 0.5, duration: [1, 2] },
    },
    sickLeisureFactor: 0.3,   // un malade qui ignore ses symptômes sort moins
    retryDelay: [0.5, 1.5],   // lieu complet : on flâne puis on réessaie (h)
    maxTravel: 5,             // au-delà (h), l'habitant est considéré arrivé
    arriveMargin: 8,          // distance au bâtiment pour y entrer (px)
    indoorSpeedFactor: 0.2,   // on se déplace lentement à l'intérieur
    indoorPause: [1, 5],      // pauses (s) entre deux déplacements intérieurs
  },

  citizens: {
    min: 100,
    max: 1500,
    default: 500,
    step: 50,
    radiusMin: 3,
    radiusMax: 4,
    // ~1 km/h de jeu = 10 px/s : un trajet domicile-travail dure 30 à 60 min.
    // Reste < 2 px par sous-étape : pas de risque de traverser un mur.
    speedMin: 70,
    speedMax: 100,
    maxSpeedFactor: 1.5,
    steering: 4,              // réactivité vers la vitesse désirée
    separationPadding: 3,     // distance de confort entre deux disques
    separationStrength: 110,
    passRightBias: 0.6,       // décalage vers la droite quand on se croise
    gridCellSize: 20,         // doit être >= distance max de séparation (distanciation incluse)
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

  epidemic: {
    // Curseurs (en %)
    transmission: { min: 0, max: 100, default: 12 },   // chance de contaminer par heure de contact rapproché
    virulence: { min: 0, max: 100, default: 10 },      // chance de forme grave (× fragilité)
    responsibility: { min: 0, max: 100, default: 50 }, // part des malades qui se prennent en charge
    prudence: { min: 0, max: 100, default: 50 },       // distanciation, masques, confinement volontaire

    contactRadius: 12,        // distance de contagion (<= gridCellSize)
    // Durées en heures de jeu
    latent: [24, 48],         // contaminé mais pas encore contagieux
    incubation: [48, 120],    // délai total avant symptômes (contagieux après la latence)
    asymptomaticCarriage: [72, 168],
    illness: [120, 240],      // forme légère
    severeIllness: [240, 400],
    treatment: [120, 240],    // hospitalisation (plafonnée à la durée restante)
    asymptomaticChance: 0.3,
    asymptomaticInfectivity: 0.5, // les asymptomatiques émettent moins de virus

    // Formes graves et décès
    deathUntreated: 0.45,     // létalité d'un cas grave non hospitalisé
    deathHospital: 0.08,      // létalité d'un cas grave hospitalisé
    irresponsibleSevereCare: 0.35, // un irresponsable grave finit parfois par consulter

    // Comportements
    sickSpeedFactor: 0.75,
    severeSpeedFactor: 0.5,
    maxHesitation: 36,        // h avant d'agir face aux symptômes, selon le civisme
    awarenessGain: 5,         // sensibilité de l'inquiétude aux malades connus
    awarenessSmoothing: 12,   // h : l'inquiétude évolue en une demi-journée
    deathMemory: 72,          // demi-vie (h) du choc provoqué par un décès
    deathShock: 3,            // un décès "compte" comme 3 malades connus
    maxExtraSpace: 8,         // distanciation max ajoutée entre deux personnes
    maskGain: 1.2,            // part de masqués = prudence × inquiétude × 1,2 (les plus prudents d'abord)
    maskEmission: 0.5,        // un masque divise par 2 ce qu'on émet...
    maskReception: 0.7,       // ... et réduit de 30 % ce qu'on reçoit
    confineRate: 0.02,        // probabilité / h de se confiner (prudence et inquiétude max)
    confineDuration: [24, 72],

    hospitalCapacity: 40,
    deathMarkLife: 12,        // h d'affichage d'un décès sur la carte
    sampleInterval: 2,        // h entre deux points de la courbe
    maxSamples: 300,          // au-delà, l'historique est sous-échantillonné
  },

  navigation: {
    cellSize: 8,              // grille des champs de flux
    clearance: 4,             // rayon libre exigé pour qu'une case soit praticable
    sourceReach: 14,          // cases considérées comme "à la porte" d'un bâtiment
  },

  colors: {
    background: '#1a1a1a',
    plaza: '#1f2328',
    roadMark: 'rgba(255, 255, 255, 0.05)',
    night: 'rgba(4, 8, 24, ALPHA)',
    nightMaxAlpha: 0.45,
    closedVenue: 'rgba(0, 0, 0, 0.45)',
    homeLight: 'rgba(241, 196, 15, ALPHA)', // fenêtres éclairées la nuit
    // Indexé par Health : sain, porteur, malade, guéri, décédé
    health: ['#3498db', '#f39c12', '#e74c3c', '#8e9aa6', '#9b59b6'],
    hospitalRing: '#ffffff',  // en route vers l'hôpital
    homeRing: '#f1c40f',      // rentre s'isoler / se confiner
    hospitalCross: '#ecf0f1',
    // Bâtiments par type : remplissage, bordure (et étiquettes)
    places: {
      home: { fill: '#2c3e50', stroke: '#34495e' },
      work: { fill: '#1f3a3a', stroke: '#2f6b66' },
      mall: { fill: '#3a3320', stroke: '#b08a2e' },
      restaurant: { fill: '#3d2820', stroke: '#c0673a' },
      nightclub: { fill: '#2f1f3d', stroke: '#9b59d6' },
      hospital: { fill: '#4a2330', stroke: '#c0392b' },
      street: { fill: '#1a1a1a', stroke: '#6b7580' },
    },
  },
};
