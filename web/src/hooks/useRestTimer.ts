import { useEffect, useState } from 'react';

const key = 'heracles.rest-timer.v1';
interface Timer { deadline: number | null; remaining: number; total: number; updated: number }
function restore(): Timer | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as Timer | null;
    if (!value || !Number.isFinite(value.updated) || Math.abs(Date.now() - value.updated) > 12 * 3600_000 || !Number.isFinite(value.total) || value.total < 1 || value.total > 900 || !Number.isFinite(value.remaining) || value.remaining < 0 || value.remaining > value.total || (value.deadline !== null && (!Number.isFinite(value.deadline) || value.deadline > Date.now() + 900_000))) return null;
    return value;
  } catch { return null; }
}
export function useRestTimer() {
  const [timer, setTimer] = useState<Timer | null>(restore);
  const [clock, setClock] = useState(Date.now);
  const remaining = timer ? timer.deadline === null ? timer.remaining : Math.max(0, Math.ceil((timer.deadline - clock) / 1000)) : 0;
  const running = Boolean(timer?.deadline && remaining > 0);
  useEffect(() => {
    try { if (timer) localStorage.setItem(key, JSON.stringify(timer)); else localStorage.removeItem(key); } catch { /* Timer still works when storage is unavailable. */ }
  }, [timer]);
  useEffect(() => {
    let interval: number | undefined;
    const sync = () => {
      window.clearInterval(interval);
      setClock(Date.now());
      if (running && document.visibilityState === 'visible') interval = window.setInterval(() => setClock(Date.now()), 250);
    };
    sync(); document.addEventListener('visibilitychange', sync); window.addEventListener('pageshow', sync);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', sync); window.removeEventListener('pageshow', sync); };
  }, [running]);
  function start(seconds: number) { const now = Date.now(); setClock(now); setTimer({ deadline: now + seconds * 1000, total: seconds, remaining: seconds, updated: now }); }
  function pause() { if (timer) setTimer({ ...timer, deadline: null, remaining, updated: Date.now() }); }
  function resume() { if (timer && remaining > 0) { const now = Date.now(); setClock(now); setTimer({ ...timer, deadline: now + remaining * 1000, updated: now }); } }
  function stop() { setTimer(null); }
  return { active: Boolean(timer), running, remaining, total: timer?.total || 0, start, pause, resume, stop };
}
export type RestTimer = ReturnType<typeof useRestTimer>;
export function timerLabel(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
