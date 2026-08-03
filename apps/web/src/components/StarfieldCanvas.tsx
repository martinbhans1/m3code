import { useEffect, useRef } from "react";

import { useEnvironment } from "../hooks/useTheme";
import { useMediaQuery } from "../hooks/useMediaQuery";

/**
 * Canvas-2D starfield for the "cosmos" ambient environment.
 *
 * Replaces the flat CSS radial-gradient dots (see .app-ambient-shell::after in
 * index.css) with stars that actually read as stars: a soft glow/halo around a
 * bright core, per-star twinkle at independent phases, subtle color temperature
 * (blue-white / white / warm), depth parallax, a few bright "hero" stars with
 * diffraction spikes, and the occasional shooting star.
 *
 * Deliberately NOT WebGL/three.js — that would add a big bundle + a persistent
 * GPU context for a background flourish in an app that stays open all day. A
 * couple hundred pre-rendered sprites drawn with additive blending on a 2D
 * context, throttled to ~30fps and paused when the window is hidden, is a tiny
 * fraction of that cost.
 *
 * While mounted it sets `data-starfield="canvas"` on <html> so the CSS starfield
 * hides (index.css) and the two don't stack. Gated to cosmos only; under
 * prefers-reduced-motion it paints a single static frame instead of animating.
 */

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
// Roughly one star per this many CSS px² of viewport, clamped to [MIN, MAX].
const STAR_AREA_PER_STAR = 9000;
const MIN_STARS = 60;
const MAX_STARS = 220;
const HERO_FRACTION = 0.05;

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
  /** Normalized position in [0, 1] so it survives resizes. */
  x: number;
  y: number;
  /** Core radius in CSS px. */
  radius: number;
  baseAlpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
  /** Parallax depth in [0, 1]; nearer (larger) stars drift more. */
  depth: number;
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

