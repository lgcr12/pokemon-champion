import { type ReactNode } from "react";
import { cn } from "../ui/utils";

type BorderBeamProps = {
  children: ReactNode;
  className?: string;
  active?: boolean;
  color?: "indigo" | "cyan" | "violet" | "emerald" | "amber";
  size?: number;
  duration?: number;
};

const colorMap = {
  indigo: { from: "#4f46e5", via: "#818cf8", to: "#4f46e5" },
  cyan: { from: "#06b6d4", via: "#22d3ee", to: "#06b6d4" },
  violet: { from: "#7c3aed", via: "#a78bfa", to: "#7c3aed" },
  emerald: { from: "#10b981", via: "#34d399", to: "#10b981" },
  amber: { from: "#f59e0b", via: "#fbbf24", to: "#f59e0b" },
};

export function BorderBeam({
  children,
  className,
  active = true,
  color = "indigo",
  size = 80,
  duration = 4,
}: BorderBeamProps) {
  const { from, via, to } = colorMap[color];

  return (
    <div className={cn("relative rounded-xl", className)}>
      {active && (
        <div
          className="pointer-events-none absolute inset-0 rounded-xl overflow-hidden"
          aria-hidden
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "inherit",
              padding: "1px",
              background: `conic-gradient(from var(--beam-angle), transparent 0%, ${from} 15%, ${via} 30%, ${to} 45%, transparent 60%)`,
              WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
              WebkitMaskComposite: "xor",
              maskComposite: "exclude",
              animation: `beamSpin ${duration}s linear infinite`,
            }}
          />
        </div>
      )}
      <style>{`
        @property --beam-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        @keyframes beamSpin {
          from { --beam-angle: 0deg; }
          to { --beam-angle: 360deg; }
        }
      `}</style>
      {children}
    </div>
  );
}
