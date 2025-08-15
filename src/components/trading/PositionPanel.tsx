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

interface Props {
  position: Position;
  pnl: PnL;
  currentPrice: number;
  // nouveaux props
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  spreadTicks?: number;
  className?: string;
}

const fmt = (n: number | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '-';

export function PositionPanel({
  position,
  pnl,
  currentPrice,
  bestBid,
  bestAsk,
  spread,
  spreadTicks,
  className
}: Props) {
  const label =
    position.quantity === 0 ? 'FLAT' : position.quantity > 0 ? 'LONG' : 'SHORT';

  return (
    <div className={cn('p-4 space-y-3 border-b border-border', className)}>
      <div className="text-sm text-muted-foreground">Position</div>
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">Status</div>
        <div className="font-semibold">{label}</div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="text-muted-foreground">Quantity</div>
        <div className="text-right font-semibold">{position.quantity}</div>

        <div className="text-muted-foreground">Avg Price</div>
        <div className="text-right font-semibold">{fmt(position.averagePrice)}</div>

        <div className="text-muted-foreground">Market Price</div>
        <div className="text-right font-semibold">{fmt(currentPrice)}</div>

        {/* SPREAD temps réel sous Market Price */}
        <div className="text-muted-foreground">Spread</div>
        <div className="text-right font-semibold">
          {bestBid !== undefined && bestAsk !== undefined && spread !== undefined && spreadTicks !== undefined
            ? `${fmt(bestAsk)} - ${fmt(bestBid)} = ${spread.toFixed(2)}  (${spreadTicks} ticks)`
            : '—'}
        </div>

        <div className="text-muted-foreground">Unrealized</div>
        <div className={cn(
          'text-right font-semibold',
          pnl.unrealized > 0 ? 'text-trading-buy' : pnl.unrealized < 0 ? 'text-trading-sell' : ''
        )}>
          {pnl.unrealized.toFixed(2)}
        </div>

        <div className="text-muted-foreground">Realized</div>
        <div className={cn(
          'text-right font-semibold',
          pnl.realized > 0 ? 'text-trading-buy' : pnl.realized < 0 ? 'text-trading-sell' : ''
        )}>
          {pnl.realized.toFixed(2)}
        </div>

        <div className="text-muted-foreground">Total PnL</div>
        <div className={cn(
          'text-right font-bold',
          pnl.total > 0 ? 'text-trading-buy' : pnl.total < 0 ? 'text-trading-sell' : ''
        )}>
          {pnl.total.toFixed(2)}
        </div>
      </div>
    </div>
  );
}