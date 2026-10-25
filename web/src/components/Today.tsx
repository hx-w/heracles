import {useEffect,useState} from 'react';
import type {CoachController} from '../hooks/useCoachState';
import type {Course} from '../training';
import {chineseTitle,coursesFor,isGarmin,shortDuration} from '../training';
import {dateLabel,kindLabels} from '../format';
import {CourseSheet,sessionTime} from './CourseSheet';
import {HealthDashboard} from './HealthDashboard';
import {ActivityFeed} from './ActivityFeed';
import {CheckinSheet} from './CheckinSheet';
import {ProposalCard} from './ProposalCard';
export function Today({controller,active,askCoach,openStrength,checkinRequest}:{controller:CoachController;active:boolean;askCoach:(message:string)=>void;openStrength:()=>void;checkinRequest:number}){
 const {state,actionBusy}=controller;const [detail,setDetail]=useState<Course|null>(null);const [checkinOpen,setCheckinOpen]=useState(false);
 useEffect(()=>{if(checkinRequest>0)setCheckinOpen(true)},[checkinRequest]);
 const dates=state?[...new Set([...state.plan.workouts,...state.active_sessions].map(s=>s.date))].filter(d=>d>=state.today).sort():[];
 const next=state?dates.flatMap(d=>coursesFor(state,d)).find(s=>s.kind!=='rest'&&(!isGarmin(s)||s.status!=='completed'&&s.status!=='skipped')):null;
 const time=next&&isGarmin(next)?sessionTime(next):null;const pending=state?.proposals.filter(p=>p.status==='pending')||[];
 return <section id="today" className={`panel today-panel${active?' is-active':''}`} aria-labelledby="today-heading"><div className="page-heading"><div><p>{state?dateLabel(state.today):'今天'}</p><h1 id="today-heading">你的训练与恢复</h1></div><button className="quiet checkin-entry" disabled={!state} onClick={()=>setCheckinOpen(true)}>{state?.checkin?'更新体感':'记录体感'}</button></div>
 <ActivityFeed state={state} askCoach={askCoach}/>
 <HealthDashboard state={state} askCoach={askCoach}/>
 {pending.length>0&&<section className="today-proposals"><div className="today-section-title"><h2>待确认的调整</h2></div>{pending.map(p=><ProposalCard key={p.id} proposal={p} controller={controller}/>)}</section>}
 <section className="next-training"><div className="today-section-title"><h2>下一次训练</h2><a className="text-button" href="#plan">七日安排 ↗</a></div>{next?<button className="next-course" onClick={()=>setDetail(next)}><span>{next.date===state?.today?'今天':dateLabel(next.date)} · {kindLabels[next.kind]||'训练'}</span><strong>{chineseTitle(next.title)}</strong><span>{time?shortDuration(time.seconds):'查看执行步骤'}<span aria-hidden="true"> ↗</span></span></button>:<button className="next-course" disabled={!state||actionBusy} onClick={()=>askCoach('请结合我的佳明主线、实际训练和恢复变化，评估下一次训练如何安排。')}><strong>和教练确认下一步</strong><span>还没有新的可执行课程 ↗</span></button>}</section>
 <div className="training-shortcuts" aria-label="训练操作"><button disabled={!state||actionBusy} onClick={()=>askCoach('请结合最近身体趋势与佳明主线，帮我临时调整训练。先问清日期和可用时间。')}>调整安排</button><button disabled={!state||actionBusy} onClick={()=>askCoach('我想加一次专项、骑行或长距离低强度训练，请先问清需求，再调整后续安排。')}>加一堂课</button><button disabled={!state} onClick={openStrength}>力量打卡</button><button disabled={!state} onClick={()=>setCheckinOpen(true)}>恢复反馈</button></div>
 {controller.planFeedback.message&&!checkinOpen&&<p className="feedback" role="status">{controller.planFeedback.message}</p>}
 <CourseSheet course={detail} onClose={()=>setDetail(null)} askCoach={askCoach}/><CheckinSheet open={checkinOpen} onClose={()=>setCheckinOpen(false)} controller={controller} askCoach={askCoach}/></section>
}
