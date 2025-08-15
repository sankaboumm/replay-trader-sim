import { memo } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface Position {
  quantity: number;
  averagePrice: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size?: number): string {
  return size && size > 0 ? String(size) : '';
}

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  position,
}: TickLadderProps) {
  const priceEq = (a: number, b: number) => Math.abs(a - b) < 0.125;

  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(
      (o) => o.side === side && priceEq(o.price, price) && o.quantity > o.filled
    );

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt    = priceEq(price, currentPrice);

    if (column === 'bid') {
      // Clic côté BID :
      // - au-dessus ou égal au dernier → MARKET BUY
      // - en dessous → LIMIT BUY au niveau cliqué
      if (isAbove || isAt) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      // Clic côté ASK :
      // - au-dessous ou égal au dernier → MARKET SELL
      // - au-dessus → LIMIT SELL au niveau cliqué
      if (isBelow || isAt) onMarketOrder('SELL', 1);
      else onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!tickLadder || !tickLadder.levels?.length) {
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
        <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Ladder Rows */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {(tickLadder.levels ?? [])
          .slice()
          .reverse()
          .map((level) => {
            const isLastPrice = priceEq(level.price, currentPrice);
            const isAvg =
              position?.quantity !== 0 &&
              priceEq(level.price, position.averagePrice);

            const buyOrders = getOrdersAtPrice(level.price, 'BUY');
            const sellOrders = getOrdersAtPrice(level.price, 'SELL');
            const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

            return (
              <div
                key={level.tick}
                className={cn(
                  'grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6',
                  isLastPrice && 'bg-ladder-last/20',
                  'hover:bg-ladder-row-hover transition-colors'
                )}
              >
                {/* Size (flux) */}
                <div
                  className={cn(
                    'flex items-center justify-center border-r border-border/50',
                    (level.sizeWindow ?? 0) > 0 && 'font-medium'
                  )}
                >
                  {formatSize(level.sizeWindow)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    'flex items-center justify-center cursor-pointer border-r border-border/50',
                    level.price <= currentPrice && (level.bidSize ?? 0) > 0 && 'bg-ladder-bid text-trading-buy',
                    level.price <= currentPrice && 'hover:bg-trading-buy/10',
                    totalBuyQty > 0 && 'ring-2 ring-trading-buy/50'
                  )}
                  onClick={() =>
                    totalBuyQty > 0
                      ? handleOrderClick(level.price)
                      : handleCellClick(level.price, 'bid')
                  }
                >
                  {level.price <= currentPrice && (
                    <>
                      <span>{formatSize(level.bidSize)}</span>
                      {totalBuyQty > 0 && (
                        <span className="ml-1 text-xs">({totalBuyQty})</span>
                      )}
                    </>
                  )}
                </div>

                {/* PRICE (cellule seulement) */}
                <div
                  className={cn(
                    'flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price',
                    isLastPrice && 'text-trading-average font-bold'
                  )}
                  style={
                    isAvg
                      ? {
                          boxShadow:
                            '0 0 0 2px hsl(var(--trading-average)) inset',
                          borderRadius: 2,
                        }
                      : undefined
                  }
                  title={isAvg ? 'Votre prix moyen' : undefined}
                >
                  {formatPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    'flex items-center justify-center cursor-pointer border-r border-border/50',
                    level.price >= currentPrice && (level.askSize ?? 0) > 0 && 'bg-ladder-ask text-trading-sell',
                    level.price >= currentPrice && 'hover:bg-trading-sell/10',
                    totalSellQty > 0 && 'ring-2 ring-trading-sell/50'
                  )}
                  onClick={() =>
                    totalSellQty > 0
                      ? handleOrderClick(level.price)
                      : handleCellClick(level.price, 'ask')
                  }
                >
                  {level.price >= currentPrice && (
                    <>
                      <span>{formatSize(level.askSize)}</span>
                      {totalSellQty > 0 && (
                        <span className="ml-1 text-xs">({totalSellQty})</span>
                      )}
                    </>
                  )}
                </div>

                {/* Volume cumulé */}
                <div className="flex items-center justify-center text-muted-foreground">
                  {formatSize(level.volumeCumulative)}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
});