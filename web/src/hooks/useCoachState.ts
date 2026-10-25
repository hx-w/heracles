import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { CoachState, Feedback, Profile, CheckInInput } from '../types';

export interface CoachController {
  state: CoachState | null;
  loading: boolean;
  loadError: string;
  reload: () => Promise<void>;
  profileSaving: boolean;
  profileFeedback: Feedback;
  saveProfile: (profile: Profile) => Promise<boolean>;
  coachBusy: boolean;
  chatFeedback: Feedback;
  sendChat: (message: string) => Promise<boolean>;
  actionBusy: boolean;
  planFeedback: Feedback;
  saveCheckIn: (checkin: CheckInInput) => Promise<boolean>;
  decideProposal: (id: string, action: 'accept' | 'dismiss' | 'revert') => Promise<void>;
  syncBusy: boolean;
  syncFeedback: Feedback;
  syncGarmin: () => Promise<void>;
}

export function useCoachState(): CoachController {
  const [state, setState] = useState<CoachState | null>(null);
  const stateRef = useRef<CoachState | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const locks = useRef({ profile: false, chat: false, sync: false });
  const chatJob = useRef<{ baseline: string; observedBusy: boolean } | null>(null);
  const syncJob = useRef<{ baseline: string; started: number; observedBusy: boolean } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationLock = useRef(false);
  const [planFeedback, setPlanFeedback] = useState<Feedback>({ message: '' });
  const [profileSaving, setProfileSaving] = useState(false);
  const [chatSubmitting, setChatSubmitting] = useState(false);
  const [chatAwaiting, setChatAwaiting] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<Feedback>({ message: '' });
  const [chatFeedback, setChatFeedback] = useState<Feedback>({ message: '' });
  const [syncFeedback, setSyncFeedback] = useState<Feedback>({ message: '' });

  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const promise = (async () => {
      setLoading(true);
      try {
        const next = await api.state();
        const chat = chatJob.current;
        if (chat) {
          if (next.coach.busy) chat.observedBusy = true;
          const replies = JSON.stringify(next.messages.filter(message => message.role === 'assistant'));
          if (!next.coach.busy && (chat.observedBusy || replies !== chat.baseline || next.coach.error)) {
            chatJob.current = null;
            setChatAwaiting(false);
            setChatFeedback(next.coach.error
              ? { message: next.coach.error, error: true }
              : { message: '教练已回复，训练方案需要你确认采用。' });
          }
        }
        const sync = syncJob.current;
        if (sync && next.syncing) sync.observedBusy = true;
        if (sync && !next.syncing && (sync.observedBusy || JSON.stringify(next.plan) !== sync.baseline || Date.now() - sync.started > 120000)) {
          const finished = sync.observedBusy || JSON.stringify(next.plan) !== sync.baseline;
          syncJob.current = null;
          setSyncBusy(false);
          setSyncFeedback(next.plan.status === 'error'
            ? { message: next.plan.sync_error || 'Garmin 同步失败，保留上次数据。', error: true }
            : finished
              ? { message: next.plan.status === 'missing' ? '同步完成，Garmin 未返回训练计划。' : '已读取最新 Garmin 数据。' }
              : { message: '已提交同步，尚未收到新结果。页面会继续自动读取状态。' });
        }
        stateRef.current = next;
        setState(next);
        setLoadError('');
      } catch (error) {
        setLoadError(errorMessage(error));
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = promise;
    return promise;
  }, []);

  const coachBusy = Boolean(state?.coach.busy || chatSubmitting || chatAwaiting);
  const syncRunning = Boolean(state?.syncing || syncBusy);
  const actionBusy = coachBusy || profileSaving || syncRunning || mutationBusy;

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    let timer: number;
    let active = true;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await reload();
        if (active) schedule();
      }, document.hidden ? 60000 : coachBusy || syncRunning ? 2500 : 30000);
    };
    const refresh = () => { if (!document.hidden) void reload(); };
    schedule();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [reload, coachBusy, syncRunning]);

  async function saveProfile(profile: Profile): Promise<boolean> {
    if (!stateRef.current || stateRef.current.coach.busy || mutationLock.current || locks.current.profile || locks.current.chat || chatJob.current || locks.current.sync || syncJob.current) return false;
    locks.current.profile = true;
    setProfileSaving(true);
    setProfileFeedback({ message: '保存中…' });
    try {
      const saved = await api.profile(profile);
      // A pre-save state request must not overwrite the accepted mutation.
      await inFlight.current;
      const next = { ...stateRef.current, profile: saved };
      stateRef.current = next;
      setState(next);
      setProfileFeedback({ message: '已保存' });
      await reload();
      return true;
    } catch (error) {
      setProfileFeedback({ message: errorMessage(error), error: true });
      return false;
    } finally {
      locks.current.profile = false;
      setProfileSaving(false);
    }
  }

  async function sendChat(message: string): Promise<boolean> {
    const current = stateRef.current;
    if (mutationLock.current || !current?.coach.available || current.coach.busy || locks.current.chat || chatJob.current || locks.current.profile || locks.current.sync || syncJob.current) return false;
    locks.current.chat = true;
    setChatSubmitting(true);
    setChatFeedback({ message: '正在提交给 教练…' });
    const baseline = JSON.stringify(current.messages.filter(item => item.role === 'assistant'));
    try {
      const result = await api.chat(message);
      if (!result.accepted) throw new Error('教练未接收这条消息，请稍后重试。');
      await inFlight.current;
      chatJob.current = { baseline, observedBusy: false };
      setChatAwaiting(true);
      setChatFeedback({ message: '留言已提交，教练解读与建议会自动出现。' });
      await reload();
      return true;
    } catch (error) {
      setChatFeedback({ message: errorMessage(error), error: true });
      await reload();
      return false;
    } finally {
      locks.current.chat = false;
      setChatSubmitting(false);
    }
  }


  async function syncGarmin(): Promise<void> {
    const current = stateRef.current;
    if (mutationLock.current || !current || current.syncing || locks.current.sync || syncJob.current) return;
    locks.current.sync = true;
    setSyncBusy(true);
    setSyncFeedback({ message: '正在请求 Garmin 同步…' });
    const baseline = JSON.stringify(current.plan);
    try {
      const result = await api.sync();
      if (!result.accepted) throw new Error('同步请求未被接收，请稍后重试。');
      await inFlight.current;
      syncJob.current = { baseline, started: Date.now(), observedBusy: false };
      setSyncFeedback({ message: '已提交，正在等待 Garmin 返回数据…' });
      await reload();
    } catch (error) {
      setSyncFeedback({ message: errorMessage(error), error: true });
      setSyncBusy(false);
    } finally {
      locks.current.sync = false;
    }
  }

  async function saveCheckIn(checkin: CheckInInput): Promise<boolean> {
    if (actionBusy || mutationLock.current) return false;
    mutationLock.current = true;
    setMutationBusy(true);
    try {
      await api.checkin(checkin);
      await inFlight.current;
      await reload();
      setPlanFeedback({ message: '已记录今天的状态。' });
      return true;
    } catch (error) {
      setPlanFeedback({ message: errorMessage(error), error: true });
      return false;
    } finally { mutationLock.current = false; setMutationBusy(false); }
  }

  async function decideProposal(id: string, action: 'accept' | 'dismiss' | 'revert'): Promise<void> {
    if (actionBusy || mutationLock.current) return;
    mutationLock.current = true;
    setMutationBusy(true);
    try {
      await api.proposal(id, action);
      setPlanFeedback({ message: action === 'accept' ? '已采用 Heracles 方案，佳明原课保留。' : action === 'revert' ? '已撤销，恢复佳明原课或移除独立安排。' : '已保留原安排。' });
    } catch (error) {
      setPlanFeedback({ message: errorMessage(error), error: true });
    } finally {
      await inFlight.current;
      await reload();
      mutationLock.current = false;
      setMutationBusy(false);
    }
  }

  return { state, loading, loadError, reload, profileSaving, profileFeedback, saveProfile, coachBusy,
    chatFeedback, sendChat, actionBusy, planFeedback, saveCheckIn, decideProposal, syncBusy: syncRunning, syncFeedback, syncGarmin };
}
