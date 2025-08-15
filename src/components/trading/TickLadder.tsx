import { memo, useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';

type Side = 'BUY' | 'SELL';

interface Order {
  id: string;
  side: Side;
  price: number;
  quantity: number;
  filled: number;
}

interface PositionLike {
  quantity: number;
  averagePrice: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: Side, price: number, quantity: number) => void;
  onMarketOrder: (side: Side, quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position?: PositionLike; // pour surligner le prix moyen
}

/* ---------- utils prix/tick ---------- */
function fmtPrice(p: number) {
  return Number.isFinite(p) ? p.toFixed(2).replace('.', ',') : '';
}
function fmtSize(s: number) {
  return s > 0 ? String(s) : '';
}

/** Normalise le pas sur une grille standard pour éviter des steps bizarres (flottants) */
function normalizeStep(raw: number, fallback = 0.25) {
  const allowed = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
  const s = (isFinite(raw) && raw > 0) ? raw : fallback;
  let best = allowed[0];
  for (const a of allowed) {
    if (Math.abs(a - s) < Math.abs(best - s)) best = a;
  }
  return best;
}

/** Déduit un pas: plus petit écart positif entre prix triés, puis normalise */
function inferStep(prices: number[], fallback = 0.25) {
  const uniq = Array.from(new Set(prices.filter(Number.isFinite))).sort((a, b) => a - b);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < uniq.length; i++) {
    const d = +(uniq[i] - uniq[i - 1]).toFixed(10);
    if (d > 0 && d < best) best = d;
  }
  if (!isFinite(best) || best <= 0) best = fallback;
  if (best > 1) best = fallback;
  return normalizeStep(best, fallback);
}

function toTickIdx(price: number, step: number) {
  return Math.round(price / step);
}
function fromTickIdx(idx: number, step: number) {
  return +(idx * step).toFixed(8);
}

