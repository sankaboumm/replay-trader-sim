import { memo } from 'react';
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
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position;
}

const fmtPrice = (p: number) => p.toFixed(2).replace('.', ',');
const fmtSize = (s: number) => (s > 0 ? s.toString() : '');

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
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);

  const avgPrice = position.quantity !== 0 ? position.averagePrice : null;

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const above = price > currentPrice;
    const side: 'BUY' | 'SELL' =
      column === 'bid'
        ? 'BUY'
        : 'SELL';

    // simple lot = 1 par défaut
    onLimitOrder(side, price, 1);
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!tickLadder) {
    return (
      <div className="flex flex-col w-[480px] border rounded-lg overflow-hidden">
        <div className="p-4 text-sm text-muted-foreground">Charge un fichier pour afficher le DOM.</div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col w-[480px] border rounded-lg overflow-hidden bg-background")}>      
      {/* Header */}
      <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-[10px] uppercase tracking-wide h-7 items-center border-b px-2 text-muted-foreground bg-muted/30">
        <div className="text-center">Win</div>
        <div className="text-center">Bids</div>
        <div className="text-center">Price</div>
        <div className="text-center">Asks</div>
        <div className="text-center">Cum.</div>
      </div>

      {/* Body */}
      <div className="overflow-auto max-h-[70vh]">
        {tickLadder.levels.map((level) => {
          const buyOrders  = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuy   = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSell  = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          const isAvgPrice  = avgPrice !== null && Math.abs(level.price - avgPrice!) < 0.125;

          return (
            <div
              key={`${level.price}-${level.tick}`}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6"
              )}
            >
              {/* Size (window) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {fmtSize(level.sizeWindow)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "relative flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid"
                )}
                onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{fmtSize(level.bidSize)}</span>
                    {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                  </>
                )}
                {level.bidSize > 20 && (
                  <div className="absolute inset-y-1 left-1 right-1 pointer-events-none ring-2 ring-yellow-400/60 rounded-sm"></div>
                )}
              </div>

              {/* Price */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono border-r border-border/50",
                  Math.abs(level.price - currentPrice) < 0.125 && "bg-primary/10 font-semibold",
                  isAvgPrice && "outline outline-1 outline-primary/40"
                )}
              >
                {fmtPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "relative flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask"
                )}
                onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{fmtSize(level.askSize)}</span>
                    {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                  </>
                )}
                {level.askSize > 20 && (
                  <div className="absolute inset-y-1 left-1 right-1 pointer-events-none ring-2 ring-yellow-400/60 rounded-sm"></div>
                )}
              </div>

              {/* Volume cumulé à ce prix */}
              <div className="flex items-center justify-center text-muted-foreground">
                {fmtSize(level.volumeCumulative)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
