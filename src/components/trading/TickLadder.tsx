import { memo, useRef, useEffect } from 'react';
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
  onRequestExpandWindow?: (deltaTicks: number) => void;
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
  position,
  onRequestExpandWindow,
}: TickLadderProps) {
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const side: 'BUY' | 'SELL' = column === 'bid' ? 'BUY' : 'SELL';
    onLimitOrder(side, price, 1);
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!onRequestExpandWindow) return;
      const nearTop = el.scrollTop <= 0;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight;
      if (nearTop || nearBottom) {
        onRequestExpandWindow(200);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onRequestExpandWindow]);

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
      <div className="grid [grid-template-columns:1fr_88px_1fr_64px] text-[10px] uppercase tracking-wide h-7 items-center border-b px-2 text-muted-foreground bg-muted/30">
        <div className="text-center">Bids</div>
        <div className="text-center">Price</div>
        <div className="text-center">Asks</div>
        <div className="text-center">Cum.</div>
      </div>

      {/* Body */}
      <div ref={bodyRef} className="overflow-auto max-h-[70vh]">
        {tickLadder.levels.map((level) => {
          const isMid = Math.abs(level.price - currentPrice) < 0.125;

          return (
            <div
              key={`${level.price}-${level.tick}`}
              className={cn(
                "grid [grid-template-columns:1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6"
              )}
            >
              {/* Bids */}
              <div
                className={cn(
                  "relative flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.bidSize > 0 && "bg-ladder-bid"
                )}
                onClick={() => handleCellClick(level.price, 'bid')}
              >
                {level.price <= currentPrice && <span>{fmtSize(level.bidSize)}</span>}
                {level.bidSize >= 20 && (
                  <div className="absolute inset-y-1 left-1 right-1 pointer-events-none ring-2 ring-yellow-400/60 rounded-sm"></div>
                )}
              </div>

              {/* Price */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono border-r border-border/50",
                  isMid && "bg-primary/10 font-semibold"
                )}
              >
                {fmtPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "relative flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.askSize > 0 && "bg-ladder-ask"
                )}
                onClick={() => handleCellClick(level.price, 'ask')}
              >
                {level.price >= currentPrice && <span>{fmtSize(level.askSize)}</span>}
                {level.askSize >= 20 && (
                  <div className="absolute inset-y-1 left-1 right-1 pointer-events-none ring-2 ring-yellow-400/60 rounded-sm"></div>
                )}
              </div>

              {/* Cumulative volume at this price */}
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
