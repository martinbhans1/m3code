import { useEffect, useRef } from "react";

import { useEnvironment } from "../hooks/useTheme";
import { useMediaQuery } from "../hooks/useMediaQuery";

/**
 * Canvas-2D starfield for the "cosmos" ambient environment.
 *
 * Replaces the flat CSS radial-gradient dots (see .app-ambient-shell::after in
 * index.css) with stars that actually read as stars: a tight bright core with
 * only a hint of halo, subtle color temperature (blue-white / white / warm), a
 * wide spread of magnitudes, a few brighter "hero" stars with faint diffraction
 * spikes, and the occasional shooting star.
 *
 * Stars do NOT twinkle. Naked-eye scintillation is an atmospheric artifact, and
 * a per-star brightness pulse reads as "breathing fairy lights" that pulls focus
 * from the app. The field is fixed.
 *
 * The whole field drifts, though, and drifts *with* the ambient gradient behind
 * it — same easing, and a period locked to a multiple of `ambient-drift` so the
 * two read as one slowly-evolving scene rather than two effects running side by
 * side. See `app-starfield-drift` in index.css.
 *
 * Because the stars are fixed relative to each other, there is no render loop
 * at rest: they are painted once, the drift is a CSS transform (compositor
 * only, no main thread), and requestAnimationFrame runs solely for the ~1s a
 * shooting star is in flight. Idle cost is a single pending timer. Measured on
 * a 2560x1440 viewport, an always-on 30fps loop cost ~10% of a core
 * continuously — the clear-and-repaint alone was ~4% before a single star was
 * drawn — against ~0.07% for this.
 *
 * Deliberately NOT WebGL/three.js: the whole effect is a few hundred static
 * points, which a persistent GPU context and a 3D scene graph would not render
 * any better, only more expensively for an app that stays open all day.
 *
 * While mounted it sets `data-starfield="canvas"` on <html> so the CSS starfield
 * hides (index.css) and the two don't stack. Gated to cosmos only; under
 * prefers-reduced-motion the field is painted without the drift animation and
 * no shooting stars are scheduled.
 */

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
// Roughly one star per this many CSS px². Denser than it sounds: without a glow
// each star is only a couple of px, so a sparse field reads as empty.
const STAR_AREA_PER_STAR = 6500;
const HERO_FRACTION = 0.03;
/**
 * Stars live at fixed positions in a virtual field measured in CSS px, anchored
 * to the top-left of the viewport, and are culled to whatever is on screen.
 * They are NOT laid out in normalized viewport coordinates: that made every star
 * shift when the window changed size, so nudging a window edge by a pixel visibly
 * rearranged the whole sky. Resizing now reveals or hides stars at the edges and
 * leaves every other star exactly where it was.
 *
 * The field is sized once from the display, with headroom, so it stays bigger
 * than any window the app is likely to occupy. `growField` handles the case
 * where it doesn't — by adding stars to the new region only, never disturbing
 * the existing ones.
 */
const FIELD_HEADROOM = 512;
const MIN_FIELD_WIDTH = 2560;
const MIN_FIELD_HEIGHT = 1440;
/** Widest a sprite can be drawn, used to cull stars just off screen. */
const MAX_SPRITE_SIZE = 48;
/**
 * The canvas is oversized on every side so the drift transform never pulls a
 * bare edge into view. The keyframes translate in percentages (of the element's
 * own box), so the padding is a percentage of the viewport too — it has to stay
 * comfortably above the largest translation in `app-starfield-drift`
 * (index.css), currently 2.1%. The scale component only ever grows the element,
 * so it can't expose an edge.
 */
const DRIFT_PAD_RATIO = 0.035;
const MIN_DRIFT_PAD = 40;

function driftPadFor(width: number, height: number): number {
  return Math.max(MIN_DRIFT_PAD, Math.round(Math.max(width, height) * DRIFT_PAD_RATIO));
}

