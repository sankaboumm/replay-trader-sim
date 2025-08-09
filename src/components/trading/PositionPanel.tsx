import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
}

interface PnL {
  unrealized: number;
  realized: number;
  total: number;
}

interface PositionPanelProps {
  position: Position;
  pnl: PnL;
  currentPrice: number;
  className?: string;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatPnL(value: number): string {
  const formatted = Math.abs(value).toFixed(2).replace('.', ',');
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

export const PositionPanel = memo(function PositionPanel({
  position,
  pnl,
  currentPrice,
  className
}: PositionPanelProps) {
  const isLong = position.quantity > 0;
  const isShort = position.quantity < 0;
  const isFlat = position.quantity === 0;

  return (
    <Card className={cn("p-4 space-y-4", className)}>
      {/* Position Summary */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">Position</h3>
        
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Symbol</span>
            <span className="font-mono font-medium">{position.symbol || 'N/A'}</span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Quantity</span>
            <span className={cn(
              "font-mono font-bold",
              isLong && "text-trading-buy",
              isShort && "text-trading-sell",
              isFlat && "text-muted-foreground"
            )}>
              {position.quantity}
            </span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Avg Price</span>
            <span className="font-mono">
              {position.quantity !== 0 ? formatPrice(position.averagePrice) : '--'}
            </span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Market Price</span>
            <span className="font-mono font-medium text-yellow-400">
              {currentPrice > 0 ? formatPrice(currentPrice) : '--'}
            </span>
          </div>
        </div>
      </div>

      {/* PnL Summary */}
      <div className="border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">P&L</h3>
        
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Non réalisé</span>
            <span className={cn(
              "font-mono font-bold",
              pnl.unrealized >= 0 ? "text-trading-profit" : "text-trading-loss"
            )}>
              {formatPnL(pnl.unrealized)} €
            </span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Réalisé</span>
            <span className={cn(
              "font-mono font-bold",
              pnl.realized >= 0 ? "text-trading-profit" : "text-trading-loss"
            )}>
              {formatPnL(pnl.realized)} €
            </span>
          </div>
          
          <div className="flex justify-between items-center border-t border-border pt-2">
            <span className="text-sm font-semibold">Total</span>
            <span className={cn(
              "font-mono font-bold text-lg",
              pnl.total >= 0 ? "text-trading-profit" : "text-trading-loss"
            )}>
              {formatPnL(pnl.total)} €
            </span>
          </div>
        </div>
      </div>

      {/* Position Status */}
      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-center p-3 rounded-md">
          <span className={cn(
            "text-sm font-semibold",
            isLong && "text-trading-buy",
            isShort && "text-trading-sell",
            isFlat && "text-muted-foreground"
          )}>
            {isLong && `LONG ${Math.abs(position.quantity)}`}
            {isShort && `SHORT ${Math.abs(position.quantity)}`}
            {isFlat && 'FLAT'}
          </span>
        </div>
      </div>
    </Card>
  );
});