import { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
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
const INITIAL_LEVELS = 100;
const EXTEND_THRESHOLD = 10;

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
  
  const [priceRange, setPriceRange] = useState<{ start: number; end: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  
  // Initialize price range once we have a current price
  useEffect(() => {
    if (currentPrice > 0 && !priceRange) {
      const roundedPrice = Math.round(currentPrice / TICK_SIZE) * TICK_SIZE;
      setPriceRange({
        start: roundedPrice - (INITIAL_LEVELS * TICK_SIZE / 2),
        end: roundedPrice + (INITIAL_LEVELS * TICK_SIZE / 2)
      });
    }
  }, [currentPrice, priceRange]);
  
  // Generate fixed price ladder
  const priceLadder = useMemo(() => {
    if (!priceRange) return [];
    
    const levels: OrderBookLevel[] = [];
    const totalLevels = Math.round((priceRange.end - priceRange.start) / TICK_SIZE);
    
    for (let i = 0; i <= totalLevels; i++) {
      const price = priceRange.start + (i * TICK_SIZE);
      
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
    
    // Sort by price descending (highest first)
    return levels.sort((a, b) => b.price - a.price);
  }, [priceRange, orderBook]);
  
  // Handle infinite scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const { scrollTop, scrollHeight, clientHeight } = target;
    setScrollTop(scrollTop);
    
    if (!priceRange) return;
    
    // Extend range upward when scrolling near top
    if (scrollTop < EXTEND_THRESHOLD * 24 && priceRange) {
      setPriceRange(prev => prev ? {
        start: prev.start - (INITIAL_LEVELS * TICK_SIZE / 4),
        end: prev.end
      } : null);
    }
    
    // Extend range downward when scrolling near bottom
    if (scrollHeight - scrollTop - clientHeight < EXTEND_THRESHOLD * 24 && priceRange) {
      setPriceRange(prev => prev ? {
        start: prev.start,
        end: prev.end + (INITIAL_LEVELS * TICK_SIZE / 4)
      } : null);
    }
  }, [priceRange]);
  
  // Center on current price when space is pressed
  const centerOnCurrentPrice = useCallback(() => {
    if (currentPrice > 0 && priceRange && scrollRef.current) {
      const priceIndex = priceLadder.findIndex(level => 
        Math.abs(level.price - currentPrice) < TICK_SIZE / 2
      );
      
      if (priceIndex >= 0) {
        const targetScroll = priceIndex * 24 - (scrollRef.current.clientHeight / 2);
        scrollRef.current.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
    }
  }, [currentPrice, priceRange, priceLadder]);

  // Handle keyboard events
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
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto trading-scroll"
        onScroll={handleScroll}
      >
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