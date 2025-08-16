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

const WINDOW = 100; // 100 niveaux au-dessus et en dessous (201 lignes visibles)
const ROW_HEIGHT_PX = 24;

function findClosestIndexDescending(levels: { price: number }[], price: number): number {
  // niveaux triés par prix décroissant
  let lo = 0, hi = levels.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = levels[mid].price;
    if (p === price) return mid;
    if (p > price) lo = mid + 1; // on est plus haut que la cible -> descendre (indices croissants = prix décroissants)
    else hi = mid - 1;
  }
  // choisir l'indice le plus proche
  const cand = Math.max(0, Math.min(levels.length - 1, lo));
  if (cand === 0) return 0;
  const prev = cand - 1;
  return Math.abs(levels[cand].price - price) < Math.abs(levels[prev].price - price) ? cand : prev;
}

// Ligne mémoïsée (évite re-renders inutiles)
const LadderRow = memo(function LadderRow({
  level,
  currentPrice,
  buyTotal,
  sellTotal,
  onCellClick,
  onCancelOrders,
  onDoubleClickPrice
}: {
  level: any;
  currentPrice: number;
  buyTotal: number;
  sellTotal: number;
  onCellClick: (price: number, side: 'bid' | 'ask') => void;
  onCancelOrders: (price: number) => void;
  onDoubleClickPrice: () => void;
}) {
  const price = level.price as number;
  const bidSize = (level as any).bidSize ?? 0;
  const askSize = (level as any).askSize ?? 0;
  const sizeWindow = (level as any).sizeWindow ?? 0;
  const volumeCumulative = (level as any).volumeCumulative ?? 0;

  const isLastPrice = Math.abs(price - currentPrice) < 0.125;
  const isAvgPrice = false; // pas nécessaire pour le virtuel (garder simple)
  const showBid = price <= currentPrice;
  const showAsk = price >= currentPrice;

  return (
    <div
      key={price}
      className={cn('grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6')}
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
        onClick={() => (buyTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'bid'))}
      >
        <span className={cn(!showBid && 'opacity-0')}>{fmtSize(bidSize ?? 0)}</span>
        {buyTotal > 0 && <span className={cn('ml-1 text-xs', !showBid && 'opacity-0')}>({buyTotal})</span>}
      </div>

      {/* Price */}
      <div
        className={cn(
          'flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price',
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
          'flex items-center justify-center cursor-pointer border-r border-border/50',
          showAsk && askSize > 0 && 'bg-ladder-ask'
        )}
        onClick={() => (sellTotal > 0 ? onCancelOrders(price) : onCellClick(price, 'ask'))}
      >
        <span className={cn(!showAsk && 'opacity-0')}>{fmtSize(askSize ?? 0)}</span>
        {sellTotal > 0 && <span className={cn('ml-1 text-xs', !showAsk && 'opacity-0')}>({sellTotal})</span>}
      </div>

      {/* Volume cumulé */}
      <div className="flex items-center justify-center text-muted-foreground">{fmtSize(volumeCumulative ?? 0)}</div>
    </div>
  );
}, (a, b) => a.level.price === b.level.price
  && (a.level.bidSize ?? 0) === (b.level.bidSize ?? 0)
  && (a.level.askSize ?? 0) === (b.level.askSize ?? 0)
  && (a.level.sizeWindow ?? 0) === (b.level.sizeWindow ?? 0)
  && (a.level.volumeCumulative ?? 0) === (b.level.volumeCumulative ?? 0)
  && a.currentPrice === b.currentPrice
  && a.buyTotal === b.buyTotal
  && a.sellTotal === b.sellTotal
);

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

  // Pagination virtuelle
  const virtualOffsetRef = useRef(0); // en ticks, relatif au centre courant
  const [nonce, setNonce] = useState(0); // force re-render pour afficher le nouvel offset
  const rafIdRef = useRef<number | null>(null);

  const requestRender = () => {
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      setNonce(n => n + 1);
    });
  };

  const pageAnchorIfNeeded = useCallback((basePrice: number) => {
    if (!setViewAnchorPrice) return;
    const off = virtualOffsetRef.current;
    if (off >= WINDOW || off <= -WINDOW) {
      const pageSteps = off > 0 ? Math.floor(off / WINDOW) : Math.ceil(off / WINDOW); // entier en pages
      const nextAnchor = basePrice + pageSteps * WINDOW * tickSize;
      virtualOffsetRef.current = off - pageSteps * WINDOW; // ramener dans [-WINDOW, WINDOW)
      setViewAnchorPrice(nextAnchor);
    }
  }, [setViewAnchorPrice, tickSize]);

  const handleWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!tickLadder) return;
    e.preventDefault();

    const base = computeBasePrice();
    const mode = (e.nativeEvent as any)?.deltaMode ?? 0; // 0 pixel, 1 line
    let steps = 0;
    if (mode === 1) {
      const lines = Math.max(1, Math.abs(Math.round(e.deltaY)));
      steps = -Math.sign(e.deltaY) * lines; // up -> +, down -> -
    } else {
      const totalPx = (innerRef.current?.scrollTop ?? 0) + e.deltaY; // ne pas scroller, on traduit en steps
      // Convertir deltaY en steps entiers
      // On accumule en nombre entier de lignes en utilisant ROW_HEIGHT_PX
      // ici simple: 1 ligne par 24px
      steps = 0;
      let accum = (virtualOffsetRef as any)._pxAccum ?? 0;
      accum += e.deltaY;
      while (Math.abs(accum) >= ROW_HEIGHT_PX) {
        if (accum > 0) { steps -= 1; accum -= ROW_HEIGHT_PX; }
        else { steps += 1; accum += ROW_HEIGHT_PX; }
      }
      (virtualOffsetRef as any)._pxAccum = accum;
    }
    if (steps !== 0) {
      virtualOffsetRef.current += steps;
      pageAnchorIfNeeded(base);
      requestRender();
    }
  }, [tickLadder]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice) return;
    if (e.code === 'Space') {
      e.preventDefault();
      virtualOffsetRef.current = 0;
      setViewAnchorPrice(null);
      requestRender();
    }
  }, [setViewAnchorPrice]);

  // Pré-calcul des totaux d'ordres par prix
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

  // fenêtrage de 201 lignes autour d'un centre trouvé dans la liste triée
  const base = computeBasePrice();
  const centerIdx = sortedLevels.length ? findClosestIndexDescending(sortedLevels as any, base) : 0;
  const displayCenter = Math.max(WINDOW, Math.min(sortedLevels.length - 1 - WINDOW, centerIdx + virtualOffsetRef.current));
  const start = Math.max(0, displayCenter - WINDOW);
  const end = Math.min(sortedLevels.length - 1, displayCenter + WINDOW);
  const view = sortedLevels.slice(start, end + 1);

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

      {/* Body */}
      <div ref={wrapperRef} onWheel={handleWheel} onWheelCapture={handleWheelCapture} onKeyDown={handleKeyDown} tabIndex={0}>
        <div className="flex-1 overflow-y-hidden" ref={innerRef} style={{ willChange: 'transform', transition: 'none' as any }}>
          {view.map((level) => {
            const price = level.price as number;
            return (
              <LadderRow
                key={price}
                level={level}
                currentPrice={currentPrice}
                buyTotal={buyTotals.get(price) ?? 0}
                sellTotal={sellTotals.get(price) ?? 0}
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