import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEY, mergeEvents, useExecution } from "@/hooks/useExecution";
import type { ExecutionEvent, ExecutionSnapshot } from "@/lib/types";
import { PLAN, destinationFlow, makeEvent } from "./fixtures";

type Listener = (e: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
  static latest() {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

function snapshot(partial: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    execution_id: "exec-1",
    parent_execution_id: null,
    kind: "plan",
    status: "completed",
    created_at: "2026-11-21T10:00:00Z",
    updated_at: "2026-11-21T10:01:00Z",
    request: PLAN.request,
    refinement_instruction: null,
    error: null,
    result: PLAN,
    events: [],
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mergeEvents", () => {
  it("dedupes by seq and keeps order", () => {
    const [a, b, c] = destinationFlow();
    expect(mergeEvents([a, c], [b, c]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("useExecution", () => {
  it("starts a plan, streams events, dedupes, and fetches the snapshot on completion", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ execution_id: "exec-1", access_token: "tok-1" }, 202));
    const { result } = renderHook(() => useExecution());

    await act(async () => {
      await result.current.start(PLAN.request);
    });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/plans$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ destination: "Cebu" });
    expect(result.current.state.status).toBe("running");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string)).toEqual({ id: "exec-1", token: "tok-1" });

    const es = MockEventSource.latest();
    expect(es.url).toContain("/api/executions/exec-1/events?token=tok-1");
    act(() => es.open());
    expect(result.current.state.connection).toBe("open");

    const flow = destinationFlow();
    act(() => {
      es.emit("execution_event", flow[0]);
      es.emit("execution_event", flow[1]);
      es.emit("execution_event", flow[1]); // duplicate
    });
    expect(result.current.state.events.map((e) => e.seq)).toEqual([1, 2]);

    const finalEvents: ExecutionEvent[] = [...flow, makeEvent({ seq: 10, type: "execution_completed", status: "completed", message: "Travel plan generated" })];
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot({ events: finalEvents })));
    await act(async () => {
      es.emit("execution_event", finalEvents[9]);
    });
    await waitFor(() => expect(result.current.state.status).toBe("completed"));
    expect(fetchMock.mock.calls[1][0]).toContain("/api/executions/exec-1?token=tok-1");
    expect(result.current.state.plan?.summary.headline).toBe(PLAN.summary.headline);
    expect(result.current.state.events).toHaveLength(10); // gaps filled from snapshot
    expect(result.current.state.connection).toBe("closed");
    expect(es.closed).toBe(true);
  });

  it("reconnects with last_event_id after a dropped connection", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ execution_id: "exec-1", access_token: "tok-1" }, 202));
    const { result } = renderHook(() => useExecution());
    await act(async () => {
      await result.current.start(PLAN.request);
    });
    const first = MockEventSource.latest();
    const flow = destinationFlow();
    act(() => {
      first.open();
      flow.slice(0, 4).forEach((e) => first.emit("execution_event", e));
      first.fail();
    });
    expect(result.current.state.connection).toBe("reconnecting");
    expect(first.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    const second = MockEventSource.latest();
    expect(second).not.toBe(first);
    expect(second.url).toContain("last_event_id=4");
    act(() => {
      second.open();
      second.emit("execution_event", flow[3]); // replayed duplicate
      second.emit("execution_event", flow[4]);
    });
    expect(result.current.state.connection).toBe("open");
    expect(result.current.state.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("recovers an execution from sessionStorage after reload and resumes streaming", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "exec-9", token: "tok-9" }));
    const flow = destinationFlow().slice(0, 5);
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot({ execution_id: "exec-9", status: "running", result: null, events: flow })));
    const { result } = renderHook(() => useExecution());
    await waitFor(() => expect(result.current.state.events).toHaveLength(5));
    expect(result.current.state.status).toBe("running");
    expect(MockEventSource.latest().url).toContain("/api/executions/exec-9/events?token=tok-9&last_event_id=5");
  });

  it("surfaces 503 (Gemini not configured) as an unavailable error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "GOOGLE_API_KEY is not set." }, 503));
    const { result } = renderHook(() => useExecution());
    await act(async () => {
      await result.current.start(PLAN.request);
    });
    expect(result.current.state.error).toBe("GOOGLE_API_KEY is not set.");
    expect(result.current.state.errorKind).toBe("unavailable");
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("refines against the execution that produced the plan", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ execution_id: "exec-1", access_token: "tok-1" }, 202));
    const { result } = renderHook(() => useExecution());
    await act(async () => {
      await result.current.start(PLAN.request);
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot()));
    await act(async () => {
      MockEventSource.latest().emit("end", { status: "completed" });
    });
    await waitFor(() => expect(result.current.state.plan).not.toBeNull());

    fetchMock.mockResolvedValueOnce(jsonResponse({ execution_id: "exec-2", access_token: "tok-2" }, 202));
    await act(async () => {
      await result.current.refine("Make the trip cheaper");
    });
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toContain("/api/executions/exec-1/refine?token=tok-1");
    expect(JSON.parse(init.body)).toEqual({ instruction: "Make the trip cheaper" });
    expect(result.current.state.kind).toBe("refine");
    expect(result.current.state.plan).not.toBeNull(); // previous plan stays visible
    expect(MockEventSource.latest().url).toContain("exec-2");
  });
});
