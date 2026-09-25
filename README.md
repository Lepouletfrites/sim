# CitySim — Simulation urbaine 2D procédurale

Simulation urbaine interactive en **Vanilla JavaScript** (modules ES, Canvas 2D), sans framework ni dépendance ni étape de build : une ville procédurale, ses habitants et leur vie quotidienne, une épidémie, une apocalypse zombie et des sectes.

## Interface

- **Barre d'outils** au-dessus de la carte : horloge (jour, heure, jour/nuit), vitesse de simulation, chiffres clés (habitants, infectés, décès, zombies, fidèles).
- **Carte** avec une légende repliable en quatre colonnes (virus, zombies, sectes, bâtiments). L'action du clic se choisit dans l'onglet Zombies ou Sectes.
- **Panneau latéral** : quatre onglets, chacun découpé en sous-onglets courts (onglet et sous-onglets mémorisés) :

| Onglet | Sous-onglets |
|---|---|
| **Virus** | **Suivi** : indicateurs, actions, courbe, état de santé, soins, lieux de contamination · **Réglages** : virus, comportements, mesures sanitaires |
| **Zombies** | **Suivi** : état de l'apocalypse, actions et clic, courbe, survivants, remède, journal · **Riposte** : police, barricades de rue, armée · **Réglages** : morsure, zombies, humains, barricades et vivres, remède, règles farfelues |
| **Sectes** | **Suivi** : état, actions et clic, fiche de chaque secte, courbe des fidèles, bilan, journal · **Riposte** : police, descente au QG, pompiers · **Réglages** : recrutement, emprise, croissance, chaos, règles farfelues |
| **Ville** | Génération (population, densité, désordre, espaces verts, rivière, graine), lieux et horaires |

- Pied de panneau : FPS, sous-étapes, nombre de bâtiments, graine et raccourcis clavier (`Espace` pause, `1`–`5` vitesse, `I` infecter, `G` gourou).

## Fonctionnalités

### Ville et physique
- Ville procédurale déterministe (graine) : îlots séparés par des avenues, subdivisés en BSP avec des ruelles. La graine peut être saisie pour rejouer une ville précise.
- **Densité urbaine** (1 à 10) : à 1, un village avec peu de petits bâtiments espacés au milieu des prés ; à 10, un centre-ville de bâtiments mitoyens. Sur une carte de 1150 × 850 : 43 bâtiments (4 % du sol bâti) à 1, 117 (14 %) à 5, 196 (32 %) à 10.
- **Désordre** (0 à 100 %) : îlots de tailles inégales, avenues de largeurs variables et boulevards, îlots fusionnés qui brisent la grille, découpes moins régulières, bâtiments accolés de profondeurs différentes.
- **Espaces verts** (0 à 100 %) : jardins, et îlots entiers transformés en parcs.
- **Rivière** : elle serpente à travers la ville (méandres plus marqués avec le désordre) et ne se franchit que par quelques ponts, ce qui crée des quartiers et des goulets d'étranglement. L'eau est un obstacle pour tout le monde.
- Les curseurs de forme s'appliquent au relâchement et gardent la même graine, pour voir leur effet sur la même ville.
- 100 à 1 500 habitants. Collision cercle/rectangle avec glissement le long des murs, séparation entre voisins, croisement par la droite.
- Contrôles : Pause, x1 (vitesse au démarrage), x5, x10, x25, x50 (clavier : `Espace`, `1` à `5`).

### Temps et lieux
Une horloge fait défiler les jours de la semaine (1 h de jeu = 8 s à x1, 1 jour ≈ 19 s à x10) avec un cycle jour/nuit.

