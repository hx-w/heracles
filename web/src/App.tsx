import { useEffect, useState } from 'react';
import { syncDisplayMode } from './viewport';
import type { Course } from './training';
import { CourseSheet } from './components/CourseSheet';
import { TrainingHub } from './components/TrainingHub';
import { useRestTimer, timerLabel } from './hooks/useRestTimer';
import { StrengthDrawer } from './components/StrengthDrawer';
import { Today } from './components/Today';
import { CoachChat } from './components/CoachChat';
import { TrainingPlan } from './components/TrainingPlan';
import { useCoachState } from './hooks/useCoachState';

type Panel = 'today' | 'coach' | 'plan';
const navigation: { panel: Panel; label: string; icon: string }[] = [
  { panel: 'today', label: '今天', icon: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0' },
  { panel: 'coach', label: '教练', icon: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z' },
  { panel: 'plan', label: '计划', icon: 'M5 5h14v16H5ZM8 3v4m8-4v4M8 11h8m-8 4h5' },
];

export default function App() {
  const controller = useCoachState();
  const { state, loadError, loading } = controller;
  const [strengthOpen, setStrengthOpen] = useState(false);
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [hubCourse,setHubCourse]=useState<Course|null>(null);
  const timer = useRestTimer();
  const [checkinRequest,setCheckinRequest]=useState(0);
  const [focusTarget,setFocusTarget]=useState('');
  const [selected, setSelected] = useState<Panel>('today');
  useEffect(() => {
    const navigate = () => {
      const hash = window.location.hash.slice(1);
      const panel = navigation.find(item => item.panel === hash)?.panel || 'today';
      setSelected(panel);
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest('button, a, summary');
      if (target && !(target instanceof HTMLButtonElement && target.disabled)) target.classList.add('pointer-press');
    };
    const clear = () => document.querySelectorAll('.pointer-press').forEach(element => element.classList.remove('pointer-press'));
    document.addEventListener('pointerdown', press);
    document.addEventListener('pointerup', clear);
    document.addEventListener('pointercancel', clear);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('pointerdown', press);
      document.removeEventListener('pointerup', clear);
      document.removeEventListener('pointercancel', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);
  useEffect(() => {
    const viewport=window.visualViewport;const root=document.documentElement;
    let baseline=Math.max(window.innerHeight,viewport?.height||0);let width=window.innerWidth;
    const sync=()=>{syncDisplayMode();if(viewport&&viewport.scale!==1)return;const height=viewport?.height??window.innerHeight;
      if(Math.abs(window.innerWidth-width)>60){baseline=Math.max(window.innerHeight,height);width=window.innerWidth}
      baseline=Math.max(baseline,window.innerHeight,height);
      const editing=document.activeElement?.matches('textarea,input,[contenteditable="true"]');const keyboard=Boolean(editing&&baseline-height>120);
      root.toggleAttribute('data-keyboard-open',keyboard);
      if(keyboard){root.style.setProperty('--app-height',`${height}px`);root.style.setProperty('--app-top',`${viewport?.offsetTop||0}px`)}
      else{root.style.removeProperty('--app-height');root.style.removeProperty('--app-top')}
    };
    sync();for(const event of ['resize','scroll'])viewport?.addEventListener(event,sync);
    for(const event of ['resize','pageshow','orientationchange'])window.addEventListener(event,sync);
    document.addEventListener('focusin',sync);document.addEventListener('focusout',sync);
    return()=>{for(const event of ['resize','scroll'])viewport?.removeEventListener(event,sync);for(const event of ['resize','pageshow','orientationchange'])window.removeEventListener(event,sync);document.removeEventListener('focusin',sync);document.removeEventListener('focusout',sync);root.style.removeProperty('--app-height');root.style.removeProperty('--app-top');root.removeAttribute('data-keyboard-open')};
  }, []);
  useEffect(()=>{
    if(!focusTarget||trainingOpen||strengthOpen)return;
    if(focusTarget==='checkin'){setCheckinRequest(n=>n+1);setFocusTarget('');return}
    const target=document.getElementById(focusTarget);
    if(!target||target.getClientRects().length===0)return;
    target.focus({preventScroll:true});setFocusTarget('');
  },[focusTarget,selected,trainingOpen,strengthOpen]);
  function openCheckin(){setSelected('today');location.hash='today';setFocusTarget('checkin')}

  function askCoach(message: string) {
    setCoachPrompt({ text: message, key: Date.now() });
    setSelected('coach');
    window.location.hash = 'coach';
    setFocusTarget('chat-message');
  }
  const [coachPrompt, setCoachPrompt] = useState<{ text: string; key: number } | null>(null);

  return <div className={`app-shell${selected === 'coach' ? ' chat-home' : ''}`}>
    <a className="skip-link" href="#main-content">跳到内容</a>
    <header className="masthead"><a className="wordmark" href="#today" lang="en">Heracles<span className="brand-dot" aria-hidden="true">.</span></a>
      <div className="masthead-actions"><button className="training-launch" aria-label="打开训练面板" onClick={() => setTrainingOpen(true)}>训练</button><button className="connection-status" disabled={!state || controller.syncBusy} onClick={() => void controller.syncGarmin()} aria-label="同步佳明数据">{loadError ? '连接中断' : controller.syncBusy ? '同步中' : state?.connection.garmin ? '已同步' : '待同步'}<span aria-hidden="true">↻</span></button></div></header>
    <div className="global-feedback" hidden={Boolean(state && !loadError)} role="status" aria-live="polite"><span>{loadError || '加载中…'}</span>{loadError && <button type="button" className="quiet" disabled={loading} onClick={() => void controller.reload()}>{loading ? '连接中…' : '重试'}</button>}</div>
    <main id="main-content" tabIndex={-1} className="workspace">
      <Today controller={controller} active={selected === 'today'} checkinRequest={checkinRequest} askCoach={askCoach} openStrength={() => setStrengthOpen(true)} />
      <CoachChat controller={controller} active={selected === 'coach'} prompt={coachPrompt} />
      <TrainingPlan askCoach={askCoach} controller={controller} active={selected === 'plan'} />
    </main>
    <TrainingHub open={trainingOpen} onClose={() => setTrainingOpen(false)} controller={controller} timer={timer} openCourse={setHubCourse} openCheckin={openCheckin} openStrength={() => setStrengthOpen(true)} askCoach={askCoach} />
    {timer.active && !trainingOpen && <button className="rest-mini" onClick={() => setTrainingOpen(true)} aria-label="打开正在进行的休息计时"><span>{timer.remaining === 0 ? '休息结束' : timer.running ? '组间休息' : '休息已暂停'}</span><strong>{timerLabel(timer.remaining)}</strong><span>打开训练面板 ↑</span></button>}
    <CourseSheet course={hubCourse} onClose={()=>setHubCourse(null)} askCoach={askCoach}/>
    <StrengthDrawer open={strengthOpen} onClose={() => setStrengthOpen(false)} controller={controller} askCoach={askCoach} />
    <nav className="navigation" aria-label="工作区">{navigation.map(item => <a key={item.panel} href={item.panel === 'coach' ? '#coach' : `#${item.panel}`} aria-current={selected === item.panel ? 'page' : undefined}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.icon} /></svg>{item.label}</a>)}</nav>
  </div>;
}
