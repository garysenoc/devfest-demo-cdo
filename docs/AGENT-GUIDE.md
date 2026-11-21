# Agent guide

Every agent is a Google ADK `LlmAgent` ([ADK LLM agents](https://google.github.io/adk-docs/agents/llm-agents/), [adk.dev](https://adk.dev)) running Gemini with a structured output contract. Specialists are wrapped as A2A services; the Coordinator's agents run in-process.

## Anatomy of a specialist

```text
agents/budget/
├── prompts.py        SPEC (AgentSpec → Agent Card) + INSTRUCTION
├── agent.py          build_agent(model) -> LlmAgent
├── calculations.py   deterministic post-processing (budget only)
└── server.py         create_app() and `python -m agents.budget.server`
```

```python
LlmAgent(
    name="budget_planning_agent",
    model=model or settings.gemini_model,          # a fake BaseLlm only in tests
    instruction=INSTRUCTION,                        # from prompts.py
    output_schema=BudgetEstimate,                   # Gemini returns this JSON shape
    generate_content_config=types.GenerateContentConfig(temperature=0.3),
    after_model_callback=make_finalizer(            # validate + compute exact totals
        input_model=BudgetTask, output_model=BudgetEstimate, finalize=_finalize, logger=logger),
    before_agent_callback=_before, after_agent_callback=_after,   # execution logging
)
```

`make_finalizer` (`shared/agent_runtime.py`) parses the incoming task, validates the model output, applies `finalize(...)` and replaces the model response with the finalized JSON. If validation fails, the callback raises. ADK then turns the run into an A2A `TASK_STATE_FAILED` with a sanitized message, and the Coordinator retries.

**Completion criteria.** A specialist's work is complete when its A2A task reaches `TASK_STATE_COMPLETED` *and* its artifact validates against the contract on the Coordinator side.

## The agents

### Destination Research Agent: `:8001`

- **Input:** `DestinationTask {request, refinement?, previous?}`
- **Output:** `DestinationResearch`
  - 5–12 `attractions`, each with `category`, `description`, `area`, `estimated_cost_per_person`, `visit_duration_hours`, `best_time_of_day`, `suitable_activities`, `rationale` and `wikipedia_title`.
  - `local_food`, `best_areas_to_stay`, `getting_around`, `notes`.
- **Post-processing:** removes duplicate attractions.
- **Skills on card:** `destination_research`, `local_food_guide`.

### Budget Planning Agent: `:8002`

- **Input:** `BudgetTask {request, refinement?, previous?}`
- **Model output:** `BudgetEstimate`. Line items in five categories (whole group, whole trip), `contingency_percent` (0–25), `cost_saving_tips`, `assumptions`.
- **Artifact:** `BudgetPlan` = estimate plus code-computed `category_totals`, `subtotal`, `contingency_amount`, `total_estimated`, `remaining`, `over_budget`, `overrun_amount`, `per_person_total` and `daily_spend_allowance` (`agents/budget/calculations.py`). The model is told **not** to compute totals.
- **Skills on card:** `budget_estimation`, `cost_optimization`.

### Itinerary Planning Agent: `:8003`

- **Input:** `ItineraryTask {request, destination_research, budget_plan, refinement?, previous?}`, which carries the other two agents' results via the Coordinator.
- **Model output:** `ItineraryDraft`. Exactly `days` days, each built around one area, with 3–5 morning, afternoon and evening activities, `start_time`, group `estimated_cost`, `transport_note` and notes.
- **Artifact:** `ItineraryPlan`. Days are sorted and renumbered and capped at the requested length, activities are ordered by slot and time, calendar dates are attached from `start_date`, and day and trip totals are computed (`agents/itinerary/scheduling.py`).
- **Skill on card:** `itinerary_planning`.

### Travel Coordinator: `:8000`

The Coordinator's own ADK agents are in `coordinator/agent.py`, with prompts in `coordinator/prompts.py`:

| Agent | Output | Used for |
|---|---|---|
| `travel_coordinator` | `CoordinatorSummary` (headline, summary, packing list, local recommendations, safety reminders, cost-saving suggestions, alternative destinations) | Consolidation, from a compact digest of the three results |
| `refinement_router` | `RefinementDecision` (which agents to re-run, new budget, days, interests or style, guidance) | Plan refinement |

The Coordinator also applies deterministic rules (`TravelOrchestrator.apply_decision`):

- A change in days re-runs every agent.
- A change in budget, days or style re-runs Budget.
- New interests re-run Destination.
- Itinerary always re-runs.

Cross-agent checks run in `coordinator/consistency.py`: day count, currency, overrun, itinerary cost versus budget allocation, rushed days, overlapping times, and how many recommended attractions are scheduled.

## Money conventions

Every prompt and schema field description states these rules, and they apply everywhere:

- Attraction and food costs are **per person**.
- Budget line items and itinerary activity costs are for the **whole group**.
- All amounts are in the trip currency and are **estimates** (`PRICE_DISCLAIMER` in `shared/schemas.py` is attached to every plan).

## Adding a new specialist (e.g. a Weather Agent)

1. **Contract.** Add `WeatherTask` and `WeatherReport` to `shared/schemas.py`, and mirror the output in `lib/types.ts`.
2. **Agent.** Create `agents/weather/` with `prompts.py` (an `AgentSpec` with a skill id such as `weather_outlook`, plus an `INSTRUCTION`), `agent.py` (`build_agent` using `make_finalizer`) and `server.py` (copy an existing one and change the port setting).
3. **Config.** Add `weather_agent_port` / `weather_agent_url` to `Settings` and to `specialist_urls`, and document both in `.env.example`.
4. **Discovery.** Add `"weather"` to `AgentId`, `SPECIALIST_IDS` (`shared/events.py`), `AGENT_NAMES` and `REQUIRED_SKILLS` (`coordinator/discovery.py`).
5. **Orchestration.** Call it from `TravelOrchestrator.run_plan`, for example inside the parallel `gather` with Destination and Budget, using `self.caller.call(...)` with a `summarize` function.
6. **Frontend.** Add the id to `AGENT_IDS` in `lib/types.ts`, a node position in `components/agent-graph/AgentGraph.tsx`, and a colour token.
7. **Tests.** Teach `tests/fakes.py::FakeGemini` the new prompt, then extend `test_a2a_integration.py` and `test_e2e.py`.
8. **Startup.** Add a `run weather …` line to `scripts/dev.sh`.

## Running one agent in isolation

```bash
cd backend
uv run python -m agents.destination.server
curl -s localhost:8001/.well-known/agent-card.json
curl -s localhost:8001/health
uv run python -m tools.send_a2a_task destination
```

No other service needs to be running.
