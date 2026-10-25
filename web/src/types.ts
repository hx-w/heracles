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
export interface MessageVisual { kind: 'trend' | 'table'; title: string; source: 'garmin'; series: MetricSeries[] }
export interface IllustrationRequest { title: string; subject: string; caption: string }
export interface MessageImage {
  id: string;
  title: string;
  caption: string;
  url: string;
  width: number;
  height: number;
  media_type: string;
  provider: string;
  model: string;
  created_at: string;
}
export interface CoachToolRequest {
  action: 'refresh_data' | 'friends_feed' | 'activity_details' | 'health_details' | 'workout_details';
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
  illustration?: IllustrationRequest | null;
}
export interface Message {
  id?: string | number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  sections?: ReplySection[];
  visuals?: MessageVisual[];
  images?: MessageImage[];
  image_error?: string | null;
  proposal_id?: string;
  proposal_error?: string;
}
export interface CoachStatus {
  available: boolean;
  busy: boolean;
  error: string | null;
  phase?: string | null;
  model?: string | null;
  provider?: string | null;
  session_id?: string | null;
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
  connection: { garmin: boolean; synced_at: string | null; sync_error: string | null };
}
export interface Feedback { message: string; error?: boolean }
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
}
export interface ProposedSession {
  date: string;
  base_workout_id: string | null;
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
}
export interface BodyMetric {
  key: string; label: string; value: number | null; unit: string;
  status: string; source_at: string | null; fetched_at: string | null;
  fresh: boolean;
}
