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
  const scrollWrapperRef = useRef<HTMLDivElement | null>(null);
  const wheelRemainderRef = useRef(0);
  const ROW_HEIGHT_PX = 24; // Tailwind h-6
  const tickSize = useMemo(() => {
    if (tickLadder?.levels && tickLadder.levels.length >= 2) {
      return Math.abs(tickLadder.levels[0].price - tickLadder.levels[1].price) || 0.25;
    }
    return 0.25;
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

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice || !tickLadder) return;
    e.preventDefault();

    const deltaY = e.deltaY;
    const mode = (e.nativeEvent as any)?.deltaMode ?? 0; // 0: pixel, 1: line, 2: page
    let steps = 0;

    if (mode === 1) {
      // LINE mode: 1 line = 1 tick, invert sign so: up (deltaY<0) => +ticks (price up)
      const lines = Math.max(1, Math.abs(Math.round(deltaY)));
      steps = -Math.sign(deltaY) * lines;
    } else {
      // PIXEL mode: accumulate by row height, invert sign mapping for price direction
      wheelRemainderRef.current += deltaY;
      while (Math.abs(wheelRemainderRef.current) >= ROW_HEIGHT_PX) {
        if (wheelRemainderRef.current > 0) {
          steps -= 1; // scroll down -> steps negative -> price down
          wheelRemainderRef.current -= ROW_HEIGHT_PX;
        } else {
          steps += 1; // scroll up -> steps positive -> price up
          wheelRemainderRef.current += ROW_HEIGHT_PX;
        }
      }
    }

    if (steps !== 0) {
      const base = computeBasePrice();
      const nextPrice = base + steps * tickSize;
      setViewAnchorPrice(nextPrice);

      // lock native scroll
      const inner = scrollWrapperRef.current?.querySelector('.overflow-y-auto') as HTMLDivElement | null;
      if (inner) inner.scrollTop = 0;
    }
  }, [setViewAnchorPrice, tickLadder, tickSize, currentPrice]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice) return;
    if (e.code === 'Space') {
      e.preventDefault();
      setViewAnchorPrice(null);
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

      {/* Body - wrap with a listener to avoid editing existing inner div */}
      <div ref={scrollWrapperRef} onWheel={handleWheel} onKeyDown={handleKeyDown} tabIndex={0}>
        <div className="flex-1 overflow-y-auto">
          {(tickLadder.levels).slice().sort((a, b) => b.price - a.price).map((level) => {
            const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
            const isAvgPrice  = avgPrice !== null && Math.abs(level.price - (avgPrice as number)) < 0.125;

            const buyOrders  = getOrdersAtPrice(level.price, 'BUY');
            const sellOrders = getOrdersAtPrice(level.price, 'SELL');
            const totalBuy   = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const totalSell  = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

            return (
              <div
                key={`${level.price}-${(level as any).tick}`}
                className={cn(
                  "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6"
                )}
              >
                {/* Size (window) */}
                <div className="flex items-center justify-center border-r border-border/50">
                  {fmtSize((level as any).sizeWindow ?? 0)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price <= currentPrice && (level as any).bidSize > 0 && "bg-ladder-bid"
                  )}
                  onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
                >
                  {level.price <= currentPrice && (
                    <>
                      <span>{fmtSize((level as any).bidSize ?? 0)}</span>
                      {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                    </>
                  )}
                </div>

                {/* Price */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                    isLastPrice && "text-trading-average font-bold",
                    isAvgPrice && "ring-2 ring-trading-average rounded-sm"
                  )}
                  onClick={() => setViewAnchorPrice && setViewAnchorPrice(level.price)}
                  onDoubleClick={() => setViewAnchorPrice && setViewAnchorPrice(null)}
                  title="Double-clique pour recentrer"
                >
                  {fmtPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price >= currentPrice && (level as any).askSize > 0 && "bg-ladder-ask"
                  )}
                  onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
                >
                  {level.price >= currentPrice && (
                    <>
                      <span>{fmtSize((level as any).askSize ?? 0)}</span>
                      {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                    </>
                  )}
                </div>

                {/* Volume cumulé à ce prix */}
                <div className="flex items-center justify-center text-muted-foreground">
                  {fmtSize((level as any).volumeCumulative ?? 0)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
