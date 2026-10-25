import type { CoachState, GarminWorkout, ProposedSession } from './types';
export type Course = GarminWorkout | ProposedSession;
export const isGarmin = (course: Course): course is GarminWorkout => 'status' in course;
export function coursesFor(state: CoachState, date: string): Course[] {
  const local = state.active_sessions.filter(s => s.date === date);
  const replaced = new Set(local.map(s => s.base_workout_id));
  return [...local, ...state.plan.workouts.filter(s => s.date === date && !replaced.has(s.id))];
}
export function chineseTitle(value: string) {
  return value.replace(/Mountain Running Race/gi, '山地越野赛').replace(/Running Plan/gi, '跑步计划').replace(/Cycling Plan/gi, '骑行计划').replace(/Strength Training/gi, '力量训练').replace(/\((\d+)K\)/g, '（$1公里）');
}
export const phaseNames: Record<string,string> = { BASE: '基础期', BUILD: '提升期', PEAK: '巅峰期', TAPER: '减量期', RECOVERY: '恢复期' };
export function shortDuration(seconds: number) { return `${Math.round(seconds / 60)} 分钟`; }
