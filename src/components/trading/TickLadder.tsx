import { memo, useMemo, useRef, useCallback } from 'react';
import { useEffect, useState } from 'react';
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
  pnl: number;
}

interface TickLevel {
  price: number;
  bidSize?: number;
  askSize?: number;
  sizeWindow?: number;
  volumeCumulative?: number;
  tick?: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType;
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
  // === Added: Price cell highlight via Cmd/Ctrl + Left Click (no deletion of existing code) ===
  // Keep a set of highlighted price string keys (e.g., "15324.50")
  const [highlightedPriceKeys, setHighlightedPriceKeys] = useState<Set<string>>(new Set());

  // Helper to normalize a price string from DOM text into a stable key
  const normalizePriceKey = useCallback((txt: string) => {
    const s = (txt || '').trim().replace(',', '.');
    const n = Number(s);
    if (Number.isFinite(n)) return n.toFixed(2);
    return '';
  }, []);

  // Inject a small CSS helper once to ensure yellow paint overrides any background
  useEffect(() => {
    const id = 'tickladder-highlight-style';
    if (!document.getElementById(id)) {
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `.tick-price--highlight { background-color: #fde047 !important; }`;
      document.head.appendChild(style);
    }
  }, []);

  // Delegate mouse down on the scroll wrapper to support Cmd/Ctrl + left click on Price cells
  useEffect(() => {
    const root = scrollWrapperRef.current;
    if (!root) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // only left click
      // Cmd (Mac) or Ctrl (PC)
      const me = e as MouseEvent & { metaKey?: boolean; ctrlKey?: boolean };
      if (!(me.metaKey || me.ctrlKey)) return;

      // find the closest Price cell by its existing class
      const target = e.target as HTMLElement | null;
      const cell = target?.closest?.('div.bg-ladder-price') as HTMLElement | null;
      if (!cell) return;

      e.preventDefault();

      const key = normalizePriceKey(cell.innerText);
      if (!key) return;

      // Toggle in React state
      setHighlightedPriceKeys(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    root.addEventListener('mousedown', onMouseDown);
    return () => {
      root.removeEventListener('mousedown', onMouseDown);
    };
  }, [scrollWrapperRef, normalizePriceKey]);

  // After each render/update, apply or remove the highlight class to matching Price cells
  useEffect(() => {
    const root = scrollWrapperRef.current;
    if (!root) return;

    const cells = Array.from(root.querySelectorAll('div.bg-ladder-price')) as HTMLElement[];
    for (const cell of cells) {
      const key = normalizePriceKey(cell.innerText);
      if (key && highlightedPriceKeys.has(key)) {
        cell.classList.add('tick-price--highlight');
      } else {
        cell.classList.remove('tick-price--highlight');
      }
    }
  }, [tickLadder, currentPrice, highlightedPriceKeys, normalizePriceKey]);
  // === End added code ===

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
      steps = deltaY < 0 ? +1 : -1;
    } else {
      // PIXEL mode: convert wheel delta to rows, keep fractional remainder
      const rows = deltaY / ROW_HEIGHT_PX;
      const withRemainder = wheelRemainderRef.current + rows;
      steps = Math.trunc(withRemainder);
      wheelRemainderRef.current = withRemainder - steps;
    }

    // anchor adjustment
    const base = computeBasePrice();
    setViewAnchorPrice(base + steps * tickSize);
  }, [setViewAnchorPrice, tickLadder]);

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

  if (!tickLadder) {
    return (
      <div className="border rounded-lg overflow-hidden">
        <div className="p-6 text-center text-muted-foreground">No data</div>
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden flex flex-col">
      {/* Header */}
      <div className="border-b border-border">
        <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs bg-muted/30">
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
          {(tickLadder.levels as TickLevel[]).slice().sort((a, b) => b.price - a.price).map((level) => {
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
                    level.price <= currentPrice && "bg-ladder-bid"
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
                  onDoubleClick={() => setViewAnchorPrice && setViewAnchorPrice(null)}
                  title="Double-clique pour recentrer"
                >
                  {fmtPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price >= currentPrice && "bg-ladder-ask"
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