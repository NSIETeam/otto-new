/** A windowed, keyboard-accessible list; relation counts always use the complete authorized set. */
import React, { useEffect, useRef, useState } from 'react';
import type { EnterpriseNode } from './model.js';
const ROW = 76;
export function EnterpriseList({
  nodes,
  id,
  selected,
  activeIndex,
  onActiveIndex,
  onSelect,
  ownId,
}: {
  nodes: EnterpriseNode[];
  id: string;
  selected: string | null;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (id: string) => void;
  ownId: string;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const focusFrame = useRef<number>();
  const datasetKey = nodes.map((node) => node.organizationId).join('\u0000');
  useEffect(
    () => () => {
      if (focusFrame.current) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(450);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const update = () => setHeight(el.clientHeight || 450);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el || activeIndex < 0) return;
    const y = activeIndex * ROW;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + height) el.scrollTop = y + ROW - height;
    setTop(el.scrollTop);
  }, [activeIndex, height]);
  useEffect(() => {
    setTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [datasetKey]);
  const start = Math.max(0, Math.floor(top / ROW) - 3);
  const end = Math.min(nodes.length, Math.ceil((top + height) / ROW) + 3);
  const visible = nodes.slice(start, end);
  return (
    <div
      ref={viewport}
      id={id}
      role="listbox"
      aria-label="企业搜索结果"
      className="star-result-window"
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: nodes.length * ROW, position: 'relative' }}>
        {visible.map((node, offset) => {
          const index = start + offset;
          return (
            <button
              key={node.organizationId}
              id={`${id}-${index}`}
              role="option"
              aria-setsize={nodes.length}
              aria-posinset={index + 1}
              aria-selected={selected === node.organizationId}
              tabIndex={index === (activeIndex < 0 ? 0 : activeIndex) ? 0 : -1}
              className={`star-company-row ${selected === node.organizationId ? 'is-selected' : ''} ${activeIndex === index ? 'is-keyboard-active' : ''}`}
              style={{
                position: 'absolute',
                top: index * ROW,
                height: ROW,
                width: '100%',
              }}
              onClick={() => onSelect(node.organizationId)}
              onFocus={() => onActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSelect(node.organizationId);
                  return;
                }
                const next =
                  event.key === 'ArrowDown'
                    ? Math.min(nodes.length - 1, index + 1)
                    : event.key === 'ArrowUp'
                      ? Math.max(0, index - 1)
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? nodes.length - 1
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  onActiveIndex(next);
                  if (focusFrame.current)
                    cancelAnimationFrame(focusFrame.current);
                  focusFrame.current = requestAnimationFrame(() =>
                    document.getElementById(`${id}-${next}`)?.focus(),
                  );
                }
              }}
            >
              <span>
                {node.organizationName}
                {node.organizationId === ownId ? ' · 本企业' : ''}
              </span>
              <small>{node.primaryIndustryName || '行业待完善'}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