/** Pre-render a soft round star sprite so the render loop only does drawImage. */
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
  glow.addColorStop(0.12, `rgba(${r}, ${g}, ${b}, 0.9)`);
  glow.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.28)`);
  glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  if (withSpikes) {
    // Diffraction spikes: a thin, fading cross through the core.
    const spike = ctx.createLinearGradient(0, half, size, half);
    spike.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    spike.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.5)`);
    spike.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = spike;
    ctx.fillRect(0, half - 0.75, size, 1.5);
    const spikeV = ctx.createLinearGradient(half, 0, half, size);
    spikeV.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    spikeV.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.5)`);
    spikeV.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = spikeV;
    ctx.fillRect(half - 0.75, 0, 1.5, size);
  }

  return sprite;
}

function createStars(width: number, height: number): Star[] {
  const target = Math.round((width * height) / STAR_AREA_PER_STAR);
  const count = Math.max(MIN_STARS, Math.min(MAX_STARS, target));
  const stars: Star[] = [];
  for (let i = 0; i < count; i += 1) {
    const hero = Math.random() < HERO_FRACTION;
    const depth = Math.random();
    stars.push({
      x: Math.random(),
      y: Math.random(),
      radius: hero ? 1.6 + Math.random() * 1.4 : 0.5 + Math.random() * 1.1,
      baseAlpha: hero ? 0.85 + Math.random() * 0.15 : 0.3 + Math.random() * 0.5,
      twinklePhase: Math.random() * Math.PI * 2,
      // Radians/sec; hero stars twinkle a touch slower and more deliberately.
      twinkleSpeed: (hero ? 0.5 : 0.8) + Math.random() * 1.4,
      depth,
      color: pickStarColor(),
      hero,
    });
  }
  return stars;
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

    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let stars = createStars(width, height);
    let shootingStar: ShootingStar | null = null;
    let nextShootingStarAt = 6000 + Math.random() * 12000;

    // One sprite per color, plus a spiked variant for hero stars.
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
    // The sprite's bright core occupies ~24% of its width; scale so a star's
    // `radius` maps to that core, letting the surrounding glow spill outward.
    const SPRITE_CORE_RATIO = 0.24;

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      stars = createStars(width, height);
    };

    const drawStar = (star: Star, alpha: number, driftX: number, driftY: number) => {
      const sprite = spriteFor(star.color, star.hero);
      const spriteSize = (star.radius / SPRITE_CORE_RATIO) * 2;
      const px = star.x * width + driftX * star.depth;
      const py = star.y * height + driftY * star.depth;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.drawImage(sprite, px - spriteSize / 2, py - spriteSize / 2, spriteSize, spriteSize);
    };

    const drawShootingStar = (s: ShootingStar) => {
      const progress = 1 - s.life / s.maxLife;
      // Fade in then out across its life so it doesn't pop.
      const fade = Math.sin(progress * Math.PI);
      const tailX = s.x - (s.vx / Math.hypot(s.vx, s.vy)) * s.length;
      const tailY = s.y - (s.vy / Math.hypot(s.vx, s.vy)) * s.length;
      const gradient = ctx.createLinearGradient(s.x, s.y, tailX, tailY);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${0.9 * fade})`);
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    };

    const render = (timeMs: number, deltaMs: number, animate: boolean) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";

      const t = timeMs / 1000;
      // Very slow field-wide parallax sway (px), modulated per-star by depth.
      const driftX = animate ? Math.sin(t * 0.03) * 12 : 0;
      const driftY = animate ? Math.cos(t * 0.024) * 8 : 0;

      for (const star of stars) {
        const twinkle = animate
          ? 0.65 + 0.35 * Math.sin(t * star.twinkleSpeed + star.twinklePhase)
          : 1;
        drawStar(star, star.baseAlpha * twinkle, driftX, driftY);
      }

      if (animate) {
        if (shootingStar) {
          shootingStar.x += shootingStar.vx * (deltaMs / 1000);
          shootingStar.y += shootingStar.vy * (deltaMs / 1000);
          shootingStar.life -= deltaMs;
          if (shootingStar.life <= 0) {
            shootingStar = null;
          } else {
            drawShootingStar(shootingStar);
          }
        } else {
          nextShootingStarAt -= deltaMs;
          if (nextShootingStarAt <= 0) {
            const fromLeft = Math.random() < 0.5;
            const speed = 380 + Math.random() * 220;
            const angle = (fromLeft ? 0.35 : Math.PI - 0.35) + (Math.random() - 0.5) * 0.3;
            shootingStar = {
              x: fromLeft ? -40 : width + 40,
              y: Math.random() * height * 0.5,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 900,
              maxLife: 900,
              length: 120 + Math.random() * 80,
            };
            nextShootingStarAt = 9000 + Math.random() * 16000;
          }
        }
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    resize();

    if (reducedMotion) {
      const handleStaticResize = () => {
        resize();
        render(0, 0, false);
      };
      render(0, 0, false);
      window.addEventListener("resize", handleStaticResize);
      return () => {
        window.removeEventListener("resize", handleStaticResize);
      };
    }

    let rafId = 0;
    let lastFrameMs = performance.now();
    let accumulator = 0;

    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop);
      const delta = now - lastFrameMs;
      lastFrameMs = now;
      accumulator += delta;
      if (accumulator < FRAME_INTERVAL_MS) return;
      // Clamp so a long stall (backgrounded tab) doesn't teleport motion.
      const frameDelta = Math.min(accumulator, 100);
      accumulator = 0;
      render(now, frameDelta, true);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      } else if (rafId === 0) {
        lastFrameMs = performance.now();
        accumulator = FRAME_INTERVAL_MS;
        rafId = requestAnimationFrame(loop);
      }
    };

    const handleResize = () => resize();

    window.addEventListener("resize", handleResize);
    document.addEventListener("visibilitychange", handleVisibility);
    if (!document.hidden) {
      rafId = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active, reducedMotion]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        opacity: "var(--environment-stars-opacity, 0)",
      }}
    />
  );
}
