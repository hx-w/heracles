import {useTrainingDialog} from '../hooks/useTrainingDialog';
import {useRef, useState} from 'react';
import type {CoachState, MetricKey, MetricSeries} from '../types';
import {number} from '../format';
import {Trend} from './ReplyVisuals';

const metrics: {key:MetricKey; label:string; unit:string; color:string}[] = [
  {key:'readiness',label:'训练准备度',unit:'/100',color:'amber'},
  {key:'sleep_hours',label:'睡眠',unit:'小时',color:'blue'},
  {key:'hrv',label:'夜间心率变异',unit:'毫秒',color:'mint'},
  {key:'recovery_hours',label:'恢复时间',unit:'小时',color:'lilac'},
];
// Calendar days, rather than the last N observations. Missing days stay missing.
function windowSeries(series:MetricSeries|undefined, end:string, days:number, key:MetricKey):MetricSeries {
  const dates=Array.from({length:days},(_,i)=>{const d=new Date(`${end}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-days+1+i);return d.toISOString().slice(0,10)});
  return {...series,key,label:series?.label||'',unit:series?.unit||'',description:series?.description||'',points:dates.map(date=>series?.points.find(p=>p.date===date)||{date,value:null,status:'missing',source_at:null,fetched_at:null})};
}
function Spark({series}:{series:MetricSeries}) {
  const nums=series.points.flatMap(p=>p.value===null||p.status!=='available'?[]:[p.value]);
  if(!nums.length)return <span className="spark-empty">暂无趋势</span>;
  const min=Math.min(...nums),max=Math.max(...nums);let paths:string[]=[];let current='';
  const dots=series.points.flatMap((p,i)=>{if(p.value===null||p.status!=='available'){if(current)paths.push(current);current='';return []}const x=4+i/Math.max(1,series.points.length-1)*92,y=27-(p.value-min)/(max-min||1)*22;current+=`${current?' L':'M'}${x},${y}`;return [{x,y}]});if(current)paths.push(current);
  return <svg className="metric-spark" viewBox="0 0 100 32" aria-hidden="true">{paths.map((d,i)=><path key={i} d={d}/>)}{dots.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r="1.8"/>)}</svg>;
}
export function HealthDashboard({state,askCoach}:{state:CoachState|null;askCoach:(message:string)=>void}) {
  const [open,setOpen]=useState(false),[period,setPeriod]=useState(7),[selected,setSelected]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null);
  useTrainingDialog(dialog,open);
  const history=state?.health_history||{},end=state?.today||new Date().toISOString().slice(0,10);
  const spec=metrics[selected],series=windowSeries(history[spec.key],end,period,spec.key);
  const valid=series.points.filter(p=>p.value!==null&&p.status==='available');
  const mean=valid.length?valid.reduce((sum,p)=>sum+p.value!,0)/valid.length:null;
  const first=valid[0],last=valid.at(-1),delta=valid.length>1?last!.value!-first.value!:null;
  return <section className="health-dashboard" aria-labelledby="health-heading">
    <div className="today-section-title"><h2 id="health-heading">恢复与身体</h2><button className="text-button" onClick={()=>setOpen(true)} disabled={!state}>查看趋势 ↗</button></div>
    <div className="health-grid">{metrics.map(({key,label,unit,color},i)=>{
      const m=state?.metrics.find(m=>m.key===key),c=state?.health_changes?.find(c=>c.key===key);
      const available=m?.status==='available'&&m.value!=null;
      const change=available&&c?.delta!=null&&(!m.data_date||m.data_date===c.date)?`${c.delta>0?'+':''}${number(c.delta)} · 较${c.previous_date?.slice(5)}`:m?.value!=null?`${m.fresh?'测量':'历史'} ${m.data_date?.slice(5)||m.source_at?.slice(5,10)||'记录'}`:'暂无记录';
      return <button key={key} disabled={!state} className={`health-tile tone-${color}`} onClick={()=>{setSelected(i);setOpen(true)}} aria-label={`查看${label}历史变化`}>
        <span>{label}{m?.value!=null&&!m.fresh&&<small className="metric-stale">历史</small>}</span>
        <div className="metric-reading"><strong>{m?.value!=null?number(m.value):'—'}<small>{m?.value!=null?unit:''}</small></strong><Spark series={windowSeries(history[key],end,7,key)}/></div>
        <span className="metric-change">{change}</span>
      </button>;
    })}</div>
    <dialog className={`training-drawer health-sheet tone-${spec.color}`} ref={dialog} aria-labelledby="health-sheet-title" onClose={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)setOpen(false)}}><div className="drawer-content">
      <header className="drawer-header"><h2 id="health-sheet-title">身体变化</h2><button className="text-button" onClick={()=>setOpen(false)} aria-label="关闭身体变化" autoFocus>关闭</button></header>
      <div className="period-control" role="group" aria-label="历史时间范围">{[7,30].map(n=><button key={n} aria-pressed={period===n} onClick={()=>setPeriod(n)}>近{n}天</button>)}</div>
      <div className="health-metric-tabs" role="group" aria-label="趋势指标">{metrics.map((m,i)=><button key={m.key} className={`tone-${m.color}`} aria-pressed={selected===i} onClick={()=>setSelected(i)}>{m.label.replace('训练','').replace('夜间','')}</button>)}</div>
      <section className="health-chart-panel" aria-label={`${spec.label}趋势`}><h3>{spec.label}<small>{spec.unit}</small></h3><Trend key={`${spec.key}-${period}`} series={series}/>
        <div className="trend-summary"><div><span>{period}天可用均值</span><strong>{mean===null?'—':number(mean)}<small>{mean===null?'':spec.unit}</small></strong></div><div><span>{delta===null?'有效样本不足':`${first.date.slice(5)} → ${last!.date.slice(5)}`}</span><strong>{delta===null?'—':`${delta>0?'+':''}${number(delta)}`}</strong></div></div>
        <p className="history-units">{valid.length}/{period} 天有记录 · 点选曲线或用方向键查看。缺失日期保留空档。</p>
      </section>
      <details className="health-records"><summary>查看每日原始数值</summary><div className="history-table-scroll"><table><caption className="sr-only">近{period}天身体指标，缺失值显示为横线</caption><thead><tr><th>日期</th>{metrics.map(m=><th key={m.key}>{m.label.replace('训练','').replace('夜间','')}<small>{m.unit}</small></th>)}</tr></thead><tbody>{[...series.points].reverse().map(p=><tr key={p.date}><th scope="row">{p.date.slice(5)}</th>{metrics.map(m=>{const value=history[m.key]?.points.find(v=>v.date===p.date);return <td key={m.key}>{value?.value!=null&&value.status==='available'?number(value.value):'—'}</td>})}</tr>)}</tbody></table></div></details>
      <button className="primary sheet-primary" disabled={!state} onClick={()=>{setOpen(false);askCoach(`请分析近${period}天身体指标的真实变化，结合训练负荷与主观恢复，说明最应关注什么、与此前相比哪里变化，以及是否需要调整训练。缺失和历史数据请明确。`)}}>让教练分析这些变化</button>
    </div></dialog>
  </section>;
}
