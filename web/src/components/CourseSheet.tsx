import {useTrainingDialog} from '../hooks/useTrainingDialog';
import { useRef, useId } from 'react';
import type { Exercise, GarminWorkout, GarminWorkoutStep, ProposedSession } from '../types';
import { duration, kindLabels, number, numeric, statusLabels } from '../format';
import { SessionSteps } from './SessionSteps';
import { StepGuide } from './SessionSteps';
import { chineseTitle, isGarmin } from '../training';
import type { Course } from '../training';

const keyFields = ['conditionTypeKey', 'workoutTargetTypeKey', 'stepTypeKey', 'sportTypeKey', 'unitKey'];
function rawKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of keyFields) if (typeof record[field] === 'string') return record[field] as string;
  }
  return '';
}
function rawText(value: unknown): string {
  if (value === null || value === undefined) return '未提供';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return rawKey(value) || JSON.stringify(value);
}
const typeLabels: Record<string, string> = {
  time: '时间', distance: '距离', 'lap.button': '按计圈键结束', lap_button: '按计圈键结束',
  iterations: '重复次数', reps: '次数', repetitions: '次数', 'fixed.repetition': '固定次数', 'fixed.rest': '固定恢复',
  heart_rate: '心率', 'heart.rate.zone': '心率范围', 'heart.rate.lap': '心率目标',
  pace: '配速', 'pace.zone': '配速范围', speed: '速度', 'speed.zone': '速度范围',
  cadence: '步频 / 踏频', power: '功率', 'power.zone': '功率范围', no_target: '无指定目标', 'no.target': '无指定目标',
  warmup: '热身', cooldown: '冷身', interval: '训练', recovery: '恢复', rest: '休息', repeat: '重复',
};
function typeText(value: unknown) {
  const key = rawKey(value);
  return key && typeLabels[key] ? typeLabels[key] : rawText(value);
}
// A total is known only when every leaf is explicitly timed and every repeat count is supplied.
function timedSeconds(step: GarminWorkoutStep): number | null {
  const nested = Array.isArray(step.workoutSteps) ? step.workoutSteps : [];
  if (nested.length) {
    const totals = nested.map(timedSeconds);
    if (totals.some(value => value === null)) return null;
    const repeat = step.numberOfIterations ?? step.repeatValue ?? (rawKey(step.endCondition) === 'iterations' ? step.endConditionValue : null);
    if (!numeric(repeat) || !Number.isInteger(repeat) || repeat < 1) return null;
    return totals.reduce<number>((sum, value) => sum + (value ?? 0), 0) * repeat;
  }
  if (rawKey(step.endCondition) !== 'time' || !numeric(step.endConditionValue) || step.endConditionValue < 0) return null;
  return step.endConditionValue;
}
export function sessionTime(workout: GarminWorkout): { seconds: number; estimate: boolean } | null {
  if (workout.rest_day || workout.kind === 'rest') return null;
  if (workout.detail_status === 'available' && workout.steps.length) {
    const totals = workout.steps.map(timedSeconds);
    if (totals.every(value => value !== null)) return {
      seconds: totals.reduce<number>((sum, value) => sum + (value ?? 0), 0), estimate: false,
    };
  }
  return numeric(workout.duration_seconds) && workout.duration_seconds >= 0
    ? { seconds: workout.duration_seconds, estimate: true } : null;
}
function EndCondition({ step }: { step: GarminWorkoutStep }) {
  const key = rawKey(step.endCondition);
  const value = step.endConditionValue;
  const unit = step.endConditionValueUnit ?? step.endConditionUnit;
  const formatted = key === 'time' && numeric(value) ? duration(value)
    : key === 'distance' && numeric(value) ? `${number(value)} 米`
    : ['iterations', 'reps', 'fixed.repetition'].includes(key) && numeric(value) ? `${number(value)} 次`
    : value == null ? '' : `${rawText(value)} · ${unit != null ? rawText(unit) : '单位未提供'}`;
  return <div><dt>结束条件</dt><dd>{typeText(step.endCondition)}{formatted && ` · ${formatted}`}</dd></div>;
}
function StepTarget({ step, secondary = false }: { step: GarminWorkoutStep; secondary?: boolean }) {
  const prefix = secondary ? 'secondaryTarget' : 'target';
  const type = step[`${prefix}Type`];
  const one = step[`${prefix}ValueOne`];
  const two = step[`${prefix}ValueTwo`];
  const unit = step[`${prefix}ValueUnit`];
  if (secondary && type == null && one == null && two == null) return null;
  const key = rawKey(type);
  const zone = secondary ? step.secondaryZoneNumber : step.zoneNumber;
  let target = '';
  // 佳明 pace.zone values are m/s, not min/km; heart.rate.zone numeric targets are bpm.
  if (key === 'pace.zone' && numeric(one) && numeric(two) && one > 0 && two > 0 && unit == null) {
    const seconds = [Math.round(1000 / one), Math.round(1000 / two)].sort((a, b) => a - b);
    const pace = (value: number) => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
    target = `${pace(seconds[0])} 至 ${pace(seconds[1])} /km`;
  } else if (one != null || two != null) {
    const inferred = key === 'heart.rate.zone' && zone == null ? 'bpm' : key === 'speed.zone' ? 'm/s' : '单位未提供';
    target = `${one != null ? rawText(one) : '下限未提供'}${two != null ? ` 至 ${rawText(two)}` : ''} · ${unit != null ? rawText(unit) : inferred}`;
  }
  return <div><dt>{secondary ? '次要目标' : '目标'}</dt><dd>{typeText(type)}
    {zone != null && ` · 分区 ${rawText(zone)}`}{target && ` · ${target}`}
  </dd></div>;
}
const nativeExercises:Record<string,string>={BARBELL_BENCH_PRESS:'bench-press',CLOSE_GRIP_LAT_PULLDOWN:'lat-pulldown',GOBLET_SQUAT:'goblet-squat',LEG_CURL:'lying-leg-curl',LEG_PRESS:'leg-press',PLANK:'plank',ROMANIAN_DEADLIFT:'romanian-deadlift',SEATED_CABLE_ROW:'seated-cable-row',INCLINE_DUMBBELL_BENCH_PRESS:'incline-dumbbell-press',DUMBBELL_HAMMER_CURL:'hammer-curl',ROW:'machine-row'};
function WorkoutSteps({ steps, exercises=[] }: { steps: GarminWorkoutStep[];exercises?:Exercise[] }) {
  return <ol className="workout-steps" aria-label="佳明 原始训练步骤">
    {steps.map((step, index) => {
      const nested = Array.isArray(step.workoutSteps) ? step.workoutSteps : [];
      const title = step.stepName ?? step.exerciseName ?? step.description ?? step.stepType;
      const exercise=exercises.find(ex=>ex.id===nativeExercises[rawKey(step.exerciseName)]);
      const repeat = step.numberOfIterations ?? step.repeatValue ?? (rawKey(step.endCondition) === 'iterations' ? step.endConditionValue : null);
      return <li key={index}>
        <div className="step-heading"><h4>{exercise?.name||(title != null ? typeText(title) : `步骤 ${index + 1}`)}</h4>
          {nested.length > 0 && <span className="step-time">{repeat != null ? `重复 ${rawText(repeat)} 次` : '重复次数未提供'}</span>}
        </div>
        <dl className="training-targets"><EndCondition step={step} /><StepTarget step={step} /><StepTarget step={step} secondary /></dl>
        {typeof step.description === 'string' && step.description !== title && <p className="prose">{step.description}</p>}
        {exercise&&<StepGuide exercise={exercise}/>}
        {nested.length > 0 && <WorkoutSteps steps={nested} exercises={exercises}/>}
      </li>;
    })}
  </ol>;
}
function WorkoutDetails({ workout,exercises }: { workout: GarminWorkout;exercises?:Exercise[] }) {
  const time = sessionTime(workout);
  const rest = workout.rest_day || workout.kind === 'rest';
  return <article className="training-course" aria-label={workout.title}>
    <div className="training-session-heading"><h3>{chineseTitle(workout.title) || kindLabels[workout.kind]}</h3>
      <p>{kindLabels[workout.kind]} · {statusLabels[workout.status]}</p>
    </div>
    <dl className="training-targets">
      {!rest && <div><dt>时长</dt><dd>{time ? `${time.estimate ? '佳明 预计' : '已知时间步骤合计'} ${duration(time.seconds)}` : '佳明 未提供时长'}
        {time && !time.estimate && workout.duration_seconds !== null && <span className="training-secondary-value">佳明 预计 {duration(workout.duration_seconds)}</span>}</dd></div>}
      {workout.training_effect && <div><dt>训练作用</dt><dd>{workout.training_effect}</dd></div>}
      {workout.priority && <div><dt>优先级</dt><dd>{workout.priority}</dd></div>}
    </dl>
    {workout.description && <section className="training-description"><h4>佳明 课程说明</h4><p className="prose">{workout.description}</p></section>}
    {rest && <p className="training-rest">佳明 安排的休息日，不添加训练步骤。</p>}
    {!rest && <>
      {workout.detail_status === 'error' && <p className="feedback is-error" role="status">详细步骤读取失败：{workout.detail_error || '佳明 暂未返回详情'}。以下保留已有数据。</p>}
      {workout.detail_status !== 'available' && workout.detail_status !== 'error' && <p className="training-chart-note">目前只有 佳明 课程摘要，不是完整训练步骤。未提供的目标范围与热身、恢复安排不会补写。</p>}
      {workout.steps.length > 0 ? <section className="training-step-section"><h4>佳明 训练步骤</h4><WorkoutSteps steps={workout.steps} exercises={exercises}/></section>
        : workout.detail_status === 'available' && <p className="training-chart-note">佳明 详情中未提供训练步骤。</p>}
    </>}
  </article>;
}

