import { CONFIG } from '../config.js';
import { Random } from '../core/Random.js';
import { PlaceType } from '../world/PlaceTypes.js';
import { ZombieState } from '../zombie/ZombieState.js';

/** Activités qui ne donnent lieu à aucun achat en entrant. */
const NO_PURCHASE = new Set(['loot', 'fetch', 'burgle', 'rob', 'heist', 'meeting', 'sermon', 'jail', 'work', 'school', 'lunch']);

/** Tirage log-normal simple (somme de trois uniformes centrée), pour les salaires. */
function logNormal(rng, spread) {
  const z = (rng.next() + rng.next() + rng.next() - 1.5) * 2; // ~ N(0, 1)
  return Math.exp(z * spread);
}

/**
 * Argent de la ville : salaires, pensions et aides versés chaque jour, charges prélevées
 * à minuit, achats dans les lieux (liquide ou carte), distributeurs, caisses des
 * commerces déposées à la banque, coffres des agences.
 *
 * Les montants sont en euros. Le chômage, les aides et les salaires sont réglables
 * (onglet Crime) : la précarité nourrit la délinquance.
 */
export class Economy {
  constructor(population, city, clock, routine, seed, settings) {
    this.population = population;
    this.city = city;
    this.clock = clock;
    this.routine = routine;
    this.settings = settings;
    this.rng = new Random(seed ^ 0x7f4a7c15);
    routine.economy = this;
    this.lastPayDay = clock.day - (clock.hour >= CONFIG.economy.payHour ? 0 : 1);
    this.lastBillDay = clock.day;
    this.lastDepositDay = clock.day - 1;
    this.history = [];
    this.historyVersion = 0;
    this.sampleTimer = 0;
    this.revenue = { today: 0, yesterday: 0, day: clock.day };
    this.paid = { wages: 0, welfare: 0, pensions: 0 };
    for (const b of city.buildings) {
      b.till = 0;
      if (b.type === PlaceType.BANK) b.vault = this.rng.range(...CONFIG.economy.bankVault);
    }
    this.initialized = new WeakSet();
    this.setup(population.citizens);
    this.applyEmployment();
    this.stats = {};
    this.recount();
    this.sample();
  }

  /** Revenus et économies de départ (aussi pour les nouveaux venus). */
  setup(citizens) {
    const cfg = CONFIG.economy;
    const rng = this.rng;
    for (const c of citizens) {
      if (this.initialized.has(c)) continue;
      this.initialized.add(c);
      if (c.age === 'child') {
        c.wage = 0;
        c.cash = rng.range(0, 15);
        c.bank = 0;
        continue;
      }
      c.wage = c.age === 'senior' && c.job < 0 ? rng.range(...cfg.pension) : cfg.medianWage * logNormal(rng, cfg.wageSpread);
      c.cash = rng.range(...cfg.cashStart);
      // Chômeurs et étudiants démarrent avec peu d'économies.
      const jobless = c.job < 0 ? c.age !== 'senior' : c.jobRank < this.settings.unemployment;
      c.bank = jobless ? rng.range(-200, 600) : c.wage * rng.range(...cfg.savingsDays);
    }
  }

  onPopulationChanged() {
    this.setup(this.population.citizens);
    this.applyEmployment();
  }

  /** Chômage : les actifs au `jobRank` le plus bas perdent leur emploi. */
  applyEmployment() {
    const u = this.settings.unemployment;
    for (const c of this.population.citizens) {
      if (c.age === 'child' || c.job < 0) continue;
      const work = c.jobRank < u ? -1 : c.job;
      if (work !== c.work) {
        c.work = work;
        if (c.alive && c.zombie === ZombieState.HUMAN && c.activity === 'work') this.routine.replan(c);
      }
    }
  }

  // ------------------------------------------------------------ Dépenses

  needsCash(c) {
    return c.cash < CONFIG.economy.atmWhenBelow && c.bank > 60 && this.city.byType[PlaceType.BANK].length > 0;
  }

