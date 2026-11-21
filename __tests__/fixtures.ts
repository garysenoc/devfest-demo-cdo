import type { AgentInfo, ExecutionEvent, TravelPlan } from "@/lib/types";

let counter = 0;

export function makeEvent(partial: Partial<ExecutionEvent> & Pick<ExecutionEvent, "seq" | "type">): ExecutionEvent {
  counter += 1;
  return {
    id: `evt-${partial.seq}-${counter}`,
    execution_id: "exec-1",
    timestamp: new Date(Date.UTC(2026, 10, 21, 10, 0, 0, partial.seq * 500)).toISOString(),
    channel: "internal",
    agent_id: "coordinator",
    target_agent_id: null,
    task_id: null,
    status: null,
    message: `event ${partial.seq}`,
    payload: null,
    metadata: {},
    ...partial,
  };
}

export const AGENTS: AgentInfo[] = (["coordinator", "destination", "budget", "itinerary"] as const).map((id, i) => ({
  id,
  name: `${id[0].toUpperCase()}${id.slice(1)} Agent`,
  description: `${id} description`,
  role: `${id} role`,
  url: `http://localhost:800${i}`,
  card_url: id === "coordinator" ? null : `http://localhost:800${i}/.well-known/agent-card.json`,
  status: "available",
  latency_ms: 4,
  error: null,
  protocol_version: id === "coordinator" ? null : "1.0",
  streaming: true,
  skills: [{ id: `${id}-skill`, name: `${id} skill`, description: "does things", tags: [] }],
  card: id === "coordinator" ? null : { name: id },
}));

/** A realistic happy-path event sequence for the destination agent. */
export function destinationFlow(): ExecutionEvent[] {
  return [
    makeEvent({ seq: 1, type: "execution_started", status: "running", message: "Coordinator received travel request" }),
    makeEvent({ seq: 2, type: "discovery_request", channel: "a2a", target_agent_id: "destination", message: "Discovering Destination Agent", metadata: { message_type: "AgentCard" } }),
    makeEvent({ seq: 3, type: "discovery_response", channel: "a2a", agent_id: "destination", target_agent_id: "coordinator", status: "available", message: "Destination Agent Card discovered", payload: { name: "Destination" }, metadata: { message_type: "AgentCard" } }),
    makeEvent({ seq: 4, type: "a2a_request", channel: "a2a", target_agent_id: "destination", status: "communicating", message: "Submitting Destination A2A task", metadata: { message_type: "SendStreamingMessage", task_label: "Research attractions in Cebu", attempt: 1 }, payload: { message: { parts: [{ text: { request: { destination: "Cebu" } } }] } } }),
    makeEvent({ seq: 5, type: "a2a_task", channel: "a2a", agent_id: "destination", target_agent_id: "coordinator", task_id: "task-dest-123456789", status: "pending", message: "Destination task submitted", metadata: { message_type: "Task", task_state: "TASK_STATE_SUBMITTED" } }),
    makeEvent({ seq: 6, type: "a2a_status_update", channel: "a2a", agent_id: "destination", target_agent_id: "coordinator", task_id: "task-dest-123456789", status: "running", message: "Destination Agent processing request", metadata: { message_type: "TaskStatusUpdateEvent", task_state: "TASK_STATE_WORKING" } }),
    makeEvent({ seq: 7, type: "a2a_artifact", channel: "a2a", agent_id: "destination", target_agent_id: "coordinator", task_id: "task-dest-123456789", status: "communicating", message: "Destination artifact received", metadata: { message_type: "TaskArtifactUpdateEvent" }, payload: { artifactUpdate: { artifact: { parts: [{ data: { attractions: [{ name: "Kawasan Falls" }] } }] } } } }),
    makeEvent({ seq: 8, type: "validation", message: "Destination result validated" }),
    makeEvent({ seq: 9, type: "agent_status", agent_id: "destination", status: "completed", message: "Destination Agent completed", metadata: { summary: "6 attractions, 4 local dishes", duration_ms: 1500 } }),
  ];
}

