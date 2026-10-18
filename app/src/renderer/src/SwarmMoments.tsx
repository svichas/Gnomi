import { useEffect, useId, useRef } from 'react';
import { useSigma } from '@react-sigma/core';
import { Icon } from './Icon.tsx';
import type { SwarmMoment } from './swarm-moments.ts';

const momentIcon = (moment: SwarmMoment) => moment.tone === 'friction' ? 'alert' : moment.tone === 'success' ? 'check' : moment.tone === 'social' ? 'message' : 'spark';
type Props = { moments: SwarmMoment[]; name(id: string): string; onOpen(id: string, seq?: number): void };

/** A bounded DOM layer follows Sigma's camera without putting every animation frame through React. */
export function MomentBubbles({ moments, name, onOpen, showConversations }: Props & { showConversations: boolean }) {
  const sigma = useSigma();
  const root = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, '');
  useEffect(() => {
    const items = moments.map((moment) => ({
      moment,
      bubble: root.current?.querySelector<HTMLButtonElement>(`[data-bubble="${moment.seq}"]`),
      stem: root.current?.querySelector<SVGPathElement>(`[data-stem="${moment.seq}"]`),
      arrow: root.current?.querySelector<SVGPathElement>(`[data-arrow="${moment.seq}"]`),
    }));
    const position = () => {
      const { width, height } = sigma.getDimensions();
      const graph = sigma.getGraph();
      const occupied: { x: number; y: number; w: number; h: number }[] = [];
      const point = (id: string) => {
        const key = `persona:${id}`;
        return graph.hasNode(key) ? sigma.graphToViewport(graph.getNodeAttributes(key) as { x: number; y: number }) : null;
      };
      if (graph.order <= 24) graph.forEachNode((_, attributes) => {
        const p = sigma.graphToViewport(attributes as { x: number; y: number });
        const labelWidth = Math.min(180, String(attributes.label).length * 8);
        occupied.push({ x: p.x - labelWidth / 2, y: p.y - 16, w: labelWidth, h: 52 });
      });
      for (const { moment, bubble, stem, arrow } of items) {
        if (!bubble || !stem) continue;
        const p = point(moment.persona);
        const visible = p && p.x >= 16 && p.x <= width - 16 && p.y >= 16 && p.y <= height - 36;
        bubble.hidden = !visible;
        stem.style.display = 'none';
        if (arrow) arrow.style.display = 'none';
        if (!visible) continue;
        const target = moment.target && point(moment.target);
        if (arrow && target && target.x >= 0 && target.x <= width && target.y >= 0 && target.y <= height) {
          const dx = target.x - p.x, dy = target.y - p.y;
          const length = Math.hypot(dx, dy);
          if (length >= 40) {
            const bend = Math.min(48, length * 0.18);
            const cx = (p.x + target.x) / 2 - dy / length * bend;
            const cy = (p.y + target.y) / 2 + dx / length * bend;
            const startLength = Math.hypot(cx - p.x, cy - p.y);
            const endLength = Math.hypot(target.x - cx, target.y - cy);
            arrow.setAttribute('d', `M ${p.x + (cx - p.x) / startLength * 16} ${p.y + (cy - p.y) / startLength * 16} Q ${cx} ${cy} ${target.x - (target.x - cx) / endLength * 19} ${target.y - (target.y - cy) / endLength * 19}`);
            arrow.style.display = '';
          }
        }
        const w = bubble.offsetWidth;
        const h = bubble.offsetHeight;
        const candidates = [
          { x: p.x - w / 2, y: p.y - h - 24 },
          { x: p.x - w / 2, y: p.y + 44 },
          { x: p.x + 32, y: p.y - h - 16 },
          { x: p.x - w - 32, y: p.y - h - 16 },
          { x: p.x - w / 2, y: p.y - h - 80 },
          { x: p.x - w / 2, y: p.y + 80 },
        ].map((c) => ({ x: Math.max(8, Math.min(width - w - 8, c.x)), y: Math.max(8, Math.min(height - h - 48, c.y)), w, h }));
        const place = candidates.find((c) => !occupied.some((o) => c.x < o.x + o.w + 8 && c.x + w + 8 > o.x && c.y < o.y + o.h + 8 && c.y + h + 8 > o.y));
        // All moments remain available in the list when a dense or zoomed view has no room for a bubble.
        bubble.hidden = !place;
        if (!place) continue;
        occupied.push(place);
        bubble.style.transform = `translate(${place.x}px, ${place.y}px)`;
        stem.setAttribute('d', `M ${p.x} ${p.y} L ${Math.max(place.x + 12, Math.min(place.x + w - 12, p.x))} ${Math.max(place.y, Math.min(place.y + h, p.y))}`);
        stem.style.display = '';
      }
    };
    sigma.on('afterRender', position);
    position();
    return () => { sigma.off('afterRender', position); };
  }, [sigma, moments, showConversations]);

  return <div ref={root} className="swarm-bubbles">
    <svg className="swarm-moment-links" aria-hidden="true">
      <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="currentColor" /></marker></defs>
      {moments.map((moment) => <g key={moment.seq}>
        <path data-stem={moment.seq} className="swarm-bubble-stem" />
        {showConversations && moment.target && <path data-arrow={moment.seq} className="swarm-social-arrow" markerEnd={`url(#${marker})`} />}
      </g>)}
    </svg>
    {moments.map((moment) => <button key={moment.seq} data-bubble={moment.seq} data-tone={moment.tone} className="swarm-bubble" onClick={() => onOpen(moment.persona, moment.seq)} title={`${name(moment.persona)} · ${moment.label}${moment.target ? ` → ${name(moment.target)}` : ''}\n${moment.text}`} aria-label={`${name(moment.persona)}: ${moment.label}${moment.target ? ` to ${name(moment.target)}` : ''}. ${moment.text}. View activity`}>
      <span className="swarm-moment-label"><Icon name={momentIcon(moment)} size={12} />{moment.label}</span>
      <span className="swarm-bubble-text">{moment.target ? `→ ${name(moment.target)}` : moment.text}</span>
    </button>)}
  </div>;
}

export function MomentList({ moments, name, onOpen }: Props) {
  return <ol className="swarm-moments-list" aria-label="Recent persona moments">
    {moments.map((moment) => <li key={moment.seq} data-tone={moment.tone}>
      <button onClick={() => onOpen(moment.persona, moment.seq)}>
        <span className="swarm-moment-label"><Icon name={momentIcon(moment)} size={14} />{moment.label}{moment.detail && <small>{moment.detail}</small>}</span>
        <span className="swarm-moment-people">{name(moment.persona)}{moment.target && <> <span aria-label="to">→</span> {name(moment.target)}</>}</span>
        <span className="swarm-moment-quote">{moment.text}</span>
      </button>
    </li>)}
  </ol>;
}