| Lieu | Horaires | Risque de contagion |
|---|---|---|
| Logements | toujours | **nul** : on ne contamine personne chez soi |
| Bureaux | Lun–Sam 7h–19h | ×1 |
| Centre commercial | Lun–Sam 9h–20h | ×0,7 (grand volume, contacts brefs) |
| Restaurants | tous les jours, 11h30–14h30 et 18h30–23h30 | ×1,6 (face à face, sans masque) |
| Boîte de nuit | Ven–Sam 23h–5h | ×3 (foule dense, parole forte) |
| Hôpital | toujours (40 lits) | nul (protocoles sanitaires) |
| Rue et places | — | ×0,3 (air libre) |

Les habitants restent **visibles à l'intérieur des bâtiments**, où ils se déplacent lentement. Un lieu fermé est assombri sur la carte, et la nuit les fenêtres des logements occupés s'éclairent. Les lieux publics ont une jauge : quand ils sont complets, on flâne un moment avant de réessayer.

### Routine quotidienne
Chaque habitant a un profil tiré à la naissance :

- **Âge** : jeunes (25 %), adultes (50 %), seniors (25 %). L'âge détermine l'emploi, les heures de lever et de coucher, la fragilité, la sociabilité et la prudence.
- **Emploi** : bureau, horaires d'embauche de 7h30 à 9h30, 15 % travaillent le samedi, 30 % déjeunent au restaurant.
- **Temps libre** : maison, promenade, centre commercial ou restaurant, selon l'heure, le jour et la sociabilité. On choisit plutôt le lieu le plus proche.
- **Noctambules** : environ 1 jeune sur 2 et 1 adulte sur 4 sortent en boîte le vendredi et le samedi.

### Épidémie
Sain → Latence (1 à 2 jours, pas encore contagieux) → Porteur contagieux → Malade (après 2 à 5 jours) → Guéri et immunisé, ou Décès. 30 % des porteurs restent **asymptomatiques**.

| Curseur | Effet |
|---|---|
| **Transmission** | Chance de contaminer par heure de contact rapproché (< 12 px), dans le **même lieu**, × le risque du lieu |
| **Virulence** | Augmente la part de formes graves (× fragilité : seniors ≈ ×3, jeunes ≈ ×0,4) **et** leur létalité : sans soins, ~23 % à 10 %, ~95 % à 100 %, puis × fragilité. L'hôpital divise le risque par 5. Les décès surviennent au fil de la maladie |
| **Responsabilité** | Part des malades qui se prennent en charge : quarantaine si forme légère, hôpital si grave. Les autres continuent de travailler (**présentéisme**) |
| **Prudence** | Quand l'inquiétude monte : **masques**, distanciation, moins de sorties, **confinement volontaire** de 1 à 3 jours |

| Mesure sanitaire | Effet |
|---|---|
| Fermer les boîtes de nuit | Les clubs restent fermés |
| Fermer commerces et restaurants | Centre commercial et restaurants fermés |
| Télétravail obligatoire | Les salariés travaillent depuis chez eux |

**Hôpital saturé** (40 lits) : les cas graves qui ne trouvent pas de lit restent alités chez eux, sans soins, donc avec un risque de décès 5 fois plus élevé. Ils rejoignent l'hôpital dès qu'un lit se libère.

Effet de la virulence (600 habitants, 10 cas index, autres réglages par défaut, une simulation par ligne) :

| Virulence | Infectés | Décès | Létalité | Hôpital | Max. en attente d'un lit |
|---|---|---|---|---|---|
| 10 % | 480 | 2 | 0,4 % | 12 / 40 | 0 |
| 50 % | 462 | 44 | 9,5 % | 40 / 40 (saturé) | 18 |
| 100 % | 480 | 147 | 31 % | 40 / 40 (saturé) | 36 |

### Mode zombie

Un second fléau, indépendant de l'épidémie, sur la même population.

Humain → **morsure** → Mordu (garde sa vie normale pendant le délai de transformation) → **Zombie** → neutralisé (combat, décomposition, frappe) ou **guéri** par le remède. Une morsure peut aussi tuer : la victime est dévorée.

