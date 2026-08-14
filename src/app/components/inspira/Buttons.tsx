import { useRef, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../ui/utils";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  children: ReactNode;
  className?: string;
};

/* ─── Gradient Button (总览页) ─────────────────────────────── */
export function GradientButton({ children, loading, className, disabled, ...props }: BtnProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        "relative inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white",
        "bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-600",
        "shadow-lg shadow-indigo-500/25",
        "transition-all duration-200 ease-out",
        "hover:brightness-110 hover:scale-[1.03] hover:shadow-indigo-500/40",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060818]",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

/* ─── Shimmer Button (配队工坊 / 实验室) ──────────────────── */
export function ShimmerButton({ children, loading, className, disabled, ...props }: BtnProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        "relative inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold",
        "bg-[#0f1128] text-white border border-indigo-500/40",
        "overflow-hidden",
        "transition-all duration-200",
        "hover:border-indigo-400/70 hover:shadow-lg hover:shadow-indigo-500/20",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060818]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "group",
        className,
      )}
      {...props}
    >
      {/* shimmer sweep */}
      <span
        className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-in-out"
        style={{
          background: "linear-gradient(90deg, transparent 0%, rgba(99,102,241,0.22) 50%, transparent 100%)",
        }}
      />
      {loading ? <Loader2 className="w-4 h-4 animate-spin relative z-10" /> : null}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

/* ─── Interactive Hover Button (回放 / 规则页) ─────────────── */
export function InteractiveHoverButton({ children, loading, className, disabled, ...props }: BtnProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        "relative inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold",
        "border border-indigo-500/50 text-indigo-300 bg-transparent",
        "overflow-hidden group",
        "transition-colors duration-200",
        "hover:text-white hover:border-indigo-400",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060818]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {/* fill from left */}
      <span className="absolute inset-0 translate-x-[-101%] group-hover:translate-x-0 transition-transform duration-300 ease-out bg-indigo-600/80 rounded-lg" />
      {loading ? <Loader2 className="w-4 h-4 animate-spin relative z-10" /> : null}
      <span className="relative z-10 transition-transform duration-300 group-hover:translate-x-[-4px]">{children}</span>
      <span className="relative z-10 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-x-[-8px] group-hover:translate-x-0">→</span>
    </button>
  );
}

/* ─── Ripple Button (模型实验室 / 弹窗) ────────────────────── */
export function RippleButton({ children, loading, className, disabled, onClick, ...props }: BtnProps) {
  const [ripples, setRipples] = useState<Array<{ x: number; y: number; id: number }>>([]);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || loading) return;
    const rect = btnRef.current!.getBoundingClientRect();
    const id = Date.now();
    setRipples((prev) => [...prev, { x: e.clientX - rect.left, y: e.clientY - rect.top, id }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 600);
    onClick?.(e);
  };

  return (
    <button
      ref={btnRef}
      disabled={disabled || loading}
      onClick={handleClick}
      className={cn(
        "relative inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold",
        "bg-violet-600 text-white overflow-hidden",
        "shadow-lg shadow-violet-500/25",
        "transition-all duration-150",
        "hover:bg-violet-500 hover:shadow-violet-500/40",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060818]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {ripples.map((r) => (
        <span
          key={r.id}
          className="pointer-events-none absolute rounded-full bg-white/30 animate-ping"
          style={{
            left: r.x - 40,
            top: r.y - 40,
            width: 80,
            height: 80,
            animationDuration: "600ms",
            animationIterationCount: 1,
          }}
        />
      ))}
      {loading ? <Loader2 className="w-4 h-4 animate-spin relative z-10" /> : null}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

/* ─── Rainbow Button (竞技场核心启动) ──────────────────────── */
export function RainbowButton({ children, loading, className, disabled, ...props }: BtnProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        "relative inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg text-sm font-bold text-white",
        "overflow-hidden",
        "transition-all duration-200",
        "hover:scale-[1.04] hover:shadow-2xl",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060818]",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
        "group",
        className,
      )}
      style={{
        background: "linear-gradient(135deg, #6366f1, #8b5cf6, #06b6d4, #6366f1)",
        backgroundSize: "300% 300%",
        animation: disabled ? "none" : "rainbowShift 3s ease infinite",
      }}
      {...props}
    >
      <style>{`
        @keyframes rainbowShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
      {/* glow layer */}
      <span className="pointer-events-none absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: "inherit", filter: "blur(12px)", transform: "scale(1.1)" }} />
      {loading ? <Loader2 className="w-4 h-4 animate-spin relative z-10" /> : null}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

/* ─── Ghost Button (次要操作通用) ──────────────────────────── */
export function GhostButton({ children, loading, className, disabled, ...props }: BtnProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium",
        "text-slate-400 hover:text-slate-200 bg-transparent hover:bg-white/5",
        "border border-transparent hover:border-white/10",
        "transition-all duration-150",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

/* ─── Kill Switch (紧急停止) ────────────────────────────────── */
export function KillSwitchButton({ children, loading, className, disabled, ...props }: BtnProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold",
        "bg-red-600 text-white border-2 border-red-500",
        "shadow-lg shadow-red-500/30",
        "transition-all duration-100",
        "hover:bg-red-500 hover:shadow-red-400/50 hover:scale-[1.02]",
        "active:scale-[0.96] active:bg-red-700",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060818]",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      {children}
    </button>
  );
}
