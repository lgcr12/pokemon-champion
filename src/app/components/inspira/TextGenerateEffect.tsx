import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "../ui/utils";

type TextGenerateEffectProps = {
  text: string;
  className?: string;
  style?: CSSProperties;
  delay?: number;
  speed?: number;
};

export function TextGenerateEffect({
  text,
  className,
  style,
  delay = 0,
  speed = 40,
}: TextGenerateEffectProps) {
  const [displayed, setDisplayed] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    if (displayed >= text.length) return;
    const t = setTimeout(() => setDisplayed((d) => d + 1), speed);
    return () => clearTimeout(t);
  }, [started, displayed, text, speed]);

  useEffect(() => {
    setDisplayed(0);
    setStarted(false);
  }, [text]);

  return (
    <span className={cn("inline", className)} style={style}>
      {text.slice(0, displayed)}
      {displayed < text.length && (
        <span className="inline-block w-[2px] h-[1em] bg-current align-middle ml-0.5 animate-pulse" />
      )}
    </span>
  );
}