type StarColor = { r: number; g: number; b: number };

// Weighted toward white; a minority of blue-white and warm stars for realism.
const DEFAULT_STAR_COLOR: StarColor = { r: 255, g: 255, b: 255 };
const STAR_COLORS: ReadonlyArray<{ color: StarColor; weight: number }> = [
  { color: DEFAULT_STAR_COLOR, weight: 6 },
  { color: { r: 202, g: 220, b: 255 }, weight: 2 }, // blue-white
  { color: { r: 255, g: 236, b: 210 }, weight: 2 }, // warm
];
const STAR_COLOR_WEIGHT_TOTAL = STAR_COLORS.reduce((sum, entry) => sum + entry.weight, 0);

function pickStarColor(): StarColor {
  let roll = Math.random() * STAR_COLOR_WEIGHT_TOTAL;
  for (const entry of STAR_COLORS) {
    roll -= entry.weight;
    if (roll <= 0) return entry.color;
  }
  return DEFAULT_STAR_COLOR;
}

interface Star {
  /** Absolute CSS px within the virtual field, whose origin is the viewport's
   * top-left corner. Fixed for the lifetime of the component. */
  x: number;
  y: number;
  /** Core radius in CSS px. */
  radius: number;
  /** Fixed brightness — stars do not pulse, see the module comment. */
  alpha: number;
  color: StarColor;
  hero: boolean;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  length: number;
}

/**
 * Pre-render a star sprite so painting the field is just drawImage.
 *
 * The falloff is deliberately brutal: alpha is down to ~0.13 by 2x the core
 * radius and hits exactly zero by 4x, so the sprite has no long tail at all.
 * That last part matters more than it looks — the field is drawn with additive
 * blending, so with several hundred stars even a 0.015 tail accumulates into a
 * faint overall fog that reads as "glow".
 */
function createStarSprite(color: StarColor, withSpikes: boolean): HTMLCanvasElement {
  const size = 64;
  const half = size / 2;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;

  const { r, g, b } = color;
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  glow.addColorStop(0.11, `rgba(${r}, ${g}, ${b}, 0.98)`);
  glow.addColorStop(0.16, `rgba(${r}, ${g}, ${b}, 0.5)`);
  glow.addColorStop(0.22, `rgba(${r}, ${g}, ${b}, 0.13)`);
  glow.addColorStop(0.32, `rgba(${r}, ${g}, ${b}, 0.025)`);
  glow.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  if (withSpikes) {
    // Diffraction spikes on the few brightest stars only — a hairline cross,
    // short enough to read as a point of light rather than a starburst.
    const inset = size * 0.3;
    const span = size - inset * 2;
    const stops = (grad: CanvasGradient) => {
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
      grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.15)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      return grad;
    };
    ctx.fillStyle = stops(ctx.createLinearGradient(inset, half, inset + span, half));
    ctx.fillRect(inset, half - 0.5, span, 1);
    ctx.fillStyle = stops(ctx.createLinearGradient(half, inset, half, inset + span));
    ctx.fillRect(half - 0.5, inset, 1, span);
  }

  return sprite;
}

function createStar(x: number, y: number): Star {
  const hero = Math.random() < HERO_FRACTION;
  return {
    x,
    y,
    radius: hero ? 1.2 + Math.random() * 0.9 : 0.4 + Math.random() * 0.8,
    // Magnitudes spread wide so the field has depth rather than reading as a
    // uniform sheet of dots. Kept bright deliberately: the complaint about the
    // earlier field was the halo, not the luminance, and once the halo is gone a
    // dim core just reads as a smudge. Crisp and bright, not soft.
    alpha: hero ? 0.75 + Math.random() * 0.25 : 0.22 + Math.random() * 0.48,
    color: pickStarColor(),
    hero,
  };
}

interface Field {
  width: number;
  height: number;
  stars: Star[];
}

