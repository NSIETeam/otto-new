/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef, useState } from 'react';
import laptop from '../assets/market-demo/laptop.jpg';
import monitor from '../assets/market-demo/monitor.jpg';
import keyboard from '../assets/market-demo/keyboard.jpg';
import './ParkMarketDialog.css';
import './MarketDemo.css';
type Status = 'active' | 'reserved' | 'offline' | 'sold';
type Product = {
  id: string;
  title: string;
  description: string;
  price: number;
  image: string;
  state: Status;
  favorite: boolean;
};
const labels: Record<Status, string> = {
  active: '在售',
  reserved: '已预留',
  offline: '已下架',
  sold: '已售出',
};
const pictures = { laptop, monitor, keyboard };
function seed(): Product[] {
  return [
    {
      id: 'laptop',
      title: '轻薄笔记本电脑 · 16GB / 512GB',
      description:
        '换新电脑后闲置，日常办公使用，屏幕和键盘功能正常，外壳有轻微使用痕迹。附原装充电器，可在园区当面检查。\n交接地点：园区一楼大厅；工作日18:00后。',
      price: 2680,
      image: 'laptop',
      state: 'active',
      favorite: false,
    },
    {
      id: 'monitor',
      title: '24英寸办公显示器 · 带支架',
      description:
        '双屏办公换下来的显示器，屏幕无明显坏点，支架完整，附电源线。已与一位园区邻居约好交接，当前为预留状态。\n交接地点：园区咖啡厅。',
      price: 380,
      image: 'monitor',
      state: 'reserved',
      favorite: false,
    },
    {
      id: 'keyboard',
      title: '机械键盘与鼠标 · 桌面升级闲置',
      description:
        '键盘按键正常，已清洁。因最近不方便交接暂时下架，可以在这里体验重新上架、编辑和免费赠送。\n交接地点：园区前台，时间另约。',
      price: 120,
      image: 'keyboard',
      state: 'offline',
      favorite: false,
    },
  ];
}
function restore(key: string): Product[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 100_000) return seed();
    const rows: unknown = JSON.parse(raw);
    if (
      !Array.isArray(rows) ||
      rows.length > 50 ||
      !rows.every(
        (p) =>
          p &&
          typeof p.id === 'string' &&
          typeof p.title === 'string' &&
          typeof p.description === 'string' &&
          typeof p.favorite === 'boolean' &&
          Number.isFinite(p.price) &&
          p.price >= 0 &&
          Object.hasOwn(pictures, p.image) &&
          Object.hasOwn(labels, p.state),
      )
    )
      return seed();
    return rows as Product[];
  } catch {
    return seed();
  }
}
export function MarketDemo({
  scope,
  onClose,
  onExit,
}: {
  scope: string;
  onClose(): void;
  onExit(): void;
}) {
  const key = `otto:market-demo:v1:${scope}`;
  const [products, setProducts] = useState(() => restore(key));
  const [view, setView] = useState<'market' | 'mine' | 'favorites'>('market');
  const [selected, select] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [free, setFree] = useState(false);
  const [sort, setSort] = useState('latest');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<Product | null>(null);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<Record<string, string[]>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(products));
    } catch {
      setNotice('浏览器存储不可用，本次演示修改仅在当前窗口保留。');
    }
  }, [key, products]);
  const current = products.find((p) => p.id === selected);
  const change = (patch: Partial<Product>) => {
    setProducts((rows) =>
      rows.map((p) => (p.id === selected ? { ...p, ...patch } : p)),
    );
    setNotice('演示数据已更新，不会修改真实商品。');
  };
  const shown = products
    .filter(
      (p) =>
        (view === 'mine' ||
          (view === 'favorites'
            ? p.favorite
            : p.state === 'active' || p.state === 'reserved')) &&
        (!free || p.price === 0) &&
        `${p.title} ${p.description}`.includes(query.trim()),
    )
    .sort((a, b) =>
      sort === 'low'
        ? a.price - b.price
        : sort === 'high'
          ? b.price - a.price
          : 0,
    );
  const picture = (p: Product) => pictures[p.image as keyof typeof pictures];
  return (
    <dialog
      ref={dialog}
      className="park-market-dialog market-demo"
      aria-labelledby="market-demo-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2 id="market-demo-title">
            园区跳蚤市场 <small>演示</small>
          </h2>
          <p>看看园区里的闲置好物，也试试管理自己的发布。</p>
        </div>
        <button onClick={onClose}>关闭</button>
      </header>
      <div className="market-demo__banner">
        <strong>本地演示 · 无需连接服务器</strong>
        <span>
          3件示例商品，图片为AI生成的示意图。可同时体验买家与卖家操作；不会真实发布、联系他人或产生交易。
        </span>
        <div>
          <button onClick={onExit}>返回真实市场</button>
          <button
            onClick={() => {
              setProducts(seed());
              select(null);
              setForm(null);
              setMessages({});
              setQuery('');
              setFree(false);
              setView('market');
              setNotice('已恢复3件初始示例商品。');
            }}
          >
            重置演示数据
          </button>
        </div>
      </div>
      <nav aria-label="演示市场页面">
        {(
          [
            ['market', '逛市场'],
            ['mine', '我的发布记录'],
            ['favorites', '我的收藏'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={view === id && !current && !form}
            onClick={() => {
              setView(id);
              select(null);
              setForm(null);
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            select(null);
            setForm({
              id: crypto.randomUUID(),
              title: '',
              price: 0,
              description: '',
              image: 'laptop',
              state: 'active',
              favorite: false,
            });
          }}
        >
          发布闲置
        </button>
      </nav>
      {notice && <p role="status">{notice}</p>}
      {form ? (
        <form
          className="market-demo__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !form.title.trim() ||
              !Number.isFinite(form.price) ||
              form.price < 0
            )
              return;
            if (
              !products.some((p) => p.id === form.id) &&
              products.length >= 50
            ) {
              setNotice('演示最多保存50件商品，请重置后继续。');
              return;
            }
            setProducts((rows) =>
              rows.some((p) => p.id === form.id)
                ? rows.map((p) =>
                    p.id === form.id
                      ? { ...form, title: form.title.trim() }
                      : p,
                  )
                : [{ ...form, title: form.title.trim() }, ...rows],
            );
            setForm(null);
            setView('mine');
            setNotice('演示商品已保存，仅你当前的演示环境可见。');
          }}
        >
          <h3>
            {products.some((p) => p.id === form.id)
              ? '编辑演示商品'
              : '发布演示商品'}
          </h3>
          <label>
            商品标题
            <input
              required
              maxLength={60}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label>
            价格（元，0为免费送）
            <input
              type="number"
              min="0"
              max="999999"
              step="0.01"
              required
              value={form.price}
              onChange={(e) =>
                setForm({ ...form, price: Number(e.target.value) })
              }
            />
          </label>
          <label>
            商品描述
            <textarea
              maxLength={2000}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <label>
            示例图片
            <select
              value={form.image}
              onChange={(e) => setForm({ ...form, image: e.target.value })}
            >
              <option value="laptop">笔记本电脑</option>
              <option value="monitor">显示器</option>
              <option value="keyboard">键盘鼠标</option>
            </select>
          </label>
          <img
            className="market-demo__form-photo"
            src={picture(form)}
            alt="所选演示商品图片"
          />
          <div>
            <button type="submit">保存演示商品</button>
            <button type="button" onClick={() => setForm(null)}>
              取消
            </button>
          </div>
        </form>
      ) : current ? (
        <section>
          <button
            onClick={() => {
              select(null);
              setMessage('');
            }}
          >
            返回列表
          </button>
          <div className="market-demo__detail">
            <img src={picture(current)} alt={current.title} />
            <div>
              <span className={`market-demo__state is-${current.state}`}>
                {labels[current.state]}
              </span>
              <h3>{current.title}</h3>
              <strong className="market-demo__price">
                {current.price ? `¥${current.price}` : '免费送'}
              </strong>
              <p>{current.description}</p>
              <p>演示卖家 · 同园区成员 · 当面交接</p>
              <div className="market-demo__actions">
                <button onClick={() => change({ favorite: !current.favorite })}>
                  {current.favorite ? '取消收藏' : '收藏'}
                </button>
                <button onClick={() => setForm({ ...current })}>
                  编辑商品
                </button>
                {current.state === 'active' && (
                  <button onClick={() => change({ state: 'reserved' })}>
                    预留
                  </button>
                )}
                {current.state === 'reserved' && (
                  <button onClick={() => change({ state: 'active' })}>
                    取消预留
                  </button>
                )}
                {current.state === 'active' || current.state === 'reserved' ? (
                  <>
                    <button onClick={() => change({ state: 'offline' })}>
                      下架
                    </button>
                    <button onClick={() => change({ state: 'sold' })}>
                      标记售出
                    </button>
                  </>
                ) : (
                  <button onClick={() => change({ state: 'active' })}>
                    重新上架
                  </button>
                )}
              </div>
            </div>
          </div>
          <details>
            <summary>体验咨询与回复（本地模拟）</summary>
            <p>仅展示会话样式，真实聊天的权限、加密和通知不在此模拟。</p>
            <div className="market-demo__chat">
              <p>买家：你好，这件商品还在吗？可以当面看看吗？</p>
              <p>卖家：还在的，工作日下班后可以在园区大厅见面。</p>
              {(messages[current.id] ?? []).map((text, i) => (
                <p key={i}>你：{text}</p>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!message.trim()) return;
                setMessages((old) => ({
                  ...old,
                  [current.id]: [
                    ...(old[current.id] ?? []),
                    message.trim(),
                  ].slice(-20),
                }));
                setMessage('');
              }}
            >
              <label>
                模拟消息
                <input
                  maxLength={500}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <button>发送演示消息</button>
            </form>
          </details>
        </section>
      ) : (
        <>
          <div className="market-demo__filters">
            <label>
              搜索商品
              <input
                placeholder="搜索电脑、显示器、键盘…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={free}
                onChange={(e) => setFree(e.target.checked)}
              />{' '}
              只看免费送
            </label>
            <label>
              排序
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="latest">最新发布</option>
                <option value="low">价格从低到高</option>
                <option value="high">价格从高到低</option>
              </select>
            </label>
          </div>
          <div className="market-demo__grid">
            {shown.map((p) => (
              <button
                className="market-demo__card"
                key={p.id}
                aria-label={`查看 ${p.title}`}
                onClick={() => {
                  select(p.id);
                  setNotice('');
                }}
              >
                <img src={picture(p)} alt={p.title} />
                <div>
                  <span className={`market-demo__state is-${p.state}`}>
                    {labels[p.state]}
                  </span>
                  <h3>{p.title}</h3>
                  <p>{p.description.split('\n')[0]}</p>
                  <footer>
                    <strong>{p.price ? `¥${p.price}` : '免费送'}</strong>
                    <span>{p.favorite ? '♥ 已收藏' : '园区当面交接'}</span>
                  </footer>
                </div>
              </button>
            ))}
          </div>
          {!shown.length && (
            <p>
              没有符合条件的演示商品。可以切换“我的发布记录”或重置演示数据。
            </p>
          )}
        </>
      )}
    </dialog>
  );
}
