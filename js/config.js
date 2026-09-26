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
    defaultTimeScale: 1,
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
    // Valeurs interpolées selon la densité (low = 1, rural ; high = 10, centre-ville)
    blockSize: { low: 290, high: 150 },     // taille des îlots entre avenues
    maxLot: { low: 125, high: 48 },         // taille max d'une parcelle
    setback: { low: 12, high: 1 },          // retrait du bâtiment sur sa parcelle
    plazaChance: { low: 0.5, high: 0.02 },  // parcelle laissée en espace vert
    buildingFill: { low: [0.35, 0.65], high: [0.92, 1] }, // part du terrain couverte
    // Personnalisation du plan (curseurs de l'onglet Ville)
    chaos: { min: 0, max: 100, default: 40 },  // désordre du plan
    green: { min: 0, max: 100, default: 30 },  // espaces verts
    river: true,
    mergeChance: 0.45,        // îlots fusionnés (× désordre)
    boulevardChance: 0.25,    // avenue élargie en boulevard (× désordre)
    splitBuildings: 0.35,     // bâtiments accolés de profondeurs différentes (× désordre)
    greenLots: 0.25,          // parcelles laissées en jardin (× espaces verts)
    parkBlocks: 0.15,         // îlots entiers transformés en parc (× espaces verts)
    riverShape: {
      width: [30, 44],        // px
      amplitude: [18, 70],    // méandres (px), selon le désordre
      bridgeChance: 0.55,     // chaque avenue coupée a cette chance d'avoir un pont
      step: 6,                // px : finesse du tracé
    },
    buildingGridCell: 64,     // grille statique d'accélération des collisions
    walkCell: 2,              // résolution de la grille de marche
    walkClearance: 1.5,       // marge autour des bâtiments dans la grille de marche
  },

  /** Types de bâtiments, horaires et risque de transmission par lieu. */
  places: {
    mallEvery: 45,            // 1 centre commercial pour ~45 bâtiments (1 à 3)
    nightclubEvery: 50,       // 1 boîte de nuit pour ~50 bâtiments (1 à 3)
    schoolEvery: 25,          // 1 école pour ~25 bâtiments (1 à 3)
    restaurantShare: 0.08,
    workShare: 0.25,
    capacityPerArea: 1 / 70,  // personnes par px² (hors logements, jamais pleins)
    // Jours : 0 = lundi ... 6 = dimanche. Créneaux en heures, fin > 24 = lendemain.
    // Un lieu peut avoir plusieurs règles (liste) : l'école ferme le mercredi après-midi.
    schedule: {
      work: { days: [0, 1, 2, 3, 4, 5], slots: [[7, 19]] },
      school: [
        { days: [0, 1, 3, 4], slots: [[8, 16.5]] },
        { days: [2], slots: [[8, 12]] },
      ],
      mall: { days: [0, 1, 2, 3, 4, 5], slots: [[9, 20]] },
      restaurant: { days: [0, 1, 2, 3, 4, 5, 6], slots: [[11.5, 14.5], [18.5, 23.5]] },
      nightclub: { days: [4, 5], slots: [[23, 29]] }, // vendredi et samedi, 23 h - 5 h
    },
    // Multiplicateur du risque de contagion selon le lieu du contact
    transmission: {
      street: 0.3,            // air libre : aérosols vite dilués
      home: 0,                // pas de contagion entre foyers d'un même immeuble...
      household: 0.1,      // ...mais au sein du foyer, sans condition de distance : on partage
                              // cuisine et salle de bains (~20 à 30 % des proches contaminés)
      isolatedAtHome: 0.5,    // un malade en quarantaine s'isole dans sa chambre
      visit: 0.4,             // visite chez des amis : salon, repas, proximité
      school: 0.35,           // classes pleines (beaucoup de contacts), mais enfants peu contagieux
      work: 1,
      mall: 0.7,              // grand volume, contacts brefs
      restaurant: 1.6,        // sans masque, face à face, longue durée
      nightclub: 3,           // foule dense, parole forte, mauvaise ventilation
      hospital: 0,            // protocoles sanitaires
      temple: 1.4,            // réunions de secte : on chante, serrés, pendant des heures
      ruin: 0,
    },
  },

  /** Emplois du temps et profils de la population. */
  routine: {
    // Foyers : composition (âges des membres) et fréquence, d'après la structure des ménages
    // en France. Taille moyenne ~2,1 ; ~20 % d'enfants, ~17 % de seniors.
    households: [
      { weight: 0.14, members: ['young'] },
      { weight: 0.15, members: ['adult'] },
      { weight: 0.12, members: ['senior'] },
      { weight: 0.07, members: ['young', 'young'] },           // couple ou colocation
      { weight: 0.12, members: ['adult', 'adult'] },
      { weight: 0.10, members: ['senior', 'senior'] },
      { weight: 0.10, members: ['adult', 'adult', 'child'] },
      { weight: 0.10, members: ['adult', 'adult', 'child', 'child'] },
      { weight: 0.04, members: ['adult', 'adult', 'child', 'child', 'child'] },
      { weight: 0.05, members: ['adult', 'child'] },          // famille monoparentale
      { weight: 0.01, members: ['senior', 'adult', 'adult', 'child'] }, // trois générations
    ],
    ages: {
      child: {
        label: 'Enfants', employment: 0,
        wake: [7, 7.5], bedtime: [20, 21.5], frailty: [0.1, 0.3],
        sociability: [0.5, 1], caution: [0, 0.4],
      },
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
    schoolHours: [8.25, 16.5], // entrée et sortie des classes
    workStart: [7.5, 9.5],
    commuteLead: 0.75,        // départ ~45 min avant l'embauche
    venueCandidates: 3,       // on choisit le plus proche parmi 3 lieux tirés au hasard
    workDuration: [7.5, 9],
    saturdayWork: 0.15,
    lunchOut: 0.3,            // part des salariés qui déjeunent au restaurant
    nightOwlSociability: 0.65, // ~ 1 jeune sur 2, 1 adulte sur 4
    nightclubChance: 0.6,     // chance de sortir en boîte (× sociabilité), si ouverte
    // Poids des activités de temps libre, et durées (h)
    // Amitiés : tirées parmi des candidats proches (âge, quartier, collègues ou camarades)
    friends: { count: [2, 5], sample: 40, max: 7 },
    joinFriendChance: 0.5,    // on propose à un ami libre de venir au restaurant ou au centre co.
    leisure: {
      visit: { weight: 0.5, duration: [1.5, 3] }, // chez un ami
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
    childRadius: [2.2, 2.7],
    childSpeed: [65, 90],
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
    transmission: { min: 0, max: 100, default: 3 },    // chance de contaminer par heure de contact rapproché
    virulence: { min: 0, max: 100, default: 10 },      // chance de forme grave (× fragilité)
    responsibility: { min: 0, max: 100, default: 50 }, // part des malades qui se prennent en charge
    prudence: { min: 0, max: 100, default: 50 },       // distanciation, masques, confinement volontaire
    immunity: { min: 0, max: 360, default: 90, step: 10 }, // jours de protection après guérison (0 = à vie)
    reinfectionSeverity: 0.5, // chaque infection passée divise le risque de forme grave par 2

    // Dépistage et traçage des contacts (mesure sanitaire)
    testing: {
      chance: 0.8,            // part des malades qui se font tester (× civisme)
      delay: [6, 24],         // h entre la demande et le résultat
      perCapitaPerDay: 0.05,  // capacité : tests par habitant et par jour
      minPerDay: 10,
      backlogDelay: 12,       // labo saturé : on repasse plus tard (h)
    },
    tracing: {
      memory: 72,             // h : on retrouve les contacts des 3 derniers jours
      minExposure: 1,         // h cumulées à moins de 12 px pour être "cas contact"
      quarantine: 168,        // h d'isolement d'un cas contact
      maxContacts: 80,        // taille du carnet de contacts d'un porteur
    },

    contactRadius: 12,        // distance de contagion (<= gridCellSize)
    // Durées en heures de jeu
    latent: [24, 48],         // contaminé mais pas encore contagieux
    incubation: [48, 120],    // délai total avant symptômes (contagieux après la latence)
    asymptomaticCarriage: [72, 168],
    symptomaticContagious: [96, 168], // un malade n'est plus contagieux après 4 à 7 jours de symptômes
    illness: [120, 240],      // forme légère
    severeIllness: [240, 400],
    treatment: [120, 240],    // hospitalisation (plafonnée à la durée restante)
    asymptomaticChance: 0.3,
    asymptomaticInfectivity: 0.5, // les asymptomatiques émettent moins de virus

    // Formes graves et décès. Létalité d'un cas grave sans soins :
    //   (base + perVirulence × virulence) × fragilité
    //   -> 23 % à virulence 10 %, 95 % à 100 %, avant l'effet de la fragilité
    lethality: {
      base: 0.15,
      perVirulence: 0.8,
      frailtyMin: 0.65,       // jeune robuste : risque × 0,65
      frailtyMax: 1.5,        // senior fragile : risque × 1,5
      hospitalFactor: 0.2,    // l'hôpital divise le risque par 5
    },
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

    bedsPerCapita: 0.06,      // lits d'hôpital par habitant (30 pour 500 habitants)
    minBeds: 10,
    deathMarkLife: 12,        // h d'affichage d'un décès sur la carte
    sampleInterval: 2,        // h entre deux points de la courbe
    maxSamples: 300,          // au-delà, l'historique est sous-échantillonné
  },

  /** Mode zombie : indépendant de l'épidémie, sur la même population. */
  zombie: {
    // Curseurs
    biteInfect: { min: 0, max: 100, default: 70 },      // % : la morsure transforme (sinon la victime est dévorée)
    turnDelay: { min: 0, max: 48, default: 6 },         // h entre morsure et transformation (0 = immédiat)
    speed: { min: 30, max: 150, default: 60 },          // % de la vitesse humaine (30 = Romero, 150 = sprinteurs)
    smell: { min: 30, max: 200, default: 90 },          // px : portée du flair
    lifespan: { min: 0, max: 30, default: 12 },         // jours avant décomposition (0 = immortels)
    defense: { min: 0, max: 100, default: 35 },         // % : capacité des humains à se défendre
    fighters: { min: 0, max: 100, default: 15 },        // % de survivalistes qui attaquent au lieu de fuir
    barricade: { min: 0, max: 100, default: 45 },       // % qui se barricadent chez eux à l'alerte
    barricadeStrength: { min: 0, max: 100, default: 60 }, // % : temps pour forcer l'entrée d'un bâtiment
    supplies: { min: 0.5, max: 5, default: 1.5, step: 0.5 }, // jours de vivres d'un foyer barricadé
    research: { min: 0, max: 100, default: 50 },        // % : vitesse de la recherche du remède
    // Riposte : seuils en % de la population transformée, effectifs
    policeThreshold: { min: 0, max: 50, default: 2 },
    policeCount: { min: 1, max: 30, default: 6 },
    wallThreshold: { min: 0, max: 60, default: 10 },
    wallCount: { min: 1, max: 30, default: 12 },
    armyThreshold: { min: 0, max: 80, default: 30 },
    armyCount: { min: 5, max: 60, default: 24 },
    policeOn: true,
    wallsOn: true,
    armyOn: true,
    // Interrupteurs par défaut
    sunFear: false,           // léthargiques le jour, déchaînés la nuit
    music: false,             // attirés par les lieux bruyants ouverts
    fortressHospital: true,   // l'hôpital ne peut pas être envahi

    // Constantes du modèle
    fearRadius: 70,           // px : un humain voit un zombie et s'enfuit
    contactExtra: 6,          // px ajoutés aux rayons pour qu'un contact compte
    biteRate: 1.2,            // morsures / s de contact
    defenseRate: 1,           // zombies neutralisés / s de contact (défense 100 %, × profil)
    fighterDefense: 2.5,      // multiplicateur de défense d'un survivaliste
    civilianDefense: 0.2,     // ... d'un civil qui se débat
    surpriseDefense: 0.4,     // avant l'alerte, personne ne s'attend à devoir se battre
    shelterDefense: 2.5,      // retranché dans un bâtiment (armes de fortune, portes, meubles)
    panicBoost: 1.35,         // vitesse d'un humain qui fuit
    familyHesitation: 0.25,   // face à un proche transformé, on se défend 4 fois moins bien
    fetchTimeout: 8,          // h : un enfant attend ses parents à l'école, puis rentre seul
    // Siège : chaque zombie collé à un bâtiment occupé use la barricade (en "zombie-heures").
    // L'entrée cède à breachMin + breachRange × solidité : ~5 h de siège pour 5 zombies à 60 %.
    breachMin: 4,
    breachRange: 36,
    siegeDecay: 1,            // la barricade se répare de 1 zombie-heure / h sans assaillant
    reseal: 6,                // h sans zombie à l'intérieur avant de rebarricader
    indoorChase: 0.6,         // vitesse d'un zombie à l'intérieur (× sa vitesse)
    occupiedSmell: 1.5,       // les humains à l'intérieur se sentent de plus loin (× flair)
    lootDuration: [0.5, 1.5], // h passées à piller
    alarmThreshold: 5,        // zombies avant l'alerte générale
    alarmLeisure: 0.25,       // pendant l'alerte, on ne sort presque plus pour ses loisirs
    researchRate: 0.03,       // progression / h du remède (recherche 100 %, population intacte)
    cureRate: 0.3,            // chance / h qu'un zombie soit guéri une fois le remède prêt
    strikeRadius: 45,         // px : rayon d'une frappe aérienne
    markLife: 12,             // h d'affichage des traces
    sampleInterval: 1,        // h entre deux points de la courbe
    maxSamples: 300,
    maxEvents: 40,

    // Forces de l'ordre : vitesse (px/s), portée (px), cadence (tirs / s), précision,
    // munitions par unité (à court, l'unité se replie), blindage (× risque de morsure)
    police: { speed: 90, radius: 3.5, range: 42, fireRate: 0.7, accuracy: 0.55, ammo: 16, armor: 1 },
    army: { speed: 75, radius: 4, range: 60, fireRate: 0.8, accuracy: 0.6, ammo: 36, armor: 0.55 },
    // Barricades de rue : points de vie en "secondes de zombie au contact"
    wall: {
      hp: 60,
      thickness: 6,
      maxLength: 56,          // on ne barre que les rues étroites (pas les carrefours)
      spacing: 70,            // px minimum entre deux barricades
      rebuildEvery: 12,       // h : on reconstruit celles qui ont cédé tant que la menace dure
    },
  },

  /** Sectes : gourous, conversions, QG, gangs et incendies. Durées en heures de jeu. */
  cult: {
    // Curseurs : recrutement
    charisma: { min: 0, max: 100, default: 55 },        // % : force de conviction des prêches
    wordOfMouth: { min: 0, max: 100, default: 35 },     // % : les fidèles recrutent leurs proches
    credulity: { min: 0, max: 100, default: 30 },       // % de la population réceptive
    hold: { min: 0, max: 100, default: 60 },            // % : emprise (les fidèles restent)
    tithe: { min: 0, max: 100, default: 50 },           // % : dîme versée par chaque fidèle
    // Croissance
    hqMembers: { min: 3, max: 80, default: 8 },         // fidèles pour acheter un QG
    gangMembers: { min: 5, max: 200, default: 15 },     // fidèles pour basculer en gang
    radicalization: { min: 0, max: 100, default: 35 },  // % des fidèles qui deviennent fanatiques
    arson: { min: 0, max: 100, default: 55 },           // % : un raid finit en incendie
    violence: { min: 0, max: 100, default: 35 },        // % : agressions des fanatiques
    fireSpread: { min: 0, max: 100, default: 40 },      // % : propagation du feu aux voisins
    vigilance: { min: 0, max: 100, default: 40 },       // % : familles et citoyens qui résistent et signalent
    // Riposte
    policeThreshold: { min: 0, max: 100, default: 20 }, // % d'insécurité avant l'intervention
    policeCount: { min: 1, max: 30, default: 6 },
    firefighterCount: { min: 1, max: 20, default: 4 },
    raidThreshold: { min: 1, max: 40, default: 6 },     // méfaits d'une secte avant la descente au QG
    policeOn: true,
    firefightersOn: true,
    raidOn: true,
    // Règles
    fearBoost: true,          // épidémie et zombies font recette
    prophecy: false,          // le gourou annonce la fin du monde
    martyr: true,             // gourou arrêté ou tué : un successeur, et la colère
    rivalry: true,            // les sectes rivales se font la guerre

    maxCults: 4,
    preachRadius: 70,         // px : portée d'un prêche
    sermonRate: 0.8,          // conviction / h d'écoute (charisme 100 %, réceptivité 1)
    listenBoost: 3,           // celui qui s'arrête pour écouter est bien plus touché
    listenChance: 3,          // / h : un passant réceptif s'arrête pour écouter
    listenDuration: [0.3, 1],
    wordRate: 0.7,            // conviction / h de contact avec un fidèle (bouche-à-oreille 100 %)
    familyBoost: 0.5,         // à la maison, les proches sont exposés en permanence (× taux)
    friendBoost: 0.4,         // un ami croisé (même lieu) est influencé, à toute distance
    inviteChance: 0.15,       // (× bouche-à-oreille) un fidèle emmène un ami réceptif à la réunion
    // Résistance de la société (× vigilance)
    familyPull: 0.05,         // ferveur / h retirée à un fidèle par proche hostile à la maison
    reportRate: 0.05,         // signalements / h d'un témoin (prêche, famille)
    reportThreshold: 12,      // signalements avant l'enquête pour abus de faiblesse
    investigationJail: 48,    // h de garde à vue du gourou
    neighborRadius: 60,       // px : voisins du QG
    moveRate: [0.003, 0.012], // / h : un foyer voisin du QG déménage (communauté, gang)
    contactRadius: 14,
    meetingRate: 0.8,         // conviction / h en réunion (curieux) ; ferveur retrouvée (fidèles)
    doubtRate: 0.02,          // perte de conviction / h sans contact (curieux)
    devotionLoss: 0.035,      // perte de ferveur / h d'un fidèle (× (1 - emprise))
    apostasyAt: 0.25,         // sous cette ferveur, le fidèle quitte la secte
    curiousAt: 0.25,          // conviction à partir de laquelle on est invité aux réunions
    preachHours: [9, 18.5],   // le gourou prêche au coin des rues
    meetingHours: [19, 22.5], // réunions du soir
    meetingChance: 0.7,       // chance qu'un fidèle aille à la réunion
    curiousMeetingChance: 0.6,
    proselytize: 0.35,        // chance (× bouche-à-oreille) qu'un fidèle prêche le week-end
    discipleCharisma: 0.35,   // un disciple prêche moins bien que le gourou
    titheRate: 300,           // €/jour par fidèle à 100 % de dîme
    pricePerArea: 1.5,        // €/px² : prix d'un bâtiment
    seizedFor: 48,            // h : après une descente, la secte sous surveillance ne peut rien acheter
    maxAnnexes: 3,
    // Nuits du gang
    nightHours: [22, 4],
    raidEvery: 1.3,           // chance / nuit de lancer un raid (× max(pyromanie, violence))
    squad: [3, 7],
    raidDuration: 3,
    prowlChance: 1,           // (× violence) un fanatique rôde la nuit au lieu de dormir
    preyRadius: 60,           // px : un fanatique qui rôde repère et suit un passant isolé
    assaultRate: 5,           // agressions / h au contact (violence 100 %)
    bail: 400,                // € : caution d'un fidèle (× 10 pour le gourou)
    assaultLethality: 0.1,
    brawlRate: 2,             // rixes / h entre fanatiques rivaux
    // Feu
    fireGrowth: 0.8,          // intensité / h (tant que personne n'arrose)
    burnTime: [2, 6],         // h à pleine intensité avant ruine (selon la taille)
    spreadRate: 1,            // / h, × propagation × intensité
    spreadGap: 34,            // px : le feu saute les ruelles (ville dense), rarement la campagne
    fireDeath: 0.05,          // chance qu'un occupant périsse au départ du feu
    extinguishRate: 0.3,      // intensité / h éteinte par équipe de pompiers sur place
    // Police
    unitSpeed: 85,
    arrestRate: 1.5,          // arrestations / s au contact
    resistRate: 0.12,         // policiers blessés / s au contact (× violence)
    jailTime: [24, 48],
    guruJail: 120,
    rageDecay: 0.02,          // / h : la colère après un martyre retombe
    insecurityMemory: 24,     // h : demi-vie des méfaits dans l'insécurité
    insecurityScale: 12,      // méfaits "récents" pour ~63 % d'insécurité
    insecurityLeisure: 0.6,   // l'insécurité freine les sorties
    prophecyDelay: 3,         // jours avant la date annoncée
    sampleInterval: 1,
    maxSamples: 300,
    maxEvents: 50,
    maxTags: 160,
  },

  navigation: {
    cellSize: 8,              // grille des champs de flux
    clearance: 4,             // rayon libre exigé pour qu'une case soit praticable
    sourceReach: 14,          // cases considérées comme "à la porte" d'un bâtiment
  },

  colors: {
    background: '#1a1a1a',
    groundRural: '#1a261d',   // sol des îlots à la campagne (champs, jardins)
    groundUrban: '#1f2124',   // ... et en ville (trottoirs, cours)
    plaza: '#1e3024',         // parcelles non bâties : parcs, prés
    water: '#173a52',
    riverBank: '#22313a',
    bridgeRail: '#8a9099',
    roadMark: 'rgba(255, 255, 255, 0.05)',
    night: 'rgba(4, 8, 24, ALPHA)',
    nightMaxAlpha: 0.45,
    closedVenue: 'rgba(0, 0, 0, 0.45)',
    homeLight: 'rgba(241, 196, 15, ALPHA)', // fenêtres éclairées la nuit
    // Indexé par Health : sain, porteur, malade, guéri, décédé
    health: ['#3498db', '#f39c12', '#e74c3c', '#8e9aa6', '#9b59b6'],
    zombie: '#7bd13a',
    zombieStroke: '#23400c',
    bittenRing: '#b4e05a',    // mordu (se transformera bientôt)
    fighterRing: '#ff9f43',   // survivaliste
    humanLoss: '#8e1b1b',     // humains dévorés ou tués
    strike: '#ffb142',
    police: '#4aa3ff',
    policeTracer: 'rgba(159, 208, 255, 0.9)',
    army: '#c9b458',
    armyStroke: '#3d3a1a',
    armyTracer: 'rgba(255, 209, 102, 0.9)',
    wall: '#9a6632',
    wallStroke: '#e0a45e',
    hospitalRing: '#ffffff',  // en route vers l'hôpital
    homeRing: '#f1c40f',      // rentre s'isoler / se confiner
    hospitalCross: '#ecf0f1',
    // Sectes (une couleur par secte), feu, secours
    cults: ['#d35cff', '#2ee6d6', '#ff5c8a', '#ffe08a'],
    guruGlow: 'rgba(255, 224, 138, ALPHA)',
    fire: '#ff7a1a',
    fireCore: '#ffd23f',
    smoke: 'rgba(90, 90, 90, ALPHA)',
    firefighter: '#e8322b',
    firefighterStroke: '#ffd9d6',
    spray: 'rgba(140, 200, 255, 0.7)',
    // Bâtiments par type : remplissage, bordure (et étiquettes)
    places: {
      home: { fill: '#2c3e50', stroke: '#34495e' },
      work: { fill: '#1f3a3a', stroke: '#2f6b66' },
      school: { fill: '#243a24', stroke: '#6fae4f' },
      mall: { fill: '#3a3320', stroke: '#b08a2e' },
      restaurant: { fill: '#3d2820', stroke: '#c0673a' },
      nightclub: { fill: '#2f1f3d', stroke: '#9b59d6' },
      hospital: { fill: '#4a2330', stroke: '#c0392b' },
      temple: { fill: '#2a1a33', stroke: '#7a4a8f' },
      ruin: { fill: '#161312', stroke: '#3b2a22' },
      street: { fill: '#1a1a1a', stroke: '#6b7580' },
    },
  },
};
