import type { Exercise } from '../types';
export function ExerciseCard({ exercise, compact = false }: { exercise: Exercise; compact?: boolean }) {
  return <article className="exercise-card"><div className="exercise-card-heading"><h3>{exercise.name}</h3><span>{exercise.equipment}</span></div>
    {exercise.image && <img src={exercise.image} alt={`${exercise.name} 通用动作示范`} loading="lazy" width={480} height={320} />}
    <p className="exercise-setup">{exercise.setup}</p>
    <ol>{exercise.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
    <details><summary>动作要点与视频</summary>{exercise.video && <video controls playsInline preload="none" poster={exercise.image || undefined} src={exercise.video}>你的浏览器不支持此视频。</video>}
      {exercise.animation && <details><summary>查看动作循环示意</summary><img src={exercise.animation} alt={`${exercise.name} 动作循环`} loading="lazy" width={360} height={240} /></details>}
      <ul>{exercise.mistakes.map((item, i) => <li key={i}>{item}</li>)}</ul>
      {!exercise.video && <p className="exercise-credit">此动作暂有图片示范，尚无目录内视频。</p>}
    </details>
    {!compact && <p className="exercise-credit">训练部位：{exercise.muscles}</p>}
    <details className="exercise-credit"><summary>素材与许可</summary><a href={exercise.source_url} target="_blank" rel="noreferrer">{exercise.source_name}</a> · {exercise.author}<br /><a href={exercise.license_url} target="_blank" rel="noreferrer">{exercise.license}</a>{exercise.credits?.map((credit, i) => <p key={i}>{credit.kind}：{credit.author} · <a href={credit.license_url} target="_blank" rel="noreferrer">{credit.license}</a></p>)}</details>
  </article>;
}
