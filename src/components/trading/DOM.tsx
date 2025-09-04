import { memo, useMemo, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import type { TickLadder as TickLadderType } from '@/lib/orderbook';

interface TradeLite {
  price: number;
  size: number;
  aggressor?: 'BUY' | 'SELL';
  timestamp?: number;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled?: number;
}

interface DOMProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  trades?: TradeLite[];
  orders?: Order[];
  disabled?: boolean;
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders?: (price: number) => void;
  position?: { averagePrice: number; quantity: number };
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size?: number): string {
  if (!size || size <= 0) return '';
  return `${size}`;
}

export function DOM({
  tickLadder,
  currentPrice,
  trades = [],
  orders = [],
  disabled,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  position,
}: DOMProps) {
  // État pour les cellules de prix surlignées en jaune avec Ctrl+clic
  const [highlightedPrices, setHighlightedPrices] = useState<Set<number>>(new Set());
  // Build a quick lookup for the last trade size at a given price
  const lastSizeByPrice = useMemo(() => {
    const map = new Map<number, number>();
    // iterate from end to start to ensure "last"
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i];
      if (!map.has(t.price)) {
        map.set(t.price, t.size);
      }
    }
    return map;
  }, [trades]);

  // Build volume lookup for each price level
  const volumeByPrice = useMemo(() => {
    const map = new Map<number, number>();
    trades.forEach(trade => {
      const current = map.get(trade.price) || 0;
      map.set(trade.price, current + trade.size);
    });
    return map;
  }, [trades]);

  // Fonction pour récupérer les ordres à un prix donné
  const getOrdersAtPrice = useCallback((price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);
  }, [orders]);

  const handleCellClick = useCallback((price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    
    const above = price > currentPrice;
    const below = price < currentPrice;

    if (column === 'bid') {
      if (above) {
        return onMarketOrder('BUY', 1);
      }
      return onLimitOrder('BUY', price, 1);
    } else if (column === 'ask') {
      if (below) {
        return onMarketOrder('SELL', 1);
      }
      return onLimitOrder('SELL', price, 1);
    }
  }, [disabled, currentPrice, onLimitOrder, onMarketOrder]);

  const handleOrderClick = useCallback((price: number) => {
    if (disabled) return;
    onCancelOrders?.(price);
  }, [disabled, onCancelOrders]);

  // Gestion du Ctrl+clic sur les cellules de prix
  const handlePriceClick = useCallback((price: number, event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setHighlightedPrices(prev => {
        const newSet = new Set(prev);
        if (newSet.has(price)) {
          newSet.delete(price);
        } else {
          newSet.add(price);
        }
        return newSet;
      });
    } else {
      onCancelOrders?.(price);
    }
  }, [onCancelOrders]);

  const levels = tickLadder?.levels ?? [];

  // Removed excessive debug logging to prevent re-render loops

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="p-3">
          <h3 className="text-sm font-semibold">DOM</h3>
        </div>
        <div data-dom-row className="grid grid-cols-4 text-xs font-semibold text-muted-foreground border-t border-border">
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto trading-scroll will-change-scroll">
        {levels.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Aucun niveau à afficher
          </div>
        ) : (
          levels.map((level) => {
            const volume = volumeByPrice.get(level.price) ?? 0;
            const isMid = Math.abs(level.price - currentPrice) < 1e-9;
            // Précision exacte pour ne capturer qu'une seule cellule (prix moyen arrondi au tick)
            const isAveragePrice = position && position.quantity !== 0 && 
              Math.abs(level.price - Math.round(position.averagePrice / 0.25) * 0.25) < 0.01;
            const isHighlighted = highlightedPrices.has(level.price);
            
            // Debug position uniquement pour le prix moyen détecté
            if (position && position.quantity !== 0 && isAveragePrice) {
              console.log(`🟡 DOM reçoit position: qty=${position.quantity}, avg=${position.averagePrice}, prix=${level.price}`);
            }
            
            
            const buyOrders = getOrdersAtPrice(level.price, 'BUY');
            const sellOrders = getOrdersAtPrice(level.price, 'SELL');
            const totalBuy = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const totalSell = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

            return (
              <div
                key={level.price}
                className={cn(
                  "grid grid-cols-4 text-xs border-b border-border/50 h-8 items-center will-change-transform",
                  "hover:bg-ladder-row-hover transition-colors duration-100"
                )}
              >
                 {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50 min-h-[2rem]",
                    level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                    "hover:bg-trading-buy/10 transition-colors duration-100"
                  )}
                  onClick={() => {
                    totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid');
                  }}
                >
                  <>
                    <span>{level.bidSize > 0 ? formatSize(level.bidSize) : ''}</span>
                    {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                  </>
                </div>

                 {/* Price */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono border-r border-border/50 cursor-pointer",
                    isMid && "text-yellow-400 font-semibold",
                    isAveragePrice && "bg-position-average",
                    isHighlighted && "bg-trading-highlight",
                    "hover:bg-muted/50 transition-colors duration-100"
                  )}
                  onClick={(e) => handlePriceClick(level.price, e)}
                >
                  {formatPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50 min-h-[2rem]",
                    level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                    "hover:bg-trading-sell/10 transition-colors duration-100"
                  )}
                  onClick={() => {
                    totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask');
                  }}
                >
                  <>
                    <span>{level.askSize > 0 ? formatSize(level.askSize) : ''}</span>
                    {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                  </>
                </div>

                {/* Volume */}
                <div className="flex items-center justify-center font-mono text-muted-foreground">
                  {formatSize(volume)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};