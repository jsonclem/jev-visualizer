import { Application, Container, Graphics, Text, type Ticker } from "pixi.js";

export const COLOR = {
  pass: 0x5dffa0,
  block: 0xff4d6a,
  amend: 0xffc043,
  info: 0x3ee0ff,
  paper: 0xdce8ff,
  commit: 0xf2f6ff,
  muted: 0x8190b8,
  faint: 0x4d5a85,
};

export type Mode = "cruise" | "hold" | "complete" | "aborted";
export type Pod = { color: number; accepted: boolean };
export type Foe = { label: string; value: number; tripped: boolean };

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t * t;
const linear = (t: number) => t;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Neon look: the same path stroked wide and faint, then narrow and bright.
function neon(g: Graphics, path: (g: Graphics) => void, color: number, width = 1.5) {
  for (const [w, alpha] of [
    [width * 7, 0.07],
    [width * 3.5, 0.16],
    [width, 1],
  ]) {
    path(g);
    g.stroke({ width: w, color, alpha, join: "round", cap: "round" });
  }
  return g;
}

const MODE_SPEED: Record<Mode, number> = { cruise: 1, hold: 0.12, complete: 0.25, aborted: 0.4 };

// The playfield. Each public method is one animation the director awaits;
// every duration is divided by `speed` so a replay can run fast.
export class Stage {
  private speed = 1;
  private mode: Mode = "cruise";
  private boost = 1;
  private boostNow = 1;
  private sway = 1;
  private time = 0;
  private offset = { x: 0, y: 0 };
  private stars: { g: Graphics; depth: number; size: number }[] = [];
  private world = new Container();
  private ship = new Container();
  private flame = new Graphics();
  private hazards = new Graphics();
  private shield = new Graphics();
  private holdRing = new Graphics();
  private fx = new Container();
  private planetView: Container | null = null;

  private constructor(
    private app: Application,
    private font: string,
  ) {}

  static async create(host: HTMLElement, font: string) {
    const app = new Application();
    await app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    host.appendChild(app.canvas);
    const stage = new Stage(app, font);
    stage.build();
    return stage;
  }

