import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlannerApp } from "@/components/app/PlannerApp";
import { AGENTS } from "./fixtures";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("EventSource", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlannerApp error states", () => {
  it("shows the backend offline banner with the start command", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<PlannerApp />);
    expect(await screen.findByText(/coordinator is not reachable/i)).toBeInTheDocument();
    expect(screen.getByText("./scripts/dev.sh")).toBeInTheDocument();
    expect(screen.getByTestId("header-status")).toHaveTextContent("Coordinator offline");
  });

  it("warns when Gemini is not configured and when an agent is offline", async () => {
    const agents = AGENTS.map((a) => (a.id === "itinerary" ? { ...a, status: "offline" as const } : a));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/health")
            ? jsonResponse({ status: "ok", service: "coordinator", model: "gemini-3.5-flash", gemini_configured: false })
            : jsonResponse({ agents, checked_at: "2026-11-21T10:00:00Z" }),
        ),
      ),
    );
    render(<PlannerApp />);
    expect(await screen.findByText("Gemini is not configured")).toBeInTheDocument();
    expect(screen.getByText(/Itinerary Agent is offline/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("agent-card-itinerary").querySelector("[data-status]")).toHaveAttribute("data-status", "offline"));
    expect(screen.getByText("gemini-3.5-flash")).toBeInTheDocument();
  });

  it("renders the idle state explaining what will happen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<PlannerApp />);
    expect(screen.getByText(/your travel plan will appear here/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no activity yet/i).length).toBeGreaterThan(0);
    await screen.findByText(/coordinator is not reachable/i);
  });
});
