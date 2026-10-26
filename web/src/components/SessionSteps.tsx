import {useState} from 'react';
import type {Exercise, ProposedSession, TrainingStep} from '../types';
import {duration} from '../format';
import {ExerciseCard} from './ExerciseCard';

const phases={warmup:'热身',work:'主训练',recovery:'恢复',cooldown:'冷身'};
function prescription(step:TrainingStep) {
  const count=(step.repeat||1)*(step.sets||1);
  const work=step.reps?`${step.reps} 次`:step.duration_seconds!=null?duration(step.duration_seconds):`${step.distance_meters} 米`;
  return `${count>1?`${count} 组 × `:''}${work}`;
}
export function StepGuide({exercise,instructions}:{exercise?:Exercise;instructions?:string}) {
  const [open,setOpen]=useState(false);
  return <details className="step-guide" onToggle={e=>setOpen(e.currentTarget.open)}><summary>{exercise?`动作指导 · 图片${exercise.video?' / 视频':''}`:'执行要点'}<span aria-hidden="true">⌄</span></summary>{open&&<div>{instructions&&<p className="step-instruction">{instructions}</p>}{exercise&&<ExerciseCard exercise={exercise} compact mediaOpen/>}{!exercise&&<p className="exercise-credit">此步骤暂无已核验的图片或视频。</p>}</div>}</details>;
}
export function SessionSteps({session,exercises=[]}:{session:ProposedSession;exercises?:Exercise[]}) {
  const groups:{phase:TrainingStep['phase'];steps:TrainingStep[]}[]=[];
  for(const step of session.steps){const last=groups.at(-1);if(last?.phase===step.phase)last.steps.push(step);else groups.push({phase:step.phase,steps:[step]})}
  return <div className="session-instructions">
    {session.kind==='rest'?<p className="rest-instruction">今天暂停训练，留出恢复时间。</p>:<>
      <nav className="session-outline" aria-label="课程结构">{groups.map((group,i)=><span key={i} className={`phase-${group.phase}`}><strong>{phases[group.phase]}</strong><small>{group.steps.length} 项</small></span>)}</nav>
      <div className="session-phases">{groups.map((group,i)=><section className={`session-phase phase-${group.phase}`} key={i}><header><h4>{phases[group.phase]}</h4><span>{group.steps.length} 项</span></header><ol className="structured-steps">{group.steps.map((step,j)=><li key={j}>
        <div className="structured-step-heading"><h5>{step.title}</h5><strong>{prescription(step)}</strong></div>
        <div className="step-prescription">{step.load_kg!=null&&<span>负重 {step.load_kg} kg</span>}{step.rest_seconds!=null&&<span>组间恢复 {step.rest_seconds} 秒</span>}</div>
        <p className="step-target">{step.target}</p>
        <StepGuide exercise={exercises.find(ex=>ex.id===step.exercise_id)} instructions={step.instructions}/>
      </li>)}</ol></section>)}</div>
    </>}
    <details className="stop-condition"><summary>调整与停止条件</summary><p>{session.stop_conditions}</p></details>
  </div>;
}
