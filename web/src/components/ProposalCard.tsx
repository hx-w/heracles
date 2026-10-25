import { useState } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { Proposal, ProposedSession } from '../types';
import { api, errorMessage } from '../api';
import { duration, dateLabel } from '../format';

const phases = { warmup: '热身', work: '主训练', recovery: '恢复', cooldown: '冷身' };
const statuses = { pending: '等待你确认', active: '已采用', dismissed: '保留原安排', reverted: '已撤销', superseded: '已有新方案', stale: '需要重新评估' };

export function SessionSteps({ session }: { session: ProposedSession }) {
  return <div className="session-instructions">
    {session.kind === 'rest' ? <p className="rest-instruction">今天暂停训练，留出恢复时间。</p> : <ol className="coach-steps">{session.steps.map((step, index) => <li key={index}>
      <div className="coach-step-top"><span>{phases[step.phase]}{(step.repeat || 1) * (step.sets || 1) > 1 && !step.reps ? ` × ${(step.repeat || 1) * (step.sets || 1)}` : step.repeat > 1 ? ` × ${step.repeat}` : ''}</span><strong>{step.reps ? `${step.sets || 1} 组 × ${step.reps} 次` : step.duration_seconds != null ? duration(step.duration_seconds) : `${step.distance_meters} 米`}</strong></div>
      <h4>{step.title}</h4><p>{step.target}</p><p className="step-instruction">{step.instructions}</p>{(step.load_kg != null || step.rest_seconds != null) && <p className="step-instruction">{step.load_kg != null ? `负重 ${step.load_kg} kg` : ''}{step.rest_seconds != null ? ` · 组间恢复 ${step.rest_seconds} 秒` : ''}</p>}
    </li>)}</ol>}
    <p className="stop-condition"><span>调整 / 停止条件</span>{session.stop_conditions}</p>
  </div>;
}

export function ProposalCard({ proposal, controller, expanded = false }: { proposal: Proposal; controller: CoachController; expanded?: boolean }) {
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [exportFeedback, setExportFeedback] = useState('');
  const exported = controller.state?.exports.find(item => item.proposal_id === proposal.id);
  async function publish() { setExporting(true); try { const result = await api.publish(proposal.id); setExportFeedback(result.note); setConfirmExport(false); await controller.reload(); } catch(error) { setExportFeedback(errorMessage(error)); } finally { setExporting(false); } }
  return <article className={`proposal-card proposal-${proposal.status}`}>
    <div className="proposal-heading"><span className="source-label">Heracles 训练方案</span><span>{proposal.invalid_reason ? '需要重新评估' : statuses[proposal.status]}</span></div>
    <h3>{proposal.title}</h3><p className="proposal-rationale">{proposal.rationale}</p>
    {proposal.invalid_reason && <p className="feedback is-error" role="status">{proposal.invalid_reason}。请告诉教练重新评估。</p>}
    {proposal.sessions.map((session, index) => <details className="proposal-session" key={index} open={expanded || undefined}>
      <summary><span><small>{dateLabel(session.date)}{session.state === 'superseded' ? ' · 已被替换' : session.operation === 'add' ? ' · 新增训练' : ''}</small><strong>{session.title}</strong></span><span aria-hidden="true">＋</span></summary>
      {session.invalid_reason && <p className="feedback is-error">本课程调整暂停：{session.invalid_reason}。</p>}
      <div className="plan-comparison"><div><span>{session.previous_session ? '此前已采用' : '佳明原课'}</span><p>{session.previous_session?.title || session.baseline?.title || '新增独立课程，原有安排保留'}</p>{session.baseline?.duration_seconds != null && <small>预计 {duration(session.baseline.duration_seconds)}</small>}</div><div><span>Heracles 建议</span><p>{session.reason}</p></div></div>
      <SessionSteps session={session} />
    </details>)}
    {proposal.status === 'pending' && <><p className="proposal-scope">确认后更新 Heracles 安排。佳明与手表上的课程不变。</p><div className="proposal-actions"><button className="primary" disabled={controller.actionBusy || Boolean(proposal.invalid_reason)} onClick={() => void controller.decideProposal(proposal.id, 'accept')}>采用方案</button><button className="quiet" disabled={controller.actionBusy} onClick={() => void controller.decideProposal(proposal.id, 'dismiss')}>保留原安排</button></div></>}
    {proposal.status === 'active' && <><div className="proposal-actions">{!exported && <button className="quiet" disabled={controller.actionBusy || exporting || Boolean(proposal.invalid_reason)} onClick={() => setConfirmExport(!confirmExport)}>发送到佳明课程库</button>}{exported && <span className="export-status">{exported.status === 'complete' ? '已保存到佳明课程库' : '佳明发送待核实'}</span>}</div>{confirmExport && <div className="export-confirm"><p>将创建独立课程，保留佳明自适应原课。不会修改原计划或替你完成训练；之后请在佳明中选择课程并同步设备。</p><button className="primary" disabled={exporting || controller.actionBusy} onClick={() => void publish()}>{exporting ? '正在发送与读回确认…' : '确认创建佳明课程'}</button></div>}{exportFeedback && <p className="feedback" role="status">{exportFeedback}</p>}<div className="proposal-actions">{confirmRevert ? <><p>撤销本次调整，恢复上一版本站安排？已发送到佳明课程库的独立课程会保留。</p><button disabled={controller.actionBusy} onClick={() => void controller.decideProposal(proposal.id, 'revert')}>确认撤销</button><button className="quiet" onClick={() => setConfirmRevert(false)}>取消</button></> : <button className="quiet" disabled={controller.actionBusy} onClick={() => setConfirmRevert(true)}>撤销本次调整</button>}</div></>}
  </article>;
}
