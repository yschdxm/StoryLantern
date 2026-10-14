import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 长列表窗口化：只渲染一屏多一点，滚到边缘再放下一批。
 *
 * 为什么不做"真虚拟化"（绝对定位 + 只渲染可见区）：本项目的列表都在页面滚动容器里，
 * 真虚拟化需要接管外层滚动与每行高度测量；窗口化已经能把 DOM 节点数控制住（万条消息也只渲染几十个），
 * 复杂度低得多。行高不固定时窗口化也更稳。
 */
export function useWindowedList<T>(
  items: T[],
  options: { pageSize?: number; from?: 'start' | 'end' } = {},
): { visible: T[]; hidden: number; sentinel: (node: Element | null) => void } {
  const pageSize = options.pageSize ?? 40;
  const from = options.from ?? 'start';
  const [count, setCount] = useState(pageSize);
  const observer = useRef<IntersectionObserver | null>(null);

  // 数据换了一批（比如切了会话）就把窗口收回初始大小
  const signature = items.length;
  useEffect(() => {
    setCount(pageSize);
  }, [signature, pageSize]);

  const sentinel = useCallback(
    (node: Element | null) => {
      observer.current?.disconnect();
      if (node === null) return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setCount((current) => (current < items.length ? current + pageSize : current));
          }
        },
        { rootMargin: '240px' },
      );
      observer.current.observe(node);
    },
    [items.length, pageSize],
  );

  useEffect(() => () => observer.current?.disconnect(), []);

  const hidden = Math.max(0, items.length - count);
  const visible = hidden === 0 ? items : from === 'end' ? items.slice(hidden) : items.slice(0, count);
  return { visible, hidden, sentinel };
}

/** 窗口化列表的"还有更多"哨兵：进入视野就加载下一批。 */
export function LoadMore({ hidden, sentinel }: { hidden: number; sentinel: (node: Element | null) => void }): ReactNode {
  if (hidden <= 0) return null;
  return (
    <div className="load-more" ref={sentinel}>
      <span className="spinner" aria-hidden="true" />
      <span className="muted">…</span>
    </div>
  );
}
