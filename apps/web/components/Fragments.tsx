'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  /** Density 0–1. Keep low for editorial calm. */
  density?: number;
  className?: string;
  /** Prefer CSS shards only (no canvas). */
  cssOnly?: boolean;
};

/**
 * Subtle amber/light fragment accents for the hero.
 * CSS shards by default; a low-density canvas layer when motion is allowed.
 * Fully suppressed under prefers-reduced-motion.
 */
export function Fragments({ density = 0.35, className = '', cssOnly = false }: Props) {
  const [reduced, setReduced] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  const shards = useMemo(() => {
    const n = Math.max(4, Math.round(10 * density));
    // Deterministic-ish positions so SSR/client match for CSS shards.
    return Array.from({ length: n }, (_, i) => {
      const t = (i + 1) / (n + 1);
      return {
        id: i,
        top: `${8 + ((i * 37) % 70)}%`,
        left: `${5 + ((i * 53) % 85)}%`,
        w: 2 + (i % 3),
        h: 8 + ((i * 5) % 18),
        rot: -35 + ((i * 17) % 70),
        delay: `${(i % 5) * -1.4}s`,
        opacity: 0.25 + (t % 0.4),
      };
    });
  }, [density]);

  useEffect(() => {
    if (reduced || cssOnly) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let alive = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const particles = Array.from({ length: Math.round(14 * density) }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.4,
      vx: (Math.random() - 0.5) * 0.00025,
      vy: -0.00015 - Math.random() * 0.00025,
      a: 0.15 + Math.random() * 0.35,
      phase: i,
    }));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const tick = () => {
      if (!alive) return;
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.y < -0.05) p.y = 1.05;
        if (p.x < -0.05) p.x = 1.05;
        if (p.x > 1.05) p.x = -0.05;
        const px = p.x * width;
        const py = p.y * height;
        ctx.beginPath();
        ctx.fillStyle = `rgba(201, 138, 60, ${p.a})`;
        // Tiny shard: short diagonal stroke rather than a dot.
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate((p.phase % 7) * 0.4);
        ctx.fillRect(-p.r * 0.4, -p.r * 2.2, p.r * 0.8, p.r * 4.4);
        ctx.restore();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reduced, cssOnly, density]);

  if (reduced) return null;

  return (
    <div className={`fragments ${className}`.trim()} aria-hidden>
      {shards.map((s) => (
        <span
          key={s.id}
          className="fragment"
          style={{
            top: s.top,
            left: s.left,
            width: s.w,
            height: s.h,
            transform: `rotate(${s.rot}deg)`,
            animationDelay: s.delay,
            opacity: s.opacity,
          }}
        />
      ))}
      {!cssOnly && <canvas ref={canvasRef} className="fragment-canvas" />}
    </div>
  );
}
