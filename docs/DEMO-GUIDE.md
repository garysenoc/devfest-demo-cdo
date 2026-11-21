# Demo guide (3–5 minutes)

A script for presenting the AI Travel Planner live. Everything the audience sees is driven by real backend events, so if something fails on stage the dashboard shows the failure honestly.

## Before you present

1. Set `GOOGLE_API_KEY` in `.env` and run **one full plan** beforehand to confirm the key, quota and model work. A cold first Gemini call can be slower.
2. Start everything: `./scripts/dev.sh`. Wait for the banner listing the URLs.
3. Run `./scripts/check-agents.sh`. All four services should be **UP** and `gemini_configured=True`.
4. Open http://localhost:3000. Zoom the browser to about 110% for a projector. Keep a terminal with the `dev.sh` logs visible if you want to show the agents' own logs.
5. Optional second tab: `http://localhost:8002/.well-known/agent-card.json`.

Expected timing with `gemini-3.5-flash`: Destination and Budget take roughly 5–20 s each (in parallel), Itinerary roughly 10–30 s, and consolidation a few seconds. Fill the gaps with narration.

## Script

| Time | Do | Say / point at |
|---|---|---|
| 0:00 | Show the idle dashboard | "Four Google ADK agents. Three of them are separate web services, each publishing an **A2A Agent Card**. The cards say *Available* because the Coordinator just fetched those cards live." Open one card's **Show execution details** to show its skills. |
| 0:30 | Optional: show the raw card in the second tab | "This JSON is the A2A Agent Card: name, skills, streaming capability, and the JSON-RPC endpoint. This is all the Coordinator knows about the agent." |
| 0:45 | Click **Load demo scenario**, then **Plan my trip with the agents** | "I'm planning a 3-day trip to Cebu with a ₱10,000 budget. I enjoy beaches, adventure activities and local food." |
| 0:50 | Watch the graph | **Discovery:** pulses go out to all three specialists and cards come back. Status flips *Discovering*, then *Available*. |
| 1:00 | Point at Destination + Budget | "Two real A2A tasks were submitted **at the same time**. Each card now shows a **task ID assigned by the remote agent**, and both are *Running*, each one calling Gemini independently." Timeline: two `a2a_request` rows, then `Task SUBMITTED` from each. |
| 1:30 | Open the **A2A communication inspector** and click a `SendStreamingMessage` row | "This is the actual message on the wire: our trip request as a structured JSON task." Then click a `TaskStatusUpdateEvent` row: "and this is the agent reporting `WORKING`." |
| 2:00 | When Destination and Budget complete | "Each returned an **artifact**. The Coordinator validated it against a schema; you can see the *validation* step in the timeline. The budget totals are computed in code, not guessed by the model." |
| 2:15 | Itinerary goes *Pending*, then *Running* | "The Itinerary agent depends on both. The Coordinator forwards both results inside a new A2A task." Inspector: open the itinerary request and scroll to `destination_research` and `budget_plan`. |
| 3:00 | Coordinator consolidates | "The Coordinator is an ADK agent too. It writes the summary and travel tips and cross-checks the results for inconsistencies." |
| 3:15 | Scroll to the plan | Overview (estimated total versus budget, remaining), **Daily itinerary**, **Budget** tab (breakdown bar and line items), **Recommendations**, **Travel tips**. Point at the estimate disclaimer. |
| 3:45 | Click **Make the trip cheaper** | "Refinement: a Coordinator agent decides *which* specialists need to run again." Usually Budget and Itinerary re-run while Destination stays idle, and the plan shows **Agents invoked**. |
| 4:30 | Wrap up | "Independent services, discovered by Agent Card, communicating over A2A, each powered by Gemini through Google ADK, and every step you saw was a real protocol event." |

## What to point at, by stage

| Stage | Agent cards | Graph | Timeline / inspector |
|---|---|---|---|
| Discovery | Specialists *Discovering*, then *Available* | Pulses on all three edges, out and back | `discovery_request` / `discovery_response` (payload = card) |
| Parallel delegation | Destination and Budget *Pending*, then *Running*, task IDs appear | Two edges animate together | Two `SendStreamingMessage` rows with near-identical timestamps |
| Results | *Communicating*, then *Completed*, output summary, duration | Edges turn green | `TaskArtifactUpdateEvent`, `TASK_STATE_COMPLETED`, `validation` |
| Dependent task | Itinerary *Pending*, then *Running* | Coordinator → Itinerary edge animates; dashed dependency edges | Itinerary request payload contains both results |
| Consolidation | Coordinator *Running*, then *Completed* | — | `Cross-checked agent results`, `Travel plan generated` |
| Refinement | Only the re-run agents change state | Only their edges animate | `Refinement plan: re-run …`, `Reusing previous …` |

## If something goes wrong on stage

- **An agent fails:** its card turns *Failed*, then *Retrying*, and a new task ID appears. That is the A2A failure and retry path working; narrate it. The real cause is in that agent's terminal log.
- **Execution failed:** the banner shows a sanitized reason. Check the key and quota, then click **New request**.
- **Wi-Fi drops briefly:** the header shows *Reconnecting*; the stream resumes from the last event and nothing is lost.
- **Accidental page reload:** the execution is recovered from the server automatically.

## Backup: terminal-only demo

```bash
cd backend
uv run python -m tools.send_a2a_task budget       # one agent, raw A2A lifecycle in the terminal
uv run python -m tools.send_a2a_task itinerary    # chains destination + budget, then itinerary
```
