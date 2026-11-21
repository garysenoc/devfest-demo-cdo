/**
 * TypeScript mirror of the backend contracts:
 *   backend/shared/schemas.py  (trip request, agent outputs, final plan)
 *   backend/shared/events.py   (execution events streamed over SSE)
 *   backend/coordinator/main.py (REST responses)
 * Keep these in sync when changing the Python models.
 */

export type AgentId = "coordinator" | "destination" | "budget" | "itinerary";
export const AGENT_IDS: AgentId[] = ["coordinator", "destination", "budget", "itinerary"];
export const SPECIALIST_IDS: Exclude<AgentId, "coordinator">[] = ["destination", "budget", "itinerary"];

export type AgentStatus =
  | "offline"
  | "discovering"
  | "available"
  | "pending"
  | "running"
  | "communicating"
  | "completed"
  | "failed"
  | "retrying";

export type EventType =
  | "execution_started"
  | "execution_completed"
  | "execution_failed"
  | "agent_status"
  | "orchestration"
  | "discovery_request"
  | "discovery_response"
  | "a2a_request"
  | "a2a_task"
  | "a2a_status_update"
  | "a2a_artifact"
  | "a2a_error"
  | "validation"
  | "plan_ready";

export type Channel = "a2a" | "internal";
export type ExecutionStatus = "running" | "completed" | "failed";

export interface ExecutionEvent {
  id: string;
  seq: number;
  execution_id: string;
  timestamp: string; // ISO-8601 UTC
  type: EventType;
  channel: Channel;
  agent_id: AgentId;
  target_agent_id: AgentId | null;
  task_id: string | null;
  status: AgentStatus | null;
  message: string;
  payload: unknown | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Trip request
// ---------------------------------------------------------------------------
export type TravelStyle = "budget" | "balanced" | "comfort" | "luxury";

export interface TripRequest {
  destination: string;
  origin?: string | null;
  start_date?: string | null; // YYYY-MM-DD
  end_date?: string | null;
  days: number;
  travelers: number;
  budget: number;
  currency: string;
  interests: string[];
  travel_style: TravelStyle;
  preferences?: string | null;
}

// ---------------------------------------------------------------------------
// Agent outputs
// ---------------------------------------------------------------------------
export interface Attraction {
  name: string;
  category: string;
  description: string;
  area: string;
  estimated_cost_per_person: number;
  visit_duration_hours: number;
  best_time_of_day: "morning" | "afternoon" | "evening" | "any";
  suitable_activities: string[];
  rationale: string;
  wikipedia_title: string | null;
}

export interface FoodRecommendation {
  name: string;
  description: string;
  where_to_try: string;
  estimated_cost_per_person: number;
}

export interface DestinationResearch {
  destination_overview: string;
  best_areas_to_stay: string[];
  attractions: Attraction[];
  local_food: FoodRecommendation[];
  getting_around: string;
  notes: string[];
}

export type BudgetCategory = "transportation" | "accommodation" | "food" | "activities" | "miscellaneous";

export interface BudgetLineItem {
  category: BudgetCategory;
  description: string;
  amount: number;
  basis: string;
}

export interface BudgetPlan {
  line_items: BudgetLineItem[];
  contingency_percent: number;
  cost_saving_tips: string[];
  assumptions: string[];
  currency: string;
  budget: number;
  travelers: number;
  days: number;
  category_totals: { category: BudgetCategory; amount: number }[];
  subtotal: number;
  contingency_amount: number;
  total_estimated: number;
  remaining: number;
  over_budget: boolean;
  overrun_amount: number;
  per_person_total: number;
  daily_spend_allowance: number;
}

export interface ItineraryActivity {
  time_slot: "morning" | "afternoon" | "evening";
  start_time: string;
  title: string;
  description: string;
  location: string;
  estimated_cost: number;
  transport_note: string;
}

export interface DayPlan {
  day: number;
  date: string | null;
  theme: string;
  area_focus: string;
  activities: ItineraryActivity[];
  notes: string[];
  estimated_cost: number;
}

export interface ItineraryPlan {
  days: DayPlan[];
  general_tips: string[];
  total_estimated_cost: number;
  currency: string;
}

export interface CoordinatorSummary {
  headline: string;
  summary: string;
  packing_list: string[];
  local_recommendations: string[];
  safety_reminders: string[];
  cost_saving_suggestions: string[];
  alternative_destinations: string[];
}

export interface ConsistencyFinding {
  level: "info" | "warning";
  message: string;
}

export interface TripOverview {
  destination: string;
  start_date: string | null;
  end_date: string | null;
  days: number;
  travelers: number;
  currency: string;
  budget: number;
  estimated_total: number;
  remaining: number;
  over_budget: boolean;
}

export interface TravelPlan {
  execution_id: string;
  parent_execution_id: string | null;
  refinement_instruction: string | null;
  request: TripRequest;
  overview: TripOverview;
  destination: DestinationResearch;
  budget: BudgetPlan;
  itinerary: ItineraryPlan;
  summary: CoordinatorSummary;
  consistency: ConsistencyFinding[];
  agents_invoked: AgentId[];
  disclaimer: string;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// REST responses (coordinator API)
// ---------------------------------------------------------------------------
export interface AgentSkillInfo {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  description: string;
  role: string;
  url: string;
  card_url: string | null;
  status: "available" | "offline";
  latency_ms: number | null;
  error: string | null;
  protocol_version: string | null;
  streaming: boolean;
  skills: AgentSkillInfo[];
  card: Record<string, unknown> | null;
}

export interface AgentsResponse {
  agents: AgentInfo[];
  checked_at: string;
}

export interface ExecutionCreated {
  execution_id: string;
  access_token: string;
}

export interface ExecutionSnapshot {
  execution_id: string;
  parent_execution_id: string | null;
  kind: "plan" | "refine";
  status: ExecutionStatus;
  created_at: string;
  updated_at: string;
  request: TripRequest;
  refinement_instruction: string | null;
  error: string | null;
  result: TravelPlan | null;
  events: ExecutionEvent[];
}

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";
