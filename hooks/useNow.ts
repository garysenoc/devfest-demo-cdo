"use client";

import { useEffect, useState } from "react";

/**
 * Current time that ticks while `active`. Starts at 0 so nothing time-dependent
 * runs during server prerendering; the first tick happens right after mount.
 */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    if (!active) return () => clearTimeout(first);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}
