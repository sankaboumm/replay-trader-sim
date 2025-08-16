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
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position?: Position; // optionnel
}

const BIG_SIZE_THRESHOLD = 20;
const EPS = 0.125;

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
  position
}: TickLadderProps) {
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < EPS && o.quantity > o.filled);

  const averagePrices = useMemo(() => {
    const filledBuy = orders.filter(o => o.side === 'BUY' && o.filled > 0);
    const filledSell = orders.filter(o => o.side === 'SELL' && o.filled > 0);
    const avgBuy = filledBuy.length
      ? filledBuy.reduce((s, o) => s + o.price * o.filled, 0) / filledBuy.reduce((s, o) => s + o.filled, 0)
      : null;
    const avgSell = filledSell.length
      ? filledSell.reduce((s, o) => s + o.price * o.filled, 0) / filledSell.reduce((s, o) => s + o.filled, 0)
      : null;
    return { avgBuyPrice: avgBuy, avgSellPrice: avgSell };
  }, [orders]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < EPS;

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
        {/* IMPORTANT : clé stable = prix (et pas un id éphémère) */}
        {tickLadder.levels.map((level) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < EPS;
          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuy = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSell = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          // Surbrillance “grosse taille”
          const bigBid = level.bidSize >= BIG_SIZE_THRESHOLD;
          const bigAsk = level.askSize >= BIG_SIZE_THRESHOLD;

          // Moyenne de position (si fournie)
          const isAvgPosition =
            position && position.quantity !== 0 && Math.abs(level.price - position.averagePrice) < EPS;

          return (
            <div
              key={`p-${level.price}`}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-none"
              )}
            >
              {/* Size (fenêtre de trades si tu l'utilises dans ton ladder) */}
              <div className={cn(
                "flex items-center justify-center border-r border-border/50"
              )}>
                {formatSize(level.sizeWindow ?? 0)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.bidSize > 0 && "bg-ladder-bid",
                  bigBid && "bg-[hsl(var(--trading-average)/0.35)]",
                )}
                onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
              >
                <>
                  <span>{formatSize(level.bidSize)}</span>
                  {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                </>
              </div>

              {/* Price (colonne fixe) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                )}
              >
                <span
                  className={cn(
                    isLastPrice && "text-trading-average font-bold",
                    isAvgPosition && "outline outline-2 outline-[hsl(var(--trading-average))] rounded-sm px-1"
                  )}
                >
                  {formatPrice(level.price)}
                </span>
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.askSize > 0 && "bg-ladder-ask",
                  bigAsk && "bg-[hsl(var(--trading-average)/0.35)]",
                )}
                onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
              >
                <>
                  <span>{formatSize(level.askSize)}</span>
                  {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                </>
              </div>

              {/* Volume cumulé par prix (si calculé côté engine) */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(level.volumeCumulative ?? 0)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});