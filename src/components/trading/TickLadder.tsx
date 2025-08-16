import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';

/** Public order type coming from the engine */
interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface TickLevelView {
  /** unique numeric price (key) */
  price: number;
  /** live sizes (may be 0 for padded ticks) */
  bidSize: number;
  askSize: number;
  /** optional extras if you have them on your TickLevel */
  sizeWindow?: number;
  volumeCumulative?: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  /** optional: pass current position if you already had it */
  position?: { quantity: number; averagePrice: number } | null;
}

const WINDOW_TARGET_ROWS = 600;           // total rows kept in memory
const CHUNK_ROWS = 300;                   // rows to add/remove per edge hit
const EDGE_PX = 40;                       // how close to edge before loading
const HIGHLIGHT_SIZE = 20;                // >= 20 lots => yellow cell

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}
function formatSize(n: number): string {
  return n > 0 ? n.toString() : '';
}

/** Round to an 0.25 grid */
const roundToGrid = (p: number, step: number) =>
  Math.round(p / step) * step;

/** Build placeholder levels for a contiguous price range (descending order) */
function buildPlaceholdersDescending(fromPrice: number, count: number, step: number): TickLevelView[] {
  const arr: TickLevelView[] = [];
  for (let i = 1; i <= count; i++) {
    arr.push({
      price: fromPrice + i * step,
      bidSize: 0,
      askSize: 0
    });
  }
  // we want highest first in the list, these are built above `fromPrice` already
  arr.sort((a, b) => b.price - a.price);
  return arr;
}
function buildPlaceholdersAscending(fromPrice: number, count: number, step: number): TickLevelView[] {
  const arr: TickLevelView[] = [];
  for (let i = 1; i <= count; i++) {
    arr.push({
      price: fromPrice - i * step,
      bidSize: 0,
      askSize: 0
    });
  }
  // lowest first right now; we render descending, so sort:
  arr.sort((a, b) => b.price - a.price);
  return arr;
}

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  position = null,
}: TickLadderProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowHeightRef = useRef<number>(24); // measured after first render
  const measuringRef = useRef<HTMLDivElement | null>(null);

  const tickSize = (tickLadder as any)?.tickSize || 0.25;

  // --- Local padded levels keyed by price (no duplicates) --------
  const [padded, setPadded] = useState<TickLevelView[]>([]);

  // map orders for quick lookup by price
  const getOrdersAtPrice = useCallback((price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(o =>
      o.side === side &&
      Math.abs(o.price - price) < tickSize / 2 &&
      o.quantity > o.filled
    );
  }, [orders, tickSize]);

  // Initialize / update with live ladder levels
  useEffect(() => {
    if (!tickLadder || !tickLadder.levels || tickLadder.levels.length === 0) return;

    // Merge incoming live levels into our padded list, keyed by price.
    setPadded(prev => {
      const byPrice = new Map<number, TickLevelView>();
      // start from existing padded (so we keep placeholders)
      for (const lv of prev) byPrice.set(lv.price, lv);

      // update/insert with live data
      for (const lv of (tickLadder.levels as any[])) {
        const p = roundToGrid(lv.price, tickSize);
        const cur = byPrice.get(p) || { price: p, bidSize: 0, askSize: 0 } as TickLevelView;
        byPrice.set(p, {
          price: p,
          bidSize: lv.bidSize ?? cur.bidSize ?? 0,
          askSize: lv.askSize ?? cur.askSize ?? 0,
          sizeWindow: lv.sizeWindow ?? cur.sizeWindow,
          volumeCumulative: lv.volumeCumulative ?? cur.volumeCumulative,
        });
      }

      // create an array and sort descending (top = highest price)
      let merged = Array.from(byPrice.values()).sort((a, b) => b.price - a.price);

      // If we have too few rows initially, pad around currentPrice to reach WINDOW_TARGET_ROWS
      if (merged.length < WINDOW_TARGET_ROWS) {
        const center = roundToGrid(currentPrice || merged[Math.floor(merged.length / 2)]?.price || 0, tickSize);
        const half = Math.max(0, Math.floor((WINDOW_TARGET_ROWS - merged.length) / 2));

        // ensure we have a continuous range around center
        const highest = merged[0]?.price ?? center;
        const lowest  = merged[merged.length - 1]?.price ?? center;
        // pad above
        const needUp = Math.max(0, half - Math.round((highest - center) / tickSize));
        // pad below
        const needDown = Math.max(0, half - Math.round((center - lowest) / tickSize));

        if (needUp > 0) {
          const up = buildPlaceholdersDescending(highest, needUp, tickSize);
          merged = [...up, ...merged];
        }
        if (needDown > 0) {
          const down = buildPlaceholdersAscending(lowest, needDown, tickSize);
          merged = [...merged, ...down];
        }
      }

      // Keep a hard cap (FIFO window)
      if (merged.length > WINDOW_TARGET_ROWS) {
        const extra = merged.length - WINDOW_TARGET_ROWS;
        // drop evenly top/bottom if possible
        const dropTop = Math.floor(extra / 2);
        const dropBottom = extra - dropTop;
        merged = merged.slice(dropTop, merged.length - dropBottom);
      }

      return merged;
    });
  }, [tickLadder, tickSize, currentPrice]);

  // Measure row height once (for accurate scrollTop compensation)
  useEffect(() => {
    if (!measuringRef.current) return;
    const el = measuringRef.current;
    const h = el.offsetHeight || 24;
    if (h && Math.abs(h - rowHeightRef.current) > 0.5) {
      rowHeightRef.current = h;
    }
  }, [padded.length]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < tickSize / 2;

    if (column === 'bid') {
      // BUY market if click above or at last, else BUY limit
      if (isAbove || isAt) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      // SELL market if click below or at last, else SELL limit
      if (isBelow || isAt) onMarketOrder('SELL', 1);
      else onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  // Infinite FIFO scroll
  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc || padded.length === 0) return;

    const { scrollTop, clientHeight, scrollHeight } = sc;

    // TOP edge → prepend higher prices and drop bottom chunk
    if (scrollTop <= EDGE_PX) {
      const highest = padded[0].price;
      const step = tickSize;
      const chunk = buildPlaceholdersDescending(highest, CHUNK_ROWS, step);

      setPadded(prev => {
        const byPrice = new Map<number, TickLevelView>();
        // new chunk first
        for (const lv of chunk) byPrice.set(lv.price, lv);
        // then existing
        for (const lv of prev) byPrice.set(lv.price, lv);

        // to array desc
        let next = Array.from(byPrice.values()).sort((a, b) => b.price - a.price);

        // FIFO: remove a chunk from the bottom to keep constant window
        if (next.length > WINDOW_TARGET_ROWS) {
          next = next.slice(0, WINDOW_TARGET_ROWS);
        }

        // Preserve scroll (we inserted CHUNK_ROWS rows of rowHeight each)
        requestAnimationFrame(() => {
          if (!scrollRef.current) return;
          scrollRef.current.scrollTop = scrollRef.current.scrollTop + CHUNK_ROWS * rowHeightRef.current;
        });

        return next;
      });
    }

    // BOTTOM edge → append lower prices and drop top chunk
    const distanceToBottom = scrollHeight - (scrollTop + clientHeight);
    if (distanceToBottom <= EDGE_PX) {
      const lowest = padded[padded.length - 1].price;
      const step = tickSize;
      const chunk = buildPlaceholdersAscending(lowest, CHUNK_ROWS, step);

      setPadded(prev => {
        const byPrice = new Map<number, TickLevelView>();
        for (const lv of prev) byPrice.set(lv.price, lv);
        for (const lv of chunk) byPrice.set(lv.price, lv);

        let next = Array.from(byPrice.values()).sort((a, b) => b.price - a.price);

        // FIFO: drop from top if needed
        if (next.length > WINDOW_TARGET_ROWS) {
          next = next.slice(next.length - WINDOW_TARGET_ROWS);
          // After dropping top rows, no need to adjust scrollTop (we removed from out of view)
        }

        return next;
      });
    }
  }, [padded, tickSize]);

  // Average entry highlight (yellow frame only around the PRICE cell)
  const avgPrice = position && position.quantity !== 0 ? position.averagePrice : null;

  if (!tickLadder || !padded.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card">
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

      {/* Rows container (scrollable) */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto trading-scroll"
        onScroll={onScroll}
      >
        {/* hidden measuring row for exact row height */}
        <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] h-6 invisible absolute" ref={measuringRef}>
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>

        {/* Render rows - padded already sorted desc by price */}
        {padded.map((level, idx) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < tickSize / 2;
          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          return (
            <div
              key={`p-${level.price.toFixed(2)}`}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                isLastPrice && "bg-ladder-last/20",
                "hover:bg-ladder-row-hover transition-none"
              )}
            >
              {/* Size (window / recent prints if you have it) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                level.sizeWindow && level.sizeWindow > 0 && "font-medium"
              )}>
                {formatSize(level.sizeWindow ?? 0)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQty > 0 && "ring-2 ring-trading-buy/50",
                  level.bidSize >= HIGHLIGHT_SIZE && "bg-[hsl(var(--trading-average)/0.25)]"
                )}
                onClick={() =>
                  totalBuyQty > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')
                }
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{formatSize(level.bidSize)}</span>
                    {totalBuyQty > 0 && <span className="ml-1 text-[10px] opacity-80">({totalBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price (only this cell shows yellow frame for avg entry) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price relative",
                  isLastPrice && "text-trading-average font-bold"
                )}
                style={
                  avgPrice && Math.abs(level.price - avgPrice) < tickSize / 2
                    ? { boxShadow: 'inset 0 0 0 2px hsl(var(--trading-average))' }
                    : undefined
                }
              >
                {formatPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQty > 0 && "ring-2 ring-trading-sell/50",
                  level.askSize >= HIGHLIGHT_SIZE && "bg-[hsl(var(--trading-average)/0.25)]"
                )}
                onClick={() =>
                  totalSellQty > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')
                }
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{formatSize(level.askSize)}</span>
                    {totalSellQty > 0 && <span className="ml-1 text-[10px] opacity-80">({totalSellQty})</span>}
                  </>
                )}
              </div>

              {/* Volume (cumulative if provided) */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(level.volumeCumulative ?? 0)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});