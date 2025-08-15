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

interface TickLadderProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;

  // >>> NOUVEAU
  lastTradeSizeByPrice: Map<number, number>;
  volumeByPrice: Map<number, number>;
  position?: { quantity: number; averagePrice: number };
}

const grid = (p: number) => Math.round(p * 4) / 4;
const fmtPrice = (p: number) => p.toFixed(2).replace('.', ',');
const fmtSize  = (n?: number) => (n && n > 0 ? String(n) : '');

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,

  // >>> NOUVEAU
  lastTradeSizeByPrice,
  volumeByPrice,
  position,
}: TickLadderProps) {

  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);

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

      {/* Rows */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {tickLadder.levels.slice().reverse().map((level) => {
          const priceKey = grid(level.price);

          // >>> NOUVEAU : Size = dernier trade à ce prix (vrai TRADE seulement)
          const lastSize = lastTradeSizeByPrice.get(priceKey) ?? 0;

          // >>> NOUVEAU : Volume cumulé = somme des trades à ce prix depuis le début
          const cumVolume = volumeByPrice.get(priceKey) ?? 0;

          const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
          const isAvgPrice = position && position.quantity !== 0 && Math.abs(level.price - position.averagePrice) < 0.125;

          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQty  = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          return (
            <div
              key={level.tick}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (dernier trade) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {fmtSize(lastSize)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  totalBuyQty > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() => totalBuyQty > 0 ? onCancelOrders(level.price) : onLimitOrder('BUY', level.price, 1)}
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{fmtSize(level.bidSize)}</span>
                    {totalBuyQty > 0 && <span className="ml-1 text-[10px] opacity-80">({totalBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price (cellule SEULE en jaune si prix moyen) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLastPrice && "text-trading-average font-bold",
                  isAvgPrice && "outline outline-2 outline-[hsl(var(--trading-average))] outline-offset-[-2px]"
                )}
              >
                {fmtPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  totalSellQty > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() => totalSellQty > 0 ? onCancelOrders(level.price) : onLimitOrder('SELL', level.price, 1)}
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{fmtSize(level.askSize)}</span>
                    {totalSellQty > 0 && <span className="ml-1 text-[10px] opacity-80">({totalSellQty})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé */}
              <div className="flex items-center justify-center text-muted-foreground">
                {fmtSize(cumVolume)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});