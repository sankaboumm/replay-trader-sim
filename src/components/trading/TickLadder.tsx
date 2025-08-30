import { memo, useMemo, useRef, useCallback } from 'react';
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

interface Props {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  trades: { price: number; size: number }[];
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number, at?: 'BID' | 'ASK') => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position;
  setViewAnchorPrice?: (price: number | null) => void;
}

const TICK_SIZE = 0.25;
const fmtPrice = (p: number) => p.toFixed(2);
const fmtSize = (n: number) => n > 0 ? n.toFixed(0) : '';

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  trades,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled,
  position,
  setViewAnchorPrice
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const levels = tickLadder?.levels ?? [];
  const lastTradePrice = trades.length ? trades[trades.length - 1].price : 0;

  const volumeByPrice = useMemo(() => {
    const map = new Map<number, number>();
    for (const t of trades) {
      const p = Math.round(t.price / TICK_SIZE) * TICK_SIZE;
      map.set(p, (map.get(p) ?? 0) + t.size);
    }
    return map;
  }, [trades]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const above = price > currentPrice;
    const below = price < currentPrice;

    if (column === 'bid') {
      if (above) return onMarketOrder('BUY', 1, 'BID');
      return onLimitOrder('BUY', price, 1);
    }
    if (column === 'ask') {
      if (below) return onMarketOrder('SELL', 1, 'ASK');
      return onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  const avgPrice = position.quantity !== 0 ? position.averagePrice : null;

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-card">
      {/* ... header ... */}

      {/* Body */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        <div className="min-w-[360px]">
          <div className="grid grid-cols-7 text-xs font-semibold text-muted-foreground">
            <div className="p-2 text-center border-r border-border">Buy</div>
            <div className="p-2 text-center border-r border-border">Sell</div>
            <div className="p-2 text-center border-r border-border">Bids</div>
            <div className="p-2 text-center border-r border-border">Price</div>
            <div className="p-2 text-center border-r border-border">Asks</div>
            <div className="p-2 text-center border-r border-border">Orders</div>
            <div className="p-2 text-center">Vol</div>
          </div>

          <div className="divide-y divide-border/50">
            {levels.map(level => {
              const totalBuy = orders.filter(o => o.side === 'BUY' && Math.abs(o.price - level.price) < 1e-9).length;
              const totalSell = orders.filter(o => o.side === 'SELL' && Math.abs(o.price - level.price) < 1e-9).length;
              const isLastPrice = Math.abs(level.price - lastTradePrice) < 1e-9;
              const isAvgPrice = avgPrice != null && Math.abs(level.price - avgPrice) < 1e-9;

              return (
                <div key={level.price} className="grid grid-cols-7 text-sm">
                  {/* Buy size (si niveau < current) */}
                  <div
                    className={cn(
                      "flex items-center justify-center cursor-pointer border-r border-border/50",
                      level.price < currentPrice && (level as any).bidSize > 0 && "bg-ladder-bid text-trading-buy"
                    )}
                    onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
                  >
                    {level.price < currentPrice && (
                      <>
                        <span>{fmtSize((level as any).bidSize ?? 0)}</span>
                        {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                      </>
                    )}
                  </div>

                  {/* Sell size (si niveau > current) */}
                  <div
                    className={cn(
                      "flex items-center justify-center cursor-pointer border-r border-border/50",
                      level.price > currentPrice && (level as any).askSize > 0 && "bg-ladder-ask text-trading-sell"
                    )}
                    onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
                  >
                    {level.price > currentPrice && (
                      <>
                        <span>{fmtSize((level as any).askSize ?? 0)}</span>
                        {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                      </>
                    )}
                  </div>

                  {/* Bids count */}
                  <div className="flex items-center justify-center border-r border-border/50">
                    {orders.filter(o => o.side === 'BUY' && Math.abs(o.price - level.price) < 1e-9).length || ''}
                  </div>

                  {/* Price */}
                  <div
                    className={cn(
                      "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                      isLastPrice && "text-trading-average font-bold",
                      isAvgPrice && "ring-2 ring-trading-average rounded-sm"
                    )}
                    onClick={() => setViewAnchorPrice && setViewAnchorPrice(level.price)}
                    onDoubleClick={() => setViewAnchorPrice && setViewAnchorPrice(null)}
                    title="Double-clique pour recentrer"
                  >
                    {fmtPrice(level.price)}
                  </div>

                  {/* Asks count */}
                  <div className="flex items-center justify-center border-r border-border/50">
                    {orders.filter(o => o.side === 'SELL' && Math.abs(o.price - level.price) < 1e-9).length || ''}
                  </div>

                  {/* Orders total (optionnel) */}
                  <div className="flex items-center justify-center border-r border-border/50 text-muted-foreground">
                    {fmtSize(volumeByPrice.get(level.price) ?? 0)}
                  </div>

                  {/* Volume cumulé */}
                  <div className="flex items-center justify-center text-muted-foreground">
                    {fmtSize((level as any).volumeCumulative ?? 0)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});