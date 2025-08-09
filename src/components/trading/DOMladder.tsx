import { memo, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface DOMladderProps {
  orderBook: OrderBookLevel[];
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
}

const TICK_SIZE = 0.25;
const VISIBLE_LEVELS = 20;

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size: number): string {
  return size.toString();
}

export const DOMladder = memo(function DOMladder({
  orderBook,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false
}: DOMladderProps) {
  
  // Generate price ladder around current price
  const priceLadder = useMemo(() => {
    if (currentPrice <= 0) return [];
    
    const levels: OrderBookLevel[] = [];
    const halfLevels = Math.floor(VISIBLE_LEVELS / 2);
    
    // Round current price to nearest tick
    const roundedPrice = Math.round(currentPrice / TICK_SIZE) * TICK_SIZE;
    
    for (let i = halfLevels; i >= -halfLevels; i--) {
      const price = roundedPrice + (i * TICK_SIZE);
      
      // Find matching orderbook level
      const bookLevel = orderBook.find(level => 
        Math.abs(level.price - price) < TICK_SIZE / 2
      );
      
      levels.push({
        price,
        bidSize: bookLevel?.bidSize || 0,
        askSize: bookLevel?.askSize || 0,
        bidOrders: bookLevel?.bidOrders || 0,
        askOrders: bookLevel?.askOrders || 0
      });
    }
    
    return levels;
  }, [currentPrice, orderBook]);

  // Get orders for a specific price level
  const getOrdersAtPrice = useCallback((price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(order => 
      order.side === side && 
      Math.abs(order.price - price) < TICK_SIZE / 2 &&
      order.quantity > order.filled
    );
  }, [orders]);

  const handleCellClick = useCallback((price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    
    const isAboveCurrentPrice = price > currentPrice;
    const isBelowCurrentPrice = price < currentPrice;
    const isAtCurrentPrice = Math.abs(price - currentPrice) < TICK_SIZE / 2;
    
    if (column === 'bid') {
      if (isAboveCurrentPrice || isAtCurrentPrice) {
        // Market Buy
        onMarketOrder('BUY', 1);
      } else {
        // Limit Buy
        onLimitOrder('BUY', price, 1);
      }
    } else {
      if (isBelowCurrentPrice || isAtCurrentPrice) {
        // Market Sell
        onMarketOrder('SELL', 1);
      } else {
        // Limit Sell
        onLimitOrder('SELL', price, 1);
      }
    }
  }, [currentPrice, disabled, onLimitOrder, onMarketOrder]);

  const handleOrderClick = useCallback((price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  }, [disabled, onCancelOrders]);

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="grid grid-cols-7 text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Buy</div>
          <div className="p-2 text-center border-r border-border">Sell</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Ladder Rows */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {priceLadder.map((level, index) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < TICK_SIZE / 2;
          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQuantity = buyOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          const totalSellQuantity = sellOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          
          return (
            <div 
              key={level.price}
              className={cn(
                "grid grid-cols-7 text-xs border-b border-border/50 h-6",
                isLastPrice && "bg-ladder-last/20",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Buy Orders */}
              <div 
                className={cn(
                  "flex items-center justify-center text-trading-buy cursor-pointer",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQuantity > 0 && "bg-trading-buy/20"
                )}
                onClick={() => totalBuyQuantity > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
              >
                {totalBuyQuantity > 0 && `+${totalBuyQuantity} LMT`}
              </div>

              {/* Sell Orders */}
              <div 
                className={cn(
                  "flex items-center justify-center text-trading-sell cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQuantity > 0 && "bg-trading-sell/20"
                )}
                onClick={() => totalSellQuantity > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
              >
                {totalSellQuantity > 0 && `+${totalSellQuantity} LMT`}
              </div>

              {/* Bids */}
              <div 
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price < currentPrice && "hover:bg-trading-buy/10"
                )}
                onClick={() => handleCellClick(level.price, 'bid')}
              >
                {level.bidSize > 0 && formatSize(level.bidSize)}
              </div>

              {/* Price */}
              <div className={cn(
                "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                isLastPrice && "text-yellow-400 font-bold"
              )}>
                {formatPrice(level.price)}
              </div>

              {/* Asks */}
              <div 
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price > currentPrice && "hover:bg-trading-sell/10"
                )}
                onClick={() => handleCellClick(level.price, 'ask')}
              >
                {level.askSize > 0 && formatSize(level.askSize)}
              </div>

              {/* Last Trade Size */}
              <div className="flex items-center justify-center border-r border-border/50">
                {/* This would show last trade size at this price */}
              </div>

              {/* Volume */}
              <div className="flex items-center justify-center text-muted-foreground">
                {/* This would show total volume at this price */}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});