import { useRef, type ReactNode, type MouseEvent } from "react";
import { cn } from "../ui/utils";

type Card3DProps = {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  intensity?: number;
};

export function Card3D({ children, className, innerClassName, intensity = 8 }: Card3DProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width / 2);
    const dy = (e.clientY - cy) / (rect.height / 2);
    card.style.transform = `perspective(700px) rotateX(${-dy * intensity}deg) rotateY(${dx * intensity}deg) scale(1.02)`;
    // Dynamic shine
    const shineEl = card.querySelector(".card3d-shine") as HTMLElement;
    if (shineEl) {
      shineEl.style.opacity = "1";
      shineEl.style.background = `radial-gradient(circle at ${((e.clientX - rect.left) / rect.width) * 100}% ${((e.clientY - rect.top) / rect.height) * 100}%, rgba(255,255,255,0.12) 0%, transparent 65%)`;
    }
  };

  const handleMouseLeave = () => {
    const card = cardRef.current;
    if (!card) return;
    card.style.transform = "perspective(700px) rotateX(0deg) rotateY(0deg) scale(1)";
    const shineEl = card.querySelector(".card3d-shine") as HTMLElement;
    if (shineEl) shineEl.style.opacity = "0";
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn("relative transition-transform duration-200 ease-out will-change-transform", className)}
      style={{ transformStyle: "preserve-3d" }}
    >
      <div
        className={cn(
          "card3d-shine pointer-events-none absolute inset-0 rounded-xl transition-opacity duration-300 z-10",
          innerClassName,
        )}
        style={{ opacity: 0 }}
      />
      {children}
    </div>
  );
}
