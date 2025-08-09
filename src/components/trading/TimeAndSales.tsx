import { memo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
}

interface TimeAndSalesProps {
  trades: Trade[];
  currentPrice: number;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${timeStr}.${ms}`;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

export const TimeAndSales = memo(function TimeAndSales({
  trades,
  currentPrice
}: TimeAndSalesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top when new trades arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [trades.length]);

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="p-3">
          <h3 className="text-sm font-semibold">Time & Sales</h3>
        </div>
        <div className="grid grid-cols-4 text-xs font-semibold text-muted-foreground border-t border-border">
          <div className="p-2 text-center border-r border-border">Time</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center">Side</div>
        </div>
      </div>

      {/* Trades List */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto trading-scroll"
      >
        {trades.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Aucun trade
          </div>
        ) : (
          trades.map((trade, index) => {
            const isUpTick = index > 0 && trade.price > trades[index - 1].price;
            const isDownTick = index > 0 && trade.price < trades[index - 1].price;
            
            return (
              <div 
                key={trade.id}
                className={cn(
                  "grid grid-cols-4 text-xs border-b border-border/50 h-8 items-center",
                  isUpTick && "flash-buy",
                  isDownTick && "flash-sell",
                  "hover:bg-ladder-row-hover transition-colors"
                )}
              >
                {/* Time */}
                <div className="px-2 text-center font-mono text-muted-foreground border-r border-border/50">
                  {formatTime(trade.timestamp)}
                </div>

                {/* Price */}
                <div className={cn(
                  "px-2 text-center font-mono font-medium border-r border-border/50",
                  trade.aggressor === 'BUY' ? "text-trading-buy" : "text-trading-sell",
                  trade.price === currentPrice && "font-bold"
                )}>
                  {formatPrice(trade.price)}
                </div>

                {/* Size */}
                <div className="px-2 text-center font-mono border-r border-border/50">
                  {trade.size}
                </div>

                {/* Side */}
                <div className={cn(
                  "px-2 text-center font-semibold",
                  trade.aggressor === 'BUY' ? "text-trading-buy" : "text-trading-sell"
                )}>
                  {trade.aggressor === 'BUY' ? '▲' : '▼'}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Stats */}
      <div className="bg-ladder-header border-t border-border p-3">
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="text-muted-foreground">Total Trades</div>
            <div className="font-mono font-semibold">{trades.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Last Price</div>
            <div className="font-mono font-semibold text-yellow-400">
              {currentPrice > 0 ? formatPrice(currentPrice) : '--'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});