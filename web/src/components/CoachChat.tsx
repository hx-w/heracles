import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { Message } from '../types';
import { reportedActivityFacts } from './replyFormatting';
import { ReplyMarkdown } from './ReplyMarkdown';
import { ReplyVisuals } from './ReplyVisuals';
import { ExerciseCard } from './ExerciseCard';
import { ProposalCard } from './ProposalCard';
import './rich-reply.css';


function AssistantReply({ message }: { message: Message }) {
  const facts=reportedActivityFacts(message);
  const sections=message.sections||[];
  const hasActions=Boolean(message.actions?.length);
  const main=hasActions?sections.filter(s=>/警|疼痛|风险|停止/.test(s.title)):sections.filter(s=>/建议|下一|注意|调整|改进|判断/.test(s.title));
  const detail=sections.filter(s=>!main.includes(s));
  const renderSection=(section: typeof sections[number],index:number)=><section key={index} className="reply-section"><h2 className="reply-section-title">{section.title}</h2>{section.items.map((item,i)=><ReplyMarkdown key={i} content={item}/>)}</section>;
  return <div className="reply-content rich-reply" lang="zh">
    {message.content && <div className="coach-verdict"><ReplyMarkdown content={message.content}/></div>}
    {facts.length>0&&<dl className="reported-facts" aria-label="本次训练数据">{facts.map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>}
    {Boolean(message.highlights?.length)&&<div className="reply-highlights">{message.highlights?.map((h,i)=><div className={`reply-highlight highlight-${h.kind}`} key={i}><span>{h.label}</span><strong>{h.text}</strong></div>)}</div>}
    {message.comparisons?.map((c,i)=><section className="reply-comparison" key={i}><h2>{c.title}</h2>{c.items.map((row,j)=><div className="comparison-row" key={j}><h3>{row.label}</h3><div><span>原先</span><strong>{row.before}</strong></div><div><span>建议 / 现在</span><strong>{row.after}</strong></div></div>)}</section>)}
    {Boolean(message.actions?.length)&&<section className="reply-actions"><h2>接下来怎么做</h2>{message.actions?.map((a,i)=><article key={i}><div><span className="action-number">{i+1}</span><h3>{a.title}</h3>{a.when&&<span className="action-when">{a.when}</span>}</div><ul>{a.steps.map((step,j)=><li key={j}><ReplyMarkdown content={step}/></li>)}</ul></article>)}</section>}
    {message.exercises?.map(exercise => <ExerciseCard key={exercise.id} exercise={exercise} compact />)}
    {main.map(renderSection)}
    {detail.length>0&&<details className="reply-detail"><summary>训练数据与分析依据</summary>{detail.map(renderSection)}</details>}
    {Boolean(message.visuals?.length)&&<details className="reply-detail"><summary>查看身体趋势</summary><ReplyVisuals visuals={message.visuals||[]}/></details>}

  </div>;
}

export function CoachChat({ controller, active, prompt }: { controller: CoachController; active: boolean; prompt: { text: string; key: number } | null }) {
  const { state, coachBusy, actionBusy, chatFeedback, sendChat } = controller;
  const [draft, setDraft] = useState('');
  const [inputError, setInputError] = useState('');
  useEffect(() => { if (prompt) { setDraft(prompt.text); inputRef.current?.focus(); } }, [prompt?.key]);
  const coach = state?.coach;
  const feedback = inputError || coach?.error || (!coach?.available && state ? '教练暂不可用' : '') || (chatFeedback.error ? chatFeedback.message : '');
  const feedbackError = Boolean(inputError || coach?.error || (!coach?.available && state) || chatFeedback.error);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const messageCount = state?.messages.length || 0;
  function showLatest() { const container=messagesRef.current;if(!container)return;const replies=container.querySelectorAll<HTMLElement>('.message-assistant');const latest=replies[replies.length-1];container.scrollTop=latest?Math.max(0,latest.offsetTop-12):container.scrollHeight; }
  useEffect(()=>{if(active){followLatest.current=true;showLatest()}},[active,Boolean(state)]);
  useEffect(()=>{const container=messagesRef.current;if(active&&container&&followLatest.current){if(coachBusy)container.scrollTop=container.scrollHeight;else showLatest()}},[messageCount,coachBusy,active]);
  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 136)}px`;
    }
  }, [draft, active]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) { setInputError('请先写下想告诉教练的内容。'); return; }
    if (!state?.coach.available || actionBusy) return;
    setInputError('');
    followLatest.current=true;
    if (await sendChat(message)) setDraft(current => current.trim() === message ? '' : current);
  }
  return <section id="coach" className={`panel coach-panel${active ? ' is-active' : ''}`} aria-labelledby="coach-heading">
    <div className="coach-topline"><h1 id="coach-heading">教练</h1>{coachBusy?<span>正在分析</span>:state?.messages.length?<button className="text-button" onClick={showLatest}>最新结论 ↓</button>:<span>结合训练与恢复</span>}</div>
    <div className="messages" ref={messagesRef} aria-label="教练对话" onScroll={event => {
      const element = event.currentTarget;
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      {state?.messages.length ? state.messages.map((message, index) => <article key={message.id ?? `${index}-${message.created_at}`} className={`message message-${message.role}`} aria-label={message.role === 'user' ? '你' : '教练'}>
        {message.role === 'assistant' ? <div><AssistantReply message={message} />{message.proposal_id && state.proposals.find(p => p.id === message.proposal_id) && <ProposalCard proposal={state.proposals.find(p => p.id === message.proposal_id)!} controller={controller} />}{message.proposal_error && <p className="feedback is-error">{message.proposal_error}</p>}</div> : <p className="message-body">{message.content}</p>}
      </article>) : <div className="conversation-empty"><h2>今天想解决什么？</h2><div className="suggested-prompts">{['复盘最近一次训练', '看看近七天的恢复变化', '今天只有30分钟，调整训练安排', '如何安排力量训练？'].map(text => <button type="button" key={text} onClick={() => { setDraft(text); inputRef.current?.focus(); }}>{text}<span aria-hidden="true">↗</span></button>)}</div></div>}
      {coachBusy && <p className="busy-note" role="status" aria-live="polite">{coach?.phase || '思考中…'}</p>}
    </div>
    <form className="chat-form" onSubmit={submit}>
      <div className="composer">
        <label htmlFor="chat-message" className="sr-only">给教练留言</label>
        <textarea id="chat-message" ref={inputRef} rows={1} required maxLength={4000} value={draft} onChange={event => { setDraft(event.target.value); setInputError(''); }} placeholder="说说今天的状况，或问问训练…" onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
        <button type="submit" className="primary send-button" aria-label="发送" disabled={!draft.trim() || !coach?.available || actionBusy}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </div>
      {controller.planFeedback.message && <p className={`feedback${controller.planFeedback.error ? ' is-error' : ''}`} role="status">{controller.planFeedback.message}</p>}
      <p className={`feedback${feedbackError ? ' is-error' : ''}`} role="status" aria-live="polite">{feedback}</p>
    </form>
  </section>;
}
