import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BudgetBreakdown } from "@/components/budget/BudgetBreakdown";
import { ItineraryView } from "@/components/itinerary/ItineraryView";
import { PlanView } from "@/components/plan/PlanView";
import { PLAN } from "./fixtures";

describe("ItineraryView", () => {
  it("renders days, activities, times and day totals", () => {
    render(<ItineraryView itinerary={PLAN.itinerary} />);
    const day1 = screen.getByRole("region", { name: "Day 1" });
    expect(within(day1).getByText("Canyoneering")).toBeInTheDocument();
    expect(within(day1).getByText("07:00")).toBeInTheDocument();
    expect(within(day1).getByText("Morning")).toBeInTheDocument();
    expect(within(day1).getByText(/3h bus/)).toBeInTheDocument();
    expect(within(day1).getByText(/Bring water shoes/)).toBeInTheDocument();
    expect(screen.getByTestId("day-total-1")).toHaveTextContent("1,300");
    const day2 = screen.getByRole("region", { name: "Day 2" });
    expect(within(day2).getAllByText("Free").length).toBeGreaterThan(0);
  });
});

describe("BudgetBreakdown", () => {
  it("visualizes category totals, contingency and remaining budget", () => {
    render(<BudgetBreakdown budget={PLAN.budget} />);
    expect(screen.getByTestId("budget-segment-accommodation")).toHaveStyle({ width: "30%" });
    expect(screen.getByTestId("budget-segment-contingency")).toHaveStyle({ width: "8%" });
    expect(screen.queryByTestId("budget-segment-miscellaneous")).not.toBeInTheDocument();
    expect(screen.getByTestId("budget-remaining")).toHaveTextContent("Remaining");
    expect(screen.getByTestId("budget-remaining")).toHaveTextContent("1,200");
    expect(screen.getByText("88% of budget")).toBeInTheDocument();
    expect(screen.getByText("Eat at carinderias")).toBeInTheDocument();
  });

  it("flags an overrun and scales the bar to the larger value", () => {
    render(
      <BudgetBreakdown
        budget={{ ...PLAN.budget, budget: 5000, total_estimated: 8800, remaining: -3800, over_budget: true, overrun_amount: 3800 }}
      />,
    );
    expect(screen.getByTestId("budget-remaining")).toHaveTextContent("Over budget by");
    expect(screen.getByTestId("budget-remaining")).toHaveTextContent("3,800");
    expect(screen.getByTestId("budget-segment-accommodation")).toHaveStyle({ width: `${(3000 / 8800) * 100}%` });
  });
});

describe("PlanView", () => {
  it("renders overview, tabs, tips, disclaimer and refinement", async () => {
    const onRefine = vi.fn();
    render(<PlanView plan={PLAN} onRefine={onRefine} refineDisabled={false} />);
    expect(screen.getByText("Two days of falls and lechon")).toBeInTheDocument();
    expect(screen.getByTestId("trip-overview")).toHaveTextContent("Cebu");
    expect(screen.getByTestId("disclaimer")).toHaveTextContent("estimates");
    expect(screen.getByTestId("agents-invoked")).toHaveTextContent("Destination");

    await userEvent.click(screen.getByRole("tab", { name: "Recommendations" }));
    expect(screen.getByText("Kawasan Falls")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Travel tips" }));
    expect(screen.getByText("Water shoes")).toBeInTheDocument();
    expect(screen.getByText("Bohol")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Make the trip cheaper" }));
    expect(onRefine).toHaveBeenCalledWith("Make the trip cheaper");
    await userEvent.type(screen.getByLabelText("Refinement instruction"), "Add a food tour");
    await userEvent.click(screen.getByRole("button", { name: "Refine" }));
    expect(onRefine).toHaveBeenLastCalledWith("Add a food tour");
  });

  it("disables refinement while an execution is running", () => {
    render(<PlanView plan={PLAN} onRefine={() => undefined} refineDisabled />);
    expect(screen.getByRole("button", { name: "Make the trip cheaper" })).toBeDisabled();
  });
});