  destroy() {
    this.app.destroy({ removeView: true }, { children: true });
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  setMode(mode: Mode) {
    this.mode = mode;
    if (mode === "cruise" || mode === "hold") this.ship.visible = true;
  }

  private get W() {
    return this.app.screen.width;
  }

  private get H() {
    return this.app.screen.height;
  }

  private get homeY() {
    return this.H * 0.8;
  }

  private build() {
    const starLayer = new Container();
    for (let i = 0; i < 160; i++) {
      const depth = Math.random() ** 1.6;
      const g = new Graphics()
        .rect(-0.75, -0.75, 1.5, 1.5)
        .fill({ color: depth > 0.8 ? COLOR.info : COLOR.paper, alpha: 0.2 + depth * 0.7 });
      g.position.set(Math.random() * this.W, Math.random() * this.H);
      starLayer.addChild(g);
      this.stars.push({ g, depth, size: 0.6 + depth * 1.3 });
    }

    const hull = neon(
      new Graphics(),
      (g) => g.poly([0, -20, 12, 10, 5, 6, 0, 11, -5, 6, -12, 10], true),
      COLOR.info,
      1.6,
    );
    neon(hull, (g) => g.moveTo(0, -9).lineTo(0, 2), COLOR.paper, 1);
    this.hazards.circle(12, 10, 2.2).circle(-12, 10, 2.2).fill({ color: COLOR.amend });
    neon(this.shield, (g) => g.circle(0, 0, 28), COLOR.block, 1.4);
    neon(this.holdRing, (g) => g.circle(0, 0, 38), COLOR.amend, 1);
    this.shield.alpha = 0;
    this.holdRing.alpha = 0;
    this.ship.addChild(this.flame, hull, this.hazards, this.shield, this.holdRing);

    this.app.stage.addChild(starLayer, this.world, this.ship, this.fx);
    this.app.ticker.add(this.update);
  }

  private update = (ticker: Ticker) => {
    const dt = Math.min(0.1, ticker.deltaMS / 1000) * this.speed;
    this.time += dt;
    const target = MODE_SPEED[this.mode] * this.boost;
    this.boostNow += (target - this.boostNow) * Math.min(1, dt * 3);
    this.sway += ((this.mode === "hold" ? 0.15 : 1) - this.sway) * Math.min(1, dt * 2);

    for (const star of this.stars) {
      star.g.y += (30 + 280 * star.depth) * this.boostNow * dt;
      if (star.g.y > this.H + 10) {
        star.g.y = -10;
        star.g.x = Math.random() * this.W;
      }
      star.g.scale.set(star.size, star.size * (1 + Math.max(0, this.boostNow - 1) * 5 * star.depth));
    }

    this.ship.x = this.W / 2 + Math.sin(this.time * 0.7) * 14 * this.sway + this.offset.x;
    this.ship.y = this.homeY + Math.sin(this.time * 1.9) * 3 + this.offset.y;

    const holding = this.mode === "hold";
    this.flame.clear();
    if (!holding) {
      const length = 7 + Math.random() * 5 + Math.max(0, this.boostNow - 1) * 6;
      neon(this.flame, (g) => g.poly([-4, 9, 0, 9 + length, 4, 9], false), COLOR.amend, 1.2);
    }
    this.hazards.visible = holding && this.time % 1 < 0.5;
    this.holdRing.alpha = holding ? 0.25 + 0.25 * Math.sin(this.time * 4) : 0;
  };

  private tween(ms: number, fn: (t: number) => void, ease = easeInOut) {
    return new Promise<void>((resolve) => {
      let elapsed = 0;
      const tick = (ticker: Ticker) => {
        elapsed += ticker.deltaMS * this.speed;
        const t = Math.min(1, elapsed / ms);
        fn(ease(t));
        if (t >= 1) {
          this.app.ticker.remove(tick);
          resolve();
        }
      };
      this.app.ticker.add(tick);
    });
  }

  wait = (ms: number) => this.tween(ms, () => {}, linear);

  private text(content: string, color: number, size = 11, wrap?: number) {
    const text = new Text({
      text: content,
      resolution: 2,
      style: {
        fontFamily: this.font,
        fontSize: size,
        fill: color,
        letterSpacing: 1.2,
        align: "center",
        wordWrap: wrap !== undefined,
        wordWrapWidth: wrap ?? 0,
      },
    });
    text.anchor.set(0.5);
    return text;
  }

  private async floatText(content: string, color: number, x: number, y: number, size = 12) {
    const label = this.text(content, color, size, this.W * 0.85);
    label.position.set(x, y);
    this.fx.addChild(label);
    await this.tween(
      1600,
      (k) => {
        label.y = y - 40 * k;
        label.alpha = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;
      },
      easeOut,
    );
    label.destroy();
  }

  private burst(x: number, y: number, color: number, count = 12) {
    const sparks = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const g = neon(new Graphics(), (g) => g.moveTo(0, 0).lineTo(5, 0), color, 1);
      g.position.set(x, y);
      g.rotation = angle;
      this.fx.addChild(g);
      return { g, angle, distance: 24 + Math.random() * 30 };
    });
    void this.tween(
      550,
      (k) => {
        for (const spark of sparks) {
          spark.g.x = x + Math.cos(spark.angle) * spark.distance * k;
          spark.g.y = y + Math.sin(spark.angle) * spark.distance * k;
          spark.g.alpha = 1 - k;
        }
      },
      easeOut,
    ).then(() => sparks.forEach((spark) => spark.g.destroy()));
  }

  private async laser(x: number, y: number) {
    const g = new Graphics();
    this.fx.addChild(g);
    const sx = this.ship.x;
    const sy = this.ship.y - 20;
    await this.tween(
      200,
      (k) => {
        const reach = Math.min(1, k * 2);
        g.clear();
        neon(g, (g) => g.moveTo(sx, sy).lineTo(lerp(sx, x, reach), lerp(sy, y, reach)), COLOR.paper, 1.1);
        g.alpha = k < 0.5 ? 1 : 1 - (k - 0.5) * 2;
      },
      linear,
    );
    g.destroy();
  }

  private async shieldHit() {
    const from = this.offset.y;
    await this.tween(
      900,
      (k) => {
        this.shield.alpha = Math.abs(Math.sin(k * Math.PI * 6)) * (1 - k * 0.7);
        this.offset.y = k < 0.3 ? lerp(from, 42, easeOut(k / 0.3)) : lerp(42, 0, easeInOut((k - 0.3) / 0.7));
      },
      linear,
    );
    this.shield.alpha = 0;
  }

  private enter(y: number) {
    this.planetView?.destroy({ children: true });
    this.planetView = null;
    this.ship.visible = true;
    this.ship.rotation = 0;
    this.ship.alpha = 1;
    this.ship.scale.set(1);
    this.offset.y = y;
  }

  async launch() {
    this.mode = "cruise";
    const start = this.H - this.homeY + 60;
    this.enter(start);
    const doors = [-1, 1].map((side) => {
      const g = neon(
        new Graphics(),
        (g) => g.moveTo(side * 16, 0).lineTo(side * 150, 0).moveTo(side * 16, 0).lineTo(side * 16, 12),
        COLOR.faint,
        1.4,
      );
      g.position.set(this.W / 2, this.H - 30);
      this.world.addChild(g);
      return { g, side };
    });
    await this.wait(300);
    this.boost = 3;
    await this.tween(
      1500,
      (k) => {
        this.offset.y = lerp(start, 0, k);
        for (const door of doors) {
          door.g.x = this.W / 2 + door.side * 90 * k;
          door.g.alpha = 1 - k;
        }
      },
      easeOut,
    );
    this.boost = 1;
    doors.forEach((door) => door.g.destroy());
    void this.floatText("LAUNCH", COLOR.info, this.ship.x, this.homeY - 56);
  }

  async warpIn(label: string) {
    this.mode = "cruise";
    const start = this.H - this.homeY + 60;
    this.enter(start);
    this.boost = 4;
    await this.tween(900, (k) => (this.offset.y = lerp(start, 0, k)), easeOut);
    this.boost = 1;
    void this.floatText(label, COLOR.info, this.ship.x, this.homeY - 56);
  }

  async cargo(pods: Pod[]) {
    const items = pods.slice(0, 16).map((pod) => {
      const g = neon(new Graphics(), (g) => g.regularPoly(0, 0, 5, 6, 0), pod.color, 1.2);
      const sx = this.W * (0.15 + Math.random() * 0.7);
      const sy = -20 - Math.random() * 90;
      g.position.set(sx, sy);
      this.world.addChild(g);
      return { g, pod, sx, sy, tx: sx, ty: this.homeY - 170 + Math.random() * 60 };
    });
    await this.tween(1000, (k) => items.forEach((it) => (it.g.y = lerp(it.sy, it.ty, k))), easeOut);
    await this.tween(
      800,
      (k) => {
        for (const it of items) {
          it.g.rotation = k * 3;
          if (it.pod.accepted) {
            it.g.x = lerp(it.tx, this.ship.x, k);
            it.g.y = lerp(it.ty, this.ship.y, k);
            it.g.scale.set(1 - k * 0.7);
          } else {
            it.g.x = it.tx + (it.tx < this.W / 2 ? -1 : 1) * 140 * k;
            it.g.y = it.ty - 30 * k;
            it.g.alpha = 1 - k;
          }
        }
      },
      easeIn,
    );
    items.forEach((it) => it.g.destroy());
    const taken = items.filter((it) => it.pod.accepted).length;
    this.burst(this.ship.x, this.ship.y, COLOR.pass, 8);
    const refused = items.length - taken;
    void this.floatText(
      `+${pods.length} ${pods.length === 1 ? "FILE" : "FILES"}${refused ? `  ·  ${refused} REFUSED` : ""}`,
      refused ? COLOR.block : COLOR.pass,
      this.ship.x,
      this.homeY - 50,
      10,
    );
    await this.wait(300);
  }

  async driftWave(foes: Foe[]) {
    const spacing = this.W / (foes.length + 1);
    const units = foes.map((foe, i) => {
      const color = foe.tripped ? COLOR.block : COLOR.info;
      const r = 7 + foe.value * 18;
      const c = new Container();
      const body = neon(new Graphics(), (g) => g.regularPoly(0, 0, r, 4, 0), color, 1.4);
      neon(body, (g) => g.regularPoly(0, 0, r * 0.4, 4, Math.PI / 4), color, 1);
      const label = this.text(`${foe.label}\n${foe.value.toFixed(2)}`, color, 9);
      label.y = r + 16;
      label.alpha = 0.85;
      c.addChild(body, label);
      const x = spacing * (i + 1);
      c.position.set(x, -50);
      this.world.addChild(c);
      return { c, foe, x, ty: this.H * 0.26 + (i % 2) * 26 };
    });
    await this.tween(1100, (k) => units.forEach((u) => (u.c.y = lerp(-50, u.ty, k))), easeOut);
    for (const u of units.filter((u) => !u.foe.tripped)) {
      await this.laser(u.c.x, u.c.y);
      this.burst(u.c.x, u.c.y, COLOR.info, 12);
      u.c.destroy({ children: true });
      await this.wait(140);
    }
    const tripped = units.filter((u) => u.foe.tripped);
    if (!tripped.length) return;
    await this.wait(350);
    await this.tween(
      750,
      (k) => {
        for (const u of tripped) {
          u.c.x = lerp(u.x, this.ship.x, k);
          u.c.y = lerp(u.ty, this.ship.y - 30, k);
          u.c.rotation = k * 4;
        }
      },
      easeIn,
    );
    for (const u of tripped) {
      this.burst(u.c.x, u.c.y, COLOR.block, 16);
      u.c.destroy({ children: true });
    }
    await this.shieldHit();
  }

  async warpRing() {
    const ring = neon(new Graphics(), (g) => g.ellipse(0, 0, 72, 18), COLOR.pass, 2);
    const x = this.ship.x;
    ring.position.set(x, -40);
    this.world.addChild(ring);
    let crossed = false;
    this.boost = 1.6;
    await this.tween(
      1900,
      (k) => {
        ring.y = lerp(-40, this.H + 80, k);
        if (!crossed && ring.y >= this.ship.y) {
          crossed = true;
          this.boost = 3.2;
          this.burst(this.ship.x, this.ship.y, COLOR.pass, 18);
          void this.floatText("GATE PASSED", COLOR.pass, this.ship.x, this.homeY - 60, 13);
        }
        if (crossed) {
          const past = (ring.y - this.ship.y) / 200;
          ring.scale.set(1 + past);
          ring.alpha = Math.max(0, 1 - past);
        }
      },
      linear,
    );
    this.boost = 1;
    ring.destroy();
  }

  async forceField(reason: string) {
    const field = new Graphics();
    neon(
      field,
      (g) => {
        for (let x = 12; x < this.W; x += 24) g.regularPoly(x, 0, 11, 6, Math.PI / 6);
      },
      COLOR.block,
      1,
    );
    field.y = -30;
    this.world.addChild(field);
    const stopAt = this.homeY - 90;
    await this.tween(1200, (k) => (field.y = lerp(-30, stopAt, k)), easeOut);
    this.boost = 0.3;
    await this.tween(280, (k) => (this.offset.y = lerp(0, -46, k)), easeIn);
    this.burst(this.ship.x, stopAt, COLOR.block, 20);
    void this.floatText(reason, COLOR.block, this.W / 2, stopAt - 30, 12);
    await this.shieldHit();
    await this.tween(1000, (k) => (field.alpha = (1 - k) * (k * 12 % 1 < 0.5 ? 1 : 0.4)), linear);
    field.destroy();
    this.boost = 1;
  }

  async station(sha: string, subject: string) {
    const c = new Container();
    const body = neon(new Graphics(), (g) => g.regularPoly(0, 0, 30, 6, 0), COLOR.commit, 1.6);
    neon(body, (g) => g.circle(0, 0, 12), COLOR.commit, 1.1);
    neon(
      body,
      (g) => {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
          g.moveTo(Math.cos(a) * 12, Math.sin(a) * 12).lineTo(Math.cos(a) * 26, Math.sin(a) * 26);
        }
      },
      COLOR.faint,
      1,
    );
    neon(body, (g) => g.moveTo(0, 30).lineTo(0, 50), COLOR.commit, 1.2);
    const beacon = new Graphics().circle(0, -30, 2.6).fill({ color: COLOR.amend });
    const shaLabel = this.text(sha, COLOR.muted, 9);
    shaLabel.y = -62;
    const subjectLabel = this.text(subject, COLOR.commit, 12, this.W * 0.8);
    subjectLabel.anchor.set(0.5, 1);
    subjectLabel.y = -72;
    c.addChild(body, beacon, shaLabel, subjectLabel);
    c.position.set(this.ship.x, -110);
    this.world.addChild(c);

    const dockY = this.homeY - 70;
    this.boost = 0.6;
    this.sway = 0;
    await this.tween(1600, (k) => (c.y = lerp(-110, dockY, k)), easeOut);
    this.burst(c.x, dockY + 50, COLOR.commit, 8);
    await this.tween(1500, (k) => (beacon.alpha = (k * 6) % 1 < 0.5 ? 1 : 0.15), linear);
    this.boost = 1;
    void this.tween(2800, (k) => (c.y = lerp(dockY, this.H + 140, k)), easeIn).then(() =>
      c.destroy({ children: true }),
    );
    await this.wait(600);
  }

  async planet() {
    this.planetView?.destroy({ children: true });
    const r = Math.min(this.W, this.H) * 0.26;
    const c = new Container();
    const g = neon(new Graphics(), (g) => g.circle(0, 0, r), COLOR.info, 1.8);
    neon(g, (g) => g.ellipse(0, 0, r, r * 0.3).ellipse(0, 0, r * 0.7, r * 0.12), COLOR.faint, 1);
    neon(g, (g) => g.ellipse(0, 0, r * 1.7, r * 0.34), COLOR.pass, 1.4);
    g.rotation = -0.25;
    c.addChild(g);
    const top = -r * 1.8;
    const rest = this.H * 0.24;
    c.position.set(this.W / 2, top);
    this.world.addChild(c);
    this.planetView = c;
    await this.tween(2400, (k) => (c.y = lerp(top, rest, k)), easeOut);
    this.boost = 5;
    const from = this.offset.y;
    await this.tween(
      1200,
      (k) => {
        this.offset.y = lerp(from, rest - this.homeY, easeIn(k));
        this.ship.scale.set(1 - k * 0.6, 1 + k * 1.2);
        this.ship.alpha = 1 - k * k;
      },
      linear,
    );
    this.ship.visible = false;
    this.ship.scale.set(1);
    this.ship.alpha = 1;
    this.offset.y = 0;
    this.boost = 1;
    this.burst(this.W / 2, rest, COLOR.pass, 28);
    this.mode = "complete";
  }

  async abort() {
    void this.floatText("ABORT", COLOR.block, this.ship.x, this.homeY - 60, 13);
    await this.tween(800, (k) => (this.ship.rotation = Math.PI * k));
    const end = this.H - this.homeY + 80;
    await this.tween(1300, (k) => (this.offset.y = lerp(0, end, k)), easeIn);
    this.ship.visible = false;
    this.ship.rotation = 0;
    this.offset.y = 0;
    this.mode = "aborted";
  }

  async alert(label: string) {
    const flash = new Graphics().rect(0, 0, this.W, this.H).fill({ color: COLOR.block });
    flash.alpha = 0;
    this.fx.addChild(flash);
    void this.floatText(label, COLOR.block, this.W / 2, this.H * 0.45, 13);
    await this.tween(1500, (k) => (flash.alpha = Math.abs(Math.sin(k * Math.PI * 3)) * 0.16), linear);
    flash.destroy();
  }

  async ping(label: string, color: number) {
    this.burst(this.ship.x, this.ship.y - 24, color, 10);
    await this.floatText(label, color, this.ship.x, this.homeY - 60, 11);
  }
}
