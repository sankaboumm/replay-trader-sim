import { memo, useMemo } from 'react';
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
  /** ajoute ceci côté parent : position={position} */
  position: Position;
  /** optionnel : taille de tick (0.25 sur NQ) */
  tickSize?: number;
  /** optionnel : nb de ticks ajoutés visuellement au-dessus et au-dessous */
  extraTicksEachSide?: number;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size: number): string {
  return size > 0 ? size.toString() : '';
}

/**
 * Construit une liste "étendue" pour permettre un scroll quasi infini :
 * on ajoute des niveaux vides (bid/ask = 0) au-dessus et au-dessous.
 */
function buildExtendedLevels(
  base: TickLadderType['levels'],
  currentPrice: number,
  tickSize: number,
  extraTicksEachSide: number
) {
  if (!base || base.length === 0) return [];

  // On part d’un “range” autour du prix courant
  const halfRangeUp   = extraTicksEachSide * tickSize;
  const halfRangeDown = extraTicksEachSide * tickSize;

  // Valeurs extrêmes existantes
  const prices = base.map(l => l.price);
  const minExisting = Math.min(...prices);
  const maxExisting = Math.max(...prices);

  // On veut couvrir [currentPrice - halfRangeDown, currentPrice + halfRangeUp]
  const targetMin = Math.min(minExisting, Math.floor((currentPrice - halfRangeDown) / tickSize) * tickSize);
  const targetMax = Math.max(maxExisting, Math.ceil((currentPrice + halfRangeUp) / tickSize) * tickSize);

  // Indexation par prix pour retrouver un niveau existant rapidement
  const byPrice = new Map<number, typeof base[number]>();
  for (const lvl of base) byPrice.set(lvl.price, lvl);

  // Construit la grille complète
  const extended: Array<typeof base[number] & { __synthetic?: boolean }> = [];
  for (let p = targetMax; p >= targetMin - 1e-9; p = +(p - tickSize).toFixed(10)) {
    const existing = byPrice.get(p);
    if (existing) {
      extended.push(existing);
    } else {
      // Niveau “vide” pour le scroll : tailles = 0
      extended.push({
        // certains types de lvl ont un "tick", d'autres non : on met un prix comme clé
        // @ts-ignore - on ajoute les min props utiles
        tick: p,
        price: p,
        bidSize: 0,
        askSize: 0,
        // champs facultatifs si présents dans ton type :
        // @ts-ignore
        sizeWindow: 0,
        // @ts-ignore
        volumeCumulative: 0,
        __synthetic: true
      });
    }
  }

  return extended;
}

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  position,
  tickSize = 0.25,
  extraTicksEachSide = 1000, // ~250 points de part et d’autre sur NQ
}: TickLadderProps) {

  // Orders présents sur un prix
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(order =>
      order.side === side &&
      Math.abs(order.price - price) < tickSize / 2 &&
      order.quantity > order.filled
    );
  };

  // Prix moyen aligné au tick le plus proche (pour l’affichage)
  const avgPriceTicked = useMemo(() => {
    if (!position || !position.quantity) return null;
    return Math.round(position.averagePrice / tickSize) * tickSize;
  }, [position, tickSize]);

  // “Last” aligné au tick (évite des surprises de comparaison flottante)
  const lastTicked = useMemo(() => {
    return Math.round(currentPrice / tickSize) * tickSize;
  }, [currentPrice, tickSize]);

  // Étend la grille pour le scroll
  const levels = useMemo(() => {
    const base = tickLadder?.levels ?? [];
    return buildExtendedLevels(base, currentPrice, tickSize, extraTicksEachSide);
  }, [tickLadder?.levels, currentPrice, tickSize, extraTicksEachSide]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const isAboveLast = price > lastTicked + 1e-9;
    const isBelowLast = price < lastTicked - 1e-9;
    const isAtLast = Math.abs(price - lastTicked) < tickSize / 2;

    if (column === 'bid') {
      if (isAboveLast || isAtLast) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      if (isBelowLast || isAtLast) onMarketOrder('SELL', 1);
      else onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!levels || levels.length === 0) {
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

      {/* Ladder Rows */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {levels.map((level, index) => {
          const isLastPrice = Math.abs(level.price - lastTicked) < tickSize / 2;
          const isAvgPos    = avgPriceTicked != null && Math.abs(level.price - (avgPriceTicked as number)) < tickSize / 2;

          const buyOrders   = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders  = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty= sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          return (
            <div
              key={`${level.price.toFixed(2)}`} // clé stable par prix
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (fenêtre d’agression si dispo) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                // @ts-ignore
                (level.sizeWindow ?? 0) > 0 && "font-medium"
              )}>
                {formatSize(
                  // @ts-ignore
                  level.sizeWindow ?? 0
                )}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= lastTicked && (level as any).bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= lastTicked && "hover:bg-trading-buy/10",
                  totalBuyQty > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() =>
                  totalBuyQty > 0
                    ? handleOrderClick(level.price)
                    : handleCellClick(level.price, 'bid')
                }
              >
                {level.price <= lastTicked && (
                  <>
                    <span>{formatSize((level as any).bidSize || 0)}</span>
                    {totalBuyQty > 0 && <span className="ml-1 text-xs">({totalBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price (seule cellule qui peut devenir jaune) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLastPrice && "bg-ladder-last/20 text-trading-average font-bold",
                  isAvgPos && "ring-2 ring-trading-average rounded-sm"
                )}
                title={
                  isAvgPos
                    ? `Prix moyen ${position.quantity > 0 ? 'achat' : 'vente'}: ${position.averagePrice.toFixed(2)}`
                    : undefined
                }
              >
                {formatPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= lastTicked && (level as any).askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= lastTicked && "hover:bg-trading-sell/10",
                  totalSellQty > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() =>
                  totalSellQty > 0
                    ? handleOrderClick(level.price)
                    : handleCellClick(level.price, 'ask')
                }
              >
                {level.price >= lastTicked && (
                  <>
                    <span>{formatSize((level as any).askSize || 0)}</span>
                    {totalSellQty > 0 && <span className="ml-1 text-xs">({totalSellQty})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé si dispo */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize((level as any).volumeCumulative || 0)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});