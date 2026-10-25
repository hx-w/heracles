import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// A small, dependency-free content reveal, inspired by React Bits Fade Content.
// Only initial content entrance animates. Data updates and keyboard actions do not.
export function Reveal({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { threshold: 0.05 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={root} className={`content-reveal${visible ? ' is-visible' : ''}`}>{children}</div>;
}
