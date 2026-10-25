import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkMetricEmphasis } from './replyFormatting';

function safeLink(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch { return ''; }
}

export const ReplyMarkdown = memo(function ReplyMarkdown({ content }: { content: string }) {
  return <div className="reply-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMetricEmphasis]} skipHtml urlTransform={safeLink} components={{
    img: () => null,
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    table: ({ children }) => <div className="reply-table-scroll" role="region" aria-label="回复表格，可横向滚动" tabIndex={0}><table>{children}</table></div>,
    input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled aria-label={checked ? '已完成' : '未完成'} />,
    td: ({ node, children, style }) => {
      const text = node?.children.map(child => child.type === 'text' ? child.value : '').join('') || '';
      return <td style={{ ...style, ...(/^\s*[-+−]?\d[\d,.%\s]*\s*$/.test(text) ? { textAlign: 'right' } : {}) }}>{children}</td>;
    },
  }}>{content}</ReactMarkdown></div>;
});
