import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { Profile } from '../types';

interface ProfileDraft { goal: string; target_date: string; weekly_days: string; experience: string; notes: string }
const emptyDraft: ProfileDraft = { goal: '', target_date: '', weekly_days: '', experience: '', notes: '' };

export function GoalForm({ controller }: { controller: CoachController }) {
  const { state, profileSaving, profileFeedback, saveProfile, actionBusy } = controller;
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (state && !dirty && !profileSaving) {
      setDraft({ ...state.profile, target_date: state.profile.target_date || '', weekly_days: String(state.profile.weekly_days) });
    }
  }, [state?.profile, dirty, profileSaving]);

  const update = (key: keyof ProfileDraft, value: string) => {
    setDraft(current => ({ ...current, [key]: value }));
    setDirty(true);
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionBusy || !state || !event.currentTarget.reportValidity()) return;
    const profile: Profile = { goal: draft.goal.trim(), target_date: draft.target_date || null,
      weekly_days: Number(draft.weekly_days), experience: draft.experience.trim(), notes: draft.notes.trim() };
    if (await saveProfile(profile)) setDirty(false);
  }

  return <section className="training-goal" aria-labelledby="profile-heading">
    <div className="training-section-heading"><h2 id="profile-heading">个人教练背景</h2></div>
    <p className="training-chart-note">教练会结合你的目标、经验与时间制定方案。保存后，前往教练对话提出训练需求。</p>
    <details className="goal-edit"><summary><span>每周可训练 {state?.profile.weekly_days || '—'} 天</span><span>{state?.profile.goal ? '编辑个人背景' : '填写个人背景'}<span className="disclosure-mark" aria-hidden="true"> ›</span></span></summary>
    <form id="profile-form" onSubmit={submit}>
      <fieldset disabled={!state || profileSaving}>
        <label htmlFor="goal">长期目标</label><textarea id="goal" rows={2} maxLength={1500} value={draft.goal} onChange={event => update('goal', event.target.value)} />
        <div className="form-row"><div><label htmlFor="target-date">目标日期（可选）</label><input type="date" id="target-date" value={draft.target_date} onChange={event => update('target_date', event.target.value)} /></div>
          <div><label htmlFor="weekly-days">每周可训练天数</label><input type="number" min={1} max={6} step={1} id="weekly-days" required inputMode="numeric" value={draft.weekly_days} onChange={event => update('weekly_days', event.target.value)} /></div></div>
        <label htmlFor="experience">运动经验</label><input id="experience" maxLength={500} value={draft.experience} onChange={event => update('experience', event.target.value)} />
        <label htmlFor="notes">补充说明</label><textarea id="notes" rows={3} maxLength={2000} value={draft.notes} onChange={event => update('notes', event.target.value)} />
      </fieldset>
      <div className="form-footer"><button className="primary" type="submit" disabled={!state || actionBusy}>{profileSaving ? '正在保存…' : controller.coachBusy ? '教练处理中…' : '保存个人背景'}</button><span className="training-draft-status" role="status">{dirty ? '未保存' : ''}</span></div>
      <p className={`feedback${profileFeedback.error ? ' is-error' : ''}`} role="status" aria-live="polite">{profileFeedback.message}</p>
    </form>
    </details>
  </section>;
}
