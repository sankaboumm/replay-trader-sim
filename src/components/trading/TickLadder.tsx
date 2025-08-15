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
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(
      (o) =>
        o.side === side &&
        Math.abs(o.price - price) < 0.125 &&
        o.quantity > o.filled
    );

  // (facultatif) calculs moyens côté buy/sell – non utilisés pour l’encadré
  const averagePrices = useMemo(() => {
    const buys = orders.filter((o) => o.side === 'BUY' && o.filled > 0);
    const sells = orders.filter((o) => o.side === 'SELL' && o.filled > 0);

    const avgBuyPrice =
      buys.length > 0
        ? buys.reduce((s, o) => s + o.price * o.filled, 0) /
          buys.reduce((s, o) => s + o.filled, 0)
        : null;

    const avgSellPrice =
      sells.length > 0
        ? sells.reduce((s, o) => s + o.price * o.filled, 0) /
          sells.reduce((s, o) => s + o.filled, 0)
        : null;

    return { avgBuyPrice, avgSellPrice };
  }, [orders]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < 0.125;

    if (column === 'bid') {
      if (isAbove || isAt) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
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
        {tickLadder.levels
          .slice()
          .reverse()
          .map((level) => {
            const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
            const isAvgPositionPrice =
              position.quantity !== 0 &&
              Math.abs(level.price - position.averagePrice) < 0.125;

            const buyOrders = getOrdersAtPrice(level.price, 'BUY');
            const sellOrders = getOrdersAtPrice(level.price, 'SELL');
            const totalBuyQty = buyOrders.reduce(
              (s, o) => s + (o.quantity - o.filled),
              0
            );
            const totalSellQty = sellOrders.reduce(
              (s, o) => s + (o.quantity - o.filled),
              0
            );

            return (
              <div
                key={level.tick}
                className={cn(
                  // ⬇️ IMPORTANT : on ne met PLUS de fond jaune sur toute la row
                  "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                  "hover:bg-ladder-row-hover transition-colors"
                )}
              >
                {/* Size */}
                <div className="flex items-center justify-center border-r border-border/50">
                  {formatSize(level.sizeWindow)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price <= currentPrice &&
                      level.bidSize > 0 &&
                      "bg-ladder-bid text-trading-buy",
                    level.price <= currentPrice && "hover:bg-trading-buy/10",
                    totalBuyQty > 0 && "ring-2 ring-trading-buy/50"
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

                {/* Price — seul endroit avec les highlights */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price"
                  )}
                >
                  <span
                    className={cn(
                      "px-1 rounded-sm",
                      // ⬇️ Dernier prix : petit fond jaune MAIS UNIQUEMENT dans la cellule Price
                      isLastPrice && "bg-ladder-last/20",
                      // ⬇️ Prix moyen en position : encadré jaune (outline) UNIQUEMENT dans la cellule Price
                      isAvgPositionPrice &&
                        "outline outline-2 outline-[hsl(var(--trading-average))]"
                    )}
                  >
                    {formatPrice(level.price)}
                  </span>
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price >= currentPrice &&
                      level.askSize > 0 &&
                      "bg-ladder-ask text-trading-sell",
                    level.price >= currentPrice && "hover:bg-trading-sell/10",
                    totalSellQty > 0 && "ring-2 ring-trading-sell/50"
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

                {/* Volume */}
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