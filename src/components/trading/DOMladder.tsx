import { memo, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  volume?: number;
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
  sizeByPrice?: Map<number, number>; // Size column data
  tickSize?: number;
  midPrice?: number;
}

function formatPrice(price: number): string {
  return price.toFixed(2);
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
  disabled = false,
  sizeByPrice = new Map(),
  tickSize = 0.25,
  midPrice = 0
}: DOMladderProps) {
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasInitialCentered, setHasInitialCentered] = useState(false);
  
  // Use orderBook directly (already contains 41 levels sorted correctly)
  const priceLadder = orderBook;
  
  // Center view on current price (manual only)
  const centerOnCurrentPrice = useCallback(() => {
    if (!currentPrice || !scrollRef.current) return;
    
    const rowHeight = 32; // Approximate height of each row
    const container = scrollRef.current;
    
    // Find the index of the current price in the ladder
    let currentPriceIndex = priceLadder.findIndex(level => 
      Math.abs(level.price - currentPrice) < tickSize / 2
    );
    
    if (currentPriceIndex === -1) {
      // If current price not found, find the closest one
      currentPriceIndex = priceLadder.reduce((closestIdx, level, idx) => {
        const currentDistance = Math.abs(priceLadder[closestIdx]?.price - currentPrice);
        const thisDistance = Math.abs(level.price - currentPrice);
        return thisDistance < currentDistance ? idx : closestIdx;
      }, 0);
    }
    
    // Calculate scroll position to center this row
    const targetScrollTop = (currentPriceIndex * rowHeight) - (container.clientHeight / 2);
    container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
  }, [currentPrice, priceLadder, tickSize]);

  // Initial centering on mid price when DOM loads
  useEffect(() => {
    if (!hasInitialCentered && midPrice > 0 && priceLadder.length > 0 && scrollRef.current) {
      const rowHeight = 32;
      const container = scrollRef.current;
      
      // Find the index of the mid price in the ladder
      let midPriceIndex = priceLadder.findIndex(level => 
        Math.abs(level.price - midPrice) < tickSize / 2
      );
      
      if (midPriceIndex === -1) {
        // If mid price not found, find the closest one
        midPriceIndex = priceLadder.reduce((closestIdx, level, idx) => {
          const currentDistance = Math.abs(priceLadder[closestIdx]?.price - midPrice);
          const thisDistance = Math.abs(level.price - midPrice);
          return thisDistance < currentDistance ? idx : closestIdx;
        }, 0);
      }
      
      // Calculate scroll position to center this row
      const targetScrollTop = (midPriceIndex * rowHeight) - (container.clientHeight / 2);
      container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
      
      setHasInitialCentered(true);
      console.log('✅ Initial centering done on mid price:', midPrice);
    }
  }, [midPrice, priceLadder, tickSize, hasInitialCentered]);

  // Get orders at specific price
  const getOrdersAtPrice = useCallback((price: number) => {
    return orders.filter(order => Math.abs(order.price - price) < tickSize / 2);
  }, [orders, tickSize]);

  // Calculate average buy and sell prices for highlighting
  const averagePrices = useMemo(() => {
    const buyOrders = orders.filter(o => o.side === 'BUY' && o.filled < o.quantity);
    const sellOrders = orders.filter(o => o.side === 'SELL' && o.filled < o.quantity);
    
    const avgBuy = buyOrders.length > 0 
      ? buyOrders.reduce((sum, order) => sum + order.price, 0) / buyOrders.length 
      : null;
      
    const avgSell = sellOrders.length > 0 
      ? sellOrders.reduce((sum, order) => sum + order.price, 0) / sellOrders.length 
      : null;
    
    return { avgBuy, avgSell };
  }, [orders]);

  // Handle keyboard events for centering
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        centerOnCurrentPrice();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [centerOnCurrentPrice]);

  // Handle cell clicks for order placement
  const handleCellClick = useCallback((side: 'BUY' | 'SELL', price: number) => {
    if (disabled) return;
    
    if (side === 'BUY') {
      if (price >= currentPrice) {
        // Market order for prices at or above current
        onMarketOrder('BUY', 1);
      } else {
        // Limit order for prices below current
        onLimitOrder('BUY', price, 1);
      }
    } else {
      if (price <= currentPrice) {
        // Market order for prices at or below current
        onMarketOrder('SELL', 1);
      } else {
        // Limit order for prices above current
        onLimitOrder('SELL', price, 1);
      }
    }
  }, [currentPrice, disabled, onLimitOrder, onMarketOrder]);

  // Handle order clicks for cancellation
  const handleOrderClick = useCallback((price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  }, [disabled, onCancelOrders]);

  return (
    <div className="h-full flex flex-col bg-card">
      <header className="sticky top-0 bg-background border-b border-border z-10">
        <div className="grid grid-cols-5 gap-1 p-2 text-xs font-medium text-muted-foreground">
          <div className="text-center">Bids</div>
          <div className="text-center">Price</div>
          <div className="text-center">Asks</div>
          <div className="text-center">Size</div>
          <div className="text-center">Volume</div>
        </div>
      </header>

      <div 
        ref={scrollRef}
        className="flex-1 overflow-auto"
      >
        {priceLadder.map((level) => {
          const ordersAtPrice = getOrdersAtPrice(level.price);
          const isCurrentPrice = Math.abs(level.price - currentPrice) < tickSize / 2;
          const isMidPrice = Math.abs(level.price - midPrice) < tickSize / 2;
          const isAvgBuy = averagePrices.avgBuy && Math.abs(level.price - averagePrices.avgBuy) < tickSize / 2;
          const isAvgSell = averagePrices.avgSell && Math.abs(level.price - averagePrices.avgSell) < tickSize / 2;
          const hasOrders = ordersAtPrice.length > 0;
          const frameSize = sizeByPrice.get(level.price) || 0;
          
          return (
            <div
              key={level.price}
              className={cn(
                "grid grid-cols-5 gap-1 p-1 text-xs border-b border-border/20 min-h-[32px] items-center hover:bg-muted/50 transition-colors relative",
                isCurrentPrice && "bg-yellow-500/20 border-yellow-500/40",
                isMidPrice && "bg-blue-500/20 border-blue-500/40",
                isAvgBuy && "bg-green-500/10",
                isAvgSell && "bg-red-500/10",
                hasOrders && "bg-blue-500/10"
              )}
            >
              {/* Bids */}
              <div 
                className="text-right text-green-400 font-mono cursor-pointer pr-2"
                onClick={() => handleCellClick('BUY', level.price)}
                title="Click to place buy limit order"
              >
                {level.bidSize > 0 ? formatSize(level.bidSize) : ''}
              </div>
              
              {/* Price */}
              <div 
                className={cn(
                  "text-center font-mono font-medium cursor-pointer px-2",
                  isCurrentPrice && "text-yellow-400 font-bold",
                  isMidPrice && "text-blue-400 font-bold"
                )}
                onClick={() => handleCellClick('BUY', level.price)}
                title="Click to center and place order"
              >
                {formatPrice(level.price)}
              </div>
              
              {/* Asks */}
              <div 
                className="text-left text-red-400 font-mono cursor-pointer pl-2"
                onClick={() => handleCellClick('SELL', level.price)}
                title="Click to place sell limit order"
              >
                {level.askSize > 0 ? formatSize(level.askSize) : ''}
              </div>
              
              {/* Size (volume in current frame window) */}
              <div className="text-center text-orange-400 font-mono">
                {frameSize > 0 ? formatSize(frameSize) : ''}
              </div>
              
              {/* Volume (cumulative) */}
              <div className="text-center text-blue-400 font-mono">
                {level.volume > 0 ? formatSize(level.volume) : ''}
              </div>
              
              {/* Order count overlay */}
              {ordersAtPrice.length > 0 && (
                <div
                  className="absolute right-1 top-1 bg-blue-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs cursor-pointer z-10"
                  onClick={() => handleOrderClick(level.price)}
                  title={`${ordersAtPrice.length} order(s) at this price. Click to cancel.`}
                >
                  {ordersAtPrice.length}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});