/** Déduplique/merge par index de tick → 1 ligne par prix exactement */
function dedupeMergeByTick(levels: any[], step: number) {
  const map = new Map<number, any>();
  for (const l of levels) {
    const idx = toTickIdx(l.price, step);
    const p = fromTickIdx(idx, step);
    const prev = map.get(idx);
    if (!prev) {
      map.set(idx, { ...l, price: p, __tickIdx: idx });
    } else {
      map.set(idx, {
        ...prev,
        // merge: on peut sommer (ou garder max) les tailles, ici somme
        bidSize: (prev.bidSize || 0) + (l.bidSize || 0),
        askSize: (prev.askSize || 0) + (l.askSize || 0),
        volumeCumulative: Math.max(prev.volumeCumulative || 0, l.volumeCumulative || 0),
        sizeWindow: (prev.sizeWindow || 0) + (l.sizeWindow || 0)
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.__tickIdx - a.__tickIdx);
}

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  position
}: TickLadderProps) {

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevAnchorDeltaRef = useRef<number | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  /* 1) niveaux bruts */
  const baseLevels = useMemo(() => {
    if (!tickLadder?.levels?.length) return [];
    return tickLadder.levels.slice();
  }, [tickLadder]);

  /* 2) pas de tick robuste */
  const step = useMemo(() => {
    const prices = baseLevels.map((l: any) => l.price);
    return inferStep(prices, 0.25);
  }, [baseLevels]);

  /* 3) déduplication stricte par index de tick */
  const mergedLevels = useMemo(() => {
    if (!baseLevels.length) return [];
    return dedupeMergeByTick(baseLevels, step);
  }, [baseLevels, step]);

  /* 4) padding visuel haut/bas, puis re-dédoublonnage (au cas où) */
  const displayLevels = useMemo(() => {
    if (!mergedLevels.length) return [];
    const levels = mergedLevels.slice();

    const PAD = 200; // nb de ticks vides haut/bas
    const topIdx = mergedLevels[0].__tickIdx;
    const botIdx = mergedLevels[mergedLevels.length - 1].__tickIdx;

    for (let i = 1; i <= PAD; i++) {
      const idx = topIdx + i;
      levels.unshift({
        price: fromTickIdx(idx, step),
        bidSize: 0,
        askSize: 0,
        volumeCumulative: 0,
        sizeWindow: 0,
        __tickIdx: idx,
        tick: `pad-top-${i}`
      });
    }
    for (let i = 1; i <= PAD; i++) {
      const idx = botIdx - i;
      levels.push({
        price: fromTickIdx(idx, step),
        bidSize: 0,
        askSize: 0,
        volumeCumulative: 0,
        sizeWindow: 0,
        __tickIdx: idx,
        tick: `pad-bot-${i}`
      });
    }

    return dedupeMergeByTick(levels, step);
  }, [mergedLevels, step]);

  /* ordres présents à un prix (match par tick index) */
  const getOrdersAtPrice = (price: number, side: Side) => {
    const targetIdx = toTickIdx(price, step);
    return orders.filter(o =>
      o.side === side &&
      toTickIdx(o.price, step) === targetIdx &&
      o.quantity > o.filled
    );
  };

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = toTickIdx(price, step) === toTickIdx(currentPrice, step);

    if (column === 'bid') {
      if (isAbove || isAt) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      if (isBelow || isAt) onMarketOrder('SELL', 1);
      else onLimitOrder('SELL', price, 1);
    }
  };
  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  /* ----- anti-sauts: mémorise la position verticale de la ligne du last avant maj ----- */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>(
      `[data-row-tick="${toTickIdx(currentPrice, step)}"]`
    );
    if (!anchor) {
      prevAnchorDeltaRef.current = null;
      return;
    }
    const crect = el.getBoundingClientRect();
    const arect = anchor.getBoundingClientRect();
    prevAnchorDeltaRef.current = arect.top - crect.top;
  }, [/* before render */]);

  /* ----- puis recale pour garder le “last” fixe à l’écran ----- */
  useLayoutEffect(() => {
    if (userScrolled) return;
    const el = scrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>(
      `[data-row-tick="${toTickIdx(currentPrice, step)}"]`
    );
    if (!anchor || prevAnchorDeltaRef.current == null) return;
    const crect = el.getBoundingClientRect();
    const arect = anchor.getBoundingClientRect();
    const delta = (arect.top - crect.top) - prevAnchorDeltaRef.current;
    if (Math.abs(delta) > 0.5) {
      el.scrollTop += delta;
    }
  }, [displayLevels, currentPrice, userScrolled, step]);

  /* Barre d’espace → recentre le last au milieu */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      const el = scrollRef.current;
      if (!el) return;
      const anchor = el.querySelector<HTMLElement>(
        `[data-row-tick="${toTickIdx(currentPrice, step)}"]`
      );
      if (!anchor) return;
      const crect = el.getBoundingClientRect();
      const arect = anchor.getBoundingClientRect();
      const delta = (arect.top + arect.height / 2) - (crect.top + crect.height / 2);
      el.scrollTop += delta;
      setUserScrolled(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPrice, step]);

  if (!tickLadder || !displayLevels.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  const lastIdx = toTickIdx(currentPrice, step);
  const avgIdx =
    position && position.quantity !== 0
      ? toTickIdx(position.averagePrice, step)
      : null;

  return (
    <div className="h-full flex flex-col bg-card">
      <div className="bg-ladder-header border-b border-border">
        <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto trading-scroll"
        onScroll={() => setUserScrolled(true)}
      >
        {displayLevels.map((level: any, idx: number) => {
          const rowIdx = level.__tickIdx ?? toTickIdx(level.price, step);
          const price = fromTickIdx(rowIdx, step);
          const isLast = rowIdx === lastIdx;
          const isAvg = avgIdx != null && rowIdx === avgIdx;

          const buyOrders = getOrdersAtPrice(price, 'BUY');
          const sellOrders = getOrdersAtPrice(price, 'SELL');
          const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          return (
            <div
              key={`${rowIdx}-${level.tick ?? idx}`}
              data-row-tick={rowIdx}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                (level.sizeWindow || 0) > 0 && "font-medium text-trading-neutral"
              )}>
                {fmtSize(level.sizeWindow ?? 0)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  price <= currentPrice && (level.bidSize || 0) > 0 && "bg-ladder-bid text-trading-buy",
                  price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQty > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() =>
                  totalBuyQty > 0 ? onCancelOrders(price) : onLimitOrder('BUY', price, 1)
                }
              >
                {price <= currentPrice && (
                  <>
                    <span>{fmtSize(level.bidSize || 0)}</span>
                    {totalBuyQty > 0 && <span className="ml-1 text-[10px]">({totalBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price — cell sticky + highlight seulement ici */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 sticky-price-cell",
                  isLast && "text-trading-average font-bold",
                  isAvg && "outline-average-price"
                )}
              >
                {fmtPrice(price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  price >= currentPrice && (level.askSize || 0) > 0 && "bg-ladder-ask text-trading-sell",
                  price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQty > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() =>
                  totalSellQty > 0 ? onCancelOrders(price) : onLimitOrder('SELL', price, 1)
                }
              >
                {price >= currentPrice && (
                  <>
                    <span>{fmtSize(level.askSize || 0)}</span>
                    {totalSellQty > 0 && <span className="ml-1 text-[10px]">({totalSellQty})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé */}
              <div className="flex items-center justify-center text-muted-foreground">
                {fmtSize(level.volumeCumulative ?? level.volume ?? 0)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});