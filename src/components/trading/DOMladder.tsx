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
  const [priceRange, setPriceRange] = useState<{ start: number; end: number } | null>(null);
  const [isExtending, setIsExtending] = useState(false);
  
  const INITIAL_LEVELS = 100;
  const EXTEND_THRESHOLD = 10;
  const ROW_HEIGHT = 32;
  
  // Initialize price range based on midPrice or orderBook
  useEffect(() => {
    if (!priceRange && (midPrice > 0 || orderBook.length > 0)) {
      const centerPrice = midPrice > 0 ? midPrice : 
        orderBook.length > 0 ? orderBook[Math.floor(orderBook.length / 2)].price : 
        currentPrice > 0 ? currentPrice : 19300;
      
      const roundedPrice = Math.round(centerPrice / tickSize) * tickSize;
      setPriceRange({
        start: roundedPrice - (INITIAL_LEVELS * tickSize / 2),
        end: roundedPrice + (INITIAL_LEVELS * tickSize / 2)
      });
    }
  }, [midPrice, orderBook, currentPrice, tickSize, priceRange]);

  // Generate infinite price ladder
  const priceLadder = useMemo(() => {
    if (!priceRange) return [];
    
    const levels: OrderBookLevel[] = [];
    const totalLevels = Math.round((priceRange.end - priceRange.start) / tickSize);
    
    for (let i = 0; i <= totalLevels; i++) {
      const price = priceRange.start + (i * tickSize);
      
      // Find matching orderbook level
      const bookLevel = orderBook.find(level => 
        Math.abs(level.price - price) < tickSize / 2
      );
      
      levels.push({
        price,
        bidSize: bookLevel?.bidSize || 0,
        askSize: bookLevel?.askSize || 0,
        bidOrders: bookLevel?.bidOrders || 0,
        askOrders: bookLevel?.askOrders || 0,
        volume: bookLevel?.volume || 0
      });
    }
    
    // Sort by price descending (highest first)
    return levels.sort((a, b) => b.price - a.price);
  }, [priceRange, orderBook, tickSize]);

  // Handle infinite scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (isExtending) return;
    
    const target = e.target as HTMLDivElement;
    const { scrollTop, scrollHeight, clientHeight } = target;
    
    const threshold = EXTEND_THRESHOLD * ROW_HEIGHT;
    
    if (scrollTop < threshold) {
      // Extend upward (add higher prices)
      setIsExtending(true);
      setPriceRange(prev => {
        if (!prev) return null;
        const newEnd = prev.end + (EXTEND_THRESHOLD * tickSize);
        return { start: prev.start, end: newEnd };
      });
      
      // Adjust scroll position to maintain view
      setTimeout(() => {
        target.scrollTop = scrollTop + (EXTEND_THRESHOLD * ROW_HEIGHT);
        setIsExtending(false);
      }, 50);
    } else if (scrollTop + clientHeight > scrollHeight - threshold) {
      // Extend downward (add lower prices)
      setIsExtending(true);
      setPriceRange(prev => {
        if (!prev) return null;
        const newStart = prev.start - (EXTEND_THRESHOLD * tickSize);
        return { start: newStart, end: prev.end };
      });
      
      setTimeout(() => {
        setIsExtending(false);
      }, 50);
    }
  }, [tickSize, isExtending]);

  // Center view on current price (manual only)
  const centerOnCurrentPrice = useCallback(() => {
    if (!currentPrice || !scrollRef.current) return;
    
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
    const targetScrollTop = (currentPriceIndex * ROW_HEIGHT) - (container.clientHeight / 2);
    container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
  }, [currentPrice, priceLadder, tickSize]);

  // Initial centering on mid price when DOM loads
  useEffect(() => {
    if (!hasInitialCentered && midPrice > 0 && priceLadder.length > 0 && scrollRef.current) {
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
      const targetScrollTop = (midPriceIndex * ROW_HEIGHT) - (container.clientHeight / 2);
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
      {/* Header - Prix | Bids | Asks | Size | Volume */}
      <header className="sticky top-0 bg-background border-b border-border z-20">
        <div className="flex">
          <div className="w-20 flex items-center justify-center text-xs font-bold text-muted-foreground bg-muted/50 border-r border-border">
            Price
          </div>
          <div className="flex-1 grid grid-cols-4 gap-1 p-2 text-xs font-medium text-muted-foreground">
            <div className="text-center">Bids</div>
            <div className="text-center">Asks</div>
            <div className="text-center">Size</div>
            <div className="text-center">Volume</div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex">
        {/* Fixed Price Column */}
        <div className="w-20 bg-background border-r border-border flex flex-col">
          <div 
            className="flex-1 overflow-hidden"
            style={{ 
              height: `${priceLadder.length * ROW_HEIGHT}px`,
              position: 'relative'
            }}
          >
            {priceLadder.map((level, index) => {
              const isCurrentPrice = Math.abs(level.price - currentPrice) < tickSize / 2;
              const isMidPrice = Math.abs(level.price - midPrice) < tickSize / 2;
              const isAvgBuy = averagePrices.avgBuy && Math.abs(level.price - averagePrices.avgBuy) < tickSize / 2;
              const isAvgSell = averagePrices.avgSell && Math.abs(level.price - averagePrices.avgSell) < tickSize / 2;
              
              return (
                <div
                  key={`price-${level.price}`}
                  className={cn(
                    "absolute left-0 right-0 flex items-center justify-center text-xs font-mono font-bold cursor-pointer border-b border-border/20",
                    isCurrentPrice && "text-yellow-400 bg-yellow-500/20",
                    isMidPrice && "text-blue-400 bg-blue-500/20",
                    isAvgBuy && "bg-green-500/10",
                    isAvgSell && "bg-red-500/10",
                    "hover:bg-muted/50 transition-colors"
                  )}
                  style={{
                    top: `${index * ROW_HEIGHT}px`,
                    height: `${ROW_HEIGHT}px`
                  }}
                  onClick={() => handleCellClick('BUY', level.price)}
                  title="Click to center and place order"
                >
                  {formatPrice(level.price)}
                </div>
              );
            })}
          </div>
        </div>

        {/* Main content area - Scrollable */}
        <div 
          ref={scrollRef}
          className="flex-1 overflow-auto"
          onScroll={handleScroll}
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
                  "grid grid-cols-4 gap-1 p-1 text-xs border-b border-border/20 items-center hover:bg-muted/50 transition-colors relative",
                  isCurrentPrice && "bg-yellow-500/20 border-yellow-500/40",
                  isMidPrice && "bg-blue-500/20 border-blue-500/40",
                  isAvgBuy && "bg-green-500/10",
                  isAvgSell && "bg-red-500/10",
                  hasOrders && "bg-blue-500/10"
                )}
                style={{ minHeight: `${ROW_HEIGHT}px` }}
              >
                {/* Bids */}
                <div 
                  className="text-right text-green-400 font-mono cursor-pointer pr-2"
                  onClick={() => handleCellClick('BUY', level.price)}
                  title="Click to place buy limit order"
                >
                  {level.bidSize > 0 ? formatSize(level.bidSize) : ''}
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
    </div>
  );
});