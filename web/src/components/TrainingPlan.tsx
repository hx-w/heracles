import { useState } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { GarminWorkout, GarminWorkoutStep, TrainingPlan as Plan } from '../types';
import { dateLabel, dateValue, duration, kindLabels, number, numeric, statusLabels } from '../format';
import { ProposalCard, SessionSteps } from './ProposalCard';
import { GoalForm } from './GoalForm';
import './training.css';

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
  time: '时间', distance: '距离', 'lap.button': '按 Lap 键结束', lap_button: '按 Lap 键结束',
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
function sessionTime(workout: GarminWorkout): { seconds: number; estimate: boolean } | null {
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
function TimeBar({ workout, scale }: { workout: GarminWorkout; scale: number }) {
  const time = sessionTime(workout);
  if (!time) return <span className="training-no-bar">{workout.rest_day || workout.kind === 'rest' ? 'Garmin 安排休息' : '时长未提供'}</span>;
  const label = `${time.estimate ? 'Garmin 预计' : '已知时间步骤合计'} ${duration(time.seconds)}`;
  return <><span className="training-timeline" role="img" aria-label={label}>
    <span className={`training-phase ${time.estimate ? 'phase-estimate' : 'phase-known'}`} style={{ width: `${time.seconds / scale * 100}%` }} />
  </span><span className="training-row-minutes">{label}</span></>;
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
  // Garmin pace.zone values are m/s, not min/km; heart.rate.zone numeric targets are bpm.
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
function WorkoutSteps({ steps }: { steps: GarminWorkoutStep[] }) {
  return <ol className="workout-steps" aria-label="Garmin 原始训练步骤">
    {steps.map((step, index) => {
      const nested = Array.isArray(step.workoutSteps) ? step.workoutSteps : [];
      const title = step.stepName ?? step.exerciseName ?? step.description ?? step.stepType;
      const repeat = step.numberOfIterations ?? step.repeatValue ?? (rawKey(step.endCondition) === 'iterations' ? step.endConditionValue : null);
      return <li key={index}>
        <div className="step-heading"><h4>{title != null ? typeText(title) : `步骤 ${index + 1}`}</h4>
          {nested.length > 0 && <span className="step-time">{repeat != null ? `重复 ${rawText(repeat)} 次` : '重复次数未提供'}</span>}
        </div>
        <dl className="training-targets"><EndCondition step={step} /><StepTarget step={step} /><StepTarget step={step} secondary /></dl>
        {typeof step.description === 'string' && step.description !== title && <p className="prose">{step.description}</p>}
        {nested.length > 0 && <WorkoutSteps steps={nested} />}
        <details className="training-raw"><summary>Garmin 步骤字段</summary><pre>{JSON.stringify(step, null, 2)}</pre></details>
      </li>;
    })}
  </ol>;
}
function WorkoutDetails({ workout, plan }: { workout: GarminWorkout; plan: Plan }) {
  const metadata = plan.plans.find(item => item.id === workout.plan_id);
  const time = sessionTime(workout);
  const rest = workout.rest_day || workout.kind === 'rest';
  return <article className="training-course" aria-label={workout.title}>
    <div className="training-session-heading"><h3>{workout.title || kindLabels[workout.kind]}</h3>
      <p>{kindLabels[workout.kind]}{workout.sport ? ` · ${workout.sport}` : ''} · {statusLabels[workout.status]}{workout.garmin_status ? ` (${workout.garmin_status})` : ''}</p>
      {metadata && <p>计划：{metadata.name}</p>}
    </div>
    <dl className="training-targets">
      {!rest && <div><dt>时长</dt><dd>{time ? `${time.estimate ? 'Garmin 预计' : '已知时间步骤合计'} ${duration(time.seconds)}` : 'Garmin 未提供时长'}
        {time && !time.estimate && workout.duration_seconds !== null && <span className="training-secondary-value">Garmin 预计 {duration(workout.duration_seconds)}</span>}</dd></div>}
      {workout.training_effect && <div><dt>训练作用</dt><dd>{workout.training_effect}</dd></div>}
      {workout.priority && <div><dt>优先级</dt><dd>{workout.priority}</dd></div>}
    </dl>
    {workout.description && <section className="training-description"><h4>Garmin 课程说明</h4><p className="prose">{workout.description}</p></section>}
    {rest && <p className="training-rest">Garmin 安排的休息日，不添加训练步骤。</p>}
    {!rest && <>
      {workout.detail_status === 'error' && <p className="feedback is-error" role="status">详细步骤读取失败：{workout.detail_error || 'Garmin 暂未返回详情'}。以下保留已有数据。</p>}
      {workout.detail_status !== 'available' && workout.detail_status !== 'error' && <p className="training-chart-note">目前只有 Garmin 课程摘要，不是完整训练步骤。未提供的目标范围与热身、恢复安排不会补写。</p>}
      {workout.steps.length > 0 ? <section className="training-step-section"><h4>Garmin 训练步骤</h4><WorkoutSteps steps={workout.steps} /></section>
        : workout.detail_status === 'available' && <p className="training-chart-note">Garmin 详情中未提供训练步骤。</p>}
    </>}
  </article>;
}
function weekDates(today: string) {
  const start = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}
function PlanMetadata({ plan, timezone }: { plan: Plan; timezone: string }) {
  return <section className="training-metadata" aria-labelledby="garmin-plan-heading">
    <div className="training-section-heading"><h2 id="garmin-plan-heading">{plan.name || 'Garmin 训练计划'}</h2><span className="training-source">Garmin 中国 · 原始计划</span></div>
    {plan.status === 'error' && <p className="feedback is-error" role="status">Garmin 同步失败：{plan.sync_error || '未返回错误详情'}。{plan.fetched_at ? '以下保留上次成功同步的数据，可能已过时。' : '尚无可用的同步数据。'}</p>}
    {plan.status === 'missing' && <p className="empty">Garmin 尚未返回训练计划。请在 Connect 中查看或设置计划，再同步。</p>}
    <p className="training-chart-note">上次成功读取：{plan.fetched_at ? dateLabel(plan.fetched_at, true, timezone) : '尚未成功同步'}{plan.updated_at ? ` · 计划记录更新：${dateLabel(plan.updated_at, true, timezone)}` : ''}</p>
    {plan.plans.map(metadata => <article key={metadata.id} className="training-plan-record">
      <h3>{metadata.name}</h3><p className="training-chart-note">{[metadata.sport, metadata.category, metadata.status].filter(Boolean).join(' · ')}</p>
      {(metadata.start_date || metadata.end_date) && <p className="training-chart-note">{metadata.start_date || '开始日期未提供'} 至 {metadata.end_date || '结束日期未提供'}</p>}
      {plan.phases.some(phase => phase.plan_id === metadata.id) && <ul className="training-phases" aria-label={`${metadata.name} 训练周期`}>
        {plan.phases.filter(phase => phase.plan_id === metadata.id).map((phase, index) => <li key={index} className={phase.current ? 'is-current' : ''}>
          <span>{phase.training_phase}{phase.current ? ' · 当前阶段' : ''}</span><span>{phase.start_date} 至 {phase.end_date}</span>
        </li>)}
      </ul>}
    </article>)}
    <p className="training-chart-note">佳明原计划持续保留。Heracles 调整独立保存；可另行确认导出独立课程到佳明课程库，不会改写自适应计划。</p>
  </section>;
}
export function TrainingPlan({ controller, active }: { controller: CoachController; active: boolean }) {
  const { state, syncBusy, syncFeedback, syncGarmin, loadError } = controller;
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const plan = state?.plan;
  const dates = state ? weekDates(state.today) : [];
  const selected = selectedDate && dates.includes(selectedDate) ? selectedDate : state?.today;
  const workouts = plan?.workouts || [];
  const visible = workouts.filter(item => dates.includes(item.date));
  const activeSessions = state?.active_sessions || [];
  const localSelected = activeSessions.filter(item => item.date === selected);
  const replaced = new Set(localSelected.map(item => item.base_workout_id));
  const selectedWorkouts = workouts.filter(item => item.date === selected && !replaced.has(item.id));
  const scale = Math.max(60, ...visible.map(item => sessionTime(item)?.seconds || 0));
  return <section id="plan" className={`panel training-plan${active ? ' is-active' : ''}`} aria-labelledby="plan-heading">
    <div className="section-heading"><h1 id="plan-heading">训练计划</h1><button type="button" className="quiet" disabled={!state || syncBusy} onClick={() => void syncGarmin()}>{syncBusy ? '同步中…' : '同步 Garmin'}</button></div>
    <p className={`feedback training-sync-feedback${syncFeedback.error ? ' is-error' : ''}`} role="status" aria-live="polite">{syncFeedback.message}</p>
    {state?.proposals.filter(p => ['pending', 'active'].includes(p.status)).map(proposal => <ProposalCard key={proposal.id} proposal={proposal} controller={controller} />)}
    {controller.planFeedback.message && <p className={`feedback${controller.planFeedback.error ? ' is-error' : ''}`} role="status">{controller.planFeedback.message}</p>}
    {plan && state ? <PlanMetadata plan={plan} timezone={state.timezone} /> : <p className="empty">{loadError ? '计划尚未读取，请检查连接后重试。' : '正在读取 Garmin 计划…'}</p>}
    <section className="training-week" aria-labelledby="week-heading">
      <div className="training-section-heading"><h2 id="week-heading">未来七日</h2>{state && <span className="training-week-total">{visible.filter(item => !item.rest_day && item.kind !== 'rest').length} 个佳明原课</span>}</div>
      <p className="training-chart-note">从今天开始，优先显示已采用的 Heracles 调整。佳明原课在方案对比中保留。未发布课程不代表休息日。</p>
      {visible.some(item => sessionTime(item)) && <div className="training-week-axis" aria-hidden="true"><span>0</span><span>{number(scale / 120, 1)}</span><span>{number(scale / 60, 1)} 分钟</span></div>}
      <div className="training-week-chart" aria-label="七日 Garmin 课程，选择日期查看详情">
        {dates.map(date => {
          const local = activeSessions.filter(item => item.date === date);
          const replacedIds = new Set(local.map(item => item.base_workout_id));
          const daily = workouts.filter(item => item.date === date && !replacedIds.has(item.id));
          return <button type="button" key={date} className="training-date-row" aria-pressed={date === selected} aria-controls="selected-training" onClick={() => setSelectedDate(date)}
            aria-label={`${dateLabel(date, false, state?.timezone)}${date === state?.today ? ' 今天' : ''}，${daily.length || local.length ? [...daily, ...local].map(item => `${item.title}，${'status' in item ? statusLabels[item.status] : 'Heracles 已采用'}`).join('；') : 'Garmin 未返回课程'}，查看详情`}>
            <span className="training-date-label"><strong>{date === state?.today ? '今天' : dateValue(date)?.toLocaleDateString('zh-CN', { timeZone: state?.timezone, weekday: 'short' })}</strong><span>{date.slice(5)}</span></span>
            <span className="training-date-content">{local.map((item, index) => <span className="training-day-course" key={`local-${index}`}><span className="training-row-heading"><span>{item.title}</span><span>Heracles · 已采用</span></span><span className="training-row-minutes">{item.kind === 'rest' ? '休息 / 恢复' : item.steps.every(step => step.duration_seconds != null) ? `步骤合计 ${duration(item.steps.reduce((sum, step) => sum + (step.duration_seconds || 0) * (step.repeat || 1) * (step.sets || 1) + (step.rest_seconds || 0) * ((step.repeat || 1) * (step.sets || 1) - 1), 0))}` : '按步骤中的时间与距离执行'}</span></span>)}{daily.length ? daily.map((item, index) => <span className="training-day-course" key={`${item.id}-${index}`}>
              <span className="training-row-heading"><span>{item.title || kindLabels[item.kind]}</span><span>{statusLabels[item.status]}</span></span><TimeBar workout={item} scale={scale} />
            </span>) : !local.length && <span className="training-no-bar">Garmin 未返回课程，非休息记录</span>}</span>
          </button>;
        })}
        {!state && <p className="empty">{loadError ? '尚未读取课程' : '正在读取课程…'}</p>}
      </div>
      <ul className="training-legend" aria-label="时长图例"><li><i className="phase-known" aria-hidden="true" />完整时间步骤合计</li><li><i className="phase-estimate" aria-hidden="true" />Garmin 预计时长，非步骤时长</li></ul>
    </section>
    <section id="selected-training" className="training-selected" aria-labelledby="selected-heading">
      <div className="training-section-heading"><h2 id="selected-heading">{selected === state?.today ? '今日课程' : '所选日期课程'}</h2>{selected && <time dateTime={selected}>{dateLabel(selected, false, state?.timezone)}</time>}</div>
      {localSelected.map((session, index) => <article className="training-course" key={`local-${index}`}><div className="training-session-heading"><p>Heracles · 已采用</p><h3>{session.title}</h3><p>{session.reason}</p></div><SessionSteps session={session} /></article>)}
      {selectedWorkouts.length && plan ? selectedWorkouts.map((workout, index) => <WorkoutDetails key={`${workout.id}-${index}`} workout={workout} plan={plan} />)
        : !localSelected.length && <p className="empty">{state ? 'Garmin 未返回这一天的课程，不推定为休息日。' : loadError ? '尚未读取课程' : '正在读取课程…'}</p>}
    </section>
    <GoalForm controller={controller} />
    {Boolean(state?.proposals.some(p => !['pending', 'active'].includes(p.status))) && <details className="proposal-history"><summary>过去的调整</summary>{state?.proposals.filter(p => !['pending', 'active'].includes(p.status)).map(proposal => <ProposalCard key={proposal.id} proposal={proposal} controller={controller} />)}</details>}
  </section>;
}
