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
    const below = price < currentPrice;
    const at    = Math.abs(price - currentPrice) < 0.125;

    // Mapping validé par toi
    if (column === 'bid') {
      // AU-DESSUS du last => MARKET BUY (bestAsk)
      if (above) return onMarketOrder('BUY', 1);
      // à/bas du last => BUY LIMIT à ce niveau
      return onLimitOrder('BUY', price, 1);
    } else {
      // EN-DESSOUS du last => MARKET SELL (bestBid)
      if (below) return onMarketOrder('SELL', 1);
      // à/au-dessus du last => SELL LIMIT à ce niveau
      return onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!tickLadder || !tickLadder.levels?.length) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card trading-no-anim">
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
      <div className="flex-1 overflow-y-auto">
        {(tickLadder.levels).slice().sort((a, b) => b.price - a.price).map((level) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
          const isAvgPrice  = avgPrice !== null && Math.abs(level.price - avgPrice!) < 0.125;

          const buyOrders  = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuy   = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSell  = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

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
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
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
              </div>

              {/* Price */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLastPrice && "text-trading-average font-bold",
                  // Encadrer uniquement la cellule Price quand on a une position
                  isAvgPrice && "ring-2 ring-trading-average rounded-sm"
                )}
              >
                {fmtPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
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