- **Chasse** : les zombies flairent l'humain le plus proche dans la rue et le poursuivent.
- **Siège et invasion des bâtiments** : sans proie dans la rue, les zombies flairent les humains cachés dans les bâtiments et les assiègent. Chaque zombie collé aux murs use les portes (plus ils sont nombreux, plus ça va vite : environ 5 h de siège pour 5 zombies avec la solidité par défaut). Une fois l'entrée forcée, **ils entrent** et se battent dans les pièces. Ils ressortent quand il n'y a plus personne, et les portes sont rebarricadées quelques heures plus tard.
- **Surprise puis alerte** : avant l'alerte générale (5 zombies), personne ne réagit et même les survivalistes sont pris de court. Ensuite, les humains fuient en courant, les **survivalistes** (les plus braves) chassent les zombies, les plus prudents se **barricadent** chez eux et tout le monde limite ses sorties. Retranché chez soi, on se défend 2,5 fois mieux.
- **Vivres et pillage** : un foyer barricadé a des réserves pour environ 1,5 jour (réglable). Une fois épuisées, ses membres sortent **piller le centre commercial** (à défaut un restaurant), puis rentrent se barricader. C'est à ce moment qu'ils sont les plus exposés.
- **Foyers** : un mordu qui se transforme à l'intérieur (chez lui, au bureau, au centre commercial) reste dans la pièce, au milieu des occupants.
- **Remède** : la recherche démarre à l'alerte, et avance d'autant plus vite qu'il reste d'humains. Une fois prêt, les mordus sont soignés et les zombies redeviennent humains peu à peu.
- **Règles farfelues** : zombies qui craignent le soleil (léthargiques le jour, déchaînés la nuit), attirés par la musique (boîtes et centre commercial ouverts), hôpital-forteresse.
- **Clic sur la carte** : infecter (virus), transformer en zombie, ou **frappe aérienne** (tout ce qui est dans la rue dans le rayon, humains compris ; les bâtiments protègent).
- **Journal de l'apocalypse** : premier cas, foyers, entrées forcées, pillages, paliers, riposte, munitions, remède, fin de l'alerte.

#### Riposte par paliers

Chaque force entre en jeu quand la **part de la population transformée** atteint son seuil. Pour chacune, l'interface montre une jauge avec le repère du seuil, un interrupteur, le seuil et l'effectif réglables, et un bilan.

| Palier | Seuil par défaut | Effet |
|---|---|---|
| **Police** | 2 % | 6 agents partent du **commissariat** (marqué POLICE sur la carte), rejoignent les zombies par les rues et tirent à 42 px, avec ligne de vue. 55 % de précision, 16 cartouches chacun. Vulnérables aux morsures. |
| **Barricades de rue** | 10 % | Les habitants barrent 12 rues étroites au contact du front, là où il y a le plus de monde à protéger. Seuls les zombies sont bloqués ; ils usent les barricades jusqu'à les faire céder. Reconstruites toutes les 12 h tant que la menace dure. |
| **Armée** | 30 % | 24 soldats entrent par le **bord de la carte le plus proche du gros de l'invasion**, sur deux rangs. Portée 60 px, 60 % de précision, 36 cartouches chacun, morsures ×0,55 grâce à l'équipement. |

Police et armée **reculent** quand un zombie s'approche trop, ne tirent que sur les zombies dans la rue, et **se replient à court de munitions**. Quand il n'y a plus ni zombie ni mordu, les forces se retirent et les barricades sont démontées ; une nouvelle vague relance la riposte. Les unités trouvent les zombies grâce à une carte des distances aux zombies (un seul BFS par tick pour toutes les unités).

Réglages : contagiosité de la morsure, délai de transformation, vitesse et flair des zombies, décomposition, combativité, part de survivalistes, réflexe barricade, solidité des portes, réserves de vivres, vitesse de la recherche.

Avec les réglages par défaut (600 habitants, un patient zéro), trois villes différentes ont donné trois histoires différentes :

