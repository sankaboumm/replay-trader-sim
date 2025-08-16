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

// Row component, memoized with custom comparator to avoid re-rendering unchanged rows
interface RowProps {
  price: number;
  bidSize: number;
  askSize: number;
  sizeWindow: number;
  volumeCumulative: number;
  isLastPrice: boolean;
  isAvgPrice: boolean;
  showBid: boolean;
  showAsk: boolean;
  totalBuy: number;
  totalSell: number;
  onClickBid: (price: number, hasOrders: boolean) => void;
  onClickAsk: (price: number, hasOrders: boolean) => void;
  onDoubleClickPrice?: () => void;
}

const LadderRow = memo(function LadderRow({
  price,
  bidSize,
  askSize,
  sizeWindow,
  volumeCumulative,
  isLastPrice,
  isAvgPrice,
  showBid,
  showAsk,
  totalBuy,
  totalSell,
  onClickBid,
  onClickAsk,
  onDoubleClickPrice
}: RowProps) {
  return (
    <div
      key={price}
      className={cn(
        'grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6'
      )}
      style={{ willChange: 'opacity, transform', backfaceVisibility: 'hidden' as any }}
    >
      {/* Size (window) */}
      <div className="flex items-center justify-center border-r border-border/50">
        {fmtSize(sizeWindow ?? 0)}
      </div>

      {/* Bids */}
      <div
        className={cn(
          'flex items-center justify-center cursor-pointer border-r border-border/50',
          showBid && bidSize > 0 && 'bg-ladder-bid'
        )}
        onClick={() => onClickBid(price, totalBuy > 0)}
        style={{ willChange: 'opacity' }}
      >
        <span className={cn(!showBid && 'opacity-0')}>
          {fmtSize(bidSize ?? 0)}
        </span>
        {totalBuy > 0 && (
          <span className={cn('ml-1 text-xs', !showBid && 'opacity-0')}>
            ({totalBuy})
          </span>
        )}
      </div>

      {/* Price */}
      <div
        className={cn(
          'flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price',
          isLastPrice && 'text-trading-average font-bold',
          isAvgPrice && 'ring-2 ring-trading-average rounded-sm'
        )}
        onDoubleClick={onDoubleClickPrice}
      >
        {fmtPrice(price)}
      </div>

      {/* Asks */}
      <div
        className={cn(
          'flex items-center justify-center cursor-pointer border-r border-border/50',
          showAsk && askSize > 0 && 'bg-ladder-ask'
        )}
        onClick={() => onClickAsk(price, totalSell > 0)}
        style={{ willChange: 'opacity' }}
      >
        <span className={cn(!showAsk && 'opacity-0')}>
          {fmtSize(askSize ?? 0)}
        </span>
        {totalSell > 0 && (
          <span className={cn('ml-1 text-xs', !showAsk && 'opacity-0')}>
            ({totalSell})
          </span>
        )}
      </div>

      {/* Volume cumulé à ce prix */}
      <div className="flex items-center justify-center text-muted-foreground">
        {fmtSize(volumeCumulative ?? 0)}
      </div>
    </div>
  );
}, (prev, next) => (
  prev.price === next.price &&
  prev.bidSize === next.bidSize &&
  prev.askSize === next.askSize &&
  prev.sizeWindow === next.sizeWindow &&
  prev.volumeCumulative === next.volumeCumulative &&
  prev.isLastPrice === next.isLastPrice &&
  prev.isAvgPrice === next.isAvgPrice &&
  prev.showBid === next.showBid &&
  prev.showAsk === next.showAsk &&
  prev.totalBuy === next.totalBuy &&
  prev.totalSell === next.totalSell
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
  const innerRef = useRef<HTMLDivElement | null>(null);
  const wheelRemainderRef = useRef(0);
  const pendingStepsRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const ROW_HEIGHT_PX = 24;
  const MAX_STEPS_PER_FRAME = 6;

  const tickSize = useMemo(() => {
    if (tickLadder?.levels && tickLadder.levels.length >= 2) {
      return Math.abs(tickLadder.levels[0].price - tickLadder.levels[1].price) || 0.25;
    }
    return 0.25;
  }, [tickLadder]);

  const sortedLevels = useMemo(() => {
    return tickLadder ? tickLadder.levels.slice().sort((a, b) => b.price - a.price) : [];
  }, [tickLadder]);

  // Precompute order totals per price (prevents recomputation per row)
  const buyTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) {
      if (o.side === 'BUY' && o.quantity > o.filled) {
        m.set(o.price, (m.get(o.price) ?? 0) + (o.quantity - o.filled));
      }
    }
    return m;
  }, [orders]);

  const sellTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) {
      if (o.side === 'SELL' && o.quantity > o.filled) {
        m.set(o.price, (m.get(o.price) ?? 0) + (o.quantity - o.filled));
      }
    }
    return m;
  }, [orders]);

  const computeBasePrice = () => {
    if (tickLadder && (tickLadder as any).midPrice != null) return (tickLadder as any).midPrice as number;
    if (tickLadder?.levels?.length) {
      const first = tickLadder.levels[0].price;
      const last  = tickLadder.levels[tickLadder.levels.length - 1].price;
      return (first + last) / 2;
    }
    return currentPrice;
  };

  const pump = () => {
    if (!setViewAnchorPrice) return;
    const total = pendingStepsRef.current;
    if (total === 0) { rafIdRef.current = null; return; }

    const step = Math.sign(total) * Math.min(MAX_STEPS_PER_FRAME, Math.abs(total));
    pendingStepsRef.current = total - step;

    if (anchorRef.current == null) anchorRef.current = computeBasePrice();
    anchorRef.current = (anchorRef.current as number) + step * tickSize;

    setViewAnchorPrice(anchorRef.current);
    if (innerRef.current && innerRef.current.scrollTop !== 0) innerRef.current.scrollTop = 0;

    rafIdRef.current = requestAnimationFrame(pump);
  };

  const scheduleAnchorUpdate = (stepsDelta: number) => {
    pendingStepsRef.current += stepsDelta;
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(pump);
    }
  };

  const handleWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!tickLadder) return;
    e.preventDefault();

    const deltaY = e.deltaY;
    const mode = (e.nativeEvent as any)?.deltaMode ?? 0; // 0: pixel, 1: line, 2: page
    let steps = 0;

    if (mode === 1) {
      const lines = Math.max(1, Math.abs(Math.round(deltaY)));
      steps = -Math.sign(deltaY) * lines; // up -> +ticks; down -> -ticks
    } else {
      wheelRemainderRef.current += deltaY;
      while (Math.abs(wheelRemainderRef.current) >= ROW_HEIGHT_PX) {
        if (wheelRemainderRef.current > 0) {
          steps -= 1; // scroll down
          wheelRemainderRef.current -= ROW_HEIGHT_PX;
        } else {
          steps += 1; // scroll up
          wheelRemainderRef.current += ROW_HEIGHT_PX;
        }
      }
    }

    if (steps !== 0) scheduleAnchorUpdate(steps);
  }, [tickLadder, tickSize]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice) return;
    if (e.code === 'Space') {
      e.preventDefault();
      setViewAnchorPrice(null);
      anchorRef.current = null;
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
    <div className="h-full flex flex-col bg-card trading-no-anim">
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
        <div className="flex-1 overflow-y-auto" ref={innerRef}>
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

            const totalBuy = buyTotals.get(price) ?? 0;
            const totalSell = sellTotals.get(price) ?? 0;

            return (
              <LadderRow
                key={price}
                price={price}
                bidSize={bidSize}
                askSize={askSize}
                sizeWindow={sizeWindow}
                volumeCumulative={volumeCumulative}
                isLastPrice={isLastPrice}
                isAvgPrice={isAvgPrice}
                showBid={showBid}
                showAsk={showAsk}
                totalBuy={totalBuy}
                totalSell={totalSell}
                onClickBid={(p, hasOrders) => hasOrders ? handleOrderClick(p) : handleCellClick(p, 'bid')}
                onClickAsk={(p, hasOrders) => hasOrders ? handleOrderClick(p) : handleCellClick(p, 'ask')}
                onDoubleClickPrice={() => setViewAnchorPrice && setViewAnchorPrice(null)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});