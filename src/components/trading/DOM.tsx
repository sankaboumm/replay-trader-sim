import { memo, useMemo, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import type { TickLadder as TickLadderType } from '@/lib/orderbook';

interface TradeLite {
  price: number;
  size: number;
  aggressor?: 'BUY' | 'SELL';
  timestamp?: number | Date;
}

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

interface Props {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  trades: TradeLite[];
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number, at?: 'BID' | 'ASK') => void;
  onCancelOrders?: (price: number) => void;
  disabled?: boolean;
  position: Position;
}

const formatSize = (size: number) => size > 0 ? size.toFixed(0) : '';

export const DOM = memo(function DOM({
  tickLadder,
  currentPrice,
  trades,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled,
  position,
}: Props) {
  const [highlightedPrices, setHighlightedPrices] = useState<Set<number>>(new Set());

  const levels = tickLadder?.levels ?? [];

  const volumeByPrice = useMemo(() => {
    const map = new Map<number, number>();
    for (const t of trades) {
      const p = Math.round(t.price / 0.25) * 0.25;
      map.set(p, (map.get(p) ?? 0) + t.size);
    }
    return map;
  }, [trades]);

  const handleCellClick = useCallback((price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const above = price > currentPrice;
    const below = price < currentPrice;

    if (column === 'bid') {
      if (above) return onMarketOrder('BUY', 1, 'BID');
      return onLimitOrder('BUY', price, 1);
    } else if (column === 'ask') {
      if (below) return onMarketOrder('SELL', 1, 'ASK');
      return onLimitOrder('SELL', price, 1);
    }
  }, [disabled, currentPrice, onLimitOrder, onMarketOrder]);

  const handleOrderClick = useCallback((price: number) => {
    if (!onCancelOrders) return;
    setHighlightedPrices(prev => {
      const next = new Set(prev);
      next.has(price) ? next.delete(price) : next.add(price);
      return next;
    });
    onCancelOrders(price);
  }, [onCancelOrders]);

  return (
    <div className="h-full flex flex-col bg-card">
      {/* ... header & grille DOM (inchangé) ... */}

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

            const buyOrders = orders.filter(o => o.side === 'BUY' && Math.abs(o.price - level.price) < 1e-9);
            const sellOrders = orders.filter(o => o.side === 'SELL' && Math.abs(o.price - level.price) < 1e-9);
            const totalBuy = buyOrders.length;
            const totalSell = sellOrders.length;

            return (
              <div key={level.price} data-dom-row className="grid grid-cols-4 text-sm border-b border-border/50">
                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price < currentPrice && (level as any).bidSize > 0 && "bg-ladder-bid"
                  )}
                  onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
                >
                  {level.price < currentPrice && (
                    <>
                      <span>{formatSize((level as any).bidSize ?? 0)}</span>
                      {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                    </>
                  )}
                </div>

                {/* Price */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                    isMid && "text-trading-average font-bold"
                  )}
                >
                  {level.price.toFixed(2)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price > currentPrice && (level as any).askSize > 0 && "bg-ladder-ask"
                  )}
                  onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
                >
                  {level.price > currentPrice && (
                    <>
                      <span>{formatSize((level as any).askSize ?? 0)}</span>
                      {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                    </>
                  )}
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