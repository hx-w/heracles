import {useEffect,useState} from 'react';
import type {CoachController} from '../hooks/useCoachState';
import type {Course} from '../training';
import {chineseTitle,coursesFor,isGarmin,shortDuration} from '../training';
import {dateLabel,kindLabels,statusLabels} from '../format';
import {CourseSheet,sessionTime} from './CourseSheet';
import {HealthDashboard} from './HealthDashboard';
import {ActivityFeed} from './ActivityFeed';
import {CheckinSheet} from './CheckinSheet';
import {ProposalCard} from './ProposalCard';
export function Today({controller,active,askCoach,openStrength,checkinRequest}:{controller:CoachController;active:boolean;askCoach:(message:string)=>void;openStrength:()=>void;checkinRequest:number}){
 const {state,actionBusy}=controller;const [detail,setDetail]=useState<Course|null>(null);const [checkinOpen,setCheckinOpen]=useState(false);
 useEffect(()=>{if(checkinRequest>0)setCheckinOpen(true)},[checkinRequest]);
 const daily=state?coursesFor(state,state.today):[];
 const pending=state?.proposals.filter(p=>p.status==='pending')||[];
 return <section id="today" className={`panel today-panel${active?' is-active':''}`} aria-labelledby="today-heading">
 <div className="page-heading"><div><h1 id="today-heading">今天</h1><p>{state?dateLabel(state.today):''}</p></div><button className="quiet checkin-entry" disabled={!state||actionBusy} onClick={()=>setCheckinOpen(true)}>{state?.checkin?'更新体感':'记录体感'}</button></div>
 <section className="today-training"><div className="today-section-title"><h2>今日训练</h2><a className="text-button" href="#plan">七日安排 ↗</a></div>
 <div className="today-course-list">{daily.map((course,i)=>{const time=isGarmin(course)?sessionTime(course):null;return <button key={i} className={`today-course sport-${course.kind}`} onClick={()=>setDetail(course)}><span className="today-course-kind">{kindLabels[course.kind]||'训练'}</span><span className="today-course-body"><strong>{chineseTitle(course.title)}</strong><small>{isGarmin(course)?statusLabels[course.status]:'本站调整'}{time?` · ${shortDuration(time.seconds)}`:!isGarmin(course)&&course.steps.length?` · ${course.steps.length} 项步骤`:''}</small></span><span aria-hidden="true">↗</span></button>})}{!daily.length&&<div className="today-course-empty"><strong>{state?'今天尚无课程':'正在读取今日安排'}</strong>{state&&<button className="text-button" disabled={actionBusy} onClick={()=>askCoach('请结合我的佳明主线、实际训练和恢复变化，评估今天如何安排。')}>和教练确认 ↗</button>}</div>}</div></section>
 <HealthDashboard state={state} askCoach={askCoach}/>
 {pending.length>0&&<section className="today-proposals"><div className="today-section-title"><h2>待确认的调整</h2></div>{pending.map(p=><ProposalCard key={p.id} proposal={p} controller={controller}/>)}</section>}
 <div className="training-shortcuts" aria-label="训练操作"><button disabled={!state||actionBusy} onClick={()=>askCoach('请结合最近身体趋势与佳明主线，帮我临时调整训练。先问清日期和可用时间。')}>调整安排</button><button disabled={!state||actionBusy} onClick={()=>askCoach('我想加一次专项、骑行或长距离低强度训练，请先问清需求，再调整后续安排。')}>加一堂课</button><button disabled={!state} onClick={openStrength}>力量打卡</button><button disabled={!state||actionBusy} onClick={()=>setCheckinOpen(true)}>恢复反馈</button></div>
 <ActivityFeed state={state} askCoach={askCoach}/>
 {controller.planFeedback.message&&!checkinOpen&&<p className="feedback" role="status">{controller.planFeedback.message}</p>}
 <CourseSheet course={detail} exercises={state?.exercise_catalog} onClose={()=>setDetail(null)} askCoach={askCoach}/><CheckinSheet open={checkinOpen} onClose={()=>setCheckinOpen(false)} controller={controller} askCoach={askCoach}/></section>
}
