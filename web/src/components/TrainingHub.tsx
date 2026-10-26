import {useTrainingDialog} from '../hooks/useTrainingDialog';
import { useEffect, useRef, useState } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { RestTimer } from '../hooks/useRestTimer';
import { timerLabel } from '../hooks/useRestTimer';

export function TrainingHub({ open, onClose, controller, timer, openCourse, openCheckin, openStrength, askCoach }: { open: boolean; onClose: () => void; controller: CoachController; timer: RestTimer; openCourse:(course:import('../training').Course)=>void; openCheckin: () => void; openStrength: () => void; askCoach: (text: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [keepAwake, setKeepAwake] = useState(false);
  const [wakeMessage, setWakeMessage] = useState('');
  const [installed, setInstalled] = useState(() => matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  useTrainingDialog(dialog,open);
  useEffect(() => {
    const mode = matchMedia('(display-mode: standalone)');
    const update = () => setInstalled(mode.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    mode.addEventListener('change', update); window.addEventListener('appinstalled', update);
    return () => { mode.removeEventListener('change', update); window.removeEventListener('appinstalled', update); };
  }, []);
  useEffect(() => {
    if (!keepAwake || (!open && !timer.running) || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined; let disposed = false; let pending = false;
    const acquire = async () => {
      if (disposed || pending || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      pending = true;
      try { const next = await navigator.wakeLock.request('screen'); if (disposed) await next.release(); else { lock = next; setWakeMessage('亮屏已开启，离开应用后由系统接管。'); } }
      catch { if (!disposed) setWakeMessage('系统暂未允许亮屏，请检查省电模式或浏览器设置。'); }
      finally { pending = false; }
    };
    void acquire(); document.addEventListener('visibilitychange', acquire);
    return () => { disposed = true; document.removeEventListener('visibilitychange', acquire); void lock?.release().catch(() => {}); };
  }, [keepAwake, open, timer.running]);
  function run(action: () => void) { onClose(); action(); }
  const state = controller.state;
  const local = state?.active_sessions.filter(s => s.date === state.today) || [];
  const replaced = new Set(local.map(s => s.base_workout_id));
  const today = [...local, ...(state?.plan.workouts.filter(s => s.date === state.today && !replaced.has(s.id)) || [])];
  return <dialog ref={dialog} className="training-drawer training-hub" aria-labelledby="training-hub-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="drawer-content"><header className="drawer-header"><h2 id="training-hub-title">训练面板</h2><button className="text-button" onClick={onClose} aria-label="收起训练面板">收起</button></header>
      
      <section className="hub-today"><h3>今天的安排</h3>{today.length ? today.map((s, i) => <button className="hub-course-link" key={i} onClick={()=>run(()=>openCourse(s))}>{s.title}<span aria-hidden="true"> ↗</span></button>) : <p>今天尚无可用课程，先和教练确认安排。</p>}</section>
      <div className="hub-actions"><button disabled={!state} onClick={() => run(openStrength)}>力量打卡</button><button disabled={!state || controller.actionBusy} onClick={() => run(() => askCoach('请复盘我最近一次实际训练，结合原计划、实际分段与恢复状态，说明一项可改进点和后续训练注意事项。'))}>训练复盘</button><button disabled={!state || controller.actionBusy} onClick={() => run(() => askCoach('我需要临时调整训练。请先确认具体日期、可用时间和身体感受，再结合佳明主线生成方案。'))}>调整安排</button><button onClick={() => run(openCheckin)}>记录体感</button></div>
      <section className="rest-timer" aria-labelledby="rest-timer-heading"><div className="today-section-title"><h3 id="rest-timer-heading">组间休息</h3><span>{timer.active ? timer.remaining === 0 ? '休息结束' : timer.running ? '计时中' : '已暂停' : '选择时长开始'}</span></div>
        <div className="rest-clock" aria-label={`剩余 ${timer.remaining} 秒`}>{timerLabel(timer.remaining)}</div>
        <progress max={timer.total || 1} value={timer.active ? timer.total - timer.remaining : 0} aria-label="休息计时进度" />
        <div className="rest-presets">{[30, 60, 90, 120].map(seconds => <button key={seconds} onClick={() => timer.start(seconds)}>{seconds < 120 ? `${seconds} 秒` : '2 分钟'}</button>)}</div>
        {timer.active && <div className="rest-controls">{timer.remaining > 0 && <button onClick={timer.running ? timer.pause : timer.resume}>{timer.running ? '暂停计时' : '继续计时'}</button>}<button className="quiet" onClick={timer.stop}>结束计时</button></div>}
        <p className="sr-only" role="status">{timer.active && timer.remaining === 0 ? '组间休息结束，请按身体感受决定下一组。' : ''}</p>
        <label className="wake-toggle"><input type="checkbox" checked={keepAwake} disabled={!('wakeLock' in navigator)} onChange={e => { setKeepAwake(e.target.checked); setWakeMessage(''); }} /><span>训练时保持亮屏</span></label>
        {wakeMessage && keepAwake && <p className="hub-note" role="status">{wakeMessage}</p>}
        <p className="hub-note">计时可收起，返回应用时按实际时间校准。锁屏后不能保证准时提醒；训练仍以佳明设备和身体感受为准。</p>
      </section>
      <details className="install-guide"><summary>{installed ? '已以桌面应用模式打开' : '添加到手机主屏幕'}</summary>{isIOS ? <ol><li>在 Safari 打开并完成设备授权。</li><li>点分享按钮，选择“添加到主屏幕”。</li><li>如有“作为 Web App 打开”，保持开启，再点“添加”。</li><li>以后从桌面 Heracles 图标进入，不用每次找链接。</li></ol> : <p>在浏览器菜单选择“安装应用”或“添加到主屏幕”。iPhone 请用 Safari 的分享菜单。</p>}<p className="hub-note">服务端授权长期有效；清除网站数据或更换浏览器仍需新授权链接。灵动岛与锁屏实时活动需要原生 iOS 扩展。</p></details>
    </div>
  </dialog>;
}
