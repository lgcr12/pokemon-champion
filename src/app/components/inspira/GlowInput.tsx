import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../ui/utils";

type GlowInputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  wrapperClassName?: string;
};

export const GlowInput = forwardRef<HTMLInputElement, GlowInputProps>(
  ({ label, error, wrapperClassName, className, ...props }, ref) => {
    return (
      <div className={cn("flex flex-col gap-1", wrapperClassName)}>
        {label && (
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</label>
        )}
        <div className="relative group">
          {/* Glow border */}
          <div className="pointer-events-none absolute -inset-[1px] rounded-lg opacity-0 group-focus-within:opacity-100 transition-opacity duration-300"
            style={{ background: "linear-gradient(135deg, #4f46e5, #7c3aed, #06b6d4)", padding: 1 }}>
            <div className="w-full h-full rounded-lg bg-[#060818]" />
          </div>
          <input
            ref={ref}
            className={cn(
              "relative w-full px-3.5 py-2.5 rounded-lg text-sm",
              "bg-white text-slate-800 placeholder-slate-400",
              "border border-slate-200 focus:border-indigo-400",
              "outline-none transition-all duration-200",
              "focus:shadow-[0_0_0_3px_rgba(79,70,229,0.12)]",
              error && "border-red-400 focus:border-red-400",
              className,
            )}
            {...props}
          />
        </div>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  },
);
GlowInput.displayName = "GlowInput";
