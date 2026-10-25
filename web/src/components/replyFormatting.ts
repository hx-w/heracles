import type { Message } from '../types';

type Node = { type: string; value?: string; children?: Node[]; data?: { hProperties: { className: string } } };
const quantities = /\d+分\d+秒|\d+:\d{2}(?:\/(?:公里|km))?|\d+(?:\.\d+)?(?:[-–～]\d+(?:\.\d+)?)?\s*(?:公里|千米|厘米|毫米|分钟|小时|毫秒|秒|米|组|次|bpm|ms|%|\/100)|(?:平均|最高|静息)?心率(?:约|为|：|:)?\s*\d+(?:[-–]\d+)?|步频(?:约|为)?\s*\d+|Z[1-5]/g;

// Emphasis preserves the original report text; it never supplies a measurement.
export function remarkMetricEmphasis() {
  return (tree: unknown) => {
    function visit(node: Node) {
      if (['strong', 'code', 'inlineCode', 'link'].includes(node.type)) return;
      if (node.type === 'paragraph' && node.children) {
        let remaining = 6;
        node.children = node.children.flatMap(child => {
          if (child.type !== 'text' || !child.value || remaining === 0) return [child];
          const out: Node[] = []; let cursor = 0;
          for (const match of child.value.matchAll(quantities)) {
            if (!remaining) break;
            const index = match.index!;
            if (index > cursor) out.push({type:'text',value:child.value.slice(cursor,index)});
            out.push({type:'strong',children:[{type:'text',value:match[0]}],data:{hProperties:{className:'metric-emphasis'}}});
            cursor=index+match[0].length; remaining--;
          }
          if (!out.length) return [child];
          if (cursor < child.value.length) out.push({type:'text',value:child.value.slice(cursor)});
          return out;
        });
      } else node.children?.forEach(visit);
    }
    visit(tree as Node);
  };
}

export function reportedActivityFacts(message: Message) {
  if (message.highlights?.length) return [];
  const report = message.sections?.filter(s=>/执行|实际|活动|数据/.test(s.title)).flatMap(s=>s.items).find(s=>/实际完成\s*\d/.test(s));
  if (!report) return [];
  return [
    {label:'距离',value:report.match(/实际完成\s*([\d.]+\s*(?:公里|千米))/)?.[1]},
    {label:'用时',value:report.match(/(\d+分\d+秒)/)?.[1]},
    {label:'平均配速',value:report.match(/平均配速\s*(\d+:\d{2}\/(?:公里|km))/)?.[1]},
    {label:'平均心率',value:report.match(/平均心率\s*(\d+)/)?.[1]},
  ].filter((fact): fact is {label:string;value:string} => Boolean(fact.value));
}
