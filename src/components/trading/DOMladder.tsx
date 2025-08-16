import { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  volume?: number;
}

interface OrderBookData {
  book_bid_sizes: number[];
  book_ask_sizes: number[];
  book_bid_prices: number[];
  book_ask_prices: number[];
  book_bid_orders?: number[];
  book_ask_orders?: number[];
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
  orderBookData?: OrderBookData;
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
  orderBookData,
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
// --- ADD: throttle/RAF state to éviter un render à chaque pixel
  const scrollRafRef = useRef<number | null>(null);
  const lastScrollArgsRef = useRef<{ top: number; height: number; client: number } | null>(null);
  
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
  
  // Generate price ladder from orderbook data
  const priceLadder = useMemo(() => {
    console.log('DOMladder: orderBookData:', orderBookData);
    console.log('DOMladder: priceRange:', priceRange);
    console.log('DOMladder: orderBook:', orderBook);
    
    if (orderBookData && (orderBookData.book_bid_prices.length > 0 || orderBookData.book_ask_prices.length > 0)) {
      // Use real orderbook data (up to 20 levels)
      const levels: OrderBookLevel[] = [];
      const allPrices = new Set<number>();
      
      // Collect all unique prices from bid and ask sides
      orderBookData.book_bid_prices.forEach(price => allPrices.add(price));
      orderBookData.book_ask_prices.forEach(price => allPrices.add(price));
      
      // Convert to sorted array (highest first for proper DOM display)
      const sortedPrices = Array.from(allPrices).sort((a, b) => b - a);
      
      // Create levels for each price
      sortedPrices.forEach(price => {
        const bidIndex = orderBookData.book_bid_prices.findIndex(p => Math.abs(p - price) < 0.001);
        const askIndex = orderBookData.book_ask_prices.findIndex(p => Math.abs(p - price) < 0.001);
        
        levels.push({
          price,
          bidSize: bidIndex >= 0 ? (orderBookData.book_bid_sizes[bidIndex] || 0) : 0,
          askSize: askIndex >= 0 ? (orderBookData.book_ask_sizes[askIndex] || 0) : 0,
          bidOrders: bidIndex >= 0 ? (orderBookData.book_bid_orders?.[bidIndex] || 0) : 0,
          askOrders: askIndex >= 0 ? (orderBookData.book_ask_orders?.[askIndex] || 0) : 0,
          volume: 0
        });
      });
      
      return levels;
    }
    
    // Fallback to fixed price ladder if no orderbook data
    if (!priceRange) return [];
    
    const levels: OrderBookLevel[] = [];
    const totalLevels = Math.round((priceRange.end - priceRange.start) / TICK_SIZE);
    
    for (let i = 0; i <= totalLevels; i++) {
      const price = priceRange.start + (i * TICK_SIZE);
      const bookLevel = orderBook.find(level => 
        Math.abs(level.price - price) < TICK_SIZE / 2
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
    
    return levels.sort((a, b) => b.price - a.price);
  }, [priceRange, orderBook, orderBookData]);
  
  // Handle infinite scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    // --- ADD: exécuter la logique dans un RAF pour éviter re-renders à chaque pixel
    const target = e.target as HTMLDivElement;
    lastScrollArgsRef.current = {
      top: target.scrollTop,
      height: target.scrollHeight,
      client: target.clientHeight,
    };
    if (scrollRafRef.current !== null) return; // déjà planifié pour ce frame
   scrollRafRef.current = requestAnimationFrame(() => {
     const args = lastScrollArgsRef.current!;
     scrollRafRef.current = null;
      // On réapplique la logique existante avec les valeurs mises en cache
      setScrollTop(args.top);
      if (!priceRange) return;
     if (args.top < EXTEND_THRESHOLD * 24) {
        setPriceRange(prev => prev ? {
          start: prev.start - (INITIAL_LEVELS * TICK_SIZE / 4),
          end: prev.end
        } : null);
      }
      if (args.height - args.top - args.client < EXTEND_THRESHOLD * 24 && priceRange) {
        setPriceRange(prev => prev ? {
          start: prev.start,
         end: prev.end + (INITIAL_LEVELS * TICK_SIZE / 4)
        } : null);
      }
    });
    return; // on court-circuite l’exécution immédiate pour ce tick
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
          <div className="p-2 text-center border-r border-border sticky-price-cell">Price</div>
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
          const isAvgBuyPrice = averagePrices.avgBuyPrice && Math.abs(level.price - averagePrices.avgBuyPrice) < TICK_SIZE / 2;
          const isAvgSellPrice = averagePrices.avgSellPrice && Math.abs(level.price - averagePrices.avgSellPrice) < TICK_SIZE / 2;
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
                (isAvgBuyPrice || isAvgSellPrice) && "border-2 border-trading-average",
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
                "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price sticky-price-cell",
                isLastPrice && "text-trading-average font-bold"
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
                {/* Show last trade size at this exact price if available */}
              </div>

              {/* Volume */}
              <div className="flex items-center justify-center text-muted-foreground">
                {level.volume && level.volume > 0 ? formatSize(level.volume) : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});