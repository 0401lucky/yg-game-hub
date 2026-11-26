import { FRUIT_CORES } from './fruits.ts';
import { createFruit, LEVELS, measure, OVERFLOW_GRACE, type WatermelonEvent, type WatermelonFruit, type WatermelonGame } from './engine.ts';

interface Point { x: number; y: number }
type Triangle = [Point, Point, Point];
interface Sprite {
  image: HTMLImageElement;
  ready: boolean;
  body: { cx: number; cy: number; rx: number; ry: number };
}
interface Particle extends Point { vx: number; vy: number; radius: number; color: string; life: number; maxLife: number }
interface RingEffect extends Point { radius: number; maxRadius: number; color: string; life: number; maxLife: number }
interface Popup extends Point { text: string; color: string; life: number; maxLife: number }

export class WatermelonRenderer {
  private readonly sprites: Sprite[];
  private readonly demo: WatermelonFruit[];
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly particles: Particle[] = [];
  private readonly rings: RingEffect[] = [];
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

  reset(): void { this.particles.length = 0; this.rings.length = 0; this.popups.length = 0; }

  merge(event: Extract<WatermelonEvent, { type: 'merge' }>): void {
    const style = LEVELS[event.level];
    this.popups.push({
      x: event.x,
      y: event.y - style.radius * .58,
      text: `+${event.points}`,
      color: event.level >= 6 ? '#bf5e3d' : '#265c3e',
      life: .95,
      maxLife: .95,
    });
    if (!this.reducedMotion) {
      this.rings.push({
        x: event.x,
        y: event.y,
        radius: style.radius * .55,
        maxRadius: style.radius * 1.48,
        color: style.color,
        life: .42,
        maxLife: .42,
      });
      if (this.rings.length > 20) this.rings.splice(0, this.rings.length - 20);
      const count = 8 + Math.min(6, event.level);
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + (event.level % 2) * .25;
        const speed = 34 + event.level * 7 + (i % 3) * 14;
        const maxLife = .52 + (i % 3) * .09;
        this.particles.push({
          x: event.x + Math.cos(angle) * style.radius * .25,
          y: event.y + Math.sin(angle) * style.radius * .25,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed * .9 - 36,
          radius: 2 + event.level * .24 + (i % 2) * .9,
          color: i % 3 === 0 ? style.light : style.color,
          life: maxLife,
          maxLife,
        });
      }
      if (this.particles.length > 120) this.particles.splice(0, this.particles.length - 120);
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
      // 网格略微超出水果物理核心，保留果蒂与叶片细节
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

  private vesselPath(ctx: CanvasRenderingContext2D, inset = 0): void {
    const left = 22 + inset, right = 338 - inset, bottom = 528 - inset, top = 58 + inset * .4, corner = Math.max(12, 36 - inset);
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom - corner);
    ctx.quadraticCurveTo(left, bottom, left + corner, bottom);
    ctx.lineTo(right - corner, bottom);
    ctx.quadraticCurveTo(right, bottom, right, bottom - corner);
    ctx.lineTo(right, top);
  }

  private vesselBack(game: WatermelonGame): void {
    const ctx = this.ctx;
    // 底部落影，让玻璃盘有稳重着地感
    const shadow = ctx.createRadialGradient(180, 536, 20, 180, 536, 156);
    shadow.addColorStop(0, 'rgba(38, 76, 52, 0.16)');
    shadow.addColorStop(.68, 'rgba(38, 76, 52, 0.06)');
    shadow.addColorStop(1, 'rgba(38, 76, 52, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath(); ctx.ellipse(180, 536, 154, 11, 0, 0, Math.PI * 2); ctx.fill();

    // 玻璃内腔柔光背景
    const glass = ctx.createLinearGradient(24, 90, 336, 524);
    glass.addColorStop(0, 'rgba(255, 255, 255, 0.78)');
    glass.addColorStop(.48, 'rgba(252, 254, 249, 0.42)');
    glass.addColorStop(1, 'rgba(196, 226, 198, 0.36)');
    ctx.fillStyle = glass;
    this.vesselPath(ctx, 2);
    ctx.closePath();
    ctx.fill();

    // 底部玻璃厚度底座反光
    const base = ctx.createLinearGradient(0, 504, 0, 526);
    base.addColorStop(0, 'rgba(155, 198, 165, 0)');
    base.addColorStop(1, 'rgba(116, 168, 134, 0.18)');
    ctx.fillStyle = base;
    this.vesselPath(ctx, 4);
    ctx.closePath();
    ctx.fill();

    // 红色警戒线与溢出倒计时
    const warning = game.overflow > 0;
    const pulse = warning && !this.reducedMotion ? .72 + Math.sin(game.tickCount * .18) * .28 : 1;
    ctx.save();
    ctx.strokeStyle = warning ? `rgba(218, 86, 74, ${pulse})` : 'rgba(214, 106, 94, 0.45)';
    ctx.lineWidth = warning ? 2.2 : 1.2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(32, game.warningY); ctx.lineTo(328, game.warningY); ctx.stroke();
    ctx.setLineDash([]);
    if (warning) {
      const fill = ctx.createLinearGradient(0, game.warningY, 0, game.warningY + 64);
      fill.addColorStop(0, `rgba(235, 118, 102, ${.24 * pulse})`);
      fill.addColorStop(1, 'rgba(235, 118, 102, 0)');
      ctx.fillStyle = fill;
      ctx.fillRect(28, game.warningY, 304, 64);

      const remain = Math.max(1, Math.ceil(OVERFLOW_GRACE - game.overflow));
      const badgeX = 278, badgeY = game.warningY - 26, badgeW = 46, badgeH = 21;
      ctx.fillStyle = '#d35348';
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 10.5);
      ctx.fill();
      ctx.fillStyle = '#fffdf8';
      ctx.font = '700 11.5px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${remain}s`, badgeX + badgeW / 2, badgeY + badgeH / 2 + .5);
    }
    ctx.restore();
  }

