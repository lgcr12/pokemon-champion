import { useEffect, useRef } from "react";

const COLORS = ["#6366f1", "#7c3aed", "#06b6d4", "#818cf8", "#a78bfa", "#22d3ee", "#4f46e5", "#38bdf8"];

type Particle = {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  color: string;
  opacity: number;
  trail: Array<{ x: number; y: number }>;
  trailLen: number;
  life: number;
  maxLife: number;
};

type Vortex = { x: number; y: number; s: number; r: number };

export function VortexBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = (canvas.width = window.innerWidth);
    let H = (canvas.height = window.innerHeight);
    let raf = 0;
    let t = 0;

    const makeVortices = (): Vortex[] => [
      { x: W * 0.07, y: H * 0.38, s: 1.3, r: 230 },
      { x: W * 0.93, y: H * 0.52, s: -1.0, r: 260 },
      { x: W * 0.48, y: H * 0.9, s: 0.8, r: 210 },
      { x: W * 0.78, y: H * 0.18, s: -0.6, r: 175 },
    ];
    let vorts = makeVortices();

    const spawn = (): Particle => {
      const r = Math.random();
      let x: number, y: number;
      if (r < 0.35) {
        const v = vorts[Math.floor(Math.random() * vorts.length)];
        const angle = Math.random() * Math.PI * 2;
        x = v.x + Math.cos(angle) * Math.random() * v.r;
        y = v.y + Math.sin(angle) * Math.random() * v.r;
      } else {
        const side = Math.floor(Math.random() * 4);
        x = side === 1 ? W + 5 : side === 3 ? -5 : Math.random() * W;
        y = side === 0 ? -5 : side === 2 ? H + 5 : Math.random() * H;
      }
      return {
        x, y,
        vx: (Math.random() - 0.5) * 1.6,
        vy: (Math.random() - 0.5) * 1.6,
        size: Math.random() * 2.8 + 0.4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        opacity: Math.random() * 0.75 + 0.2,
        trail: [],
        trailLen: Math.floor(Math.random() * 28 + 10),
        life: 0,
        maxLife: Math.random() * 420 + 140,
      };
    };

    const particles: Particle[] = Array.from({ length: 300 }, spawn);

    const draw = () => {
      t += 0.0035;
      ctx.fillStyle = "rgba(6, 8, 24, 0.15)";
      ctx.fillRect(0, 0, W, H);

      // Drift vortex centers
      vorts[0] = { ...vorts[0], x: W * 0.07 + Math.sin(t * 0.38) * 65, y: H * 0.38 + Math.cos(t * 0.28) * 42 };
      vorts[1] = { ...vorts[1], x: W * 0.93 + Math.cos(t * 0.32) * 52, y: H * 0.52 + Math.sin(t * 0.42) * 72 };
      vorts[2] = { ...vorts[2], x: W * 0.48 + Math.sin(t * 0.18) * 110, y: H * 0.9 + Math.cos(t * 0.48) * 28 };
      vorts[3] = { ...vorts[3], x: W * 0.78 + Math.cos(t * 0.26) * 58, y: H * 0.18 + Math.sin(t * 0.36) * 48 };

      // Ambient vortex glows
      vorts.forEach((v) => {
        const g = ctx.createRadialGradient(v.x, v.y, 0, v.x, v.y, v.r * 0.7);
        g.addColorStop(0, "rgba(99,102,241,0.09)");
        g.addColorStop(0.5, "rgba(124,58,237,0.05)");
        g.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(v.x, v.y, v.r * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      });

      // Cluster glows in corners / gaps
      const clusterPoints = [
        { x: W * 0.15, y: H * 0.08 },
        { x: W * 0.85, y: H * 0.12 },
        { x: W * 0.92, y: H * 0.85 },
        { x: W * 0.1, y: H * 0.78 },
      ];
      clusterPoints.forEach((c, ci) => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.6 + ci * 1.4);
        const g2 = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 120);
        g2.addColorStop(0, `rgba(6,182,212,${0.05 * pulse})`);
        g2.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(c.x, c.y, 120, 0, Math.PI * 2);
        ctx.fillStyle = g2;
        ctx.fill();
      });

      particles.forEach((p, i) => {
        // Apply vortex forces
        vorts.forEach((v) => {
          const dx = v.x - p.x;
          const dy = v.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < v.r && d > 4) {
            const f = (v.r - d) / v.r;
            p.vx += (-dy / d) * v.s * f * 0.055;
            p.vy += (dx / d) * v.s * f * 0.055;
            p.vx += (dx / d) * f * 0.012;
            p.vy += (dy / d) * f * 0.012;
          }
        });

        // Flow field noise
        const nx = Math.sin(p.x * 0.011 + t) * Math.cos(p.y * 0.009 + t * 0.65);
        const ny = Math.cos(p.x * 0.009 + t * 0.72) * Math.sin(p.y * 0.011 + t * 0.38);
        p.vx += nx * 0.016;
        p.vy += ny * 0.016;
        p.vx *= 0.972;
        p.vy *= 0.972;

        const spd = Math.hypot(p.vx, p.vy);
        if (spd > 2.8) { p.vx = (p.vx / spd) * 2.8; p.vy = (p.vy / spd) * 2.8; }

        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > p.trailLen) p.trail.shift();
        p.x += p.vx;
        p.y += p.vy;
        p.life++;

        if (p.x < -70 || p.x > W + 70 || p.y < -70 || p.y > H + 70 || p.life > p.maxLife) {
          particles[i] = spawn();
          return;
        }

        const lp = p.life / p.maxLife;
        const fade = lp < 0.12 ? lp / 0.12 : lp > 0.82 ? 1 - (lp - 0.82) / 0.18 : 1;

        // Trail
        if (p.trail.length > 2) {
          ctx.beginPath();
          ctx.moveTo(p.trail[0].x, p.trail[0].y);
          for (const pt of p.trail) ctx.lineTo(pt.x, pt.y);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size * 0.55;
          ctx.globalAlpha = p.opacity * fade * 0.32;
          ctx.stroke();
        }

        // Core dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.opacity * fade * 0.88;
        ctx.fill();

        // Glow halo
        if (p.size > 1.4) {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 5.5);
          g.addColorStop(0, p.color + "55");
          g.addColorStop(1, p.color + "00");
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 5.5, 0, Math.PI * 2);
          ctx.fillStyle = g;
          ctx.globalAlpha = fade * 0.22;
          ctx.fill();
        }

        ctx.globalAlpha = 1;
      });

      raf = requestAnimationFrame(draw);
    };

    draw();

    const resize = () => {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
      vorts = makeVortices();
    };
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
}
