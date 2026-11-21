"use client";

/** Polls the coordinator for health and live Agent Card availability. */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, type HealthResponse } from "@/lib/api";
import type { AgentInfo } from "@/lib/types";

export interface AgentsState {
  agents: AgentInfo[];
  health: HealthResponse | null;
  backendOnline: boolean | null; // null = first check pending
  error: string | null;
  checkedAt: string | null;
}

export function useAgents(pollMs = 10_000) {
  const [state, setState] = useState<AgentsState>({
    agents: [],
    health: null,
    backendOnline: null,
    error: null,
    checkedAt: null,
  });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [health, agents] = await Promise.all([api.health(), api.agents()]);
      if (!mounted.current) return;
      setState({
        agents: agents.agents,
        health,
        backendOnline: true,
        error: null,
        checkedAt: agents.checked_at,
      });
    } catch (err) {
      if (!mounted.current) return;
      setState((prev) => ({
        ...prev,
        backendOnline: err instanceof ApiError && err.kind !== "network" ? true : false,
        agents: err instanceof ApiError && err.kind === "network" ? [] : prev.agents,
        error: err instanceof Error ? err.message : "Unable to reach the coordinator.",
      }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), pollMs);
    return () => {
      mounted.current = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { ...state, refresh };
}