export function CourseSheet({ course, onClose, askCoach, exercises }: { course: Course | null; onClose: () => void; askCoach?:(text:string)=>void; exercises?:Exercise[] }) {
 const titleId=useId();const dialog=useRef<HTMLDialogElement>(null);
 useTrainingDialog(dialog,Boolean(course));
 return <dialog ref={dialog} className="training-drawer course-sheet" aria-labelledby={titleId} onClose={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose()}}><div className="drawer-content"><header className="drawer-header"><h2 id={titleId}>课程详情</h2><button onClick={onClose} className="text-button" aria-label="关闭课程详情" autoFocus>关闭</button></header>{course&&(isGarmin(course)?<WorkoutDetails workout={course} exercises={exercises}/>:<><h3 className="course-sheet-name">{course.title}</h3><p className="course-sheet-reason">{course.reason}</p><SessionSteps session={course as ProposedSession} exercises={exercises}/></>)}{course&&askCoach&&<button className="primary sheet-primary" onClick={()=>{onClose();askCoach(`请帮我评估并细化 ${course.date} 的课程“${course.title}”${isGarmin(course)?`（佳明课程编号${course.id}）`:`（已采用的本站课程编号${course.local_id}）`}，结合实际训练和身体历史变化，需要调整时给出待确认方案。`)}}>请教练评估这堂课</button>}</div></dialog>
}
