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

  const handleCellClick = useCallback((price: number, column: 'bid' | 'ask') => {
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
  }, [disabled, currentPrice, onLimitOrder, onMarketOrder]);

  const levels = tickLadder?.levels ?? [];

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="p-3">
          <h3 className="text-sm font-semibold">DOM</h3>
        </div>
        <div className="grid grid-cols-4 text-xs font-semibold text-muted-foreground border-t border-border">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center">Asks</div>
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
            const isMid = Math.abs(level.price - currentPrice) < 1e-9;

            return (
              <div
                key={level.price}
                className={cn(
                  "grid grid-cols-4 text-xs border-b border-border/50 h-8 items-center",
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
                    "flex items-center justify-center font-mono border-r border-border/50",
                    isMid && "text-yellow-400 font-semibold"
                  )}
                >
                  {formatPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer",
                    level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                    level.price > currentPrice && "hover:bg-trading-sell/10"
                  )}
                  onClick={() => handleCellClick(level.price, 'ask')}
                >
                  {level.price >= currentPrice && formatSize(level.askSize)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});