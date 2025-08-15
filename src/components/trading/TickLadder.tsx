import React, { memo, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
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
  position: Position;
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size?: number): string {
  if (!size || size <= 0) return '';
  // Affichage sans décimales
  return Math.round(size).toString();
}

const ROW_PX = 24; // h-6

export const TickLadder = memo(forwardRef(function TickLadder(
  {
    tickLadder,
    currentPrice,
    orders,
    position,
    onLimitOrder,
    onMarketOrder,
    onCancelOrders,
    disabled = false,
  }: TickLadderProps,
  ref: React.Ref<{ centerOnPrice: (p: number) => void }>
) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Expose une méthode imperative pour recentrer sur un prix
  useImperativeHandle(ref, () => ({
    centerOnPrice: (price: number) => {
      const container = scrollRef.current;
      const levels = tickLadder?.levels ?? [];
      if (!container || levels.length === 0) return;

      // On cherche l’index du niveau le plus proche du prix demandé
      let targetIndex = 0;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < levels.length; i++) {
        const d = Math.abs(levels[i].price - price);
        if (d < bestDiff) {
          bestDiff = d;
          targetIndex = i;
        }
      }

      const targetCenter = targetIndex * ROW_PX;
      const middle = container.clientHeight / 2;
      const newScrollTop = Math.max(0, targetCenter - middle);
      container.scrollTo({ top: newScrollTop, behavior: 'smooth' });
    },
  }), [tickLadder]);

  // Commandes au clic dans les colonnes
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

  // Commandes en attente à un niveau
  const getOpenQtyAt = (price: number, side: 'BUY' | 'SELL') => {
    return orders
      .filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled)
      .reduce((s, o) => s + (o.quantity - o.filled), 0);
  };

  // Surlignage du prix moyen de la position
  const isAvgPriceAt = (levelPrice: number) =>
    position.quantity !== 0 && Math.abs(levelPrice - position.averagePrice) < 0.125;

  if (!tickLadder || !tickLadder.levels || tickLadder.levels.length === 0) {
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

      {/* Rows */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto trading-scroll">
        {(tickLadder.levels ?? []).slice().reverse().map((level) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
          const bidOpen = getOpenQtyAt(level.price, 'BUY');
          const askOpen = getOpenQtyAt(level.price, 'SELL');

          return (
            <div
              key={level.tick}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                isLastPrice && "bg-ladder-last/20",
                isAvgPriceAt(level.price) && "ring-2 ring-offset-0 ring-[hsl(var(--trading-average))]",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (dernière fenêtre de prints) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                level.sizeWindow > 0 && "font-medium",
                level.sizeWindow > 0 && (level.lastAggressor === 'BUY' ? "text-trading-buy" : "text-trading-sell")
              )}>
                {formatSize(level.sizeWindow)}
              </div>

              {/* Bids (prix <= last) */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  bidOpen > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() => (bidOpen > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid'))}
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{formatSize(level.bidSize)}</span>
                    {bidOpen > 0 && <span className="ml-1 text-[10px] opacity-80">({bidOpen})</span>}
                  </>
                )}
              </div>

              {/* Price (colonne centrale, fond stable) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLastPrice && "text-trading-average font-bold"
                )}
              >
                {formatPrice(level.price)}
              </div>

              {/* Asks (prix >= last) */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  askOpen > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() => (askOpen > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask'))}
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{formatSize(level.askSize)}</span>
                    {askOpen > 0 && <span className="ml-1 text-[10px] opacity-80">({askOpen})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé par niveau de prix */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(level.volumeCumulative)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}));