import { memo, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { TickLadder as TickLadderType } from '@/lib/orderbook';

interface TradeLite {
  price: number;
  size: number;
  aggressor?: 'BUY' | 'SELL';
  timestamp?: number | Date;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface DOMProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  trades?: TradeLite[];
  orders?: Order[];
  disabled?: boolean;
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders?: (price: number) => void;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size?: number): string {
  if (!size || size <= 0) return '';
  return `${size}`;
}

export const DOM = memo(function DOM({
  tickLadder,
  currentPrice,
  trades = [],
  orders = [],
  disabled,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
}: DOMProps) {
  // Build a quick lookup for the last trade size at a given price
  const lastSizeByPrice = useMemo(() => {
    const map = new Map<number, number>();
    // iterate from end to start to ensure "last"
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i];
      if (!map.has(t.price)) {
        map.set(t.price, t.size);
      }
    }
    return map;
  }, [trades]);

  // Build volume lookup for each price level
  const volumeByPrice = useMemo(() => {
    const map = new Map<number, number>();
    trades.forEach(trade => {
      const current = map.get(trade.price) || 0;
      map.set(trade.price, current + trade.size);
    });
    return map;
  }, [trades]);

  // Fonction pour récupérer les ordres à un prix donné
  const getOrdersAtPrice = useCallback((price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);
  }, [orders]);

  const handleCellClick = useCallback((price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    
    const above = price > currentPrice;
    const below = price < currentPrice;

    if (column === 'bid') {
      if (above) return onMarketOrder('BUY', 1);
      return onLimitOrder('BUY', price, 1);
    } else if (column === 'ask') {
      if (below) return onMarketOrder('SELL', 1);
      return onLimitOrder('SELL', price, 1);
    }
  }, [disabled, currentPrice, onLimitOrder, onMarketOrder]);

  const handleOrderClick = useCallback((price: number) => {
    if (disabled) return;
    onCancelOrders?.(price);
  }, [disabled, onCancelOrders]);

  
  // ===== Infinite scroll window (no external files, no TradingInterface changes) =====
  const [lowTick, setLowTick] = useState<number | null>(null);
  const [highTick, setHighTick] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pendingScrollAdjustRef = useRef<number>(0);
  const BATCH_SIZE = 100;

  // Base levels from props
  const baseLevels = tickLadder?.levels ?? [];

  // Deduce tickSize from known prices (fallback 0.25 for NQ)
  const tickSize = useMemo(() => {
    if (!tickLadder?.levels?.length) return 0.25;
    const prices = Array.from(new Set(tickLadder.levels.map(l => l.price))).sort((a, b) => a - b);
    let minStep = Number.POSITIVE_INFINITY;
    for (let i = 1; i < prices.length; i++) {
      const diff = Math.abs(prices[i] - prices[i - 1]);
      if (diff > 0 && diff < minStep) minStep = diff;
    }
    return Number.isFinite(minStep) ? minStep : 0.25;
  }, [tickLadder]);

  // Initialize window once from current ladder
  useEffect(() => {
    if (!tickLadder) return;
    if (lowTick == null || highTick == null) {
      const visible = tickLadder.levels?.length ?? 101;
      const half = Math.floor(visible / 2);
      setLowTick(tickLadder.midTick - half);
      setHighTick(tickLadder.midTick + half);
    }
  }, [tickLadder, lowTick, highTick]);

  // Build fast lookup tick->level
  const levelByTick = useMemo(() => {
    const m = new Map<number, any>();
    tickLadder?.levels?.forEach(l => m.set(l.tick, l));
    return m;
  }, [tickLadder]);

  // Converter tick->price based on mid
  const tickToPrice = useMemo(() => {
    if (!tickLadder) return (t: number) => t;
    const baseTick = tickLadder.midTick;
    const basePx = tickLadder.midPrice;
    return (t: number) => +(basePx + (t - baseTick) * tickSize).toFixed(10);
  }, [tickLadder, tickSize]);

  // Extended levels according to [lowTick..highTick] (descending)
  const extendedLevels = useMemo(() => {
    if (!tickLadder || lowTick == null || highTick == null) return null;
    const out: any[] = [];
    for (let t = highTick; t >= lowTick; t--) {
      const known = levelByTick.get(t);
      if (known) {
        out.push(known);
      } else {
        out.push({ tick: t, price: tickToPrice(t), bidSize: 0, askSize: 0 });
      }
    }
    return out;
  }, [tickLadder, lowTick, highTick, levelByTick, tickToPrice]);

  // Scroll listener to extend window
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const el = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!el) return;

    const THRESHOLD = 40;
    let rowHeight = 32; // default ~h-8
    const firstRow = el.querySelector('[data-dom-row]') as HTMLElement | null;
    if (firstRow?.offsetHeight) rowHeight = firstRow.offsetHeight;

    const onScroll = () => {
      const top = el.scrollTop;
      const maxScrollTop = el.scrollHeight - el.clientHeight;
      const distToBottom = maxScrollTop - top;

      if (top < THRESHOLD) {
        pendingScrollAdjustRef.current += BATCH_SIZE * rowHeight;
        setHighTick(h => (h == null ? h : h + BATCH_SIZE));
      } else if (distToBottom < THRESHOLD) {
        setLowTick(l => (l == null ? l : l - BATCH_SIZE));
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [tickLadder, lowTick, highTick]);

  // After extending up, compensate visual jump
  useEffect(() => {
    if (!pendingScrollAdjustRef.current) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) { pendingScrollAdjustRef.current = 0; return; }
    const el = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!el) { pendingScrollAdjustRef.current = 0; return; }
    const delta = pendingScrollAdjustRef.current;
    pendingScrollAdjustRef.current = 0;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollTop + delta;
    });
  }, [extendedLevels]);

  // Final rows to render
  const levels = extendedLevels ?? baseLevels;


  return (
    <div ref={wrapperRef} className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="p-3">
          <h3 className="text-sm font-semibold">DOM</h3>
        </div>
        <div data-dom-row className="grid grid-cols-5 text-xs font-semibold text-muted-foreground border-t border-border">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {levels.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Aucun niveau à afficher
          </div>
        ) : (
          levels.map((level) => {
            const lastSize = lastSizeByPrice.get(level.price) ?? 0;
            const volume = volumeByPrice.get(level.price) ?? 0;
            const isMid = Math.abs(level.price - currentPrice) < 1e-9;
            
            const buyOrders = getOrdersAtPrice(level.price, 'BUY');
            const sellOrders = getOrdersAtPrice(level.price, 'SELL');
            const totalBuy = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const totalSell = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

            return (
              <div
                key={level.price}
                className={cn(
                  "grid grid-cols-5 text-xs border-b border-border/50 h-8 items-center",
                  "hover:bg-ladder-row-hover transition-colors"
                )}
              >
                {/* Size (last trade @ price) */}
                <div className="flex items-center justify-center border-r border-border/50 font-mono">
                  {formatSize(lastSize)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                    "hover:bg-trading-buy/10"
                  )}
                  onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
                >
                  {level.price <= currentPrice && (
                    <>
                      <span>{formatSize(level.bidSize)}</span>
                      {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                    </>
                  )}
                  {/* Cellule cliquable même sans contenu visible pour ordres de marché */}
                  {level.price > currentPrice && <span className="invisible">.</span>}
                </div>

                {/* Price */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono border-r border-border/50 cursor-pointer",
                    isMid && "text-yellow-400 font-semibold",
                    "hover:bg-muted/50"
                  )}
                  onClick={() => onCancelOrders?.(level.price)}
                >
                  {formatPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                    "hover:bg-trading-sell/10"
                  )}
                  onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
                >
                  {level.price >= currentPrice && (
                    <>
                      <span>{formatSize(level.askSize)}</span>
                      {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                    </>
                  )}
                  {/* Cellule cliquable même sans contenu visible pour ordres de marché */}
                  {level.price < currentPrice && <span className="invisible">.</span>}
                </div>

                {/* Volume */}
                <div className="flex items-center justify-center font-mono text-muted-foreground">
                  {formatSize(volume)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});