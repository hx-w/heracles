import { useState } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { Proposal, ProposedSession } from '../types';
import { duration, dateLabel } from '../format';

const phases = { warmup: '热身', work: '主训练', recovery: '恢复', cooldown: '冷身' };
const statuses = { pending: '等待你确认', active: '已采用', dismissed: '保留原安排', reverted: '已撤销', superseded: '已有新方案', stale: '需要重新评估' };

export function SessionSteps({ session }: { session: ProposedSession }) {
  return <div className="session-instructions">
    {session.kind === 'rest' ? <p className="rest-instruction">今天暂停训练，留出恢复时间。</p> : <ol className="coach-steps">{session.steps.map((step, index) => <li key={index}>
      <div className="coach-step-top"><span>{phases[step.phase]}{step.repeat > 1 ? ` × ${step.repeat}` : ''}</span><strong>{step.duration_seconds !== null ? duration(step.duration_seconds) : `${step.distance_meters} 米`}</strong></div>
      <h4>{step.title}</h4><p>{step.target}</p><p className="step-instruction">{step.instructions}</p>
    </li>)}</ol>}
    <p className="stop-condition"><span>调整 / 停止条件</span>{session.stop_conditions}</p>
  </div>;
}

export function ProposalCard({ proposal, controller, expanded = false }: { proposal: Proposal; controller: CoachController; expanded?: boolean }) {
  const [confirmRevert, setConfirmRevert] = useState(false);
  return <article className={`proposal-card proposal-${proposal.status}`}>
    <div className="proposal-heading"><span className="source-label">Heracles 训练方案</span><span>{proposal.invalid_reason ? '需要重新评估' : statuses[proposal.status]}</span></div>
    <h3>{proposal.title}</h3><p className="proposal-rationale">{proposal.rationale}</p>
    {proposal.invalid_reason && <p className="feedback is-error" role="status">{proposal.invalid_reason}。请告诉教练重新评估。</p>}
    {proposal.sessions.map((session, index) => <details className="proposal-session" key={index} open={expanded || undefined}>
      <summary><span><small>{dateLabel(session.date)}{session.state === 'superseded' ? ' · 已被替换' : ''}</small><strong>{session.title}</strong></span><span aria-hidden="true">＋</span></summary>
      {session.invalid_reason && <p className="feedback is-error">本课程调整暂停：{session.invalid_reason}。</p>}
      <div className="plan-comparison"><div><span>佳明原课</span><p>{session.baseline?.title || '当天未返回佳明课程'}</p>{session.baseline?.duration_seconds != null && <small>预计 {duration(session.baseline.duration_seconds)}</small>}</div><div><span>Heracles 建议</span><p>{session.reason}</p></div></div>
      <SessionSteps session={session} />
    </details>)}
    {proposal.status === 'pending' && <><p className="proposal-scope">确认后更新 Heracles 安排。佳明与手表上的课程不变。</p><div className="proposal-actions"><button className="primary" disabled={controller.actionBusy || Boolean(proposal.invalid_reason)} onClick={() => void controller.decideProposal(proposal.id, 'accept')}>采用方案</button><button className="quiet" disabled={controller.actionBusy} onClick={() => void controller.decideProposal(proposal.id, 'dismiss')}>保留原安排</button></div></>}
    {proposal.status === 'active' && <div className="proposal-actions">{confirmRevert ? <><p>撤销这份方案，恢复原安排？</p><button disabled={controller.actionBusy} onClick={() => void controller.decideProposal(proposal.id, 'revert')}>确认撤销</button><button className="quiet" onClick={() => setConfirmRevert(false)}>取消</button></> : <button className="quiet" disabled={controller.actionBusy} onClick={() => setConfirmRevert(true)}>撤销本次调整</button>}</div>}
  </article>;
}
