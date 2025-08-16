import { memo, useMemo, useRef, useCallback, useState } from 'react';
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

const WINDOW = 100; // 100 ticks au-dessus et en dessous (201 lignes)
const ROW_HEIGHT_PX = 24;

type TickRow = {
  tickIndex: number;
  price: number;
  bidSize: number;
  askSize: number;
  sizeWindow: number;
  volumeCumulative: number;
};

// Ligne mémoïsée
const LadderRow = memo(function LadderRow({
  row,
  currentPrice,
  buyTotal,
  sellTotal,
  onCellClick,
  onCancelOrders,
  onDoubleClickPrice
}: {
  row: TickRow;
  currentPrice: number;
  buyTotal: number;
  sellTotal: number;
  onCellClick: (price: number, side: 'bid' | 'ask') => void;
  onCancelOrders: (price: number) => void;
  onDoubleClickPrice: () => void;
}) {
  const { price, bidSize, askSize, sizeWindow, volumeCumulative } = row;

  const isLastPrice = Math.abs(price - currentPrice) < 0.125;
  const showBid = price <= currentPrice;
  const showAsk = price >= currentPrice;

  return (
    <div
      key={price}
      className={cn('grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6')}
      style={{ willChange: 'opacity', backfaceVisibility: 'hidden' as any }}
    >
      {/* Size (window) */}
      <div className="flex items-center justify-center border-r border-border/50">
        {fmtSize(sizeWindow)}
      </div>

      {/* Bids */}
      <div
        className={cn(
          'flex items-center justify-center cursor-pointer border-r border-border/50',
          showBid && bidSize > 0 && 'bg-ladder-bid'
        )}
        onClick={() => (buyTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'bid'))}
      >
        <span className={cn(!showBid && 'opacity-0')}>{fmtSize(bidSize)}</span>
        {buyTotal > 0 && <span className={cn('ml-1 text-xs', !showBid && 'opacity-0')}>({buyTotal})</span>}
      </div>

      {/* Price */}
      <div
        className={cn(
          'flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price',
          isLastPrice && 'text-trading-average font-bold'
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
          showAsk && askSize > 0 && 'bg-ladder-ask'
        )}
        onClick={() => (sellTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'ask'))}
      >
        <span className={cn(!showAsk && 'opacity-0')}>{fmtSize(askSize)}</span>
        {sellTotal > 0 && <span className={cn('ml-1 text-xs', !showAsk && 'opacity-0')}>({sellTotal})</span>}
      </div>

      {/* Volume cumulé */}
      <div className="flex items-center justify-center text-muted-foreground">{fmtSize(volumeCumulative)}</div>
    </div>
  );
}, (a, b) => (
  a.row.price === b.row.price &&
  a.row.bidSize === b.row.bidSize &&
  a.row.askSize === b.row.askSize &&
  a.row.sizeWindow === b.row.sizeWindow &&
  a.row.volumeCumulative === b.row.volumeCumulative &&
  a.currentPrice === b.currentPrice &&
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

  const tickSize = useMemo(() => {
    if (tickLadder?.levels && tickLadder.levels.length >= 2) {
      return Math.abs(tickLadder.levels[0].price - tickLadder.levels[1].price) || 0.25;
    }
    return 0.25;
  }, [tickLadder]);

  const toTickIndex = useCallback((price: number) => Math.round(price / tickSize), [tickSize]);
  const fromTickIndex = useCallback((idx: number) => idx * tickSize, [tickSize]);

  // Regroupement par tickIndex (évite les mismatches flottants)
  const rowByTick = useMemo(() => {
    const m = new Map<number, TickRow>();
    if (tickLadder?.levels) {
      for (const lvl of tickLadder.levels) {
        const idx = Math.round(lvl.price / tickSize);
        const price = fromTickIndex(idx);
        const prev = m.get(idx);
        const row: TickRow = prev ?? {
          tickIndex: idx,
          price,
          bidSize: 0,
          askSize: 0,
          sizeWindow: 0,
          volumeCumulative: 0,
        };
        row.bidSize += (lvl as any).bidSize ?? 0;
        row.askSize += (lvl as any).askSize ?? 0;
        row.sizeWindow += (lvl as any).sizeWindow ?? 0;
        row.volumeCumulative += (lvl as any).volumeCumulative ?? 0;
        m.set(idx, row);
      }
    }
    return m;
  }, [tickLadder, tickSize, fromTickIndex]);

  // Totaux d'ordres par tickIndex
  const buyTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) {
      if (o.side === 'BUY' && o.quantity > o.filled) {
        const idx = Math.round(o.price / tickSize);
        m.set(idx, (m.get(idx) ?? 0) + (o.quantity - o.filled));
      }
    }
    return m;
  }, [orders, tickSize]);
  const sellTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of orders) {
      if (o.side === 'SELL' && o.quantity > o.filled) {
        const idx = Math.round(o.price / tickSize);
        m.set(idx, (m.get(idx) ?? 0) + (o.quantity - o.filled));
      }
    }
    return m;
  }, [orders, tickSize]);

  // Base (ancre) + offset virtuel en ticks
  const computeBaseTick = () => {
    if (tickLadder && (tickLadder as any).midPrice != null) return toTickIndex((tickLadder as any).midPrice as number);
    if (tickLadder?.levels?.length) {
      const first = tickLadder.levels[0].price;
      const last  = tickLadder.levels[tickLadder.levels.length - 1].price;
      return toTickIndex((first + last) / 2);
    }
    return toTickIndex(currentPrice);
  };
  const baseTick = computeBaseTick();

  const offsetRef = useRef(0); // en ticks
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
    if (off >= WINDOW || off <= -WINDOW) {
      const pages = off > 0 ? Math.floor(off / WINDOW) : Math.ceil(off / WINDOW);
      const nextTick = baseTick + pages * WINDOW;
      const nextPrice = fromTickIndex(nextTick);
      offsetRef.current = off - pages * WINDOW;
      setViewAnchorPrice(nextPrice);
    }
  }, [setViewAnchorPrice, baseTick, fromTickIndex]);

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
      // PIXEL mode: 1 tick = 24px
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

  // Construire la fenêtre synthétique de 201 ticks autour de baseTick + offset
  const centerTick = baseTick + offsetRef.current;
  const rows: TickRow[] = useMemo(() => {
    const out: TickRow[] = [];
    for (let i = WINDOW; i >= -WINDOW; i--) {
      const idx = centerTick + i;
      const price = fromTickIndex(idx);
      const base = rowByTick.get(idx) ?? { tickIndex: idx, price, bidSize: 0, askSize: 0, sizeWindow: 0, volumeCumulative: 0 };
      out.push(base);
    }
    return out;
  }, [rowByTick, centerTick, fromTickIndex, nonce]);

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

      {/* Body (pas de scroll natif, fenêtrage virtuel) */}
      <div ref={wrapperRef} onWheel={handleWheel} onWheelCapture={handleWheelCapture} onKeyDown={handleKeyDown} tabIndex={0}>
        <div className="flex-1 overflow-y-hidden">
          {rows.map((row) => {
            const idx = row.tickIndex;
            const price = row.price;
            const buyTotal = buyTotals.get(idx) ?? 0;
            const sellTotal = sellTotals.get(idx) ?? 0;
            return (
              <LadderRow
                key={idx}
                row={row}
                currentPrice={currentPrice}
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