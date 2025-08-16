import { memo, useMemo, useRef, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType, TickLevel } from '@/lib/orderbook';

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position;
  setViewAnchorPrice?: (price: number | null) => void;
}

const fmtPrice = (p: number) => p.toFixed(2).replace('.', ',');
const fmtSize = (s: number) => (s || s === 0 ? String(s) : '');

const ROW_HEIGHT_PX = 24;
const EPS = 1e-8;

// Row
const LadderRow = memo(function LadderRow({
  level,
  currentPrice,
  isAvgPrice,
  buyTotal,
  sellTotal,
  onCellClick,
  onCancelOrders,
  onDoubleClickPrice
}: {
  level: TickLevel;
  currentPrice: number;
  isAvgPrice: boolean;
  buyTotal: number;
  sellTotal: number;
  onCellClick: (price: number, side: 'bid' | 'ask') => void;
  onCancelOrders: (price: number) => void;
  onDoubleClickPrice: () => void;
}) {
  const price = (level as any).price as number;
  const bidSize = (level as any).bidSize ?? 0;
  const askSize = (level as any).askSize ?? 0;
  const sizeWindow = (level as any).sizeWindow ?? 0;
  const volumeCumulative = (level as any).volumeCumulative ?? 0;

  const isLastPrice = Math.abs(price - currentPrice) < 0.125;

  return (
    <div
      key={(level as any).tick as number}
      className={cn('grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6')}
    >
      {/* Size (window) */}
      <div className="flex items-center justify-center border-r border-border/50">{fmtSize(sizeWindow)}</div>

      {/* Bids */}
      <div
        className={cn(
          'flex items-center justify-center cursor-pointer border-r border-border/50',
          bidSize > 0 && 'bg-ladder-bid'
        )}
        onClick={() => (buyTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'bid'))}
        title={`Bid ${bidSize}`}
      >
        {fmtSize(bidSize)}
        {buyTotal > 0 && <span className="ml-1 text-xs">({buyTotal})</span>}
      </div>

      {/* Price */}
      <div
        className={cn(
          'flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price sticky-price-cell',
          isLastPrice && 'text-trading-average font-bold',
          isAvgPrice && 'outline-average-price'
        )}
        onDoubleClick={onDoubleClickPrice}
        title="Double-clique pour recentrer"
      >
        {fmtPrice(price)}
      </div>

      {/* Asks */}
      <div
        className={cn(
          'flex items-center justify-center cursor-pointer border-r border-border/50',
          askSize > 0 && 'bg-ladder-ask'
        )}
        onClick={() => (sellTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'ask'))}
        title={`Ask ${askSize}`}
      >
        {fmtSize(askSize)}
        {sellTotal > 0 && <span className="ml-1 text-xs">({sellTotal})</span>}
      </div>

      {/* Volume cumulé */}
      <div className="flex items-center justify-center text-muted-foreground">{fmtSize(volumeCumulative)}</div>
    </div>
  );
}, (a, b) => (
  ((a.level as any).tick as number) === ((b.level as any).tick as number) &&
  ((a.level as any).bidSize ?? 0) === ((b.level as any).bidSize ?? 0) &&
  ((a.level as any).askSize ?? 0) === ((b.level as any).askSize ?? 0) &&
  ((a.level as any).sizeWindow ?? 0) === ((b.level as any).sizeWindow ?? 0) &&
  ((a.level as any).volumeCumulative ?? 0) === ((b.level as any).volumeCumulative ?? 0) &&
  a.currentPrice === b.currentPrice &&
  a.isAvgPrice === b.isAvgPrice &&
  a.buyTotal === b.buyTotal &&
  a.sellTotal === b.sellTotal
));

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  position,
  setViewAnchorPrice
}: TickLadderProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // tick size from engine
  const tickSize = useMemo(() => {
    if (tickLadder?.levels && tickLadder.levels.length >= 2) {
      let best: number | null = null;
      for (let i = 0; i < tickLadder.levels.length - 1; i++) {
        const a = tickLadder.levels[i] as any;
        const b = tickLadder.levels[i + 1] as any;
        if (a.tick !== b.tick) {
          const dTick = Math.abs(a.tick - b.tick);
          const dPrice = Math.abs(a.price - b.price);
          const cand = dPrice / dTick;
          if (cand > 0) best = best == null ? cand : Math.min(best, cand);
        }
      }
      if (best && isFinite(best)) return +best.toFixed(8);
    }
    return 0.25;
  }, [tickLadder]);

  // Visible window size (max rows we draw)
  const WINDOW = 100;

  // engine-provided levels sorted by tick desc (as in createTickLadder)
  const levels = useMemo(() => {
    const arr = (tickLadder?.levels ?? []).slice();
    arr.sort((a: any, b: any) => b.tick - a.tick);
    return arr;
  }, [tickLadder?.levels]);

  // Index of center price within provided levels (closest by tick)
  const centerIndex = useMemo(() => {
    if (!levels.length) return 0;
    const midTick = (tickLadder as any)?.midTick as number | undefined;
    if (typeof midTick === 'number') {
      const idx = Math.max(0, Math.min(levels.length - 1, levels.findIndex((lv: any) => lv.tick === midTick)));
      return idx >= 0 ? idx : Math.floor(levels.length / 2);
    }
    return Math.floor(levels.length / 2);
  }, [levels, tickLadder]);

  // UI offset in rows relative to centerIndex
  const offsetRef = useRef(0);
  const [nonce, setNonce] = useState(0);
  const rafIdRef = useRef<number | null>(null);
  const requestRender = () => {
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      setNonce(n => n + 1);
    });
  };

  // When approaching array edges, ask engine to page anchor (FIFO scroll)
  const pageAnchorIfNeeded = useCallback(() => {
    if (!setViewAnchorPrice || !levels.length) return;
    const off = offsetRef.current;
    const idx = centerIndex + off;
    const PAD = Math.max(10, Math.floor(levels.length / 4)); // when 1/4 from an edge, page
    if (idx <= PAD || idx >= levels.length - 1 - PAD) {
      const target = levels[Math.min(levels.length - 1, Math.max(0, idx))] as any;
      const nextPrice = (target?.price as number) ?? (levels[Math.floor(levels.length/2)] as any).price;
      offsetRef.current = 0; // reset offset after paging
      setViewAnchorPrice(nextPrice);
    }
  }, [levels, centerIndex, setViewAnchorPrice]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!levels.length) return;
    // don't block page scroll unless over the component
    e.preventDefault();
    const mode = (e.nativeEvent as any)?.deltaMode ?? 0;
    let steps = 0;
    if (mode === 1) {
      const lines = Math.max(1, Math.abs(Math.round(e.deltaY)));
      steps = -Math.sign(e.deltaY) * lines;
    } else {
      // pixel mode
      let accum = (offsetRef as any)._pxAccum ?? 0;
      accum += e.deltaY;
      while (Math.abs(accum) >= ROW_HEIGHT_PX) {
        if (accum > 0) { steps -= 1; accum -= ROW_HEIGHT_PX; }
        else { steps += 1; accum += ROW_HEIGHT_PX; }
      }
      (offsetRef as any)._pxAccum = accum;
    }
    if (steps !== 0) {
      offsetRef.current += steps;
      pageAnchorIfNeeded();
      requestRender();
    }
  }, [levels, pageAnchorIfNeeded]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice) return;
    if (e.code === 'Space') {
      e.preventDefault();
      offsetRef.current = 0;
      (offsetRef as any)._pxAccum = 0;
      setViewAnchorPrice(null);
      requestRender();
    }
  }, [setViewAnchorPrice]);

  if (!levels.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  // Visible slice indices, clamped to available levels
  const center = centerIndex + offsetRef.current;
  const start = Math.max(0, Math.min(levels.length - 1, center - WINDOW));
  const end   = Math.max(0, Math.min(levels.length,     center + WINDOW + 1));
  const rows = levels.slice(start, end);

  // Aggregate user's working orders by tick (optional badges)
  const priceToTick = useCallback((price: number) => Math.round(price / tickSize), [tickSize]);
  const buyTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) if (o.side === 'BUY' && o.quantity > o.filled) {
      const idx = priceToTick(o.price);
      m.set(idx, (m.get(idx) ?? 0) + (o.quantity - o.filled));
    }
    return m;
  }, [orders, priceToTick]);
  const sellTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) if (o.side === 'SELL' && o.quantity > o.filled) {
      const idx = priceToTick(o.price);
      m.set(idx, (m.get(idx) ?? 0) + (o.quantity - o.filled));
    }
    return m;
  }, [orders, priceToTick]);

  const avgPrice: number | null = position.quantity !== 0 ? position.averagePrice : null;

  const onCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const above = price > currentPrice;
    const below = price < currentPrice;
    if (column === 'bid') {
      if (above) return onMarketOrder('BUY', 1);
      return onLimitOrder('BUY', price, 1);
    }
    if (column === 'ask') {
      if (below) return onMarketOrder('SELL', 1);
      return onLimitOrder('SELL', price, 1);
    }
  };

  return (
    <div className="h-full flex flex-col bg-card trading-no-anim" style={{ transition: 'none' as any }}>
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Body */}
      <div
        ref={wrapperRef}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        <div className="flex-1 overflow-y-hidden">
          {rows.map((lvl: any) => {
            const idx = lvl.tick as number;
            const price = lvl.price as number;
            const buyTotal = buyTotals.get(idx) ?? 0;
            const sellTotal = sellTotals.get(idx) ?? 0;
            const isAvg = avgPrice != null && Math.abs(price - (avgPrice as number)) <= tickSize / 2 + EPS;
            return (
              <LadderRow
                key={idx}
                level={lvl}
                currentPrice={currentPrice}
                isAvgPrice={!!isAvg}
                buyTotal={buyTotal}
                sellTotal={sellTotal}
                onCellClick={onCellClick}
                onCancelOrders={onCancelOrders}
                onDoubleClickPrice={() => setViewAnchorPrice && setViewAnchorPrice(null)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});