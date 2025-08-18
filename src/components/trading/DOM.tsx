import { memo, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { TickLadder as TickLadderType } from '@/lib/orderbook';

interface TradeLite {
  price: number;
  size: number;
  aggressor?: 'BUY' | 'SELL';
  timestamp?: number | Date;
}

interface DOMProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  trades?: TradeLite[];
  disabled?: boolean;
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders?: (price: number) => void;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size?: number): string {
  if (!size || size <= 0) return '';
  return `${size}`;
}

export const DOM = memo(function DOM({
  tickLadder,
  currentPrice,
  trades = [],
  disabled,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
}: DOMProps) {
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

  const handleCellClick = useCallback((price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    
    if (column === 'bid') {
      // Clic sur Bid: placer un ordre BUY
      onLimitOrder('BUY', price, 1);
    } else if (column === 'ask') {
      // Clic sur Ask: placer un ordre SELL  
      onLimitOrder('SELL', price, 1);
    }
  }, [disabled, onLimitOrder]);

  const handlePriceClick = useCallback((price: number) => {
    if (disabled || !onCancelOrders) return;
    onCancelOrders(price);
  }, [disabled, onCancelOrders]);

  const levels = tickLadder?.levels ?? [];

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="p-3">
          <h3 className="text-sm font-semibold">DOM</h3>
        </div>
        <div className="grid grid-cols-5 text-xs font-semibold text-muted-foreground border-t border-border">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {levels.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Aucun niveau à afficher
          </div>
        ) : (
          levels.map((level) => {
            const lastSize = lastSizeByPrice.get(level.price) ?? 0;
            const volume = volumeByPrice.get(level.price) ?? 0;
            const isMid = Math.abs(level.price - currentPrice) < 1e-9;

            return (
              <div
                key={level.price}
                className={cn(
                  "grid grid-cols-5 text-xs border-b border-border/50 h-8 items-center",
                  "hover:bg-ladder-row-hover transition-colors"
                )}
              >
                {/* Size (last trade @ price) */}
                <div className="flex items-center justify-center border-r border-border/50 font-mono">
                  {formatSize(lastSize)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                    level.price < currentPrice && "hover:bg-trading-buy/10"
                  )}
                  onClick={() => handleCellClick(level.price, 'bid')}
                >
                  {level.price <= currentPrice && formatSize(level.bidSize)}
                </div>

                {/* Price */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono border-r border-border/50 cursor-pointer",
                    isMid && "text-yellow-400 font-semibold",
                    "hover:bg-muted/50"
                  )}
                  onClick={() => handlePriceClick(level.price)}
                >
                  {formatPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                    level.price > currentPrice && "hover:bg-trading-sell/10"
                  )}
                  onClick={() => handleCellClick(level.price, 'ask')}
                >
                  {level.price >= currentPrice && formatSize(level.askSize)}
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
});