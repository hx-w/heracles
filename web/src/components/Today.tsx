import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { CheckInInput } from '../types';
import { dateLabel, duration, kindLabels } from '../format';
import { Reveal } from './motion/Reveal';
import { ProposalCard, SessionSteps } from './ProposalCard';

export function Today({ controller, active, askCoach, openStrength }: { controller: CoachController; active: boolean; askCoach: (message: string) => void; openStrength: () => void }) {
  const { state, actionBusy, saveCheckIn, planFeedback } = controller;
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<CheckInInput>({ fatigue: 3, soreness: 'none', available_minutes: 40, notes: '' });
  useEffect(() => {
    if (!dirty && state?.checkin) {
      const { fatigue, soreness, available_minutes, notes } = state.checkin;
      setDraft({ fatigue, soreness, available_minutes, notes });
    }
  }, [state?.checkin, dirty]);
  function update(patch: Partial<CheckInInput>) { setDraft(current => ({ ...current, ...patch })); setDirty(true); setSaved(false); }
  async function submit(event: FormEvent, coach = false) {
    event.preventDefault();
    if (await saveCheckIn(draft)) {
      setDirty(false); setSaved(true); setEditing(false);
      if (coach) askCoach('我已更新今天的状态。请结合我的疲劳、疼痛反馈、可用时间和佳明数据，评估今天的训练；需要调整时给出包含热身、主训练、恢复、冷身和停止条件的具体方案，等我确认。');
    }
  }
  const todayWorkouts = state?.plan.workouts.filter(w => w.date === state.today) || [];
  const adjusted = state?.active_sessions.filter(w => w.date === state.today) || [];
  const replaced = new Set(adjusted.map(w => w.base_workout_id));
  const original = todayWorkouts.filter(w => !replaced.has(w.id));
  const pending = state?.proposals.filter(p => p.status === 'pending') || [];
  const currentPhase = state?.plan.phases.find(p => p.current);
  return <section id="today" className={`panel today-panel${active ? ' is-active' : ''}`} aria-labelledby="today-heading">
    <div className="day-heading"><p>{state ? dateLabel(state.today) : 'Heracles'}<span> / </span>每一步，都有回应</p><h1 id="today-heading">今天，按你的节奏。</h1></div>
    <div className="today-section-title"><h2>今天怎么练</h2><a href="#plan">完整计划 <span aria-hidden="true">↗</span></a></div>
    {state?.plan.status === 'error' && <p className="sync-warning" role="status">佳明同步未成功，以下是上次的记录。同步后再调整训练。</p>}
    {controller.syncFeedback.message && <p className={`feedback${controller.syncFeedback.error ? ' is-error' : ''}`} role="status">{controller.syncFeedback.message}</p>}
    {state && !state.connection.garmin && <p className="connection-help">还未连接佳明。在服务器完成一次账号登录后，点击顶部同步。<a href="https://github.com/hx-w/heracles#连接佳明" target="_blank" rel="noreferrer">查看连接方法 ↗</a></p>}
    <Reveal><div className="today-sessions">
      {adjusted.map((session, index) => <article className="today-workout adjusted-workout" key={index}>
        <div className="workout-eyebrow"><span>Heracles · 已采用</span><span>{kindLabels[session.kind] || session.sport || '其他训练'}</span></div><h2>{session.title}</h2><p>{session.reason}</p>
        <details><summary>查看执行步骤 <span aria-hidden="true">↓</span></summary><SessionSteps session={session} /></details>
        <a href="#plan">查看调整与撤销</a>
      </article>)}
      {original.map((workout, index) => <article className="today-workout" key={`${workout.id}-${index}`}>
        <div className="workout-eyebrow"><span>GARMIN COACH</span><span>{workout.status === 'completed' ? '已完成' : workout.rest_day ? '休息' : kindLabels[workout.kind]}</span></div>
        <h2>{workout.title}</h2>{workout.duration_seconds !== null && <p className="workout-duration">{duration(workout.duration_seconds)}<span>佳明预计</span></p>}
        {workout.description && <p className="workout-description">{workout.description}</p>}
        <div className="workout-footer"><span>{currentPhase?.training_phase || '以原计划为起点'}</span><a href="#plan">训练详情 <span aria-hidden="true">↗</span></a></div>
      </article>)}
      {!adjusted.length && !original.length && <article className="today-workout empty-workout"><div className="workout-eyebrow"><span>YOUR NEXT SESSION</span></div><h2>{state ? '从你的目标开始' : '正在连接私人教练'}</h2><p>{state ? '今天还没有可用的课程。连接佳明，或告诉教练你的目标、经验与时间，一起制定详细计划。' : '正在读取训练安排与身体状态。'}</p><button className="primary" disabled={!state || actionBusy} onClick={() => askCoach('请根据我的目标、运动经验、每周可用天数和佳明数据，为我制定未来七天的详细训练方案。缺少关键信息时先问我，不猜测能力。')}>和教练制定计划 <span aria-hidden="true">↗</span></button></article>}
    </div></Reveal>
    <button className="coach-entry" disabled={!state || actionBusy} onClick={() => askCoach('请结合我的佳明原课、已采用的方案和近期身体状态，判断今天怎么练，并解释训练目的、执行要点与调整条件。')}><span className="coach-glyph" aria-hidden="true">✳</span><span><strong>计划之外，也有教练</strong><small>只有 20 分钟？睡得不好？随时聊聊。</small></span><span aria-hidden="true">↗</span></button>
    <div className="training-shortcuts" aria-label="训练与教练操作"><button disabled={!state || actionBusy} onClick={() => askCoach('请复盘我最近一次实际训练，结合佳明原计划、实际活动详情与恢复状态，说明做得好的地方、可以改善的地方和后续注意事项。')}><span>训练复盘</span><small>用实际记录说话 ↗</small></button><button disabled={!state || actionBusy} onClick={() => askCoach('我临时有事，想调整接下来一段时间的佳明主线执行安排。请先问清具体日期和可用时间，再给出有差异说明的临时方案。')}><span>调整安排</span><small>改期、减量、恢复 ↗</small></button><button disabled={!state || actionBusy} onClick={() => askCoach('我想在当前佳明主线中加入一次专项训练，可能是间歇、骑车或长距离低强度训练。请先确认我的具体想法、日期与可用时间，再考虑同日和后续负荷提出方案。')}><span>加一堂训练</span><small>专项、骑车、LSD ↗</small></button><button disabled={!state} onClick={openStrength}><span>力量训练</span><small>打卡、动作与器材 ↗</small></button></div>
    <section className="readiness-section" aria-labelledby="body-heading"><div className="today-section-title"><h2 id="body-heading">身体的声音</h2><span>{state?.connection.synced_at ? `${dateLabel(state.connection.synced_at, true)} 读取` : '佳明记录'}</span></div>
      <div className="body-metrics">{['sleep_hours', 'hrv', 'readiness', 'recovery_hours'].map(key => {
        const metric = state?.metrics.find(m => m.key === key);
        const names: Record<string, string> = { sleep_hours: '睡眠', hrv: '夜间 HRV', readiness: '训练准备度', recovery_hours: '恢复时间' };
        return <div className="body-metric" key={key}><span>{names[key]}</span><strong>{metric?.value != null ? metric.value : '暂无'}<small>{metric?.value != null ? metric.unit : ''}</small></strong><span className="metric-age">{metric?.value != null ? metric.fresh ? '近期有效记录' : `历史 · ${metric.source_at ? dateLabel(metric.source_at) : '测量时间未提供'}` : '等待设备数据'}</span></div>;
      })}</div>
    </section>
    {Boolean(state?.activities.length) && <section className="activity-section" aria-labelledby="activity-heading"><div className="today-section-title"><h2 id="activity-heading">最近的训练</h2><span>佳明活动</span></div><div className="activity-list">{state?.activities.slice(0, 3).map(activity => <button type="button" className="activity-row" key={activity.id} disabled={actionBusy} onClick={() => askCoach(`请分析佳明活动 ${activity.id}（${activity.name}），结合详细分段和心率说明执行情况、恢复需求以及对后续计划的影响。`)}><span className="activity-date">{activity.date ? dateLabel(activity.date) : '日期缺失'}</span><span className="activity-body"><strong>{activity.name}</strong><small>{activity.distance_km !== null ? `${activity.distance_km} km · ` : ''}{activity.duration_minutes !== null ? `${activity.duration_minutes} 分钟` : ''}{activity.pace ? ` · ${activity.pace}` : ''}</small></span><span aria-hidden="true">↗</span></button>)}</div></section>}
    <section className="checkin-section" aria-labelledby="checkin-heading"><div className="today-section-title"><h2 id="checkin-heading">你的感觉，同样重要</h2>{state?.checkin && <button className="text-button" onClick={() => setEditing(!editing)}>{editing ? '收起' : '更新状态'}</button>}</div>
      {state?.checkin && !editing ? <div className="checkin-saved"><p>疲劳 {state.checkin.fatigue}/5 · {state.checkin.available_minutes} 分钟可用 · {state.checkin.soreness === 'pain' ? '有疼痛' : state.checkin.soreness === 'mild' ? '轻微酸痛' : '没有不适'}</p>{state.checkin.notes && <p>{state.checkin.notes}</p>}<small>{saved ? '刚刚记录' : '今天已记录'}</small><button className="quiet" disabled={actionBusy} onClick={() => askCoach('请结合我今天的状态反馈和佳明数据评估训练，必要时提出详细的临时调整方案。')}>请教练评估今天</button></div> : <form className="checkin-form" onSubmit={event => void submit(event)}>
        <fieldset disabled={!state || actionBusy}><legend className="sr-only">今天的主观状态</legend>
          <label>现在有多疲劳？<span className="label-hint">1 很轻松 · 5 很疲惫</span></label><div className="fatigue-options" role="group" aria-label="疲劳程度">{[1, 2, 3, 4, 5].map(value => <button type="button" key={value} aria-pressed={draft.fatigue === value} onClick={() => update({ fatigue: value })}>{value}</button>)}</div>
          <div className="checkin-fields"><div><label htmlFor="available-minutes">今天有多少时间</label><div className="minutes-input"><input id="available-minutes" type="number" inputMode="numeric" min={5} max={240} required value={draft.available_minutes} onChange={event => update({ available_minutes: Number(event.target.value) })} /><span>分钟</span></div></div><div><label htmlFor="soreness">身体有不适吗</label><select id="soreness" value={draft.soreness} onChange={event => update({ soreness: event.target.value as CheckInInput['soreness'] })}><option value="none">没有不适</option><option value="mild">轻微酸痛</option><option value="pain">有疼痛</option></select></div></div>
          <label className="sr-only" htmlFor="checkin-notes">其他情况</label><textarea id="checkin-notes" rows={2} maxLength={500} placeholder="还有什么想让教练知道？比如昨晚加班、今天出差。" value={draft.notes} onChange={event => update({ notes: event.target.value })} />
        </fieldset><div className="checkin-actions"><button type="submit" className="quiet" disabled={!state || actionBusy}>记录状态</button><button type="button" className="primary" disabled={!state || actionBusy} onClick={event => { if (event.currentTarget.form?.reportValidity()) void submit(event, true); }}>记录并让教练调整 ↗</button></div>
      </form>}
    </section>
    {pending.length > 0 && <section className="today-proposals"><div className="today-section-title"><h2>教练的新方案</h2><span>{pending.length} 份待确认</span></div>{pending.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} controller={controller} />)}</section>}
    {planFeedback.message && <p className={`feedback${planFeedback.error ? ' is-error' : ''}`} role="status">{planFeedback.message}</p>}
    <footer className="today-footnote"><p>大力神也有恢复日。</p><span>每 {Math.round((state?.connection.poll_seconds || 300) / 60)} 分钟读取佳明云端 · 设备上传后可同步</span></footer>
  </section>;
}
