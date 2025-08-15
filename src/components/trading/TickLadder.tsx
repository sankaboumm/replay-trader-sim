import { memo, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType, TickLevel } from '@/lib/orderbook';
import { Order, PositionPnL } from '@/lib/engine';

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  position: PositionPnL;
  originTick: number;
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  tickSize?: number;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size: number): string {
  return size > 0 ? size.toString() : '';
}

const TOTAL = 2_000_001;
const MID_INDEX = 1_000_000;
const ROW_H = 22;

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  position,
  originTick,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  tickSize = 0.25
}: TickLadderProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Mapping index → tick
  const indexToTick = (i: number) => originTick + (i - MID_INDEX);
  const fromTick = (tick: number) => tick * tickSize;
  const toTick = (price: number) => Math.round(price / tickSize);

  // Virtual scrolling
  const rowVirtualizer = useVirtualizer({
    count: TOTAL,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_H,
    overscan: 40,
  });

  // Get orders for a specific price level
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') => {
    const tickIndex = toTick(price);
    return orders.filter(order => 
      order.side === side && 
      order.tickIndex === tickIndex &&
      order.remain > 0 &&
      (order.status === 'WORKING' || order.status === 'PARTIAL')
    );
  };

  // Get position average price tick for highlighting
  const positionAverageTick = useMemo(() => {
    return position.pos !== 0 ? toTick(position.avg) : null;
  }, [position, toTick]);

  // Get current data for a tick
  const getTickData = (tick: number) => {
    if (!tickLadder) return { bidSize: 0, askSize: 0, sizeWindow: 0, volumeCumulative: 0 };
    
    const level = tickLadder.levels.find(l => l.tick === tick);
    return level ? {
      bidSize: level.bidSize,
      askSize: level.askSize,
      sizeWindow: level.sizeWindow,
      volumeCumulative: level.volumeCumulative
    } : { bidSize: 0, askSize: 0, sizeWindow: 0, volumeCumulative: 0 };
  };

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

  if (!tickLadder && originTick === 0) {
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
        <div className="grid grid-cols-[80px_80px_80px_80px_80px] text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border sticky left-1/2 -translate-x-1/2 z-20 bg-ladder-header">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Virtual Ladder */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-y-auto trading-scroll"
        style={{ height: '400px' }}
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const tick = indexToTick(virtualItem.index);
            const price = fromTick(tick);
            const data = getTickData(tick);
            
            const isLastPrice = Math.abs(price - currentPrice) < 0.125;
            const isPositionAverage = positionAverageTick !== null && tick === positionAverageTick;
            const buyOrders = getOrdersAtPrice(price, 'BUY');
            const sellOrders = getOrdersAtPrice(price, 'SELL');
            const totalBuyQuantity = buyOrders.reduce((sum, order) => sum + order.remain, 0);
            const totalSellQuantity = sellOrders.reduce((sum, order) => sum + order.remain, 0);

            return (
              <div
                key={virtualItem.index}
                className={cn(
                  "absolute top-0 left-0 w-full grid grid-cols-[80px_80px_80px_80px_80px] text-xs border-b border-border/50",
                  isLastPrice && "bg-ladder-last/20",
                  isPositionAverage && "ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900/20",
                  "hover:bg-ladder-row-hover transition-colors"
                )}
                style={{
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {/* Bids */}
                <div 
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    data.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                    "hover:bg-trading-buy/10",
                    totalBuyQuantity > 0 && "ring-2 ring-trading-buy/50"
                  )}
                  onClick={() => totalBuyQuantity > 0 ? handleOrderClick(price) : handleCellClick(price, 'bid')}
                >
                  <span>{formatSize(data.bidSize)}</span>
                  {totalBuyQuantity > 0 && <span className="ml-1 text-xs">({totalBuyQuantity})</span>}
                </div>

                {/* Price (sticky center) */}
                <div className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  "sticky left-1/2 -translate-x-1/2 z-20 bg-background/90 backdrop-blur",
                  isLastPrice && "text-trading-average font-bold"
                )}>
                  {formatPrice(price)}
                </div>

                {/* Asks */}
                <div 
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    data.askSize > 0 && "bg-ladder-ask text-trading-sell",
                    "hover:bg-trading-sell/10",
                    totalSellQuantity > 0 && "ring-2 ring-trading-sell/50"
                  )}
                  onClick={() => totalSellQuantity > 0 ? handleOrderClick(price) : handleCellClick(price, 'ask')}
                >
                  <span>{formatSize(data.askSize)}</span>
                  {totalSellQuantity > 0 && <span className="ml-1 text-xs">({totalSellQuantity})</span>}
                </div>

                {/* Size (Window) */}
                <div className={cn(
                  "flex items-center justify-center border-r border-border/50",
                  data.sizeWindow > 0 && "font-medium text-trading-average"
                )}>
                  {formatSize(data.sizeWindow)}
                </div>

                {/* Volume (Cumulative) */}
                <div className="flex items-center justify-center text-muted-foreground">
                  {formatSize(data.volumeCumulative)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});