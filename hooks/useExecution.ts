"use client";

/**
 * Execution lifecycle: create / refine a plan, stream real backend events over
 * SSE, reconnect with Last-Event-ID semantics, and recover state from the
 * snapshot endpoint (after a reload, a dropped connection, or completion).
 */
import { useCallback, useEffect, useReducer, useRef } from "react";

import { ApiError, api, eventsUrl } from "@/lib/api";
import type {
  ConnectionState,
  ExecutionEvent,
  ExecutionSnapshot,
  ExecutionStatus,
  TravelPlan,
  TripRequest,
} from "@/lib/types";

export const STORAGE_KEY = "travel-planner:execution";
const MAX_RECONNECT_ATTEMPTS = 8;

export interface ExecutionRef {
  id: string;
  token: string;
}

export interface ExecutionState {
  execution: ExecutionRef | null;
  kind: "plan" | "refine" | null;
  status: ExecutionStatus | "idle";
  events: ExecutionEvent[];
  plan: TravelPlan | null;
  /** Execution that produced `plan`; refinements are issued against it. */
  planSource: ExecutionRef | null;
  connection: ConnectionState;
  error: string | null;
  errorKind: ApiError["kind"] | null;
  submitting: boolean;
  reconnectAttempts: number;
}

export const initialExecutionState: ExecutionState = {
  execution: null,
  kind: null,
  status: "idle",
  events: [],
  plan: null,
  planSource: null,
  connection: "idle",
  error: null,
  errorKind: null,
  submitting: false,
  reconnectAttempts: 0,
};

type Action =
  | { type: "submit" }
  | { type: "submit_failed"; error: string; kind: ApiError["kind"] }
  | { type: "started"; execution: ExecutionRef; kind: "plan" | "refine" }
  | { type: "events"; events: ExecutionEvent[] }
  | { type: "connection"; connection: ConnectionState; reconnectAttempts?: number }
  | { type: "snapshot"; snapshot: ExecutionSnapshot; execution: ExecutionRef }
  | { type: "reset" };

/** Merge events by `seq`, ignoring duplicates delivered after a reconnect. */
export function mergeEvents(current: ExecutionEvent[], incoming: ExecutionEvent[]): ExecutionEvent[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((a, b) => a.seq - b.seq);
}

export function executionReducer(state: ExecutionState, action: Action): ExecutionState {
  switch (action.type) {
    case "submit":
      return { ...state, submitting: true, error: null, errorKind: null };
    case "submit_failed":
      return { ...state, submitting: false, error: action.error, errorKind: action.kind };
    case "started":
      return {
        ...state,
        execution: action.execution,
        kind: action.kind,
        status: "running",
        events: [],
        submitting: false,
        error: null,
        errorKind: null,
        connection: "connecting",
        reconnectAttempts: 0,
      };
    case "events":
      return { ...state, events: mergeEvents(state.events, action.events) };
    case "connection":
      return {
        ...state,
        connection: action.connection,
        reconnectAttempts: action.reconnectAttempts ?? state.reconnectAttempts,
      };
    case "snapshot": {
      const { snapshot } = action;
      const hasResult = snapshot.status === "completed" && snapshot.result;
      return {
        ...state,
        execution: action.execution,
        kind: snapshot.kind,
        status: snapshot.status,
        events: mergeEvents(state.events, snapshot.events),
        plan: hasResult ? snapshot.result : state.plan,
        planSource: hasResult ? action.execution : state.planSource,
        error: snapshot.status === "failed" ? snapshot.error || "The execution failed." : null,
        errorKind: snapshot.status === "failed" ? "server" : null,
      };
    }
    case "reset":
      return initialExecutionState;
    default:
      return state;
  }
}

function errorInfo(err: unknown): { error: string; kind: ApiError["kind"] } {
  if (err instanceof ApiError) return { error: err.message, kind: err.kind };
  return { error: "Unexpected error. Check the coordinator logs.", kind: "server" };
}

function saveExecution(ref: ExecutionRef | null) {
  try {
    if (ref) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode); recovery is best-effort */
  }
}

function loadExecution(): ExecutionRef | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExecutionRef>;
    return parsed.id && parsed.token ? { id: parsed.id, token: parsed.token } : null;
  } catch {
    return null;
  }
}

