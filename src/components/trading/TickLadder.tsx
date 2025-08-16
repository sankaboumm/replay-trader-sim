import { memo, useMemo, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';

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
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);

  // FIFO scroll state
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const pxAccumRef = useRef(0);        // pixel remainder relative to row height
  const pendingStepsRef = useRef(0);   // whole-tick steps awaiting commit
  const lastCommitTsRef = useRef(0);   // to throttle to ~30fps
  const rafIdRef = useRef<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const ROW_HEIGHT_PX = 24;
  const MAX_STEPS_PER_FRAME = 12;      // allow bigger throughput but still bounded
  const COMMIT_INTERVAL_MS = 33;       // ~30 fps

  const tickSize = useMemo(() => {
    if (tickLadder?.levels && tickLadder.levels.length >= 2) {
      return Math.abs(tickLadder.levels[0].price - tickLadder.levels[1].price) || 0.25;
    }
    return 0.25;
  }, [tickLadder]);

  const sortedLevels = useMemo(() => {
    return tickLadder ? tickLadder.levels.slice().sort((a, b) => b.price - a.price) : [];
  }, [tickLadder]);

  const computeBasePrice = () => {
    if (tickLadder && (tickLadder as any).midPrice != null) return (tickLadder as any).midPrice as number;
    if (tickLadder?.levels?.length) {
      const first = tickLadder.levels[0].price;
      const last  = tickLadder.levels[tickLadder.levels.length - 1].price;
      return (first + last) / 2;
    }
    return currentPrice;
  };

  const applyLocalTransform = (px: number) => {
    const el = innerRef.current;
    if (!el) return;
    // Avoid any transition to keep paint stable
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    el.style.transform = `translateY(${px}px)`;
  };

  const commitSteps = () => {
    if (!setViewAnchorPrice) { rafIdRef.current = null; return; }

    const now = performance.now();
    const elapsed = now - lastCommitTsRef.current;
    // throttle to ~30fps
    if (elapsed < COMMIT_INTERVAL_MS) {
      rafIdRef.current = requestAnimationFrame(commitSteps);
      return;
    }
    lastCommitTsRef.current = now;

    let total = pendingStepsRef.current;
    if (total === 0) { rafIdRef.current = null; return; }

    const step = Math.sign(total) * Math.min(MAX_STEPS_PER_FRAME, Math.abs(total));
    pendingStepsRef.current = total - step;

    if (anchorRef.current == null) anchorRef.current = computeBasePrice();
    anchorRef.current = (anchorRef.current as number) + step * tickSize;
    setViewAnchorPrice(anchorRef.current);

    // keep the local translate to the remainder only
    const remainderPx = pxAccumRef.current % ROW_HEIGHT_PX;
    applyLocalTransform(remainderPx);

    rafIdRef.current = requestAnimationFrame(commitSteps);
  };

  const scheduleSteps = (deltaSteps: number) => {
    pendingStepsRef.current += deltaSteps;
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(commitSteps);
    }
  };

  const handleWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!tickLadder) return;
    e.preventDefault();

    const mode = (e.nativeEvent as any)?.deltaMode ?? 0; // 0: pixel, 1: line, 2: page

    if (mode === 1) {
      // LINE mode: 1 line = 1 tick, map up->+1 (price up), down->-1
      const lines = Math.max(1, Math.abs(Math.round(e.deltaY)));
      const steps = -Math.sign(e.deltaY) * lines;
      // visually also nudge 1 row per tick for immediate feedback
      pxAccumRef.current += -steps * ROW_HEIGHT_PX; // invert to match visual direction
      const remainderPx = pxAccumRef.current % ROW_HEIGHT_PX;
      applyLocalTransform(remainderPx);
      scheduleSteps(steps);
    } else {
      // PIXEL mode: accumulate pixels; when crossing a row, convert to steps
      pxAccumRef.current += e.deltaY;
      // translate visual immediately (inverse to keep price column "fixed"-like)
      const remainderBefore = pxAccumRef.current;
      let steps = 0;
      while (Math.abs(pxAccumRef.current) >= ROW_HEIGHT_PX) {
        if (pxAccumRef.current > 0) { steps -= 1; pxAccumRef.current -= ROW_HEIGHT_PX; } // down
        else { steps += 1; pxAccumRef.current += ROW_HEIGHT_PX; } // up
      }
      const remainderPx = pxAccumRef.current;
      applyLocalTransform(remainderPx);
      if (steps !== 0) scheduleSteps(steps);
    }
  }, [tickLadder, tickSize]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice) return;
    if (e.code === 'Space') {
      e.preventDefault();
      setViewAnchorPrice(null);
      anchorRef.current = null;
      pxAccumRef.current = 0;
      applyLocalTransform(0);
    }
  }, [setViewAnchorPrice]);

  const avgPrice = position.quantity !== 0 ? position.averagePrice : null;

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
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

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!tickLadder || !tickLadder.levels?.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

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
      <div ref={wrapperRef} onWheel={handleWheel} onWheelCapture={handleWheelCapture} onKeyDown={handleKeyDown} tabIndex={0}>
        <div className="flex-1 overflow-y-auto" ref={innerRef} style={{ willChange: 'transform', transition: 'none' as any }}>
          {sortedLevels.map((level) => {
            const price = level.price as number;
            const bidSize = (level as any).bidSize ?? 0;
            const askSize = (level as any).askSize ?? 0;
            const sizeWindow = (level as any).sizeWindow ?? 0;
            const volumeCumulative = (level as any).volumeCumulative ?? 0;

            const isLastPrice = Math.abs(price - currentPrice) < 0.125;
            const isAvgPrice  = avgPrice !== null && Math.abs(price - (avgPrice as number)) < 0.125;
            const showBid = price <= currentPrice;
            const showAsk = price >= currentPrice;

            return (
              <div
                key={price}
                className={cn(
                  'grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6'
                )}
                style={{ willChange: 'transform, opacity', backfaceVisibility: 'hidden' as any, transition: 'none' as any }}
              >
                {/* Size (window) */}
                <div className="flex items-center justify-center border-r border-border/50" style={{ transition: 'none' as any }}>
                  {fmtSize(sizeWindow ?? 0)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    'flex items-center justify-center cursor-pointer border-r border-border/50',
                    showBid && bidSize > 0 && 'bg-ladder-bid'
                  )}
                  onClick={() => (/* no-op to keep signature consistent */ false) || (showBid && bidSize > 0 ? handleOrderClick(price) : handleCellClick(price, 'bid'))}
                  style={{ transition: 'none' as any }}
                >
                  <span className={cn(!showBid && 'opacity-0')}>
                    {fmtSize(bidSize ?? 0)}
                  </span>
                </div>

                {/* Price */}
                <div
                  className={cn(
                    'flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price',
                    isLastPrice && 'text-trading-average font-bold',
                    isAvgPrice && 'ring-2 ring-trading-average rounded-sm'
                  )}
                  onDoubleClick={() => setViewAnchorPrice && setViewAnchorPrice(null)}
                  title="Double-clique pour recentrer"
                  style={{ transition: 'none' as any }}
                >
                  {fmtPrice(price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    'flex items-center justify-center cursor-pointer border-r border-border/50',
                    showAsk && askSize > 0 && 'bg-ladder-ask'
                  )}
                  onClick={() => (/* no-op to keep signature consistent */ false) || (showAsk && askSize > 0 ? handleOrderClick(price) : handleCellClick(price, 'ask'))}
                  style={{ transition: 'none' as any }}
                >
                  <span className={cn(!showAsk && 'opacity-0')}>
                    {fmtSize(askSize ?? 0)}
                  </span>
                </div>

                {/* Volume cumulé à ce prix */}
                <div className="flex items-center justify-center text-muted-foreground" style={{ transition: 'none' as any }}>
                  {fmtSize(volumeCumulative ?? 0)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});