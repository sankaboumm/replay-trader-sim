import { memo, useMemo } from 'react';
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

function formatSize(size: number): string {
  return size > 0 ? size.toString() : '';
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

  // Get orders for a specific price level
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') => {
    return orders.filter(order =>
      order.side === side &&
      Math.abs(order.price - price) < 0.125 &&
      order.quantity > order.filled
    );
  };

  // (facultatif) moyennes d’exécution par côté
  const averagePrices = useMemo(() => {
    const filledBuyOrders = orders.filter(o => o.side === 'BUY' && o.filled > 0);
    const filledSellOrders = orders.filter(o => o.side === 'SELL' && o.filled > 0);

    const avgBuyPrice = filledBuyOrders.length > 0
      ? filledBuyOrders.reduce((sum, o) => sum + (o.price * o.filled), 0) /
        filledBuyOrders.reduce((sum, o) => sum + o.filled, 0)
      : null;

    const avgSellPrice = filledSellOrders.length > 0
      ? filledSellOrders.reduce((sum, o) => sum + (o.price * o.filled), 0) /
        filledSellOrders.reduce((sum, o) => sum + o.filled, 0)
      : null;

    return { avgBuyPrice, avgSellPrice };
  }, [orders]);

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

  if (!tickLadder || !tickLadder.levels || tickLadder.levels.length === 0) {
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
        {(tickLadder?.levels ?? []).slice().reverse().map((level, index) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;

          // 👉 Seulement cette condition sert à encadrer la cellule "Price"
          const isAvgPositionPrice =
            position.quantity !== 0 &&
            Math.abs(level.price - position.averagePrice) < 0.125;

          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQuantity = buyOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);
          const totalSellQuantity = sellOrders.reduce((sum, order) => sum + (order.quantity - order.filled), 0);

          // (placeholder) coloration size
          const isDominantBuy = level.sizeWindow > 0;
          const isDominantSell = level.sizeWindow > 0;

          return (
            <div
              key={level.tick}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                isLastPrice && "bg-ladder-last/20",
                // ❌ on NE met plus de bordure ici (sur toute la row)
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (Window) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50",
                level.sizeWindow > 0 && "font-medium",
                isDominantBuy && level.sizeWindow > 0 && "text-trading-buy",
                isDominantSell && level.sizeWindow > 0 && "text-trading-sell"
              )}>
                {formatSize(level.sizeWindow)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQuantity > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() => totalBuyQuantity > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{formatSize(level.bidSize)}</span>
                    {totalBuyQuantity > 0 && <span className="ml-1 text-xs">({totalBuyQuantity})</span>}
                  </>
                )}
              </div>

              {/* Price (👉 c’est ICI qu’on encadre uniquement la cellule quand c’est le prix moyen) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLastPrice && "text-trading-average font-bold"
                )}
              >
                <span
                  className={cn(
                    "px-1 rounded-sm",
                    // Encadrement jaune uniquement sur la cellule Price quand level == avg position
                    isAvgPositionPrice && "outline outline-2 outline-[hsl(var(--trading-average))]"
                  )}
                >
                  {formatPrice(level.price)}
                </span>
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQuantity > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() => totalSellQuantity > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{formatSize(level.askSize)}</span>
                    {totalSellQuantity > 0 && <span className="ml-1 text-xs">({totalSellQuantity})</span>}
                  </>
                )}
              </div>

              {/* Volume (Cumulative) */}
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