| Ville | Déroulement | Survivants |
|---|---|---|
| 1 | La ville vacille pendant 3 jours ; l'armée arrive au jour 4 et nettoie tout | 60 |
| 2 | La police contient l'invasion dès le premier jour | 474 |
| 3 | Guerre d'usure avec des pillages ; le remède arrive au jour 4 | 368 |

### Sectes

Un troisième phénomène, sur la même population. Jusqu'à **4 sectes rivales**, chacune avec son nom, sa couleur et son gourou (« Les Enfants du Grand Pigeon », « Le Temple du Wifi Céleste »…).

Passant → **prêche** ou **bouche-à-oreille** → Curieux → **réunions** → Fidèle → (gang) **Fanatique**. Sans réunions, la ferveur s'use et le fidèle finit par partir, échaudé.

| Étape | Déclencheur par défaut | Ce qui se passe |
|---|---|---|
| **Prédication** | un gourou apparaît (bouton, touche `G` ou clic « Gourou ») | Le gourou démissionne et prêche devant les lieux fréquentés (centre commercial, restaurants, bureaux). Les passants **crédules** s'arrêtent pour l'écouter et forment un attroupement. Réunions du soir dans son salon. |
| **Communauté** | 12 fidèles, et assez d'argent | La secte **achète un immeuble** grâce à la dîme : c'est son **QG** (tracé à ses couleurs, avec son symbole). Le gourou y emménage, les réunions s'y tiennent. Locataires et salariés partent ailleurs. Une **annexe** de plus à chaque palier (jusqu'à 3). Le week-end, les disciples prêchent à leur tour. |
| **Gang** | 35 fidèles | Les moins civiques deviennent **fanatiques** et s'installent au QG. La nuit, ils rôdent, suivent et **agressent** les passants isolés, et lancent des **raids** : un commando se rassemble devant une cible (centre commercial, restaurant, bureaux, QG rival) et y met le feu, ou brise les vitrines et **tague** la façade. |

- **Incendies** : le feu grandit tant que personne ne l'arrose, se **propage** aux bâtiments voisins (ruelles : redoutable en ville dense, rare à la campagne), fait sortir les occupants (certains y restent) et laisse des **ruines** où plus personne ne va. Les habitants d'un bâtiment détruit sont relogés. Clic « Incendie » pour mettre le feu soi-même.
- **Pompiers** : partent de la **caserne** (marquée POMPIERS sur la carte), se répartissent entre les foyers et les arrosent sur place.
- **Police** : patrouille dès que l'**insécurité** (agressions et incendies récents) dépasse son seuil, surveille le QG le plus remuant et interpelle les fanatiques dehors la nuit. Garde à vue de 1 à 2 jours au commissariat, où l'on voit les détenus. Une secte riche **paie la caution** de ses membres.
- **Descente au QG** : quand une secte cumule trop de méfaits, la police perquisitionne. Tous les membres présents sont embarqués (le gourou pour 5 jours), les locaux saisis, 80 % de la caisse confisquée et les comptes gelés 48 h.
- **Insécurité** : elle pousse les habitants à rester chez eux, et retombe en un jour ou deux.
- **Interactions** : une réunion de secte est un lieu de contagion (×1,4) ; un fidèle mordu quitte la secte ; avec « La peur fait recette », l'épidémie et les zombies rendent la population bien plus crédule.

| Règle farfelue | Effet |
|---|---|
| **La peur fait recette** | Épidémie, alerte zombie et insécurité multiplient les conversions |
| **Prophétie de fin du monde** | Le gourou annonce la fin du monde pour dans 3 jours. Si une catastrophe tombe ce jour-là (zombies, épidémie, ville en feu), la secte explose ; sinon, désillusion, départs… et nouvelle date |
| **Martyrs** | Gourou arrêté ou tué : un fanatique prend sa place et la colère rend le gang plus violent pendant un temps |
| **Guerre des sectes** | Les fanatiques rivaux se battent dans la rue et incendient les QG adverses |