function createField(width: number, height: number): Field {
  const count = Math.round((width * height) / STAR_AREA_PER_STAR);
  const stars: Star[] = [];
  for (let i = 0; i < count; i += 1) {
    stars.push(createStar(Math.random() * width, Math.random() * height));
  }
  return { width, height, stars };
}

/**
 * Extend an existing field to cover a larger area, keeping every existing star
 * exactly where it is and populating only the newly exposed L-shaped region at
 * the same density. Rare — it takes a window bigger than the display the field
 * was sized from.
 */
function growField(field: Field, width: number, height: number): Field {
  const nextWidth = Math.max(field.width, width);
  const nextHeight = Math.max(field.height, height);
  if (nextWidth === field.width && nextHeight === field.height) return field;

  const addedArea = nextWidth * nextHeight - field.width * field.height;
  const toAdd = Math.round(addedArea / STAR_AREA_PER_STAR);
  const stars = field.stars.slice();
  for (let i = 0; i < toAdd; i += 1) {
    // Rejection-sample so the new stars land only in the added region.
    let x = 0;
    let y = 0;
    do {
      x = Math.random() * nextWidth;
      y = Math.random() * nextHeight;
    } while (x < field.width && y < field.height);
    stars.push(createStar(x, y));
  }
  return { width: nextWidth, height: nextHeight, stars };
}