  private vesselFront(): void {
    const ctx = this.ctx;
    ctx.save();
    // 玻璃外框（带顶口翻边）
    ctx.strokeStyle = 'rgba(65, 130, 93, 0.44)';
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(38, 58); ctx.lineTo(29, 58); ctx.quadraticCurveTo(22, 58, 22, 66);
    ctx.lineTo(22, 492); ctx.quadraticCurveTo(22, 528, 58, 528); ctx.lineTo(302, 528);
    ctx.quadraticCurveTo(338, 528, 338, 492); ctx.lineTo(338, 66); ctx.quadraticCurveTo(338, 58, 331, 58); ctx.lineTo(322, 58);
    ctx.stroke();

    // 内层亮白高光边
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 左右玻璃柱面高光条
    const leftGloss = ctx.createLinearGradient(0, 110, 0, 468);
    leftGloss.addColorStop(0, 'rgba(255, 255, 255, 0)');
    leftGloss.addColorStop(.18, 'rgba(255, 255, 255, 0.72)');
    leftGloss.addColorStop(.82, 'rgba(255, 255, 255, 0.45)');
    leftGloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.strokeStyle = leftGloss;
    ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(32, 110); ctx.lineTo(32, 468); ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.36)';
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(328, 165); ctx.lineTo(328, 452); ctx.stroke();
    ctx.restore();
  }

  private preview(game: WatermelonGame): void {
    if (game.phase !== 'playing' && game.phase !== 'paused') return;
    const style = LEVELS[game.held], radius = style.radius;
    if (game.cooldown <= 0) {
      const landing = game.world.bodies.reduce(
        (height, body) => body.bounds.left < game.aim + radius && body.bounds.right > game.aim - radius ? Math.min(height, body.bounds.top - radius) : height,
        game.world.bottom - radius,
      );
      const y = Math.max(118, landing), ctx = this.ctx;
      ctx.save();
      const lineGrad = ctx.createLinearGradient(game.aim, 108, game.aim, y);
      lineGrad.addColorStop(0, 'rgba(60, 105, 77, 0.42)');
      lineGrad.addColorStop(1, 'rgba(60, 105, 77, 0.14)');
      ctx.setLineDash([3, 6]);
      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(game.aim, 108); ctx.lineTo(game.aim, y); ctx.stroke();
      ctx.setLineDash([]);

      // 落点柔和光晕提示
      ctx.fillStyle = 'rgba(60, 105, 77, 0.14)';
      ctx.beginPath(); ctx.ellipse(game.aim, y + radius * .68, radius * .62, 3.6, 0, 0, Math.PI * 2); ctx.fill();
      const glow = ctx.createRadialGradient(game.aim, 87, radius * .35, game.aim, 87, radius * 1.38);
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
      glow.addColorStop(.6, 'rgba(166, 216, 183, 0.2)');
      glow.addColorStop(1, 'rgba(166, 216, 183, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(game.aim, 87, radius * 1.38, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    this.drawFruit(createFruit(0, game.held, game.aim, 87), game.cooldown > 0 ? .35 : 1);
  }

  draw(game: WatermelonGame, dt: number, showPreview = true): void {
    const ctx = this.ctx, view = this.viewport;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(view.scale * view.dpr, 0, 0, view.scale * view.dpr, view.x * view.dpr, view.y * view.dpr);
    this.vesselBack(game);
    for (const body of game.phase === 'ready' ? this.demo : game.world.bodies) this.drawFruit(body);
    if (showPreview) this.preview(game);
    this.vesselFront();

    // 合成扩散柔光环
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; r.life -= dt;
      if (r.life <= 0) { this.rings.splice(i, 1); continue; }
      const progress = 1 - r.life / r.maxLife;
      const eased = 1 - Math.pow(1 - progress, 3);
      ctx.save();
      ctx.globalAlpha = (1 - progress) * .55;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, 4 * (1 - progress));
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius + (r.maxRadius - r.radius) * eased, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 果味溅射粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 150 * dt;
      const ratio = Math.min(1, p.life / p.maxLife);
      ctx.globalAlpha = ratio;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * (.45 + ratio * .55), 0, Math.PI * 2); ctx.fill();
    }

    // 合成得分飘字（带白边提升可读性）
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i]; p.life -= dt;
      if (p.life <= 0) { this.popups.splice(i, 1); continue; }
      const ratio = p.life / p.maxLife;
      const offsetY = this.reducedMotion ? 0 : (1 - ratio) * 28;
      ctx.save();
      ctx.globalAlpha = Math.min(1, ratio * 2.2);
      ctx.font = '800 17px ui-rounded, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(255, 254, 248, 0.92)';
      ctx.strokeText(p.text, p.x, p.y - offsetY);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y - offsetY);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  dispose(): void {
    for (const sprite of this.sprites) { sprite.image.onload = null; sprite.image.onerror = null; }
    this.reset();
  }
}
