/**
 * Boucle principale basée sur requestAnimationFrame.
 * Calcule le deltaTime réel (clampé) et mesure les FPS.
 */
export class GameLoop {
  constructor({ update, render, maxFrameDt = 0.1 }) {
    this.update = update;
    this.render = render;
    this.maxFrameDt = maxFrameDt;
    this.running = false;
    this.last = 0;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsWindowStart = 0;
    this.tick = this.tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.fpsWindowStart = this.last;
    requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
  }

  tick(now) {
    if (!this.running) return;

    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt < 0) dt = 0;
    if (dt > this.maxFrameDt) dt = this.maxFrameDt;

    this.fpsFrames++;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed >= 500) {
      this.fps = (this.fpsFrames * 1000) / elapsed;
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
    }

    this.update(dt);
    this.render();
    requestAnimationFrame(this.tick);
  }
}