export function StarfieldCanvas() {
  const { environment } = useEnvironment();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const active = environment === "cosmos";

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.starfield = "canvas";
    return () => {
      delete root.dataset.starfield;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Canvas dimensions include the drift padding on all four sides;
    // `width`/`height` are the padded CSS size. Field coordinates are viewport
    // coordinates, so canvas x = pad + star.x.
    let width = 0;
    let height = 0;
    let pad = MIN_DRIFT_PAD;
    let dpr = 1;
    // Sized from the display rather than the window, so ordinary resizing never
    // has to touch it and the stars stay put.
    let field = createField(
      Math.max(window.screen?.width ?? 0, window.innerWidth, MIN_FIELD_WIDTH) + FIELD_HEADROOM,
      Math.max(window.screen?.height ?? 0, window.innerHeight, MIN_FIELD_HEIGHT) + FIELD_HEADROOM,
    );

    const spriteCache = new Map<string, HTMLCanvasElement>();
    const spriteFor = (color: StarColor, spikes: boolean): HTMLCanvasElement => {
      const key = `${color.r},${color.g},${color.b},${spikes ? 1 : 0}`;
      let sprite = spriteCache.get(key);
      if (!sprite) {
        sprite = createStarSprite(color, spikes);
        spriteCache.set(key, sprite);
      }
      return sprite;
    };
    // The sprite's bright core occupies ~12% of its width; scale so a star's
    // `radius` maps to that core. The rest of the sprite box is the short
    // falloff, which is fully transparent well before the edge.
    const SPRITE_CORE_RATIO = 0.12;

    const paintField = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      // Cull to the padded canvas: the field is deliberately larger than the
      // window, so most of it is off screen at any one time.
      const minX = -pad - MAX_SPRITE_SIZE;
      const minY = minX;
      const maxX = width - pad + MAX_SPRITE_SIZE;
      const maxY = height - pad + MAX_SPRITE_SIZE;
      for (const star of field.stars) {
        if (star.x < minX || star.x > maxX || star.y < minY || star.y > maxY) continue;
        const sprite = spriteFor(star.color, star.hero);
        const spriteSize = (star.radius / SPRITE_CORE_RATIO) * 2;
        const px = pad + star.x;
        const py = pad + star.y;
        ctx.globalAlpha = star.alpha;
        ctx.drawImage(sprite, px - spriteSize / 2, py - spriteSize / 2, spriteSize, spriteSize);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const resize = () => {
      pad = driftPadFor(window.innerWidth, window.innerHeight);
      width = window.innerWidth + pad * 2;
      height = window.innerHeight + pad * 2;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.top = `${-pad}px`;
      canvas.style.left = `${-pad}px`;
      field = growField(field, window.innerWidth, window.innerHeight);
      paintField();
    };

    resize();
    window.addEventListener("resize", resize);

    if (reducedMotion) {
      return () => {
        window.removeEventListener("resize", resize);
      };
    }

    // ---- Shooting stars -----------------------------------------------------
    // The only thing that animates. rAF spins up when one launches and stops
    // the moment it burns out, so the field costs nothing the rest of the time.

    let shootingStar: ShootingStar | null = null;
    let rafId = 0;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let lastFrameMs = 0;
    let accumulator = 0;

    const drawShootingStar = (s: ShootingStar) => {
      const progress = 1 - s.life / s.maxLife;
      // Fade in then out across its life so it doesn't pop.
      const fade = Math.sin(progress * Math.PI);
      const speed = Math.hypot(s.vx, s.vy) || 1;
      const tailX = s.x - (s.vx / speed) * s.length;
      const tailY = s.y - (s.vy / speed) * s.length;
      const gradient = ctx.createLinearGradient(s.x, s.y, tailX, tailY);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${0.9 * fade})`);
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    };

    const scheduleShootingStar = (delay: number) => {
      clearTimeout(timerId);
      timerId = setTimeout(launchShootingStar, delay);
    };

    const step = (now: number) => {
      const s = shootingStar;
      if (!s) return;
      rafId = requestAnimationFrame(step);
      accumulator += now - lastFrameMs;
      lastFrameMs = now;
      if (accumulator < FRAME_INTERVAL_MS) return;
      // Clamp so a long stall doesn't teleport the meteor across the screen.
      const delta = Math.min(accumulator, 100);
      accumulator = 0;

      s.x += s.vx * (delta / 1000);
      s.y += s.vy * (delta / 1000);
      s.life -= delta;

      // Repainting the whole field each frame is the simple, correct way to
      // erase the previous tail; it only happens during the ~1s of flight.
      paintField();
      if (s.life > 0) {
        drawShootingStar(s);
        return;
      }
      shootingStar = null;
      cancelAnimationFrame(rafId);
      rafId = 0;
      scheduleShootingStar(7000 + Math.random() * 13000);
    };

    function launchShootingStar() {
      timerId = undefined;
      if (document.hidden || shootingStar) return;
      const viewportWidth = width - pad * 2;
      const viewportHeight = height - pad * 2;
      const fromLeft = Math.random() < 0.5;
      const speed = 380 + Math.random() * 220;
      const angle = (fromLeft ? 0.35 : Math.PI - 0.35) + (Math.random() - 0.5) * 0.3;
      shootingStar = {
        x: pad + (fromLeft ? -40 : viewportWidth + 40),
        y: pad + Math.random() * viewportHeight * 0.65,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 900,
        maxLife: 900,
        length: 120 + Math.random() * 80,
      };
      lastFrameMs = performance.now();
      accumulator = FRAME_INTERVAL_MS;
      rafId = requestAnimationFrame(step);
    }

    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafId);
        rafId = 0;
        clearTimeout(timerId);
        timerId = undefined;
        if (shootingStar) {
          shootingStar = null;
          paintField();
        }
      } else if (rafId === 0 && timerId === undefined) {
        scheduleShootingStar(4000 + Math.random() * 10000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    if (!document.hidden) scheduleShootingStar(6000 + Math.random() * 12000);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active, reducedMotion]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="app-starfield"
      data-drift={reducedMotion ? "off" : "on"}
      style={{
        position: "fixed",
        // top/left are set alongside the canvas size in the effect, since the
        // drift padding scales with the viewport.
        zIndex: 0,
        pointerEvents: "none",
        opacity: "var(--environment-stars-opacity, 0)",
      }}
    />
  );
}
