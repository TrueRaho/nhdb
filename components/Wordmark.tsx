import { cn } from "@/lib/utils";

/** The "nh" + accent "db" logotype, as drawn in the desktop header. */
export function Wordmark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-baseline font-display font-extrabold text-nh-text-1", className)}
      style={{ fontSize: size, letterSpacing: "-0.04em", lineHeight: 1 }}
    >
      <span>nh</span>
      <span className="text-nh-accent">db</span>
    </span>
  );
}
