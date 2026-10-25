import { useState } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { Course } from '../training';
import { chineseTitle, coursesFor, isGarmin, phaseNames, shortDuration } from '../training';
import { dateLabel, dateValue, kindLabels, statusLabels } from '../format';
import { ProposalCard } from './ProposalCard';
import { GoalForm } from './GoalForm';
import { CourseSheet, sessionTime } from './CourseSheet';
import './training.css';
function datesFrom(today: string) { const d=new Date(`${today}T12:00:00Z`);return Array.from({length:7},(_,i)=>{const n=new Date(d);n.setUTCDate(n.getUTCDate()+i);return n.toISOString().slice(0,10)}) }
export function TrainingPlan({ controller, active, askCoach }: { controller: CoachController; active: boolean; askCoach:(text:string)=>void }) {
 const {state}=controller;
 const [selectedDate,setSelectedDate]=useState('');const [detail,setDetail]=useState<Course|null>(null);
 const dates=state?datesFrom(state.today):[];const selected=dates.includes(selectedDate)?selectedDate:state?.today||'';
 const daily=state?coursesFor(state,selected):[];const all=state?dates.flatMap(d=>coursesFor(state,d)):[];const phase=state?.plan.phases.find(p=>p.current);const pending=state?.proposals.filter(p=>p.status==='pending')||[];
 const counts=all.filter(s=>s.kind!=='rest').length;
 return <section id="plan" className={`panel training-plan${active?' is-active':''}`} aria-labelledby="plan-heading">
  <div className="page-heading"><div><h1 id="plan-heading">训练安排</h1></div></div>
  {state?.plan.status==='error'&&<p className="feedback is-error">同步未完成，当前显示上次安排。</p>}
  <section className="plan-overview"><h2>{chineseTitle(state?.plan.name||'你的训练计划')}</h2><div className="plan-summary"><span>{phase?phaseNames[phase.training_phase]||'训练期':'训练计划'}</span><span>未来七天 <strong>{counts}</strong> 次训练</span></div></section>
  {pending.length>0&&<details className="pending-adjustments" open><summary>{pending.length} 份方案待确认</summary>{pending.map(p=><ProposalCard key={p.id} proposal={p} controller={controller}/>)}</details>}
  <div className="week-picker" role="group" aria-label="选择训练日期">{dates.map(date=>{const sessions=state?coursesFor(state,date):[];return <button key={date} aria-pressed={selected===date} onClick={()=>setSelectedDate(date)} aria-label={`${dateLabel(date)}，${sessions.length}堂课程`}><span>{date===state?.today?'今天':dateValue(date)?.toLocaleDateString('zh-CN',{weekday:'narrow'})}</span><strong>{Number(date.slice(-2))}</strong><span className="day-marks" aria-hidden="true">{sessions.slice(0,3).map((s,i)=><i key={i} className={`sport-${s.kind}`}/>)}</span></button>})}</div>
  <section className="daily-courses" aria-labelledby="selected-heading"><div className="today-section-title"><h2 id="selected-heading">{selected===state?.today?'今日课程':dateLabel(selected)}</h2><span>{daily.length?`${daily.length}堂安排`:''}</span></div>
   {daily.map((course,i)=>{const time=isGarmin(course)?sessionTime(course):null;return <button key={i} className={`course-row sport-${course.kind}`} onClick={()=>setDetail(course)} aria-label={`查看课程：${chineseTitle(course.title)}`}><span className="course-sport">{kindLabels[course.kind]||'训练'}</span><span className="course-row-main"><strong>{chineseTitle(course.title)}</strong><span>{course.kind==='rest'?'休息与恢复':time?shortDuration(time.seconds):'查看执行步骤'} · {isGarmin(course)?statusLabels[course.status]:'已采用调整'}</span></span><span className="course-arrow" aria-hidden="true">↗</span></button>})}
   {!daily.length&&<div className="plan-empty"><h3>{state?'这一天还没有发布课程':'正在读取安排'}</h3>{state&&<p>选择其他日期，或请教练安排。</p>}</div>}
  </section>
  {Boolean(state?.proposals.some(p=>p.status==='active'))&&<details className="plan-disclosure"><summary>已采用的临时调整</summary>{state?.proposals.filter(p=>p.status==='active').map(p=><ProposalCard key={p.id} proposal={p} controller={controller}/>)}</details>}
  {Boolean(state?.plan.phases.length)&&<details className="plan-disclosure"><summary>查看完整训练周期</summary><ol className="phase-timeline">{state?.plan.phases.map((p,i)=><li key={i} className={p.current?'current':''}><strong>{phaseNames[p.training_phase]||'训练阶段'}{p.current?' · 当前':''}</strong><span>{p.start_date.slice(5)} — {p.end_date.slice(5)}</span></li>)}</ol></details>}
  <details className="plan-disclosure"><summary>目标与训练背景</summary><GoalForm controller={controller}/></details>
  {Boolean(state?.proposals.some(p=>!['pending','active'].includes(p.status)))&&<details className="plan-disclosure"><summary>过去的调整</summary>{state?.proposals.filter(p=>!['pending','active'].includes(p.status)).map(p=><ProposalCard key={p.id} proposal={p} controller={controller}/>)}</details>}
  {controller.planFeedback.message&&<p className="feedback" role="status">{controller.planFeedback.message}</p>}
  <CourseSheet askCoach={askCoach} course={detail} onClose={()=>setDetail(null)}/>
 </section>;
}
