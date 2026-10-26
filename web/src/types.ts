export type GarminWorkoutStatus = 'planned' | 'completed' | 'skipped' | 'unknown';
export type GarminWorkoutKind = 'rest' | 'running' | 'cycling' | 'strength' | 'other';
export interface GarminWorkoutStep {
  [key: string]: unknown;
  workoutSteps?: GarminWorkoutStep[];
}
export interface GarminWorkout {
  id: string;
  plan_id: string;
  date: string;
  title: string;
  kind: GarminWorkoutKind;
  sport: string | null;
  duration_seconds: number | null;
  description: string | null;
  status: GarminWorkoutStatus;
  garmin_status: string | null;
  training_effect: string | null;
  priority: string | null;
  rest_day: boolean;
  detail_status: 'available' | 'summary' | 'error' | 'not_applicable';
  detail_error: string | null;
  steps: GarminWorkoutStep[];
}
export interface GarminPlanMetadata {
  id: string;
  name: string;
  category: string;
  status: string;
  sport: string;
  start_date: string | null;
  end_date: string | null;
}
export interface GarminPlanPhase {
  plan_id: string;
  start_date: string;
  end_date: string;
  training_phase: string;
  current: boolean;
}
export interface TrainingPlan {
  source: 'garmin';
  status: 'available' | 'missing' | 'error';
  sync_error: string | null;
  fetched_at: string | null;
  updated_at: string | null;
  name: string | null;
  plans: GarminPlanMetadata[];
  phases: GarminPlanPhase[];
  workouts: GarminWorkout[];
}
export interface Profile {
  goal: string;
  target_date: string | null;
  weekly_days: number;
  experience: string;
  notes: string;
}
export interface ReplySection { title: string; items: string[] }
export type MetricKey = 'resting_hr' | 'sleep_hours' | 'sleep_score' | 'hrv' | 'readiness' | 'recovery_hours' | 'stress' | 'acute_load' | 'respiration' | 'spo2' | 'steps' | 'body_battery_peak';
export interface MetricPoint {
  date: string;
  value: number | null;
  status: 'available' | 'missing' | 'error';
  source_at: string | null;
  fetched_at: string | null;
}
export interface MetricSeries {
  key: MetricKey;
  label: string;
  unit: string;
  description: string;
  points: MetricPoint[];
}
export interface VisualRequest { kind: 'trend' | 'table'; title: string; metrics: MetricKey[] }
export interface MessageVisual { period_days?: number; kind: 'trend' | 'table'; title: string; source: 'garmin'; series: MetricSeries[] }
export interface CoachToolRequest {
  action: 'refresh_data' | 'activity_details' | 'health_details' | 'workout_details';
  activity_id?: string | null;
  workout_id?: string | null;
  date?: string | null;
  source?: string | null;
  metrics?: string[] | null;
  start_at?: string | null;
  end_at?: string | null;
}
export interface CoachReply {
  summary: string;
  sections: ReplySection[];
  profile_update: Profile | null;
  tool_requests: CoachToolRequest[];
  visuals?: VisualRequest[];
}
export interface Message {
  id?: string | number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  sections?: ReplySection[];
  comparisons?: {title: string; items: {label: string; before: string; after: string}[]}[];
  actions?: {title: string; when: string; steps: string[]}[];
  highlights?: {label: string; text: string; kind: 'result' | 'action' | 'attention'}[];
  visuals?: MessageVisual[];
  exercises?: Exercise[];
  proposal_id?: string;
  proposal_error?: string;
}
export interface CoachStatus {
  revision?:number;
  available: boolean;
  busy: boolean;
  error: string | null;
  phase?: string | null;
}
export interface CoachState {
  today: string;
  timezone: string;
  profile: Profile;
  plan: TrainingPlan;
  messages: Message[];
  coach: CoachStatus;
  syncing: boolean;
  checkin: CheckIn | null;
  proposals: Proposal[];
  active_sessions: ProposedSession[];
  metrics: BodyMetric[];
  health_history: Partial<Record<MetricKey, MetricSeries>>;
  health_changes: HealthChange[];
  connection: { garmin: boolean; synced_at: string | null; sync_error: string | null; poll_seconds: number };
  training_logs: TrainingLog[];
  exercise_catalog: Exercise[];
  exports: {id: string; proposal_id: string; status: string; note: string; error?: string}[];
  export_cleanup?: ExportCleanup[];
  activities: ActivityRecord[];
}
export interface Feedback { message: string; error?: boolean }
export interface ExportCleanup {receipt_id:string;workout_id:string;date:string;title:string;proposal_id:string;confirmation:string;removal_status?:string|null}
export interface Accepted { accepted: boolean }

export interface CheckInInput {
  fatigue: number;
  soreness: 'none' | 'mild' | 'pain';
  available_minutes: number;
  notes: string;
}
export interface CheckIn extends CheckInInput { date: string; updated_at: string }
export interface TrainingStep {
  phase: 'warmup' | 'work' | 'recovery' | 'cooldown';
  title: string;
  duration_seconds: number | null;
  distance_meters: number | null;
  repeat: number;
  target: string;
  instructions: string;
  exercise_id?: string | null;
  sets?: number | null;
  reps?: string | null;
  load_kg?: number | null;
  rest_seconds?: number | null;
}
export interface ProposedSession {
  date: string;
  base_workout_id: string | null;
  base_local_id?: string | null;
  local_id?: string;
  previous_session?: ProposedSession | null;
  operation?: 'add' | 'replace';
  sport?: string | null;
  title: string;
  kind: GarminWorkoutKind;
  reason: string;
  steps: TrainingStep[];
  stop_conditions: string;
  baseline?: GarminWorkout | null;
  state?: 'active' | 'superseded';
  invalid_reason?: string | null;
  proposal_id?: string;
}
export interface Proposal {
  id: string;
  title: string;
  rationale: string;
  sessions: ProposedSession[];
  status: 'pending' | 'active' | 'dismissed' | 'reverted' | 'superseded' | 'stale';
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
  export_issues?: {local_id?:string;title?:string;reason:string}[];
}
export interface BodyMetric {
  key: string; label: string; value: number | null; unit: string;
  status: string; source_at: string | null; fetched_at: string | null;
  fresh: boolean;
  data_date?:string|null;
}

export interface Exercise {
  id: string; name: string; equipment: string; muscles: string;
  setup: string; steps: string[]; mistakes: string[];
  image: string | null; video: string | null; animation?: string | null;
  credits?: { kind: string; author: string; license: string; license_url: string; source_url: string }[];
  source_url: string; source_name: string;
  license: string; license_url: string; author: string;
}
export interface TrainingSet { exercise_id: string; exercise_name: string; reps: number; load_kg: number }
export interface TrainingLog { id: string; date: string; title: string; kind: string; sets: TrainingSet[]; effort: number; notes: string; created_at?: string; source?: string }

export interface HealthChange { key: MetricKey; label: string; unit: string; current: number; date: string; previous: number | null; previous_date: string | null; delta: number | null; baseline_mean: number | null; baseline_days: number }

export interface ActivityRecord { id: number|string; date: string|null; name: string; sport: string; distance_km: number|null; duration_minutes: number|null; pace: string|null; average_hr?:number|null; max_hr?:number|null; elevation_gain?:number|null; calories?:number|null; average_speed_kmh?:number|null; route_points?:[number,number][] }
