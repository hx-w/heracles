import { memo, useId, useState } from 'react';
import type { PointerEvent } from 'react';
import type { MessageVisual, MetricPoint, MetricSeries } from '../types';

const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const times = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
function SourceTime({ value }: { value: string | null | undefined }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <>未提供</>;
  return <time dateTime={value} title={value}>{times.format(new Date(value))}</time>;
}
function pointText(point: MetricPoint | undefined, unit: string): string {
  if (!point) return '无记录';
  if (point.status !== 'available') return `${point.status === 'error' ? '读取失败' : '缺失'}${point.value !== null ? `（缓存 ${numbers.format(point.value)} ${unit}，非当前观测）` : ''}`;
  return point.value === null || !Number.isFinite(point.value) ? '缺失' : `${numbers.format(point.value)} ${unit}`;
}
function Provenance({ point }: { point: MetricPoint | undefined }) {
  return <span className="reply-provenance">Garmin · 来源时间 <SourceTime value={point?.source_at} /> · 读取 <SourceTime value={point?.fetched_at} /> · 北京时间</span>;
}

function MetricTrend({ series }: { series: MetricSeries }) {
  const id = useId();
  const points = [...series.points].sort((a, b) => a.date.localeCompare(b.date));
  const [selected, setSelected] = useState(points.length - 1);
  const index = Math.max(0, Math.min(selected, points.length - 1));
  const point = points[index];
  const valid = points.filter(p => p.status === 'available' && p.value !== null && Number.isFinite(p.value));
  const values = valid.map(p => p.value as number);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 1;
  const padding = Math.max((maximum - minimum) * .15, Math.abs(maximum) * .025, .5);
  const low = minimum - padding;
  const high = maximum + padding;
  const dates = points.map(p => Date.parse(`${p.date}T00:00:00Z`));
  const start = dates[0] || 0;
  const span = Math.max((dates[dates.length - 1] || start) - start, 86400000);
  const x = (i: number) => points.length === 1 ? 184 : 48 + (dates[i] - start) / span * 272;
  const y = (value: number) => 156 - (value - low) / (high - low) * 126;
  let path = '';
  let connected = false;
  points.forEach((p, i) => {
    if (p.status !== 'available' || p.value === null || !Number.isFinite(p.value)) { connected = false; return; }
    path += `${connected ? 'L' : 'M'}${x(i)},${y(p.value)} `;
    connected = true;
  });
  function inspect(event: PointerEvent<SVGSVGElement>) {
    if (!points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width * 344;
    let nearest = 0;
    points.forEach((_, i) => { if (Math.abs(x(i) - position) < Math.abs(x(nearest) - position)) nearest = i; });
    setSelected(nearest);
  }
  return <div className="reply-trend" data-metric={series.key}>
    <p className="reply-metric-label">{series.label} · {series.unit || '数值'}</p>
    {series.description && <p className="reply-visual-note">{series.description}</p>}
    {valid.length ? <svg className="reply-chart" viewBox="0 0 344 194" role="img" aria-label={`${series.label}趋势，${points.length}天，${valid.length}天有记录。使用下方日期选择查看数值。`} onPointerDown={event => { inspect(event); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.buttons || event.pointerType === 'touch') inspect(event); }}>
      {[low, (low + high) / 2, high].map(value => <g key={value}><line x1="48" x2="320" y1={y(value)} y2={y(value)} className="reply-chart-grid" /><text x="41" y={y(value) + 4} textAnchor="end">{numbers.format(value)}</text></g>)}
      <path d={path} className="reply-chart-line" />
      {points.map((p, i) => p.status === 'available' && p.value !== null && Number.isFinite(p.value) ? <circle key={p.date} cx={x(i)} cy={y(p.value)} r={i === index ? 5 : 3} className="reply-chart-dot" /> : <g key={p.date} className="reply-chart-gap"><line x1={x(i) - 3} x2={x(i) + 3} y1="159" y2="165" /><line x1={x(i) - 3} x2={x(i) + 3} y1="165" y2="159" /></g>)}
      {point && <line x1={x(index)} x2={x(index)} y1="24" y2="166" className="reply-chart-selection" />}
      {points.length > 0 && <><text x="48" y="187">{points[0].date.slice(5)}</text><text x="320" y="187" textAnchor="end">{points[points.length - 1].date.slice(5)}</text></>}
    </svg> : <p className="reply-chart-empty" role="status">这段时间没有可绘制的有效记录。</p>}
    <p className="reply-visual-note">断线及 × 表示缺失或读取失败，未按零值绘制。</p>
    {points.length > 0 && <><label htmlFor={`${id}-date`}>查看日期</label><select id={`${id}-date`} className="reply-date-select" value={index} onChange={event => setSelected(Number(event.target.value))}>{points.map((p, i) => <option key={p.date} value={i}>{p.date} · {pointText(p, series.unit)}</option>)}</select><div className="reply-inspection" aria-live="polite" aria-atomic="true"><p><time dateTime={point.date}>{point.date}</time> · <strong>{pointText(point, series.unit)}</strong></p><Provenance point={point} /></div></>}
  </div>;
}
function MetricTable({ series, title }: { series: MetricSeries[]; title: string }) {
  const id = useId();
  const dates = [...new Set(series.flatMap(s => s.points.map(p => p.date)))].sort();
  const [metric, setMetric] = useState(0);
  const [selectedDate, setSelectedDate] = useState('');
  const selected = series[Math.min(metric, series.length - 1)];
  const date = dates.includes(selectedDate) ? selectedDate : dates.at(-1);
  const point = selected?.points.find(item => item.date === date);
  return <>
    <div className="reply-table-scroll" role="region" aria-label={`${title}，可横向滚动`} tabIndex={0}>
      <table className="reply-metric-table"><caption className="sr-only">{title}，Garmin 测量记录</caption>
        <thead><tr><th scope="col">日期</th>{series.map(s => <th scope="col" key={s.key}>{s.label}<br /><span className="reply-visual-note">{s.unit}</span></th>)}</tr></thead>
        <tbody>{dates.map(day => <tr key={day}><th scope="row"><time dateTime={day}>{day.slice(5).replace('-', '/')}</time></th>{series.map(s => <td key={s.key}>{pointText(s.points.find(item => item.date === day), '')}</td>)}</tr>)}</tbody>
      </table>
      {!dates.length && <p className="reply-chart-empty">没有测量日期记录。</p>}
    </div>
    {dates.length > 0 && <details className="reply-source-details"><summary>数据口径与来源</summary>
      <label htmlFor={`${id}-metric`}>指标</label><select id={`${id}-metric`} value={metric} onChange={event => setMetric(Number(event.target.value))}>{series.map((s, index) => <option key={s.key} value={index}>{s.label}</option>)}</select>
      <label htmlFor={`${id}-date`}>测量日</label><select id={`${id}-date`} value={date} onChange={event => setSelectedDate(event.target.value)}>{dates.map(day => <option key={day} value={day}>{day}</option>)}</select>
      <p className="reply-visual-note">{selected.description}</p><Provenance point={point} />
    </details>}
  </>;
}


