import { memo, useMemo, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface LadderRow {
  price: number;
  bidSize: number;
  askSize: number;
  size: number;
  volume: number;
  tickIndex: number;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface DOMladderProps {
  ladderData: LadderRow[];
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
}

const TICK_SIZE = 0.25;

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size: number): string {
  return size.toString();
}

export const DOMladder = memo(function DOMladder({
  ladderData,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false
}: DOMladderProps) {
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  console.log('🎯 DOMladder: received ladderData with', ladderData.length, 'rows');
  console.log('🎯 DOMladder: currentPrice:', currentPrice);
  
  // Center on current price when space is pressed
  const centerOnCurrentPrice = useCallback(() => {
    if (currentPrice > 0 && scrollRef.current && ladderData.length > 0) {
      const priceIndex = ladderData.findIndex(row => 
        Math.abs(row.price - currentPrice) < TICK_SIZE / 2
      );
      
      if (priceIndex >= 0) {
        const targetScroll = priceIndex * 24 - (scrollRef.current.clientHeight / 2);
        scrollRef.current.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
    }
  }, [currentPrice, ladderData]);

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

  if (ladderData.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">No ladder data available</div>
      </div>
    );
  }

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
      >
        {ladderData.map((row) => {
          const isLastPrice = Math.abs(row.price - currentPrice) < TICK_SIZE / 2;
          const isAvgBuyPrice = averagePrices.avgBuyPrice && Math.abs(row.price - averagePrices.avgBuyPrice) < TICK_SIZE / 2;
          const isAvgSellPrice = averagePrices.avgSellPrice && Math.abs(row.price - averagePrices.avgSellPrice) < TICK_SIZE / 2;
          const buyOrders = getOrdersAtPrice(row.price, 'BUY');
          const sellOrders = getOrdersAtPrice(row.price, 'SELL');
          const totalBuyQuantity = buyOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          const totalSellQuantity = sellOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          
          return (
            <div 
              key={row.tickIndex}
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
                  row.price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQuantity > 0 && "bg-trading-buy/20"
                )}
                onClick={() => totalBuyQuantity > 0 ? handleOrderClick(row.price) : handleCellClick(row.price, 'bid')}
              >
                {totalBuyQuantity > 0 && `+${totalBuyQuantity} LMT`}
              </div>

              {/* Sell Orders */}
              <div 
                className={cn(
                  "flex items-center justify-center text-trading-sell cursor-pointer border-r border-border/50",
                  row.price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQuantity > 0 && "bg-trading-sell/20"
                )}
                onClick={() => totalSellQuantity > 0 ? handleOrderClick(row.price) : handleCellClick(row.price, 'ask')}
              >
                {totalSellQuantity > 0 && `+${totalSellQuantity} LMT`}
              </div>

              {/* Bids */}
              <div 
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  row.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  row.price < currentPrice && "hover:bg-trading-buy/10"
                )}
                onClick={() => handleCellClick(row.price, 'bid')}
              >
                {row.bidSize > 0 && formatSize(row.bidSize)}
              </div>

              {/* Price */}
              <div className={cn(
                "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                isLastPrice && "text-trading-average font-bold"
              )}>
                {formatPrice(row.price)}
              </div>

              {/* Asks */}
              <div 
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  row.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  row.price > currentPrice && "hover:bg-trading-sell/10"
                )}
                onClick={() => handleCellClick(row.price, 'ask')}
              >
                {row.askSize > 0 && formatSize(row.askSize)}
              </div>

              {/* Size (traded in this frame) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {row.size > 0 && formatSize(row.size)}
              </div>

              {/* Volume (cumulative) */}
              <div className="flex items-center justify-center text-muted-foreground">
                {row.volume > 0 && formatSize(row.volume)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});