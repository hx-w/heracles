import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CoachController } from '../hooks/useCoachState';
import type { Message } from '../types';
import { ReplyMarkdown } from './ReplyMarkdown';
import { ReplyVisuals } from './ReplyVisuals';
import { ExerciseCard } from './ExerciseCard';
import { ProposalCard } from './ProposalCard';
import './rich-reply.css';


function AssistantReply({ message }: { message: Message }) {
  return <div className="reply-content rich-reply" lang="zh">
    {message.content && <ReplyMarkdown content={message.content} />}
    {message.exercises?.map(exercise => <ExerciseCard key={exercise.id} exercise={exercise} compact />)}
    <ReplyVisuals visuals={message.visuals || []} />
    {message.sections?.map((section, index) => <section key={index} className="reply-section">
      <h2 className="reply-section-title">{section.title}</h2>
      {section.items.map((item, itemIndex) => <ReplyMarkdown key={itemIndex} content={item} />)}
    </section>)}
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
  useEffect(() => {
    if (active) {
      followLatest.current = true;
      const messages = messagesRef.current;
      if (messages) messages.scrollTop = messages.scrollHeight;
    }
  }, [active, Boolean(state)]);
  useEffect(() => {
    const messages = messagesRef.current;
    if (active && messages && followLatest.current) messages.scrollTop = messages.scrollHeight;
  }, [messageCount, coachBusy, active]);
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
    if (await sendChat(message)) setDraft(current => current.trim() === message ? '' : current);
  }
  return <section id="coach" className={`panel coach-panel${active ? ' is-active' : ''}`} aria-labelledby="coach-heading">
    <div className="coach-topline"><div><span className="coach-glyph" aria-hidden="true">✳</span><h1 id="coach-heading">你的训练教练</h1></div><span>{coachBusy ? '正在分析' : coach?.available ? (coach.model || 'AI 教练') : '等待连接'}</span></div>
    <div className="messages" ref={messagesRef} aria-label="教练对话" onScroll={event => {
      const element = event.currentTarget;
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      {state?.messages.length ? state.messages.map((message, index) => <article key={message.id ?? `${index}-${message.created_at}`} className={`message message-${message.role}`} aria-label={message.role === 'user' ? '你' : '教练'}>
        {message.role === 'assistant' ? <div><span className="message-author">Heracles</span><AssistantReply message={message} />{message.proposal_id && state.proposals.find(p => p.id === message.proposal_id) && <ProposalCard proposal={state.proposals.find(p => p.id === message.proposal_id)!} controller={controller} />}{message.proposal_error && <p className="feedback is-error">{message.proposal_error}</p>}</div> : <p className="message-body">{message.content}</p>}
      </article>) : <div className="conversation-empty"><span className="coach-empty-glyph" aria-hidden="true">✳</span><h2>训练有计划，<br />变化也有回应。</h2><p>告诉我你今天的情况。我们一起把计划变成适合你的每一步。</p><div className="suggested-prompts">{['今天只有 20 分钟，怎么调整？', '解释一下今天训练的目的和执行细节', '帮我制定未来七天的训练计划'].map(text => <button type="button" key={text} onClick={() => { setDraft(text); inputRef.current?.focus(); }}>{text}<span aria-hidden="true">↗</span></button>)}</div></div>}
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
