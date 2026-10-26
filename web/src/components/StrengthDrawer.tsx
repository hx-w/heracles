import {useTrainingDialog} from '../hooks/useTrainingDialog';
import { useRef, useState } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { TrainingSet } from '../types';
import { api, errorMessage } from '../api';
import { ExerciseCard } from './ExerciseCard';

export function StrengthDrawer({ open, onClose, controller, askCoach }: { open: boolean; onClose: () => void; controller: CoachController; askCoach: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'log' | 'learn'>('log');
  const [query, setQuery] = useState('');
  const [exerciseId, setExerciseId] = useState('');
  const [sets, setSets] = useState<TrainingSet[]>([]);
  const [reps, setReps] = useState(10);
  const [load, setLoad] = useState(0);
  const [effort, setEffort] = useState(6);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const id = useRef(crypto.randomUUID());
  const exercises = controller.state?.exercise_catalog || [];
  const selected = exercises.find(e => e.id === exerciseId) || exercises[0];
  useTrainingDialog(dialog,open);
  async function save(review: boolean) {
    if (!controller.state || saving || !sets.length) return;
    setSaving(true); setFeedback('');
    try {
      await api.trainingLog({ id: id.current, date: controller.state.today, title: '力量训练', kind: 'strength', sets, effort, notes });
      await controller.reload(); setSets([]); setNotes(''); id.current = crypto.randomUUID();
      setFeedback('已保存你的力量训练记录。佳明完成状态保持原样。');
      if (review) { onClose(); askCoach('我刚记录了今天的力量训练。请结合实际组次、负重、体感、佳明身体信号与主线计划进行复盘，指出执行要点、可改进之处以及后续训练是否需要调整。'); }
    } catch (error) { setFeedback(errorMessage(error)); } finally { setSaving(false); }
  }
  return <dialog className="training-drawer" ref={dialog} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="drawer-content"><header className="drawer-header"><h2>力量训练</h2><button type="button" className="text-button" onClick={onClose} aria-label="关闭力量训练">关闭</button></header>
      <div className="drawer-tabs" role="tablist" aria-label="力量训练功能"><button role="tab" aria-selected={tab === 'log'} onClick={() => setTab('log')}>训练打卡</button><button role="tab" aria-selected={tab === 'learn'} onClick={() => setTab('learn')}>动作与器材</button></div>
      {tab === 'log' ? <div role="tabpanel"><p className="drawer-description">记录实际完成的每一组。它是你的训练日志，独立于佳明课程状态。</p>
        <fieldset disabled={saving}><label htmlFor="strength-exercise">今天练了什么</label><select id="strength-exercise" value={selected?.id || ''} onChange={event => setExerciseId(event.target.value)}>{exercises.map(exercise => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select>
          <div className="strength-set-input"><div><label htmlFor="strength-reps">次数</label><input id="strength-reps" type="number" min={1} max={300} inputMode="numeric" value={reps} onChange={event => setReps(Number(event.target.value))} /></div><div><label htmlFor="strength-load">负重 kg</label><input id="strength-load" type="number" min={0} max={1000} step={0.5} inputMode="decimal" value={load} onChange={event => setLoad(Number(event.target.value))} /></div><button type="button" disabled={!selected || reps < 1 || load < 0 || sets.length >= 100} onClick={() => { if (selected) setSets(current => [...current, { exercise_id: selected.id, exercise_name: selected.name, reps, load_kg: load }]); }}>添加一组</button></div>
          <ol className="logged-sets">{sets.map((set, index) => <li key={index}><span>{set.exercise_name}<small>{set.reps} 次 · {set.load_kg} kg</small></span><button type="button" className="text-button" aria-label={`删除第 ${index + 1} 组`} onClick={() => setSets(current => current.filter((_, i) => i !== index))}>删除</button></li>)}</ol>
          <label htmlFor="strength-effort">整体用力感 {effort}/10</label><input id="strength-effort" type="range" min={1} max={10} value={effort} onChange={event => setEffort(Number(event.target.value))} />
          <label htmlFor="strength-notes">执行与身体感受</label><textarea id="strength-notes" rows={2} maxLength={1500} placeholder="哪一组最吃力？有没有动作不稳或不适？" value={notes} onChange={event => setNotes(event.target.value)} />
        </fieldset><div className="checkin-actions"><button disabled={saving || !sets.length} onClick={() => void save(false)}>保存打卡</button><button className="primary" disabled={saving || !sets.length || controller.coachBusy} onClick={() => void save(true)}>{saving ? '保存中…' : '保存并请教练复盘 ↗'}</button></div>
        <p className="feedback" role="status">{feedback}</p>
        {selected && <details className="exercise-disclosure"><summary>看看这个动作怎么做</summary><ExerciseCard exercise={selected} compact /></details>}
        <section className="recent-strength"><h3>最近的力量训练</h3>{controller.state?.training_logs.slice(0, 5).map(log => <article key={log.id}><p>{log.date} · {log.sets.length} 组 · 用力感 {log.effort}/10</p>{log.notes && <small>{log.notes}</small>}<button className="text-button" onClick={() => { onClose(); askCoach(`请复盘我在 ${log.date} 记录的力量训练（记录ID ${log.id}），结合动作、组次与后续佳明计划给出建议。`); }}>请教练复盘 ↗</button></article>)}</section>
      </div> : <div role="tabpanel"><label className="sr-only" htmlFor="exercise-search">搜索动作或器材</label><input id="exercise-search" type="search" placeholder="搜索动作、器材或部位" value={query} onChange={event => setQuery(event.target.value)} /><p className="drawer-description">有来源的通用示范，优先确认器材调节和动作路线。训练中出现疼痛时停止。</p>{exercises.filter(e => `${e.name} ${e.equipment} ${e.muscles}`.includes(query.trim())).map(exercise => <ExerciseCard key={exercise.id} exercise={exercise} />)}</div>}
    </div>
  </dialog>;
}
