import {useState} from 'react';
import type {CoachController} from '../hooks/useCoachState';
import type {Proposal} from '../types';
import {api,errorMessage} from '../api';
import {duration,dateLabel} from '../format';
import {SessionSteps} from './SessionSteps';
const statuses={pending:'等待你确认',active:'已采用',dismissed:'保留原安排',reverted:'已撤销',superseded:'已有新方案',stale:'需要重新评估'};
export function ProposalCard({proposal,controller,expanded=false}:{proposal:Proposal;controller:CoachController;expanded?:boolean}) {
 const [confirmRevert,setConfirmRevert]=useState(false),[exporting,setExporting]=useState(false),[confirmExport,setConfirmExport]=useState(false),[feedback,setFeedback]=useState(''),[confirmDelete,setConfirmDelete]=useState('');
 const exported=controller.state?.exports.find(item=>item.proposal_id===proposal.id);
 const cleanup=controller.state?.export_cleanup?.filter(item=>item.proposal_id===proposal.id)||[];
 const issues=proposal.export_issues||[];
 async function publish(){setExporting(true);setFeedback('');try{const result=await api.publish(proposal.id);setFeedback(result.note);setConfirmExport(false)}catch(error){setFeedback(errorMessage(error))}finally{await controller.reload();setExporting(false)}}
 async function remove(item:typeof cleanup[number]){setExporting(true);setFeedback('');try{const result=await api.removeExport(item);setFeedback(result.note);setConfirmDelete('')}catch(error){setFeedback(errorMessage(error))}finally{await controller.reload();setExporting(false)}}
 function repair(){location.hash='coach';void controller.sendChat(`请修正方案“${proposal.title}”中不能发送到佳明的课程：${issues.map(i=>`${i.title||''}：${i.reason}`).join('；')}。${proposal.sessions.filter(s=>s.state!=='superseded').map(s=>`${s.date} 的“${s.title}”${proposal.status==='active'?`本站课程编号 ${s.local_id}`:s.base_workout_id?`佳明原课编号 ${s.base_workout_id}`:s.base_local_id?`本站原课编号 ${s.base_local_id}`:'新增课程'}`).join('；')}。保留训练目标和其余课程，使用已验证的动作和明确次数，拆分不同运动，返回一份待我确认的新方案。`)}
 return <article className={`proposal-card proposal-${proposal.status}`}>
  <div className="proposal-heading"><span className="source-label">Heracles 训练方案</span><span>{proposal.invalid_reason?'需要重新评估':statuses[proposal.status]}</span></div>
  <h3>{proposal.title}</h3><p className="proposal-rationale">{proposal.rationale}</p>
  {proposal.invalid_reason&&<p className="feedback is-error" role="status">{proposal.invalid_reason}。请告诉教练重新评估。</p>}
  {proposal.sessions.map((session,index)=><details className="proposal-session" key={index} open={expanded||undefined}><summary><span><small>{dateLabel(session.date)}{session.state==='superseded'?' · 已被替换':session.operation==='add'?' · 新增训练':''}</small><strong>{session.title}</strong><small>{session.kind==='rest'?'休息与恢复':`${session.steps.length} 项步骤 · ${new Set(session.steps.map(s=>s.phase)).size} 个阶段`}</small></span><span aria-hidden="true">＋</span></summary>
   {session.invalid_reason&&<p className="feedback is-error">本课程调整暂停：{session.invalid_reason}。</p>}
   <div className="plan-comparison"><div><span>{session.previous_session?'此前已采用':'佳明原课'}</span><p>{session.previous_session?.title||session.baseline?.title||'新增独立课程，原有安排保留'}</p>{session.baseline?.duration_seconds!=null&&<small>预计 {duration(session.baseline.duration_seconds)}</small>}</div><div><span>Heracles 建议</span><p>{session.reason}</p></div></div>
   <SessionSteps session={session} exercises={controller.state?.exercise_catalog}/>
  </details>)}
  {issues.length>0&&['pending','active'].includes(proposal.status)&&<div className="export-issues"><strong>佳明发送需要调整</strong><ul>{issues.map((item,i)=><li key={i}>{item.title&&`${item.title}：`}{item.reason}</li>)}</ul>{proposal.sessions.some(s=>s.kind!=='rest')&&<button disabled={controller.actionBusy||exporting} onClick={repair}>请教练修正后再发送</button>}</div>}
  {proposal.status==='pending'&&<><p className="proposal-scope">确认后更新本站安排，佳明与手表课程保持原状。</p><div className="proposal-actions"><button className="primary" disabled={controller.actionBusy||Boolean(proposal.invalid_reason)} onClick={()=>void controller.decideProposal(proposal.id,'accept')}>采用方案</button><button className="quiet" disabled={controller.actionBusy} onClick={()=>void controller.decideProposal(proposal.id,'dismiss')}>保留原安排</button></div></>}
  {proposal.status==='active'&&<>
   <div className="proposal-actions">{!exported&&issues.length===0&&proposal.sessions.some(s=>s.state!=='superseded'&&s.kind!=='rest')&&<button className="quiet" disabled={controller.actionBusy||exporting||Boolean(proposal.invalid_reason)} onClick={()=>setConfirmExport(!confirmExport)}>发送到佳明课程库</button>}{exported&&<span className="export-status">{exported.status==='complete'?'已保存到佳明课程库':'佳明发送待核实，请先核对课程库'}</span>}</div>
   {confirmExport&&<div className="export-confirm"><p>创建独立课程，并核对训练步骤。修改过的旧版本会在新课核实后列出，由你确认删除。佳明自适应原计划保留。</p><button className="primary" disabled={exporting||controller.actionBusy} onClick={()=>void publish()}>{exporting?'正在发送与读回确认…':'确认创建佳明课程'}</button><button className="quiet" disabled={exporting} onClick={()=>setConfirmExport(false)}>取消</button></div>}
   {cleanup.length>0&&<section className="export-cleanup"><h4>清理被替换的旧课</h4>{cleanup.map(item=><div key={`${item.receipt_id}-${item.workout_id}`}><p><strong>{item.title}</strong><span>{dateLabel(item.date)} · 佳明课程 {item.workout_id}</span></p>{item.removal_status?<button disabled={exporting||controller.actionBusy} onClick={()=>void remove(item)}>核实删除结果</button>:confirmDelete===item.workout_id?<div className="cleanup-confirm"><p>确认从佳明课程库删除这个旧版本？删除无法撤销，请同步设备以更新手表课程。</p><button disabled={exporting||controller.actionBusy} onClick={()=>void remove(item)}>确认删除旧版</button><button className="quiet" disabled={exporting} onClick={()=>setConfirmDelete('')}>取消</button></div>:<button disabled={exporting||controller.actionBusy} onClick={()=>setConfirmDelete(item.workout_id)}>删除旧版佳明课程</button>}</div>)}</section>}
   <div className="proposal-actions">{confirmRevert?<><p>恢复上一版本站安排？已删除的佳明课程不会自动重建，已发送的课程仍保留。</p><button disabled={controller.actionBusy||exporting} onClick={()=>void controller.decideProposal(proposal.id,'revert')}>确认撤销</button><button className="quiet" onClick={()=>setConfirmRevert(false)}>取消</button></>:<button className="quiet" disabled={controller.actionBusy||exporting} onClick={()=>setConfirmRevert(true)}>撤销本次调整</button>}</div>
  </>}
  {feedback&&<p className="feedback" role="status">{feedback}</p>}
 </article>;
}
