/** Sources du fil d'actualité : un module de la simulation = une source = un onglet. */
export const NEWS_SOURCES = ['virus', 'zombies', 'cult', 'crime', 'city'];
export const NEWS_LABELS = {
  virus: 'Virus', zombies: 'Zombies', cult: 'Sectes', crime: 'Crime', city: 'Ville',
};

const MAX_ITEMS = 200;

/**
 * Fil d'actualité commun à toute la ville. Chaque module y publie ses événements
 * (en plus de son propre journal) ; l'interface en tire le fil de la vue d'ensemble,
 * les pastilles de non-lus sur les onglets et les notifications de la carte.
 *
 * Un événement : { id, source, when, text, kind, t } ; `kind` = 'info', 'good', 'bad', 'crime'…
 */
export class News {
  constructor(clock) {
    this.clock = clock;
    this.items = [];
    this.nextId = 1;
    this.version = 0;
    this.generation = 0; // change à chaque nouvelle ville : les compteurs de non-lus repartent de zéro
    this.counts = Object.fromEntries(NEWS_SOURCES.map((s) => [s, 0])); // cumul par source
  }

  /** Nouvelle horloge (ville régénérée) : on repart d'un fil vide. */
  reset(clock) {
    this.clock = clock;
    this.items = [];
    for (const s of NEWS_SOURCES) this.counts[s] = 0;
    this.generation++;
    this.version++;
  }

  push(source, text, kind = 'info') {
    const clock = this.clock;
    this.items.unshift({
      id: this.nextId++,
      source,
      when: `J${clock.day} ${clock.format().split(' ')[1]}`,
      text,
      kind,
      t: clock.time,
    });
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
    this.counts[source]++;
    this.version++;
  }
}
