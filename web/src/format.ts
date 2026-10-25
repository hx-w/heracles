import type { GarminWorkoutKind, GarminWorkoutStatus } from './types';

export const statusLabels: Record<GarminWorkoutStatus, string> = { planned: '待训练', completed: '已完成', skipped: '已跳过', unknown: '状态未提供' };
export const kindLabels: Record<GarminWorkoutKind, string> = { rest: '休息', running: '跑步', cycling: '骑行', strength: '力量', other: '其他运动' };
export const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const number = (value: unknown, digits = 1) => numeric(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '未提供';

export function dateValue(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+08:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function dateLabel(value: string | null | undefined, includeTime = false, timezone = 'Asia/Shanghai') {
  return dateValue(value)?.toLocaleString('zh-CN', { timeZone: timezone, month: 'numeric', day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short' }) }) || '未提供';
}
export function duration(seconds: number) {
  if (!numeric(seconds)) return '未提供';
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes ? `${minutes} 分钟${remaining ? ` ${remaining} 秒` : ''}` : `${remaining} 秒`;
}
