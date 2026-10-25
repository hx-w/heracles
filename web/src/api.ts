import type { Accepted, CoachState, Profile, CheckInInput, CheckIn, Proposal, TrainingLog } from './types';

function serverError(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const body = payload as { detail?: unknown; error?: unknown };
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail.map((item: { loc?: unknown[]; msg?: string }) =>
        `${(item.loc || []).filter(part => part !== 'body').join(' / ')}：${item.msg || '输入不符合要求'}`
      ).join('\n');
    }
    if (typeof body.error === 'string') return body.error;
  }
  return status === 409 ? '教练正在处理上一条请求，请稍后再试。' : `请求失败（${status}），请稍后重试。`;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const options: RequestInit = { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      options.method = 'POST';
      if (body !== null) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
      }
    }
    const response = await fetch(path, options);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(serverError(payload, response.status));
    if (payload === null) throw new Error('服务没有返回有效数据，请稍后重试。');
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('连接超时。请求可能已被接收，请刷新状态后再试。');
    if (error instanceof TypeError) throw new Error('无法连接私人服务，请检查网络与服务器连接。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const api = {
  async state(): Promise<CoachState> {
    const state = await request<CoachState>('/api/state');
    if (!state || typeof state.today !== 'string' || !state.coach || !state.plan || !state.profile) {
      throw new Error('服务返回的数据格式不完整，请检查后端状态。');
    }
    return state;
  },
  profile: (profile: Profile) => request<Profile>('/api/profile', profile),
  chat: (message: string) => request<Accepted>('/api/chat', { message }),
  checkin: (body: CheckInInput) => request<CheckIn>('/api/checkin', body),
  proposal: (id: string, action: 'accept' | 'dismiss' | 'revert') => request<Proposal>(`/api/proposals/${encodeURIComponent(id)}/${action}`, null),
  trainingLog: (log: TrainingLog) => request<TrainingLog>('/api/training-logs', log),
  publish: (id: string) => request<{status: string; note: string}>(`/api/proposals/${encodeURIComponent(id)}/publish`, null),
  sync: () => request<Accepted>('/api/sync', null),
};

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求未能完成，请稍后重试。';