  nearestBank(c) {
    let best = -1;
    let bestD2 = Infinity;
    for (const i of this.city.byType[PlaceType.BANK]) {
      const b = this.city.buildings[i];
      const d2 = (b.x + b.w / 2 - c.x) ** 2 + (b.y + b.h / 2 - c.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  withdraw(c) {
    const amount = Math.min(Math.max(0, c.bank - CONFIG.economy.overdraft), this.rng.range(...CONFIG.economy.atmWithdraw));
    c.bank -= amount;
    c.cash += amount;
    c.atmAt = this.clock.time; // repéré par les voleurs qui guettent devant le distributeur
  }

  /** Achat en entrant dans un lieu payant : en liquide si on en a, sinon par carte. */
  onEnter(c, building) {
    const prices = CONFIG.economy.prices[building.type];
    if (!prices || NO_PURCHASE.has(c.activity)) return;
    let price = this.rng.range(...prices);
    if (c.age === 'child') price *= 0.3;
    if (c.cash >= price && this.rng.chance(CONFIG.economy.cashShare + c.cashHabit * 0.4)) {
      c.cash -= price;
      building.till = (building.till || 0) + price;
    } else {
      if (c.bank - price < CONFIG.economy.overdraft) return; // carte refusée : on regarde sans acheter
      c.bank -= price;
    }
    building.revenue = (building.revenue || 0) + price;
    this.addRevenue(price);
  }

  addRevenue(amount) {
    const r = this.revenue;
    if (r.day !== this.clock.day) {
      r.yesterday = r.today;
      r.today = 0;
      r.day = this.clock.day;
    }
    r.today += amount;
  }

  // ------------------------------------------------------------------ Tick

  tick() {
    const cfg = CONFIG.economy;
    const clock = this.clock;
    if (clock.hour >= cfg.payHour && this.lastPayDay !== clock.day) {
      this.lastPayDay = clock.day;
      this.payDay();
    }
    if (this.lastBillDay !== clock.day) {
      this.lastBillDay = clock.day;
      this.bills();
    }
    if (clock.hour >= cfg.shopDeposit && this.lastDepositDay !== clock.day) {
      this.lastDepositDay = clock.day;
      this.depositTills();
    }
    this.sampleTimer += CONFIG.simulation.tickInterval / CONFIG.time.secondsPerHour;
    if (this.sampleTimer >= cfg.sampleInterval) {
      this.sampleTimer = 0;
      this.recount();
      this.sample();
    }
  }

  /** Salaires (jours ouvrés), pensions et aides (tous les jours). */
  payDay() {
    const s = this.settings;
    const workday = this.clock.weekday < 5;
    const welfare = CONFIG.economy.welfareBase * s.welfare;
    const paid = { wages: 0, welfare: 0, pensions: 0 };
    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN || c.age === 'child') continue;
      if (c.work >= 0) {
        if (!workday && !(this.clock.weekday === 5 && c.worksSaturday)) continue;
        const pay = c.wage * s.wages;
        c.bank += pay;
        paid.wages += pay;
      } else if (c.age === 'senior' && c.job < 0) {
        c.bank += c.wage;
        paid.pensions += c.wage;
      } else {
        c.bank += welfare; // chômeurs, étudiants
        paid.welfare += welfare;
      }
    }
    this.paid = paid;
  }

  /** Loyer, factures, courses : prélevés à minuit sur les adultes, enfants compris. */
  bills() {
    const cfg = CONFIG.economy;
    for (const members of this.population.households.values()) {
      const adults = members.filter((m) => m.age !== 'child' && m.alive);
      if (adults.length === 0) continue;
      const kids = members.length - adults.length;
      const share = cfg.livingCost + (cfg.childCost * kids) / adults.length;
      for (const a of adults) a.bank = Math.max(cfg.overdraft, a.bank - share);
      // Un foyer met ses revenus en commun : le conjoint au foyer ne s'appauvrit pas seul.
      if (adults.length > 1) {
        const mean = adults.reduce((sum, a) => sum + a.bank, 0) / adults.length;
        for (const a of adults) a.bank += (mean - a.bank) * 0.5;
      }
    }
  }

  /** Le soir, les commerçants déposent la caisse à la banque la plus proche. */
  depositTills() {
    const banks = this.city.byType[PlaceType.BANK];
    for (const b of this.city.buildings) {
      if (!(b.till > 0) || b.type === PlaceType.BANK) continue;
      if (banks.length > 0) {
        const bank = this.city.buildings[banks[b.index % banks.length]];
        bank.vault = (bank.vault || 0) + b.till;
      }
      b.till = 0;
    }
  }

  // ------------------------------------------------------------ Statistiques

  isPoor(c) {
    return c.bank < CONFIG.economy.poorBelow;
  }

  recount() {
    const cfg = CONFIG.economy;
    const st = this.stats;
    st.bank = 0;
    st.cash = 0;
    st.unemployed = 0;
    st.workers = 0;
    st.poor = 0;
    st.modest = 0;
    st.comfortable = 0;
    st.rich = 0;
    let wageSum = 0;
    for (const c of this.population.citizens) {
      if (!c.alive || c.zombie !== ZombieState.HUMAN || c.age === 'child') continue;
      st.bank += c.bank;
      st.cash += c.cash;
      if (c.job >= 0) {
        if (c.work < 0) st.unemployed++;
        else {
          st.workers++;
          wageSum += c.wage * this.settings.wages;
        }
      }
      if (c.bank < cfg.poorBelow) st.poor++;
      else if (c.bank < 1500) st.modest++;
      else if (c.bank < cfg.richAbove) st.comfortable++;
      else st.rich++;
    }
    st.meanWage = st.workers > 0 ? wageSum / st.workers : 0;
    st.vaults = 0;
    st.tills = 0;
    for (const b of this.city.buildings) {
      if (b.type === PlaceType.BANK) st.vaults += b.vault || 0;
      else st.tills += b.till || 0;
    }
  }

  sample() {
    const st = this.stats;
    this.history.push({
      t: this.clock.time,
      poor: st.poor, modest: st.modest, comfortable: st.comfortable, rich: st.rich,
    });
    if (this.history.length > 300) this.history = this.history.filter((_, i) => i % 2 === 0);
    this.historyVersion++;
  }
}
