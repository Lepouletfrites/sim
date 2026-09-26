import { CONFIG } from '../config.js';

/** Types de bâtiments. Les valeurs servent aussi de clés dans la config. */
export const PlaceType = Object.freeze({
  HOME: 'home',
  WORK: 'work',
  SCHOOL: 'school',
  MALL: 'mall',
  RESTAURANT: 'restaurant',
  NIGHTCLUB: 'nightclub',
  BAR: 'bar',
  SHOP: 'shop',
  BANK: 'bank',
  HOSPITAL: 'hospital',
  TEMPLE: 'temple', // bâtiment acheté par une secte
  RUIN: 'ruin',     // bâtiment détruit par le feu
});

/** Lieu "rue" (hors de tout bâtiment), utilisé pour les statistiques. */
export const STREET = 'street';

export const PLACE_LABELS = {
  home: 'Logements',
  work: 'Bureaux',
  school: 'École',
  mall: 'Centre commercial',
  restaurant: 'Restaurants',
  nightclub: 'Boîte de nuit',
  bar: 'Bars',
  shop: 'Boutiques',
  bank: 'Banque',
  hospital: 'Hôpital',
  temple: 'Locaux de secte',
  ruin: 'Ruines',
  street: 'Rue et places',
};

/** Étiquettes courtes affichées sur la carte. */
export const MAP_LABELS = {
  school: 'ÉCOLE',
  mall: 'CENTRE CO.',
  restaurant: 'RESTO',
  nightclub: 'CLUB',
  bar: 'BAR',
  shop: 'BOUTIQUE',
  bank: 'BANQUE',
};

/** Horaires d'un type : une ou plusieurs règles { days, slots }, ou null (toujours ouvert). */
function scheduleOf(type) {
  const schedule = CONFIG.places.schedule[type];
  if (!schedule) return null;
  return Array.isArray(schedule) ? schedule : [schedule];
}

/**
 * Le lieu est-il ouvert à cet instant ?
 * Tient compte des horaires (config) et des mesures sanitaires (`policies`).
 */
export function isOpen(type, clock, policies) {
  if (policies) {
    if (type === PlaceType.NIGHTCLUB && policies.closeNightclubs) return false;
    if ((type === PlaceType.MALL || type === PlaceType.RESTAURANT || type === PlaceType.BAR ||
      type === PlaceType.SHOP) && policies.closeCommerce) return false;
    if (type === PlaceType.SCHOOL && policies.closeSchools) return false;
  }
  const rules = scheduleOf(type);
  if (!rules) return true; // logements et hôpital : toujours ouverts

  const hour = clock.hour;
  const weekday = clock.weekday;
  for (const rule of rules) {
    for (const [open, close] of rule.slots) {
      // offset 1 : créneau commencé la veille et qui déborde après minuit
      for (let offset = 0; offset <= 1; offset++) {
        const day = (weekday - offset + 7) % 7;
        if (!rule.days.includes(day)) continue;
        const t = hour + 24 * offset;
        if (t >= open && t < close) return true;
      }
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

function describeRule({ days, slots }) {
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText =
    days.length === 7 ? 'Tous les jours'
      : days.length === 1 ? DAY_SHORT[days[0]]
        : contiguous ? `${DAY_SHORT[days[0]]}–${DAY_SHORT[days[days.length - 1]]}`
          : days.map((d) => DAY_SHORT[d]).join(', ');
  return `${dayText} ${slots.map(([a, b]) => `${formatHour(a)}–${formatHour(b)}`).join(', ')}`;
}

/** Horaires lisibles, ex. "Ven–Sam 23h–5h". */
export function describeSchedule(type) {
  const rules = scheduleOf(type);
  return rules ? rules.map(describeRule).join(' · ') : '24h/24';
}
