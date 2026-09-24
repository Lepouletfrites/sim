# CitySim — Simulation urbaine 2D procédurale

Simulation urbaine interactive en **Vanilla JavaScript** (modules ES, Canvas 2D), sans framework ni dépendance ni étape de build : une ville procédurale, ses habitants et leur vie quotidienne, et une épidémie qui s'y propage.

## Fonctionnalités

### Ville et physique
- Ville procédurale déterministe (graine) : super-blocs séparés par des avenues, subdivisés en BSP avec des ruelles, places ouvertes.
- 100 à 1 500 habitants. Collision cercle/rectangle avec glissement le long des murs, séparation entre voisins, croisement par la droite.
- Contrôles : Pause, x1, x5, x10, x25, x50 (clavier : `Espace`, `1` à `5`), population, densité urbaine, régénération.

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
| **Virulence** | Chance de forme grave × fragilité (seniors ≈ ×3, jeunes ≈ ×0,4). Un cas grave meurt dans 45 % des cas, 8 % à l'hôpital |
| **Responsabilité** | Part des malades qui se prennent en charge : quarantaine si forme légère, hôpital si grave. Les autres continuent de travailler (**présentéisme**) |
| **Prudence** | Quand l'inquiétude monte : **masques**, distanciation, moins de sorties, **confinement volontaire** de 1 à 3 jours |

| Mesure sanitaire | Effet |
|---|---|
| Fermer les boîtes de nuit | Les clubs restent fermés |
| Fermer commerces et restaurants | Centre commercial et restaurants fermés |
| Télétravail obligatoire | Les salariés travaillent depuis chez eux |

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
├── physics/
│   └── Collision.js        Collision cercle/rectangle avec glissement
├── render/
│   └── Renderer.js         Calque statique, jour/nuit, lieux fermés, agents
└── ui/
    ├── UI.js               Panneau latéral et raccourcis clavier
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
