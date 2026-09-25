/** Statut d'un habitant vis-à-vis de l'apocalypse. */
export const ZombieState = Object.freeze({
  HUMAN: 0,
  BITTEN: 1,    // mordu : encore humain, se transformera
  ZOMBIE: 2,
  DESTROYED: 3, // zombie neutralisé (combat, décomposition, frappe, forces de l'ordre)
  DEVOURED: 4,  // humain dévoré
  KILLED: 5,    // civil tué par une frappe aérienne
});
