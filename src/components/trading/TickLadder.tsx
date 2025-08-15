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
  /** Optionnel – si tu le passes on surligne le prix moyen (arrondi au tick) */
  position?: PositionLike;
}

/** format prix */
function fmtPrice(p: number) {
  return Number.isFinite(p) ? p.toFixed(2).replace('.', ',') : '';
}
/** format taille */
function fmtSize(s: number) {
  return s > 0 ? String(s) : '';
}
/** arrondi au tick 0.25 (sécurisé) */
function roundToTick(p: number, step = 0.25) {
  return Math.round(p / step) * step;
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

  // ---- refs & états pour stabiliser le scroll (anti-sauts) ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevAnchorDeltaRef = useRef<number | null>(null);
  const [userScrolled, setUserScrolled] = useState(false); // on ne recentre pas automatiquement

  // ---- fenêtre d’affichage : on “padde” avec des ticks vides pour un scroll large ----
  const displayLevels = useMemo(() => {
    if (!tickLadder || !tickLadder.levels?.length) return [];

    const levels = tickLadder.levels.slice(); // ne pas muter
    // step déduit (fallback 0.25)
    const step = Math.abs((levels[1]?.price ?? currentPrice) - (levels[0]?.price ?? currentPrice)) || 0.25;

    // on veut pouvoir scroller “au-delà” : on rajoute ~200 ticks vides en haut & en bas
    const PAD = 200;
    const maxPrice = levels[0].price;
    const minPrice = levels[levels.length - 1].price;

    // haut (au-dessus du prix max)
    for (let i = 1; i <= PAD; i++) {
      levels.unshift({
        // @ts-ignore: on ne dépend que de price/bidSize/askSize/volume
        price: maxPrice + i * step,
        bidSize: 0,
        askSize: 0,
        volumeCumulative: 0,
        sizeWindow: 0,
        tick: `pad-top-${i}`
      });
    }
    // bas (en-dessous du prix min)
    for (let i = 1; i <= PAD; i++) {
      levels.push({
        // @ts-ignore
        price: minPrice - i * step,
        bidSize: 0,
        askSize: 0,
        volumeCumulative: 0,
        sizeWindow: 0,
        tick: `pad-bot-${i}`
      });
    }

    // IMPORTANT : l’échelle visuelle est décroissante (prix du haut > bas)
    levels.sort((a: any, b: any) => b.price - a.price);
    return levels;
  }, [tickLadder, currentPrice]);

  // ---- gestion des ordres dans les cellules ----
  const getOrdersAtPrice = (price: number, side: Side) =>
    orders.filter(o =>
      o.side === side &&
      Math.abs(o.price - price) < 0.125 &&
      o.quantity > o.filled
    );

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < 0.125;

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

  // ---- ancrage de scroll : on garde la ligne du “last” au même endroit quand la data bouge ----
  // 1) avant update : on mémorise la position du “last” dans le viewport
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>(`[data-row-price="${roundToTick(currentPrice).toFixed(2)}"]`);
    if (!anchor) {
      prevAnchorDeltaRef.current = null;
      return;
    }
    const crect = el.getBoundingClientRect();
    const arect = anchor.getBoundingClientRect();
    prevAnchorDeltaRef.current = arect.top - crect.top;
  }, [/* dépend de la version précédente */]);

  // 2) après update : on réapplique un delta pour que le “last” ne saute pas
  useLayoutEffect(() => {
    if (userScrolled) return; // l’utilisateur a pris la main, on ne touche plus
    const el = scrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>(`[data-row-price="${roundToTick(currentPrice).toFixed(2)}"]`);
    if (!anchor || prevAnchorDeltaRef.current == null) return;

    const crect = el.getBoundingClientRect();
    const arect = anchor.getBoundingClientRect();
    const delta = (arect.top - crect.top) - prevAnchorDeltaRef.current;
    if (Math.abs(delta) > 0.5) {
      el.scrollTop += delta;
    }
  }, [displayLevels, currentPrice, userScrolled]);

  // barre d’espace => recadrer le “last” au centre
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      const el = scrollRef.current;
      if (!el) return;
      const anchor = el.querySelector<HTMLElement>(`[data-row-price="${roundToTick(currentPrice).toFixed(2)}"]`);
      if (!anchor) return;
      const crect = el.getBoundingClientRect();
      const arect = anchor.getBoundingClientRect();
      const delta = (arect.top + arect.height / 2) - (crect.top + crect.height / 2);
      el.scrollTop += delta;
      setUserScrolled(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPrice]);

  if (!tickLadder || !displayLevels.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  // surlignage du prix moyen UNIQUEMENT sur la cellule “Price”
  const avgPriceRounded =
    position && position.quantity !== 0
      ? roundToTick(position.averagePrice)
      : null;

  // largeur des colonnes (on les fige → utile pour la sticky)
  // 64px | 1fr | 88px | 1fr | 64px  → price = 88px
  // On rend la cellule Price sticky et on lui donne un z-index + un fond.
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
        {displayLevels.map((level: any) => {
          const price = roundToTick(level.price);
          const isLast = Math.abs(price - roundToTick(currentPrice)) < 0.125;

          const buyOrders = getOrdersAtPrice(price, 'BUY');
          const sellOrders = getOrdersAtPrice(price, 'SELL');
          const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          return (
            <div
              key={level.tick ?? price}
              data-row-price={price.toFixed(2)}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (fenêtre d’agression récente si tu l’utilises) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                level.sizeWindow > 0 && "font-medium",
                level.sizeWindow > 0 && "text-trading-neutral"
              )}>
                {fmtSize(level.sizeWindow ?? 0)}
              </div>

              {/* Bids (affiché pour prix <= last) */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQty > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() =>
                  totalBuyQty > 0 ? handleOrderClick(price) : handleCellClick(price, 'bid')
                }
              >
                {price <= currentPrice && (
                  <>
                    <span>{fmtSize(level.bidSize || 0)}</span>
                    {totalBuyQty > 0 && <span className="ml-1 text-[10px]">({totalBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price (VRAIMENT FIXE & SEULEMENT cette cellule en jaune si avg) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 sticky-price-cell",
                  isLast && "text-trading-average font-bold",
                  avgPriceRounded != null &&
                    Math.abs(price - avgPriceRounded) < 0.125 &&
                    "outline-average-price"
                )}
              >
                {fmtPrice(price)}
              </div>

              {/* Asks (affiché pour prix >= last) */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQty > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() =>
                  totalSellQty > 0 ? handleOrderClick(price) : handleCellClick(price, 'ask')
                }
              >
                {price >= currentPrice && (
                  <>
                    <span>{fmtSize(level.askSize || 0)}</span>
                    {totalSellQty > 0 && <span className="ml-1 text-[10px]">({totalSellQty})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé par niveau */}
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