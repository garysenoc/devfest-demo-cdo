# A2A communication

How the Travel Coordinator and the specialists talk, message by message. Protocol: [A2A 1.0](https://a2a-protocol.org/latest/), JSON-RPC binding over HTTP, implemented with the official [a2a-python SDK](https://github.com/a2aproject/a2a-python) on both sides. The server side comes from ADK's `to_a2a()` ([ADK A2A docs](https://google.github.io/adk-docs/a2a/), [adk.dev](https://adk.dev)).

## 1. Discovery: the Agent Card

The Coordinator starts every execution by fetching each specialist's card with `A2ACardResolver` (`coordinator/discovery.py`):

```http
GET http://localhost:8002/.well-known/agent-card.json
```

```json
{
  "name": "Budget Planning Agent",
  "description": "Estimates transportation, accommodation, food, activity and miscellaneous costs ...",
  "version": "1.0.0",
  "supportedInterfaces": [
    { "url": "http://localhost:8002/", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "provider": { "organization": "AI Travel Planner demo", "url": "https://github.com/google/adk-python" },
  "documentationUrl": "https://adk.dev",
  "capabilities": { "streaming": true },
  "defaultInputModes": ["application/json", "text/plain"],
  "defaultOutputModes": ["application/json"],
  "skills": [
    { "id": "budget_estimation", "name": "Trip budget estimation", "description": "...",
      "tags": ["travel", "budget", "cost"], "examples": ["{...}"],
      "inputModes": ["application/json"], "outputModes": ["application/json"] },
    { "id": "cost_optimization", "name": "Cost optimization", "description": "...", "tags": ["budget", "savings"] }
  ]
}
```

`validate_card()` then checks the card before any work is delegated:

| Check | Required value |
|---|---|
| Skill present | destination → `destination_research`, budget → `budget_estimation`, itinerary → `itinerary_planning` |
| Capability | `capabilities.streaming == true` |
| Interface | at least one `supportedInterfaces[].protocolBinding == "JSONRPC"` |

The card is built in `shared/a2a_server.py::build_agent_card` from each agent's `AgentSpec` (`agents/*/prompts.py`).

## 2. Delegation: `SendStreamingMessage`

`coordinator/a2a_client.py::RemoteAgentCaller` creates a client from the card with `ClientFactory(ClientConfig(streaming=True))` and sends the task. The message part's text is the **task payload as JSON**, validated on both ends by the Pydantic contracts in `shared/schemas.py` (`DestinationTask`, `BudgetTask`, `ItineraryTask`).

```json
{
  "jsonrpc": "2.0", "id": "…", "method": "SendStreamingMessage",
  "params": {
    "message": {
      "messageId": "4d8c…", "role": "ROLE_USER",
      "parts": [{ "text": "{\"request\": {\"destination\": \"Cebu\", \"days\": 3, \"budget\": 10000, …}}",
                  "mediaType": "application/json" }],
      "metadata": { "task_label": "Estimate trip costs for PHP 10,000", "sender": "travel_coordinator", "attempt": 1 }
    },
    "configuration": { "acceptedOutputModes": ["application/json", "text/plain"] }
  }
}
```

The Itinerary task carries the other agents' results. Its payload contains `destination_research` (the validated `DestinationResearch`) and `budget_plan` (the validated `BudgetPlan`). This is how the dependency is satisfied without the specialists ever calling each other.

## 3. Task lifecycle (server-sent stream)

ADK's `A2aAgentExecutor` publishes these events, and the SDK client yields each one as a `StreamResponse`:

| # | StreamResponse field | Task state | Meaning | Dashboard event |
|---|---|---|---|---|
| 1 | `task` | `TASK_STATE_SUBMITTED` | Task created; **task ID assigned by the remote agent** | `a2a_task`, agent → `pending` |
| 2 | `status_update` | `TASK_STATE_WORKING` | ADK run started (metadata has the ADK app, user and session) | `a2a_status_update`, agent → `running` |
| 3 | `status_update` | `TASK_STATE_WORKING` + message | Gemini's final JSON produced (or an error description) | `a2a_status_update` |
| 4 | `artifact_update` | — | **Result artifact** (the JSON plan part) | `a2a_artifact`, agent → `communicating` |
| 5 | `status_update` | `TASK_STATE_COMPLETED` | Terminal success | `a2a_status_update` |
| — | `status_update` | `TASK_STATE_FAILED` | Terminal failure, sanitized message with an error id | `a2a_status_update` + `a2a_error` |

After step 5 the Coordinator validates the artifact text against the expected model (`DestinationResearch`, `BudgetPlan` or `ItineraryPlan`), emits a `validation` event and then `agent_status: completed` with a one-line summary and the duration.

Example artifact event as the inspector shows it (payload is the sanitized `StreamResponse`, with the artifact JSON parsed for readability):

```json
{
  "artifactUpdate": {
    "taskId": "859a7244-…", "contextId": "36d9…", "lastChunk": true,
    "artifact": { "artifactId": "d35c…", "parts": [{ "data": { "line_items": [ … ], "total_estimated": 8250, "remaining": 1750, … } }] },
    "metadata": { "adk_app_name": "budget_planning_agent", "adk_session_id": "…" }
  }
}
```

## 4. Retries, timeouts and cancellation

- **Failed task** (`FAILED`, `CANCELED` or `REJECTED`), **transport error**, **missing or invalid artifact**: `RemoteTaskError`. If attempts remain (`A2A_MAX_RETRIES`, default 1), the Coordinator emits `agent_status: retrying` and sends a **new** task, so a retry produces a new task ID.
- **Timeout** (`A2A_TIMEOUT_SECONDS`): the Coordinator sends `CancelTask(id=…)` (best effort), then retries or fails.
- Parallel tasks are awaited with `gather(return_exceptions=True)` so a sibling's lifecycle completes and appears on the dashboard even when the other task fails.

## 5. Coordinator-local vs network traffic

| Happens over the network (`channel: "a2a"`) | Happens inside the Coordinator (`channel: "internal"`) |
|---|---|
| Agent Card GETs and responses | Request validation, orchestration decisions |
| `SendStreamingMessage` requests | Artifact schema validation |
| `Task`, `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent` responses | Consistency checks, ADK summary / refinement-router runs |
| Failed tasks (`a2a_error`) | Agent status bookkeeping, plan ready / execution completed |

The inspector shows only the left column by default. "Include internal events" adds the right column, labelled `INTERNAL`.

## 6. Trying it yourself

```bash
cd backend
uv run python -m tools.send_a2a_task budget        # streams the lifecycle above to your terminal
curl -s http://localhost:8003/.well-known/agent-card.json | python3 -m json.tool
```

There is also a raw JSON-RPC `SendMessage` curl example in the [README](../README.md#testing-a2a-communication-by-hand). The automated proofs are in `backend/tests/test_a2a_integration.py`: card discovery, task IDs, lifecycle, artifacts, a real `TASK_STATE_FAILED` followed by a retry, and timeouts.
