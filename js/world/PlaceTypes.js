import { CONFIG } from '../config.js';

/** Types de bâtiments. Les valeurs servent aussi de clés dans la config. */
export const PlaceType = Object.freeze({
  HOME: 'home',
  WORK: 'work',
  MALL: 'mall',
  RESTAURANT: 'restaurant',
  NIGHTCLUB: 'nightclub',
  HOSPITAL: 'hospital',
  TEMPLE: 'temple', // bâtiment acheté par une secte
  RUIN: 'ruin',     // bâtiment détruit par le feu
});

/** Lieu "rue" (hors de tout bâtiment), utilisé pour les statistiques. */
export const STREET = 'street';

export const PLACE_LABELS = {
  home: 'Logements',
  work: 'Bureaux',
  mall: 'Centre commercial',
  restaurant: 'Restaurants',
  nightclub: 'Boîte de nuit',
  hospital: 'Hôpital',
  temple: 'Locaux de secte',
  ruin: 'Ruines',
  street: 'Rue et places',
};

/** Étiquettes courtes affichées sur la carte. */
export const MAP_LABELS = {
  mall: 'CENTRE CO.',
  restaurant: 'RESTO',
  nightclub: 'CLUB',
};

/**
 * Le lieu est-il ouvert à cet instant ?
 * Tient compte des horaires (config) et des mesures sanitaires (`policies`).
 */
export function isOpen(type, clock, policies) {
  if (policies) {
    if (type === PlaceType.NIGHTCLUB && policies.closeNightclubs) return false;
    if ((type === PlaceType.MALL || type === PlaceType.RESTAURANT) && policies.closeCommerce) return false;
  }
  const schedule = CONFIG.places.schedule[type];
  if (!schedule) return true; // logements et hôpital : toujours ouverts

  const hour = clock.hour;
  const weekday = clock.weekday;
  for (const [open, close] of schedule.slots) {
    // offset 1 : créneau commencé la veille et qui déborde après minuit
    for (let offset = 0; offset <= 1; offset++) {
      const day = (weekday - offset + 7) % 7;
      if (!schedule.days.includes(day)) continue;
      const t = hour + 24 * offset;
      if (t >= open && t < close) return true;
    }
  }
  return false;
}

const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

const formatHour = (h) => {
  const hh = Math.floor(h % 24);
  const mm = Math.round((h % 1) * 60);
  return mm ? `${hh}h${String(mm).padStart(2, '0')}` : `${hh}h`;
};

/** Horaires lisibles, ex. "Ven–Sam 23h–5h". */
export function describeSchedule(type) {
  const schedule = CONFIG.places.schedule[type];
  if (!schedule) return '24h/24';
  const days = schedule.days;
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText =
    days.length === 7 ? 'Tous les jours'
      : contiguous ? `${DAY_SHORT[days[0]]}–${DAY_SHORT[days[days.length - 1]]}`
        : days.map((d) => DAY_SHORT[d]).join(', ');
  const slots = schedule.slots.map(([a, b]) => `${formatHour(a)}–${formatHour(b)}`).join(', ');
  return `${dayText} ${slots}`;
}
