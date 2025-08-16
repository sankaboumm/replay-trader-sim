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
const fmtSize = (s: number) => (s > 0 ? s.toString() : '');

const WINDOW = 100; // display window size (±100)
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
  const price = level.price;
  const bidSize = (level as any).bidSize ?? 0;
  const askSize = (level as any).askSize ?? 0;
  const sizeWindow = (level as any).sizeWindow ?? 0;
  const volumeCumulative = (level as any).volumeCumulative ?? 0;

  const isLastPrice = Math.abs(price - currentPrice) < 0.125;
  const showBid = price <= currentPrice;
  const showAsk = price >= currentPrice;

  return (
    <div
      key={(level as any).tick as number}
      className={cn('grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6 orderbook-ladder-row')}
    >
      {/* Size (window) */}
      <div className="orderbook-ladder-cell relative overflow-hidden bg-clip-padding flex items-center justify-center border-r border-border/50">
        {fmtSize(sizeWindow)}
      </div>

      {/* Bids */}
      <div
        className={cn(
          'orderbook-ladder-cell relative overflow-hidden bg-clip-padding flex items-center justify-center cursor-pointer border-r border-border/50',
          bidSize > 0 && 'bg-ladder-bid'
        )}
        onClick={() => (buyTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'bid'))}
      >
        {bidSize > 0 ? fmtSize(bidSize) : ''}
        {buyTotal > 0 && <span className='ml-1 text-xs'>({buyTotal})</span>}
      </div>

      {/* Price */}
      <div
        className={cn(
          'orderbook-ladder-cell relative overflow-hidden bg-clip-padding flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price',
          isLastPrice && 'text-trading-average font-bold',
          isAvgPrice && 'ring-2 ring-trading-average rounded-sm'
        )}
        onDoubleClick={onDoubleClickPrice}
        title="Double-clique pour recentrer"
      >
        {fmtPrice(price)}
      </div>

      {/* Asks */}
      <div
        className={cn(
          'orderbook-ladder-cell relative overflow-hidden bg-clip-padding flex items-center justify-center cursor-pointer border-r border-border/50',
          askSize > 0 && 'bg-ladder-ask'
        )}
        onClick={() => (sellTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'ask'))}
      >
        {askSize > 0 ? fmtSize(askSize) : ''}
        {sellTotal > 0 && <span className='ml-1 text-xs'>({sellTotal})</span>}
      </div>

      {/* Volume cumulé */}
      <div className="orderbook-ladder-cell relative overflow-hidden bg-clip-padding flex items-center justify-center text-muted-foreground">
        {fmtSize(volumeCumulative)}
      </div>
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
        const a = tickLadder.levels[i];
        const b = tickLadder.levels[i + 1];
        if ((a as any).tick !== (b as any).tick) {
          const dTick = Math.abs((a as any).tick - (b as any).tick);
          const dPrice = Math.abs(a.price - b.price);
          const cand = dPrice / dTick;
          if (cand > 0) best = best == null ? cand : Math.min(best, cand);
        }
      }
      if (best && isFinite(best)) return +best.toFixed(8);
    }
    return 0.25;
  }, [tickLadder]);

  // Stable reference point to avoid drift
  const refPoint = useMemo(() => {
    if (tickLadder?.levels?.length) {
      const mid = tickLadder.levels[Math.floor(tickLadder.levels.length / 2)] as any;
      return { refTick: mid.tick as number, refPrice: mid.price as number };
    }
    return { refTick: 0, refPrice: 0 };
  }, [tickLadder]);

  const priceToTick = useCallback((price: number) => {
    const raw = (price - refPoint.refPrice + EPS) / tickSize + refPoint.refTick;
    return Math.round(raw);
  }, [refPoint, tickSize]);

  const tickToPrice = useCallback((idx: number) => {
    const p = refPoint.refPrice + (idx - refPoint.refTick) * tickSize;
    return +p.toFixed(8);
  }, [refPoint, tickSize]);

  // Map levels by tick
  const levelByTick = useMemo(() => {
    const m = new Map<number, TickLevel>();
    if (tickLadder?.levels) {
      for (const lvl of tickLadder.levels as any[]) {
        m.set((lvl as any).tick as number, lvl as any);
      }
    }
    return m;
  }, [tickLadder]);

  // Aggregate orders by tick
  const buyTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) {
      if (o.side === 'BUY' && o.quantity > o.filled) {
        const idx = priceToTick(o.price);
        m.set(idx, (m.get(idx) ?? 0) + (o.quantity - o.filled));
      }
    }
    return m;
  }, [orders, priceToTick]);

  const sellTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) {
      if (o.side === 'SELL' && o.quantity > o.filled) {
        const idx = priceToTick(o.price);
        m.set(idx, (m.get(idx) ?? 0) + (o.quantity - o.filled));
      }
    }
    return m;
  }, [orders, priceToTick]);

  // Base tick from engine or current price
  const baseTick = useMemo(() => {
    if (tickLadder && (tickLadder as any).midTick != null) return (tickLadder as any).midTick as number;
    if (tickLadder && (tickLadder as any).midPrice != null) return priceToTick((tickLadder as any).midPrice as number);
    if (tickLadder?.levels?.length) {
      const hi = (tickLadder.levels[0] as any).tick as number;
      const lo = (tickLadder.levels[tickLadder.levels.length - 1] as any).tick as number;
      return Math.round((hi + lo) / 2);
    }
    return priceToTick(currentPrice);
  }, [tickLadder, currentPrice, priceToTick]);

  // Engine half-width (≈40); page when reaching this threshold to keep rows backed by real levels
  const ENGINE_HALF = useMemo(() => {
    const n = tickLadder?.levels?.length ?? 81;
    return Math.max(1, Math.floor((n - 1) / 2));
  }, [tickLadder?.levels?.length]);

  const PAGE = ENGINE_HALF;

  // offset in ticks (UI window ±100)
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

  const pageAnchorIfNeeded = useCallback(() => {
    if (!setViewAnchorPrice) return;
    const off = offsetRef.current;
    if (off >= PAGE || off <= -PAGE) {
      const pages = off > 0 ? Math.floor(off / PAGE) : Math.ceil(off / PAGE);
      const nextTick = baseTick + pages * PAGE;
      const nextPrice = tickToPrice(nextTick);
      offsetRef.current = off - pages * PAGE;
      setViewAnchorPrice(nextPrice);
    }
  }, [setViewAnchorPrice, baseTick, tickToPrice, PAGE]);

  const handleWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!tickLadder) return;
    e.preventDefault();

    const mode = (e.nativeEvent as any)?.deltaMode ?? 0; // 0 pixel, 1 line
    let steps = 0;
    if (mode === 1) {
      const lines = Math.max(1, Math.abs(Math.round(e.deltaY)));
      steps = -Math.sign(e.deltaY) * lines; // up -> +, down -> -
    } else {
      // pixel mode: 1 tick = 24px
      let accum = (offsetRef as any)._pxAccum ?? 0;
      accum += e.deltaY;
      while (Math.abs(accum) >= ROW_HEIGHT_PX) {
        if (accum > 0) { steps -= 1; accum -= ROW_HEIGHT_PX; } // down
        else { steps += 1; accum += ROW_HEIGHT_PX; }           // up
      }
      (offsetRef as any)._pxAccum = accum;
    }

    if (steps !== 0) {
      offsetRef.current += steps;
      pageAnchorIfNeeded();
      requestRender();
    }
  }, [tickLadder, pageAnchorIfNeeded]);

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

  // Average price marker
  const avgPrice: number | null = position.quantity !== 0 ? position.averagePrice : null;

  // Build 201 rows around center tick
  const centerTick = baseTick + offsetRef.current;
  const rows = useMemo(() => {
    const out: TickLevel[] = [];
    for (let i = WINDOW; i >= -WINDOW; i--) {
      const idx = centerTick + i;
      const lvl = levelByTick.get(idx) ?? ({
        tick: idx,
        price: tickToPrice(idx),
        bidSize: 0,
        askSize: 0,
        sizeWindow: 0,
        volumeCumulative: 0,
      } as any);
      out.push(lvl as TickLevel);
    }
    return out;
  }, [levelByTick, centerTick, tickToPrice, nonce]);

  if (!tickLadder || !tickLadder.levels?.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

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
        onWheelCapture={handleWheelCapture}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        onMouseEnter={() => wrapperRef.current?.focus()}
        onClick={() => wrapperRef.current?.focus()}
      >
        <div className="flex-1 overflow-y-hidden">
          {rows.map((lvl) => {
            const idx = (lvl as any).tick as number;
            const price = (lvl as any).price as number;
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