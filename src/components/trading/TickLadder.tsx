import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType, TickLevel } from '@/lib/orderbook';

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size: number): string {
  return size > 0 ? size.toString() : '';
}

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false
}: TickLadderProps) {

  // Get orders for a specific price level
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(order => 
      order.side === side && 
      Math.abs(order.price - price) < 0.125 &&
      order.quantity > order.filled
    );
  };

  // Calculate average buy and sell prices
  const averagePrices = useMemo(() => {
    const filledBuyOrders = orders.filter(o => o.side === 'BUY' && o.filled > 0);
    const filledSellOrders = orders.filter(o => o.side === 'SELL' && o.filled > 0);
    
    const avgBuyPrice = filledBuyOrders.length > 0 
      ? filledBuyOrders.reduce((sum, o) => sum + (o.price * o.filled), 0) / filledBuyOrders.reduce((sum, o) => sum + o.filled, 0)
      : null;
      
    const avgSellPrice = filledSellOrders.length > 0
      ? filledSellOrders.reduce((sum, o) => sum + (o.price * o.filled), 0) / filledSellOrders.reduce((sum, o) => sum + o.filled, 0)
      : null;
      
    return { avgBuyPrice, avgSellPrice };
  }, [orders]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    
    const isAboveCurrentPrice = price > currentPrice;
    const isBelowCurrentPrice = price < currentPrice;
    const isAtCurrentPrice = Math.abs(price - currentPrice) < 0.125;
    
    if (column === 'bid') {
      if (isAboveCurrentPrice || isAtCurrentPrice) {
        onMarketOrder('BUY', 1);
      } else {
        onLimitOrder('BUY', price, 1);
      }
    } else {
      if (isBelowCurrentPrice || isAtCurrentPrice) {
        onMarketOrder('SELL', 1);
      } else {
        onLimitOrder('SELL', price, 1);
      }
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

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
        <div className="grid grid-cols-5 text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Ladder Rows */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {(tickLadder?.levels ?? []).slice().reverse().map((level, index) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
          const isAvgBuyPrice = averagePrices.avgBuyPrice && Math.abs(level.price - averagePrices.avgBuyPrice) < 0.125;
          const isAvgSellPrice = averagePrices.avgSellPrice && Math.abs(level.price - averagePrices.avgSellPrice) < 0.125;
          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQuantity = buyOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          const totalSellQuantity = sellOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          
          // Determine dominant aggressor for size coloring
          const isDominantBuy = level.sizeWindow > 0; // Simplified for now
          const isDominantSell = level.sizeWindow > 0; // Simplified for now
          
          // Debug log for first few levels
          if (index < 3) {
            console.log(`Level ${index}: price=${level.price}, bidSize=${level.bidSize}, askSize=${level.askSize}`);
          }
          
          return (
            <div 
              key={level.tick}
              className={cn(
                "grid grid-cols-5 text-xs border-b border-border/50 h-6",
                isLastPrice && "bg-ladder-last/20",
                (isAvgBuyPrice || isAvgSellPrice) && "border-2 border-trading-average",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (Window) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                level.sizeWindow > 0 && "font-medium",
                isDominantBuy && level.sizeWindow > 0 && "text-trading-buy",
                isDominantSell && level.sizeWindow > 0 && "text-trading-sell"
              )}>
                {formatSize(level.sizeWindow)}
              </div>

              {/* Bids - only show if price is below or at current price */}
              <div 
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQuantity > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() => totalBuyQuantity > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{formatSize(level.bidSize)}</span>
                    {totalBuyQuantity > 0 && <span className="ml-1 text-xs">({totalBuyQuantity})</span>}
                  </>
                )}
              </div>

              {/* Price */}
              <div className={cn(
                "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                isLastPrice && "text-trading-average font-bold"
              )}>
                {formatPrice(level.price)}
              </div>

              {/* Asks - only show if price is above or at current price */}
              <div 
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQuantity > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() => totalSellQuantity > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{formatSize(level.askSize)}</span>
                    {totalSellQuantity > 0 && <span className="ml-1 text-xs">({totalSellQuantity})</span>}
                  </>
                )}
              </div>

              {/* Volume (Cumulative) */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(level.volumeCumulative)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});