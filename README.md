# CitySim — Simulation urbaine 2D procédurale

Simulation urbaine interactive en **Vanilla JavaScript** (modules ES, Canvas 2D), sans framework ni dépendance ni étape de build.

## Fonctionnalités

- Ville procédurale déterministe (graine) : super-blocs séparés par des avenues, subdivisés en BSP avec des ruelles, places ouvertes.
- 100 à 1 500 habitants en errance autonome : ils marchent droit, tournent aux carrefours ou devant un mur, se décalent sur leur droite pour se croiser.
- Collision cercle/rectangle avec glissement le long des murs.
- Contrôles : Pause / x1 / x2 / x5 (clavier : `Espace`, `1`, `2`, `5`), population, densité urbaine, régénération.

## Architecture

```
index.html
css/style.css
js/
├── main.js                 Point d'entrée : assemble les modules
├── config.js               Tous les paramètres réglables
├── core/
│   ├── GameLoop.js         requestAnimationFrame + deltaTime + FPS
│   ├── Simulation.js       timeScale + accumulateur à pas fixe (sub-stepping)
│   ├── SpatialHashGrid.js  Grille spatiale (listes chaînées en tableaux typés)
│   └── Random.js           PRNG déterministe (mulberry32)
├── world/
│   ├── CityGenerator.js    Génération procédurale du plan
│   └── City.js             Grille des bâtiments + grille de marche
├── physics/
│   └── Collision.js        Collision cercle/rectangle avec glissement
├── agents/
│   ├── Citizen.js          État d'un habitant
│   ├── WanderBehavior.js   Décisions lentes (errance)
│   └── Population.js       Pas physique : séparation, pilotage, collisions
├── render/
│   └── Renderer.js         Calque statique + dessin groupé des agents
└── ui/
    └── UI.js               Panneau latéral et raccourcis clavier
```

### Performance

| Technique | Où |
|---|---|
| Grille spatiale : voisins cherchés uniquement dans les 3×3 cases adjacentes (pas de O(N²)) | `SpatialHashGrid.js`, `Population.step` |
| Pas physique fixe de 1/60 s ; à x5, 5 sous-étapes par frame, donc jamais de déplacement > 1 px par pas | `Simulation.update` |
| Multi-tick : décisions toutes les 0,2–0,45 s, décalées aléatoirement entre agents | `WanderBehavior`, `Citizen.decisionTimer` |
| Bâtiments indexés dans une grille statique, grille de marche précalculée pour les sondes | `City.js` |
| Ville rendue une seule fois hors écran ; tous les agents dessinés en un seul `fill()` | `Renderer.js` |
| Aucune allocation dans la boucle chaude (tampons réutilisés) | `Population.js` |

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
