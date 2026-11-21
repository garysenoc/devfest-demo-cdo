import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DEMO_FORM, EMPTY_FORM, TripForm, validateTrip } from "@/components/planner/TripForm";

describe("validateTrip", () => {
  it("mirrors backend rules", () => {
    const { errors } = validateTrip({ ...EMPTY_FORM, destination: "C", days: "15", travelers: "0", budget: "-5" });
    expect(errors.destination).toBeDefined();
    expect(errors.days).toBeDefined();
    expect(errors.travelers).toBeDefined();
    expect(errors.budget).toBeDefined();
  });

  it("rejects a return date before departure and derives days from dates", () => {
    expect(validateTrip({ ...DEMO_FORM, start_date: "2026-12-10", end_date: "2026-12-08" }).errors.end_date).toBeDefined();
    const { request } = validateTrip({ ...DEMO_FORM, start_date: "2026-12-10", end_date: "2026-12-14", days: "3" });
    expect(request?.days).toBe(5);
  });

  it("builds the demo request", () => {
    const { request, errors } = validateTrip(DEMO_FORM);
    expect(errors).toEqual({});
    expect(request).toMatchObject({ destination: "Cebu, Philippines", days: 3, budget: 10000, currency: "PHP", interests: ["Beaches", "Adventure", "Local food"] });
  });
});

describe("TripForm", () => {
  it("shows validation errors and does not submit an empty form", async () => {
    const onSubmit = vi.fn();
    render(<TripForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: /plan my trip/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/enter a destination/i)).toBeInTheDocument();
    expect(screen.getByText(/budget greater than zero/i)).toBeInTheDocument();
  });

  it("loads the demo scenario and submits the expected payload", async () => {
    const onSubmit = vi.fn();
    render(<TripForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: /load demo scenario/i }));
    expect(screen.getByLabelText("Destination")).toHaveValue("Cebu, Philippines");
    expect(screen.getByRole("button", { name: "Beaches" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /plan my trip/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ destination: "Cebu, Philippines", budget: 10000, days: 3, travel_style: "budget" });
  });

  it("supports custom interests and travel style", async () => {
    const onSubmit = vi.fn();
    render(<TripForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("Destination"), "Kyoto");
    await userEvent.type(screen.getByLabelText("Total budget"), "2000");
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "USD");
    await userEvent.type(screen.getByLabelText(/custom interest/i), "Temples{enter}");
    await userEvent.click(screen.getByRole("radio", { name: "Luxury" }));
    await userEvent.click(screen.getByRole("button", { name: /plan my trip/i }));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ destination: "Kyoto", currency: "USD", interests: ["Temples"], travel_style: "luxury", budget: 2000 });
  });
});
