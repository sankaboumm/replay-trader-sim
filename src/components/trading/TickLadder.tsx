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

function fmtPrice(p: number) {
  return Number.isFinite(p) ? p.toFixed(2).replace('.', ',') : '';
}
function fmtSize(s: number) {
  return s > 0 ? String(s) : '';
}
function roundToTick(p: number, step = 0.25) {
  return Math.round(p / step) * step;
}

/** Déduit un pas de tick robuste: plus petit écart > 0, sinon 0.25 */
function inferStep(prices: number[], fallback = 0.25) {
  const uniq = Array.from(new Set(prices.filter(Number.isFinite))).sort((a, b) => a - b);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < uniq.length; i++) {
    const d = +(uniq[i] - uniq[i - 1]).toFixed(10);
    if (d > 0 && d < best) best = d;
  }
  if (!isFinite(best) || best <= 0) return fallback;
  // borne supérieure : si le “pas” est aberrant, garde fallback
  if (best > 1) return fallback;
  return best;
}

/** Déduplique/merge les niveaux à prix identique (arrondis au tick) */
function dedupeMergeLevels(
  levels: any[],
  step: number
) {
  const map = new Map<string, any>();
  for (const l of levels) {
    const k = roundToTick(l.price, step).toFixed(2);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, { ...l, price: parseFloat(k) });
    } else {
      map.set(k, {
        ...prev,
        // on garde le max pour les tailles (ou somme si tu préfères)
        bidSize: Math.max(prev.bidSize || 0, l.bidSize || 0),
        askSize: Math.max(prev.askSize || 0, l.askSize || 0),
        volumeCumulative: Math.max(prev.volumeCumulative || 0, l.volumeCumulative || 0),
        sizeWindow: (prev.sizeWindow || 0) + (l.sizeWindow || 0)
      });
    }
  }
  // tri décroissant (haut = prix élevé)
  return Array.from(map.values()).sort((a: any, b: any) => b.price - a.price);
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

  // Étape 1: on part des niveaux fournis
  const baseLevels = useMemo(() => {
    if (!tickLadder?.levels?.length) return [];
    return tickLadder.levels.slice();
  }, [tickLadder]);

  // Étape 2: on déduit un pas de tick fiable à partir des prix présents
  const step = useMemo(() => {
    const prices = baseLevels.map((l: any) => l.price);
    return inferStep(prices, 0.25);
  }, [baseLevels]);

  // Étape 3: dédoublonner/merger par prix (arrondi au step)
  const mergedLevels = useMemo(() => {
    if (!baseLevels.length) return [];
    return dedupeMergeLevels(baseLevels, step);
  }, [baseLevels, step]);

  // Étape 4: on “padde” visuellement pour scroller au-delà (sans dupliquer les prix existants)
  const displayLevels = useMemo(() => {
    if (!mergedLevels.length) return [];
    const levels = mergedLevels.slice(); // copie

    const PAD = 200; // nb de ticks vides haut/bas
    const top = levels[0].price;
    const bot = levels[levels.length - 1].price;

    // ajoute au-dessus
    for (let i = 1; i <= PAD; i++) {
      const p = top + i * step;
      levels.unshift({
        price: p,
        bidSize: 0,
        askSize: 0,
        volumeCumulative: 0,
        sizeWindow: 0,
        tick: `pad-top-${i}`
      });
    }
    // ajoute en-dessous
    for (let i = 1; i <= PAD; i++) {
      const p = bot - i * step;
      levels.push({
        price: p,
        bidSize: 0,
        askSize: 0,
        volumeCumulative: 0,
        sizeWindow: 0,
        tick: `pad-bot-${i}`
      });
    }

    // par sécurité: re-merge si jamais un pad tombe sur un prix existant
    return dedupeMergeLevels(levels, step);
  }, [mergedLevels, step]);

  // ordres présents à un prix
  const getOrdersAtPrice = (price: number, side: Side) =>
    orders.filter(o =>
      o.side === side &&
      Math.abs(o.price - price) < step / 2 &&
      o.quantity > o.filled
    );

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < step / 2;

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

  // ---- anti-sauts: mémorise la position verticale de la ligne du last avant maj ----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>(
      `[data-row-price="${roundToTick(currentPrice, step).toFixed(2)}"]`
    );
    if (!anchor) {
      prevAnchorDeltaRef.current = null;
      return;
    }
    const crect = el.getBoundingClientRect();
    const arect = anchor.getBoundingClientRect();
    prevAnchorDeltaRef.current = arect.top - crect.top;
  }, [/* avant re-render */]);

  // ---- puis réapplique un décalage pour garder le last au même endroit ----
  useLayoutEffect(() => {
    if (userScrolled) return;
    const el = scrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>(
      `[data-row-price="${roundToTick(currentPrice, step).toFixed(2)}"]`
    );
    if (!anchor || prevAnchorDeltaRef.current == null) return;
    const crect = el.getBoundingClientRect();
    const arect = anchor.getBoundingClientRect();
    const delta = (arect.top - crect.top) - prevAnchorDeltaRef.current;
    if (Math.abs(delta) > 0.5) {
      el.scrollTop += delta;
    }
  }, [displayLevels, currentPrice, userScrolled, step]);

  // barre d’espace → recentre le last
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      const el = scrollRef.current;
      if (!el) return;
      const anchor = el.querySelector<HTMLElement>(
        `[data-row-price="${roundToTick(currentPrice, step).toFixed(2)}"]`
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

  const avgPriceRounded =
    position && position.quantity !== 0
      ? roundToTick(position.averagePrice, step)
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
          const price = roundToTick(level.price, step);
          const isLast = Math.abs(price - roundToTick(currentPrice, step)) < step / 2;

          const buyOrders = getOrdersAtPrice(price, 'BUY');
          const sellOrders = getOrdersAtPrice(price, 'SELL');
          const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          return (
            <div
              key={`${price.toFixed(2)}-${level.tick ?? idx}`}
              data-row-price={price.toFixed(2)}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                level.sizeWindow > 0 && "font-medium text-trading-neutral"
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

              {/* Price — sticky + highlight moyen uniquement ici */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 sticky-price-cell",
                  isLast && "text-trading-average font-bold",
                  avgPriceRounded != null &&
                    Math.abs(price - avgPriceRounded) < step / 2 &&
                    "outline-average-price"
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