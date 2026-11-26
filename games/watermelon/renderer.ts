import { FRUIT_CORES } from './fruits.ts';
import { createFruit, LEVELS, measure, OVERFLOW_GRACE, type WatermelonEvent, type WatermelonFruit, type WatermelonGame } from './engine.ts';

interface Point { x: number; y: number }
type Triangle = [Point, Point, Point];
interface Sprite {
  image: HTMLImageElement;
  ready: boolean;
  body: { cx: number; cy: number; rx: number; ry: number };
}
interface Particle extends Point { vx: number; vy: number; radius: number; color: string; life: number }
interface Popup extends Point { text: string; life: number }

export class WatermelonRenderer {
  private readonly sprites: Sprite[];
  private readonly demo: WatermelonFruit[];
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly particles: Particle[] = [];
  private readonly popups: Popup[] = [];
  private viewport = { x: 0, y: 0, scale: 1, dpr: 1 };
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, invalidate: () => void) {
    this.canvas = canvas; this.ctx = ctx;
    this.sprites = LEVELS.map((level, index) => {
      const image = new Image();
      const body = FRUIT_CORES[index];
      const sprite: Sprite = { image, ready: false, body };
      image.onload = () => { sprite.ready = true; invalidate(); };
      image.onerror = () => { sprite.ready = false; invalidate(); };
      image.src = `/games/watermelon/assets/fruits/${level.id}.webp`;
      return sprite;
    });
    this.demo = [createFruit(-1, 8, 207, 427), createFruit(-2, 5, 78, 474), createFruit(-3, 4, 296, 478), createFruit(-4, 2, 75, 400), createFruit(-5, 0, 316, 415)];
    for (const body of this.demo) {
      for (const point of body.nodes) { point.x = body.x + point.rx * 1.05; point.y = body.y + point.ry / 1.05; }
      measure(body);
    }
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const scale = Math.max(.01, Math.min(rect.width / 360, rect.height / 550));
    this.viewport = { x: (rect.width - 360 * scale) / 2, y: (rect.height - 550 * scale) / 2, scale, dpr };
  }

  pointerX(clientX: number): number {
    return Math.round((clientX - this.canvas.getBoundingClientRect().left - this.viewport.x) / this.viewport.scale);
  }

  reset(): void { this.particles.length = 0; this.popups.length = 0; }

  merge(event: Extract<WatermelonEvent, { type: 'merge' }>): void {
    this.popups.push({ x: event.x, y: event.y - LEVELS[event.level].radius * .55, text: `+${event.points}`, life: .9 });
    if (!this.reducedMotion) {
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        this.particles.push({ x: event.x, y: event.y, vx: Math.cos(angle) * (32 + event.level * 8), vy: Math.sin(angle) * 44 - 32, radius: 1.5 + event.level * .22, color: LEVELS[event.level].color, life: .6 });
      }
      if (this.particles.length > 96) this.particles.splice(0, this.particles.length - 96);
    }
  }

  private triangle(image: HTMLImageElement, source: Triangle, target: Triangle): void {
    const [s0, s1, s2] = source, [d0, d1, d2] = target;
    const sx1 = s1.x - s0.x, sy1 = s1.y - s0.y, sx2 = s2.x - s0.x, sy2 = s2.y - s0.y;
    const dx1 = d1.x - d0.x, dy1 = d1.y - d0.y, dx2 = d2.x - d0.x, dy2 = d2.y - d0.y;
    const determinant = sx1 * sy2 - sx2 * sy1;
    if (Math.abs(determinant) < .0001) return;
    const a = (dx1 * sy2 - dx2 * sy1) / determinant, b = (dy1 * sy2 - dy2 * sy1) / determinant;
    const c = (dx2 * sx1 - dx1 * sx2) / determinant, d = (dy2 * sx1 - dy1 * sx2) / determinant;
    const ctx = this.ctx;
    ctx.save();
    const mx = (d0.x + d1.x + d2.x) / 3, my = (d0.y + d1.y + d2.y) / 3;
    ctx.beginPath();
    target.forEach((point, i) => {
      const dx = point.x - mx, dy = point.y - my, length = Math.sqrt(dx * dx + dy * dy) || 1;
      const x = point.x + dx / length * .28, y = point.y + dy / length * .28;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath(); ctx.clip();
    ctx.transform(a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  }

  private drawFruit(body: WatermelonFruit, opacity = 1): void {
    const ctx = this.ctx, sprite = this.sprites[body.level], style = LEVELS[body.level];
    ctx.save(); ctx.globalAlpha = opacity;
    if (sprite.ready) {
      const core = sprite.body, cx = body.x, cy = body.y, image = sprite.image;
      const edgeX = Math.max(core.cx, image.width - core.cx) / core.rx;
      const edgeY = Math.max(core.cy, image.height - core.cy) / core.ry;
      const outer = Math.sqrt(edgeX * edgeX + edgeY * edgeY) * 1.04;
      const sourceCenter = { x: core.cx, y: core.cy }, targetCenter = { x: cx, y: cy };
      // The mesh extends beyond the fruit's physical core, retaining stems and leaves.
      for (let i = 0; i < body.nodes.length; i++) {
        const p = body.nodes[i], q = body.nodes[(i + 1) % body.nodes.length];
        const source: Triangle = [sourceCenter, { x: core.cx + p.rx / body.radius * core.rx * outer, y: core.cy + p.ry / body.radius * core.ry * outer }, { x: core.cx + q.rx / body.radius * core.rx * outer, y: core.cy + q.ry / body.radius * core.ry * outer }];
        const target: Triangle = [targetCenter, { x: cx + (p.x - cx) * outer, y: cy + (p.y - cy) * outer }, { x: cx + (q.x - cx) * outer, y: cy + (q.y - cy) * outer }];
        this.triangle(image, source, target);
      }
    } else {
      const nodes = body.nodes, last = nodes[nodes.length - 1], first = nodes[0];
      ctx.beginPath(); ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i], q = nodes[(i + 1) % nodes.length];
        ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
      }
      ctx.closePath();
      const gradient = ctx.createLinearGradient(body.bounds.left, body.bounds.top, body.bounds.right, body.bounds.bottom);
      gradient.addColorStop(0, style.light); gradient.addColorStop(1, style.color);
      ctx.fillStyle = gradient; ctx.fill(); ctx.fillStyle = '#20583e';
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(body.x + side * body.radius * .2, body.y, body.radius * .05, body.radius * .075, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  private vessel(game: WatermelonGame): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#1d54390c'; ctx.beginPath(); ctx.ellipse(180, 535, 145, 8, 0, 0, Math.PI * 2); ctx.fill();
    const glass = ctx.createLinearGradient(24, 180, 338, 490);
    glass.addColorStop(0, '#ffffff80'); glass.addColorStop(.5, '#ffffff24'); glass.addColorStop(1, '#bce3c94d');
    ctx.fillStyle = glass; ctx.beginPath();
    ctx.moveTo(24, 58); ctx.lineTo(24, 490); ctx.quadraticCurveTo(24, 526, 59, 526);
    ctx.lineTo(301, 526); ctx.quadraticCurveTo(336, 526, 336, 490); ctx.lineTo(336, 58); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#438a6266'; ctx.lineWidth = 4; ctx.beginPath();
    ctx.moveTo(37, 58); ctx.lineTo(29, 58); ctx.quadraticCurveTo(23, 58, 23, 66);
    ctx.lineTo(23, 493); ctx.quadraticCurveTo(23, 528, 58, 528); ctx.lineTo(302, 528);
    ctx.quadraticCurveTo(337, 528, 337, 493); ctx.lineTo(337, 66); ctx.quadraticCurveTo(337, 58, 331, 58); ctx.lineTo(323, 58); ctx.stroke();
    ctx.strokeStyle = '#ffffffdd'; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.strokeStyle = '#ffffffb0'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(34, 172); ctx.lineTo(34, 458); ctx.stroke();
    const warning = game.overflow > 0;
    ctx.strokeStyle = warning ? '#dd6559' : '#dd655969'; ctx.lineWidth = warning ? 2 : 1;
    ctx.setLineDash([5, 6]); ctx.beginPath(); ctx.moveTo(33, game.warningY); ctx.lineTo(327, game.warningY); ctx.stroke(); ctx.setLineDash([]);
    if (warning) {
      const fill = ctx.createLinearGradient(0, game.warningY, 0, game.warningY + 55);
      fill.addColorStop(0, '#f28f762b'); fill.addColorStop(1, '#f28f7600');
      ctx.fillStyle = fill; ctx.fillRect(30, game.warningY, 300, 55);
      ctx.fillStyle = '#c44e45'; ctx.font = '700 12px Consolas, monospace'; ctx.textAlign = 'right';
      ctx.fillText(String(Math.max(1, Math.ceil(OVERFLOW_GRACE - game.overflow))), 319, game.warningY - 10);
    }
  }

  private preview(game: WatermelonGame): void {
    if (game.phase !== 'playing' && game.phase !== 'paused') return;
    const radius = LEVELS[game.held].radius;
    if (game.cooldown <= 0) {
      const landing = game.world.bodies.reduce((height, body) => body.bounds.left < game.aim + radius && body.bounds.right > game.aim - radius ? Math.min(height, body.bounds.top - radius) : height, game.world.bottom - radius);
      const y = Math.max(118, landing), ctx = this.ctx;
      ctx.setLineDash([2, 6]); ctx.strokeStyle = '#26855250'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(game.aim, 113); ctx.lineTo(game.aim, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#26855218'; ctx.beginPath(); ctx.ellipse(game.aim, y + radius * .65, radius * .6, 3, 0, 0, Math.PI * 2); ctx.fill();
    }
    this.drawFruit(createFruit(0, game.held, game.aim, 87), game.cooldown > 0 ? .35 : 1);
  }

  draw(game: WatermelonGame, dt: number, showPreview = true): void {
    const ctx = this.ctx, view = this.viewport;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(view.scale * view.dpr, 0, 0, view.scale * view.dpr, view.x * view.dpr, view.y * view.dpr);
    this.vessel(game);
    for (const body of game.phase === 'ready' ? this.demo : game.world.bodies) this.drawFruit(body);
    if (showPreview) this.preview(game);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 125 * dt;
      ctx.globalAlpha = Math.min(1, p.life / .6); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i]; p.life -= dt;
      if (p.life <= 0) { this.popups.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, p.life * 2); ctx.fillStyle = '#1d5439'; ctx.font = '800 17px Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText(p.text, p.x, p.y - (this.reducedMotion ? 0 : (1 - p.life) * 24));
    }
    ctx.globalAlpha = 1;
  }

  dispose(): void {
    for (const sprite of this.sprites) { sprite.image.onload = null; sprite.image.onerror = null; }
    this.reset();
  }
}