export const PLAN: TravelPlan = {
  execution_id: "exec-1",
  parent_execution_id: null,
  refinement_instruction: null,
  request: {
    destination: "Cebu",
    origin: "Manila",
    start_date: null,
    end_date: null,
    days: 2,
    travelers: 1,
    budget: 10000,
    currency: "PHP",
    interests: ["Beaches"],
    travel_style: "budget",
    preferences: null,
  },
  overview: {
    destination: "Cebu",
    start_date: null,
    end_date: null,
    days: 2,
    travelers: 1,
    currency: "PHP",
    budget: 10000,
    estimated_total: 8800,
    remaining: 1200,
    over_budget: false,
  },
  destination: {
    destination_overview: "Cebu is an island province.",
    best_areas_to_stay: ["Cebu City"],
    attractions: [
      {
        name: "Kawasan Falls",
        category: "nature",
        description: "Turquoise falls.",
        area: "Badian",
        estimated_cost_per_person: 200,
        visit_duration_hours: 3,
        best_time_of_day: "morning",
        suitable_activities: ["canyoneering"],
        rationale: "Adventure lover",
        wikipedia_title: null,
      },
    ],
    local_food: [{ name: "Lechon", description: "Roast pig", where_to_try: "CnT", estimated_cost_per_person: 300 }],
    getting_around: "Jeepneys and buses.",
    notes: [],
  },
  budget: {
    line_items: [
      { category: "transportation", description: "Buses", amount: 2000, basis: "4 rides" },
      { category: "accommodation", description: "Hostel", amount: 3000, basis: "2 nights" },
      { category: "food", description: "Meals", amount: 2000, basis: "2 days" },
      { category: "activities", description: "Canyoneering", amount: 1000, basis: "1 tour" },
    ],
    contingency_percent: 10,
    cost_saving_tips: ["Eat at carinderias"],
    assumptions: ["Solo traveler"],
    currency: "PHP",
    budget: 10000,
    travelers: 1,
    days: 2,
    category_totals: [
      { category: "transportation", amount: 2000 },
      { category: "accommodation", amount: 3000 },
      { category: "food", amount: 2000 },
      { category: "activities", amount: 1000 },
      { category: "miscellaneous", amount: 0 },
    ],
    subtotal: 8000,
    contingency_amount: 800,
    total_estimated: 8800,
    remaining: 1200,
    over_budget: false,
    overrun_amount: 0,
    per_person_total: 8800,
    daily_spend_allowance: 1600,
  },
  itinerary: {
    days: [
      {
        day: 1,
        date: null,
        theme: "Falls and canyons",
        area_focus: "Badian",
        activities: [
          { time_slot: "morning", start_time: "07:00", title: "Canyoneering", description: "Jump into pools.", location: "Kawasan", estimated_cost: 1000, transport_note: "3h bus" },
          { time_slot: "evening", start_time: "19:00", title: "Lechon dinner", description: "Local food.", location: "Cebu City", estimated_cost: 300, transport_note: "Taxi 15 min" },
        ],
        notes: ["Bring water shoes"],
        estimated_cost: 1300,
      },
      {
        day: 2,
        date: null,
        theme: "City heritage",
        area_focus: "Cebu City",
        activities: [
          { time_slot: "afternoon", start_time: "14:00", title: "Magellan's Cross", description: "Historic site.", location: "Downtown", estimated_cost: 0, transport_note: "Walk" },
        ],
        notes: [],
        estimated_cost: 0,
      },
    ],
    general_tips: ["Start early"],
    total_estimated_cost: 1300,
    currency: "PHP",
  },
  summary: {
    headline: "Two days of falls and lechon",
    summary: "A budget-friendly Cebu escape.",
    packing_list: ["Water shoes"],
    local_recommendations: ["Try puso"],
    safety_reminders: ["Wear a life vest"],
    cost_saving_suggestions: ["Ride jeepneys"],
    alternative_destinations: ["Bohol"],
  },
  consistency: [{ level: "info", message: "Itinerary covers all 2 days." }],
  agents_invoked: ["destination", "budget", "itinerary"],
  disclaimer: "All prices are AI-generated estimates.",
  generated_at: "2026-11-21T10:00:00Z",
};