Réglages : charisme, bouche-à-oreille, crédulité, emprise, dîme, fidèles pour le QG et pour le gang, radicalisation, pyromanie, violence, propagation du feu ; seuil et effectif de la police, méfaits avant la descente, nombre d'équipes de pompiers.

Trois incendies allumés dans la même ville (trois villes par ligne, 16 h de jeu) :

| Densité | Pompiers | Bâtiments touchés | En ruine |
|---|---|---|---|
| 5 | oui | 11 | 4 |
| 9 (centre-ville) | oui | 37 | 21 |
| 9 (centre-ville) | non | 59 | 59 |

### Pourquoi ce modèle de transmission

| Choix | Raison |
|---|---|
| Contagion uniquement entre personnes proches **dans le même lieu** | Un mur sépare la rue de l'intérieur ; le risque dépend du temps passé ensemble |
| Rien à domicile (réglable dans `config.js`) | Les logements regroupent des foyers distincts |
| Rue ×0,3, boîte de nuit ×3 | Air libre contre foule dense en espace clos |
| **Superpropagateurs** : infectiosité individuelle très dispersée (~10 % émettent plus de 2,5× la moyenne) | La plupart des contaminations viennent d'une minorité de porteurs, et beaucoup de chaînes s'éteignent seules |
| Asymptomatiques 2× moins contagieux mais jamais isolés | Ils propagent le virus sans le savoir |
| Latence non contagieuse puis phase pré-symptomatique contagieuse | On contamine avant de se savoir malade |
| Masque : émission ×0,5, réception ×0,7 | Protège surtout les autres |
| Fragilité liée à l'âge | Les formes graves touchent surtout les seniors |

### Ce que montrent les tests
Une simulation par scénario, même ville de 600 habitants, 3 cas index, transmission 12 %, virulence 10 %. Les résultats varient d'une partie à l'autre : les superpropagateurs rendent l'épidémie très aléatoire à ses débuts.

| Scénario | Infectés | Pic | Décès |
|---|---|---|---|
| Insouciant (responsabilité 0 %, prudence 0 %) | 563 | 462 | 15 |
| Par défaut (50 % / 50 %) | 485 | 372 | 10 |
| Exemplaire (100 % / 100 %) | 373 | 243 | 1 |

Sans mesures, on se contamine surtout au **travail** (40 à 55 %), puis au restaurant et au centre commercial ; la rue pèse moins de 5 %. Avec le télétravail seul, les contaminations basculent vers les restaurants (47 %), le centre commercial (36 %) et la boîte de nuit (13 %).

### Légende de la carte