function Visual({ visual }: { visual: MessageVisual }) {
  const id = useId();
  const [metric, setMetric] = useState(0);
  const series = visual.series[Math.min(metric, visual.series.length - 1)];
  return <section className="reply-visual" aria-labelledby={`${id}-title`} data-visual-kind={visual.kind}>
    <h3 id={`${id}-title`}>{visual.title}</h3>
    <p className="reply-visual-note">Garmin 日级记录 · 日期为设备记录日</p>
    {!visual.series.length ? <p className="reply-chart-empty">没有可用的指标记录。</p> : visual.kind === 'trend' ? <>
      {visual.series.length > 1 && <><label htmlFor={`${id}-metric`}>趋势指标</label><select id={`${id}-metric`} value={metric} onChange={event => setMetric(Number(event.target.value))}>{visual.series.map((s, i) => <option key={s.key} value={i}>{s.label}（{s.unit || '数值'}）</option>)}</select></>}
      {series && <MetricTrend key={series.key} series={series} />}
    </> : <MetricTable series={visual.series} title={visual.title} />}
  </section>;
}

export const ReplyVisuals = memo(function ReplyVisuals({ visuals }: { visuals: MessageVisual[] }) {
  return <div className="reply-visuals">{visuals.map((visual, index) => <Visual key={index} visual={visual} />)}</div>;
});
