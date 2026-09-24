/**
 * Résout la collision entre un agent (cercle) et un bâtiment (rectangle).
 *
 * L'agent est repoussé hors du rectangle le long de la normale de contact,
 * puis la composante de vitesse dirigée vers le mur est supprimée :
 * seule la composante tangentielle subsiste, l'agent glisse le long du mur.
 *
 * @returns {boolean} true si une collision a été corrigée
 */
export function resolveCircleRect(agent, rect) {
  const r = agent.radius;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;

  // Point du rectangle le plus proche du centre du cercle.
  const cx = agent.x < rect.x ? rect.x : agent.x > right ? right : agent.x;
  const cy = agent.y < rect.y ? rect.y : agent.y > bottom ? bottom : agent.y;
  const dx = agent.x - cx;
  const dy = agent.y - cy;
  const d2 = dx * dx + dy * dy;

  if (d2 >= r * r) return false;

  let nx;
  let ny;
  let penetration;

  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
    penetration = r - d;
  } else {
    // Centre à l'intérieur du rectangle : sortie par le côté le plus proche.
    const toLeft = agent.x - rect.x;
    const toRight = right - agent.x;
    const toTop = agent.y - rect.y;
    const toBottom = bottom - agent.y;
    const min = Math.min(toLeft, toRight, toTop, toBottom);
    if (min === toLeft) { nx = -1; ny = 0; penetration = toLeft + r; }
    else if (min === toRight) { nx = 1; ny = 0; penetration = toRight + r; }
    else if (min === toTop) { nx = 0; ny = -1; penetration = toTop + r; }
    else { nx = 0; ny = 1; penetration = toBottom + r; }
  }

  agent.x += nx * penetration;
  agent.y += ny * penetration;

  const vn = agent.vx * nx + agent.vy * ny;
  if (vn < 0) {
    agent.vx -= vn * nx;
    agent.vy -= vn * ny;
  }
  return true;
}

/** Maintient un agent à l'intérieur des limites du monde. */
export function clampToBounds(agent, width, height) {
  const r = agent.radius;
  if (agent.x < r) { agent.x = r; if (agent.vx < 0) agent.vx = 0; }
  else if (agent.x > width - r) { agent.x = width - r; if (agent.vx > 0) agent.vx = 0; }
  if (agent.y < r) { agent.y = r; if (agent.vy < 0) agent.vy = 0; }
  else if (agent.y > height - r) { agent.y = height - r; if (agent.vy > 0) agent.vy = 0; }
}
