import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../ui/utils";

type SparklesTextProps = {
  children: ReactNode;
  className?: string;
  sparkleColor?: string;
  count?: number;
};

function randomBetween(a: number, b: number) {
  return a + Math.random() * (b - a);
}

export function SparklesText({
  children,
  className,
  sparkleColor = "#a78bfa",
  count = 6,
}: SparklesTextProps) {
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const sparkles: Array<{ el: HTMLSpanElement; timer: ReturnType<typeof setTimeout> }> = [];

    const addSparkle = () => {
      const rect = el.getBoundingClientRect();
      const span = document.createElement("span");
      const size = randomBetween(8, 16);
      const x = randomBetween(-8, rect.width + 8);
      const y = randomBetween(-8, rect.height + 8);

      span.style.cssText = `
        position:absolute;
        pointer-events:none;
        left:${x}px;
        top:${y}px;
        width:${size}px;
        height:${size}px;
        animation:sparkle-pop 700ms ease-out forwards;
        z-index:10;
      `;
      span.innerHTML = `<svg viewBox="0 0 16 16" fill="${sparkleColor}" xmlns="http://www.w3.org/2000/svg"><path d="M8 0L9.5 6.5L16 8L9.5 9.5L8 16L6.5 9.5L0 8L6.5 6.5Z"/></svg>`;
      el.appendChild(span);

      const timer = setTimeout(() => {
        span.remove();
      }, 700);
      sparkles.push({ el: span, timer });
    };

    const style = document.createElement("style");
    style.textContent = `
      @keyframes sparkle-pop {
        0% { transform: scale(0) rotate(0deg); opacity: 0; }
        40% { transform: scale(1.2) rotate(20deg); opacity: 1; }
        100% { transform: scale(0) rotate(45deg) translateY(-10px); opacity: 0; }
      }
    `;
    document.head.appendChild(style);

    const interval = setInterval(addSparkle, 900 / count);
    return () => {
      clearInterval(interval);
      sparkles.forEach((s) => { clearTimeout(s.timer); s.el.remove(); });
      style.remove();
    };
  }, [count, sparkleColor]);

  return (
    <span ref={containerRef} className={cn("relative inline-block", className)}>
      {children}
    </span>
  );
}
