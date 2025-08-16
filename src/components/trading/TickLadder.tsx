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

type LevelLike = {
  price: number;
  bidSize?: number;
  askSize?: number;
  sizeWindow?: number;
  volumeCumulative?: number;
};

// Ligne mémoïsée
const LadderRow = memo(function LadderRow({
  level,
  currentPrice,
  buyTotal,
  sellTotal,
  onCellClick,
  onCancelOrders,
  onDoubleClickPrice
}: {
  level: LevelLike;
  currentPrice: number;
  buyTotal: number;
  sellTotal: number;
  onCellClick: (price: number, side: 'bid' | 'ask') => void;
  onCancelOrders: (price: number) => void;
  onDoubleClickPrice: () => void;
}) {
  const price = level.price;
  const bidSize = level.bidSize ?? 0;
  const askSize = level.askSize ?? 0;
  const sizeWindow = level.sizeWindow ?? 0;
  const volumeCumulative = level.volumeCumulative ?? 0;

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
  a.level.price === b.level.price &&
  (a.level.bidSize ?? 0) === (b.level.bidSize ?? 0) &&
  (a.level.askSize ?? 0) === (b.level.askSize ?? 0) &&
  (a.level.sizeWindow ?? 0) === (b.level.sizeWindow ?? 0) &&
  (a.level.volumeCumulative ?? 0) === (b.level.volumeCumulative ?? 0) &&
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

  // Map des niveaux existants par prix exact
  const levelByPrice = useMemo(() => {
    const m = new Map<number, LevelLike>();
    if (tickLadder?.levels) {
      for (const lvl of tickLadder.levels) {
        m.set(lvl.price, {
          price: lvl.price,
          bidSize: (lvl as any).bidSize ?? 0,
          askSize: (lvl as any).askSize ?? 0,
          sizeWindow: (lvl as any).sizeWindow ?? 0,
          volumeCumulative: (lvl as any).volumeCumulative ?? 0,
        });
      }
    }
    return m;
  }, [tickLadder]);

  // Totaux d'ordres par prix
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

  // Base (ancre actuelle) et fenêtrage virtuel par offset en ticks
  const computeBasePrice = () => {
    if (tickLadder && (tickLadder as any).midPrice != null) return (tickLadder as any).midPrice as number;
    if (tickLadder?.levels?.length) {
      // centre géométrique
      const first = tickLadder.levels[0].price;
      const last  = tickLadder.levels[tickLadder.levels.length - 1].price;
      return (first + last) / 2;
    }
    return currentPrice;
  };
  const basePrice = computeBasePrice();
  const baseTickPrice = Math.round(basePrice / tickSize) * tickSize;

  // offset virtuel en ticks (contrôlé par la molette)
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
    if (off >= WINDOW || off <= -WINDOW) {
      const pages = off > 0 ? Math.floor(off / WINDOW) : Math.ceil(off / WINDOW);
      const nextAnchor = baseTickPrice + pages * WINDOW * tickSize;
      offsetRef.current = off - pages * WINDOW;
      setViewAnchorPrice(nextAnchor);
    }
  }, [setViewAnchorPrice, baseTickPrice, tickSize]);

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
      // PIXEL mode: 1 ligne visuelle = 1 tick (24px)
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

  // Construire la fenêtre synthétique de 201 ticks autour de baseTickPrice + offset
  const centerTickOffset = offsetRef.current;
  const view: LevelLike[] = useMemo(() => {
    const rows: LevelLike[] = [];
    const centerPrice = baseTickPrice + centerTickOffset * tickSize;
    // top->bottom (prix décroissant)
    for (let i = WINDOW; i >= -WINDOW; i--) {
      const p = +(centerPrice + i * tickSize).toFixed(10);
      const lvl = levelByPrice.get(p) ?? { price: p, bidSize: 0, askSize: 0, sizeWindow: 0, volumeCumulative: 0 };
      rows.push(lvl);
    }
    return rows;
  }, [levelByPrice, baseTickPrice, centerTickOffset, tickSize, nonce]);

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

      {/* Body (pas de scroll natif, fenêtrage virtuel) */}
      <div ref={wrapperRef} onWheel={handleWheel} onWheelCapture={handleWheelCapture} onKeyDown={handleKeyDown} tabIndex={0}>
        <div className="flex-1 overflow-y-hidden">
          {view.map((lvl) => {
            const price = lvl.price;
            const buyTotal = buyTotals.get(price) ?? 0;
            const sellTotal = sellTotals.get(price) ?? 0;
            return (
              <LadderRow
                key={price}
                level={lvl}
                currentPrice={currentPrice}
                buyTotal={buyTotal}
                sellTotal={sellTotal}
                onCellClick={handleCellClick}
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