| Symbole | Signification |
|---|---|
| Bleu | Sain |
| Orange | Porteur sans symptômes |
| Rouge | Malade |
| Gris | Guéri, immunisé |
| Croix violette | Décès (s'efface en 12 h de jeu) |
| Anneau blanc | En route vers l'hôpital |
| Anneau jaune | Rentre s'isoler ou se confiner |
| Disque cerclé de blanc avec un halo | Gourou (cercle pointillé : portée de son prêche) |
| Anneau de couleur (pâle : curieux) | Fidèle de la secte de cette couleur |
| Losange de couleur | Fanatique |
| Bâtiment liseré de couleur, « QG » / « ANNEXE » | Locaux d'une secte |
| Flammes et fumée | Incendie ; bâtiment noirci : ruine |
| Carré rouge | Pompiers (pointillés bleus : jet d'eau) |
| Couleur du bâtiment | Type de lieu (voir le panneau Lieux) |

Infection d'un habitant au clic sur la carte, bouton ou touche `I` ; courbe de l'épidémie au fil des jours, avec info-bulle.

## Architecture

```
index.html
css/style.css
js/
├── main.js                 Point d'entrée : assemble les modules
├── config.js               Tous les paramètres réglables
├── core/
│   ├── GameLoop.js         requestAnimationFrame + deltaTime + FPS
│   ├── Simulation.js       timeScale, pas fixe (sub-stepping), tick lent
│   ├── Clock.js            Heure de jeu, jours de la semaine, lumière du jour
│   ├── SpatialHashGrid.js  Grille spatiale (listes chaînées en tableaux typés)
│   └── Random.js           PRNG déterministe (mulberry32)
├── world/
│   ├── CityGenerator.js    Génération procédurale du plan
│   ├── City.js             Grilles, types de bâtiments, capacités
│   ├── PlaceTypes.js       Types de lieux, horaires d'ouverture
│   └── NavigationField.js  Champs de flux (BFS) vers chaque bâtiment
├── agents/
│   ├── Citizen.js          État d'un habitant
│   ├── Traits.js           Profil : âge, emploi, horaires, personnalité
│   ├── Routine.js          Emploi du temps, trajets, entrées et sorties
│   ├── WanderBehavior.js   Errance dans la rue (décisions lentes)
│   └── Population.js       Pas physique, dehors et dedans
├── epidemic/
│   └── Epidemic.js         Contagion par lieu, gravité, décès, soins, comportements
├── zombie/
│   ├── ZombieState.js      États (humain, mordu, zombie...)
│   ├── Zombies.js          Apocalypse : chasse, combats, sièges, foyers, remède, journal
│   └── Response.js         Riposte : police, barricades de rue, armée
├── cult/
│   ├── Cult.js             Sectes : prêches, conversions, QG, gangs, raids, prophétie, journal
│   ├── Fires.js            Incendies : propagation, extinction, ruines
│   └── CultResponse.js     Police (interpellations, descente au QG) et pompiers
├── physics/
│   └── Collision.js        Collision cercle/rectangle avec glissement
├── render/
│   └── Renderer.js         Calque statique, jour/nuit, lieux fermés, agents
└── ui/
    ├── UI.js               Barre d'outils, onglets, légende et raccourcis clavier
    ├── ZombiePanel.js      Onglet Zombies
    ├── CultPanel.js        Onglet Sectes
    └── EpidemicChart.js    Courbe de l'épidémie (aire empilée)
```

### Performance

| Technique | Où |
|---|---|
| Grille spatiale : voisins cherchés uniquement dans les 3×3 cases adjacentes (pas de O(N²)), filtrés par lieu | `SpatialHashGrid.js`, `Population.step`, `Epidemic.transmit` |
| Pas physique fixe de 1/60 s ; à x50, 50 sous-étapes par frame, donc jamais plus de 2 px par pas | `Simulation.update` |
| Multi-tick : routine et épidémie 4 fois par seconde simulée, errance toutes les 0,2–0,45 s | `Simulation`, `Routine`, `WanderBehavior` |
| Chemins vers chaque bâtiment précalculés par BFS : un agent n'a qu'à lire la case voisine, en O(1) | `NavigationField.js` |
| Ville rendue une seule fois hors écran ; un `fill()` par état de santé | `Renderer.js` |
| Aucune allocation dans la boucle chaude (tampons réutilisés) | `Population.js`, `Epidemic.js` |

Mesuré avec 1 500 habitants : environ 0,4 ms par pas physique et 0,4 ms de rendu. On tient 60 FPS jusqu'à x25 ; x50 descend vers 45 FPS avec 1 500 habitants, mais tient 60 FPS avec 500.

## Lancer en local

Les modules ES ne se chargent pas en `file://` : il faut un petit serveur HTTP.

```bash
python -m http.server 8000
```

Puis ouvrir <http://localhost:8000>.

## Publier sur GitHub Pages

1. Pousser le dépôt sur GitHub.
2. **Settings → Pages → Build and deployment** : Source = *Deploy from a branch*, Branch = `main`, dossier `/ (root)`.
3. Le site est publié sur `https://<utilisateur>.github.io/<dépôt>/`.

Tous les chemins sont relatifs, aucun réglage supplémentaire n'est nécessaire (le fichier `.nojekyll` désactive le traitement Jekyll).