export function useExecution() {
  const [state, dispatch] = useReducer(executionReducer, initialExecutionState);

  const sourceRef = useRef<EventSource | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(0);
  const activeId = useRef<string | null>(null);
  const finished = useRef(false);

  const closeStream = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const finalize = useCallback(
    async (ref: ExecutionRef) => {
      finished.current = true;
      closeStream();
      dispatch({ type: "connection", connection: "closed" });
      try {
        const snapshot = await api.snapshot(ref.id, ref.token);
        if (activeId.current !== ref.id) return;
        dispatch({ type: "snapshot", snapshot, execution: ref });
      } catch (err) {
        if (activeId.current !== ref.id) return;
        dispatch({ type: "submit_failed", ...errorInfo(err) });
      }
    },
    [closeStream],
  );

  const openStream = useCallback(
    (ref: ExecutionRef, initialAttempt: number) => {
      const connect = (startAttempt: number) => {
        let attempt = startAttempt;
        closeStream();
        finished.current = false;
        const source = new EventSource(eventsUrl(ref.id, ref.token, lastSeq.current));
        sourceRef.current = source;

        source.onopen = () => {
          if (sourceRef.current !== source) return;
          dispatch({ type: "connection", connection: "open", reconnectAttempts: 0 });
          attempt = 0;
        };

        source.addEventListener("execution_event", (message) => {
          if (sourceRef.current !== source) return;
          let event: ExecutionEvent;
          try {
            event = JSON.parse((message as MessageEvent<string>).data) as ExecutionEvent;
          } catch {
            return;
          }
          if (event.seq <= lastSeq.current) return; // duplicate after reconnect
          lastSeq.current = event.seq;
          dispatch({ type: "events", events: [event] });
          if (event.type === "execution_completed" || event.type === "execution_failed") {
            void finalize(ref);
          }
        });

        source.addEventListener("end", () => {
          if (sourceRef.current !== source || finished.current) return;
          void finalize(ref);
        });

        source.onerror = () => {
          if (sourceRef.current !== source || finished.current) return;
          source.close();
          sourceRef.current = null;
          const next = attempt + 1;
          if (next > MAX_RECONNECT_ATTEMPTS) {
            dispatch({ type: "connection", connection: "error", reconnectAttempts: next });
            // Fall back to the snapshot so the user still sees the latest state.
            void api
              .snapshot(ref.id, ref.token)
              .then((snapshot) => {
                if (activeId.current === ref.id) dispatch({ type: "snapshot", snapshot, execution: ref });
              })
              .catch(() => undefined);
            return;
          }
          dispatch({ type: "connection", connection: "reconnecting", reconnectAttempts: next });
          const delay = Math.min(1000 * 2 ** (next - 1), 10_000);
          retryTimer.current = setTimeout(() => {
            if (activeId.current === ref.id) connect(next);
          }, delay);
        };
      };
      connect(initialAttempt);
    },
    [closeStream, finalize],
  );

  const begin = useCallback(
    (ref: ExecutionRef, kind: "plan" | "refine") => {
      activeId.current = ref.id;
      lastSeq.current = 0;
      saveExecution(ref);
      dispatch({ type: "started", execution: ref, kind });
      openStream(ref, 0);
    },
    [openStream],
  );

  const start = useCallback(
    async (trip: TripRequest) => {
      dispatch({ type: "submit" });
      try {
        const created = await api.createPlan(trip);
        begin({ id: created.execution_id, token: created.access_token }, "plan");
        return true;
      } catch (err) {
        dispatch({ type: "submit_failed", ...errorInfo(err) });
        return false;
      }
    },
    [begin],
  );

  const refine = useCallback(
    async (instruction: string) => {
      const source = state.planSource;
      if (!source) return false;
      dispatch({ type: "submit" });
      try {
        const created = await api.refinePlan(source.id, source.token, instruction);
        begin({ id: created.execution_id, token: created.access_token }, "refine");
        return true;
      } catch (err) {
        dispatch({ type: "submit_failed", ...errorInfo(err) });
        return false;
      }
    },
    [begin, state.planSource],
  );

  const reset = useCallback(() => {
    closeStream();
    activeId.current = null;
    lastSeq.current = 0;
    saveExecution(null);
    dispatch({ type: "reset" });
  }, [closeStream]);

  // Recover an execution after a page reload.
  useEffect(() => {
    const stored = loadExecution();
    if (!stored) return;
    let cancelled = false;
    activeId.current = stored.id;
    api
      .snapshot(stored.id, stored.token)
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({ type: "snapshot", snapshot, execution: stored });
        lastSeq.current = snapshot.events.reduce((max, e) => Math.max(max, e.seq), 0);
        if (snapshot.status === "running") {
          dispatch({ type: "connection", connection: "connecting" });
          openStream(stored, 0);
        } else {
          finished.current = true;
          dispatch({ type: "connection", connection: "closed" });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.kind === "unauthorized" || err.kind === "not_found")) {
          saveExecution(null);
          activeId.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [openStream]);

  useEffect(() => closeStream, [closeStream]);

  return { state, start, refine, reset };
}
