import { memo, useMemo, MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';
import type { Position } from '@/hooks/useTradingEngine';

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
  position: Position; // pour highlight du prix moyen
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size: number | undefined): string {
  return size && size > 0 ? String(size) : '';
}

const TICK = 0.25;
const near = (a: number, b: number) => Math.abs(a - b) < TICK / 2;
const roundTick = (p: number) => Math.round(p / TICK) * TICK;

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

  // ordres restants à un niveau
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o =>
      o.side === side &&
      near(o.price, price) &&
      (o.quantity - o.filled) > 0
    );

  // dernier trade “fenêtre” (sizeWindow) → déjà fourni par TickLevel
  // volumeCumulative → cumulé par prix (fourni par processor)

  // Calcul du prix moyen de position arrondi au tick
  const avgPriceRounded = useMemo(() => {
    if (!position || position.quantity === 0) return undefined;
    return roundTick(position.averagePrice);
  }, [position]);

  // CLICK LOGIC :
  // - Simple clic BID  => MARKET SELL (sauf s'il y a des ordres BUY en attente → clic = cancel)
  // - Simple clic ASK  => MARKET BUY  (sauf s'il y a des ordres SELL en attente → clic = cancel)
  // - Alt+clic sur BID => LIMIT BUY  au niveau cliqué
  // - Alt+clic sur ASK => LIMIT SELL au niveau cliqué
  const handleBidClick = (e: MouseEvent, price: number) => {
    if (disabled) return;
    const buyOrders = getOrdersAtPrice(price, 'BUY');
    if (e.altKey) {
      onLimitOrder('BUY', price, 1);
    } else {
      if (buyOrders.length > 0) onCancelOrders(price);
      else onMarketOrder('SELL', 1);
    }
  };

  const handleAskClick = (e: MouseEvent, price: number) => {
    if (disabled) return;
    const sellOrders = getOrdersAtPrice(price, 'SELL');
    if (e.altKey) {
      onLimitOrder('SELL', price, 1);
    } else {
      if (sellOrders.length > 0) onCancelOrders(price);
      else onMarketOrder('BUY', 1);
    }
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
        {tickLadder.levels.slice().reverse().map((level) => {
          const isLast = near(level.price, currentPrice);
          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const pendingBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const pendingSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          // highlight uniquement dans la cellule “Price”
          const isAvg = avgPriceRounded !== undefined && near(level.price, avgPriceRounded);

          return (
            <div
              key={level.tick}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size (dernier trade sur ce prix) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {formatSize(level.sizeWindow)}
              </div>

              {/* Bids (zone <= last) */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price <= currentPrice && level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price <= currentPrice && "hover:bg-trading-buy/10",
                  pendingBuyQty > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={(e) => handleBidClick(e, level.price)}
                title="Clic: SELL Market • Alt+clic: LIMIT BUY • Clic sur bague: Cancel"
              >
                {level.price <= currentPrice && (
                  <>
                    <span>{formatSize(level.bidSize)}</span>
                    {pendingBuyQty > 0 && <span className="ml-1 text-xs">({pendingBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price (cellule fixe, highlight uniquement ici) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLast && "text-trading-average font-bold",
                  isAvg && "ring-2 ring-trading-average rounded-sm"
                )}
                title={isAvg ? "Votre prix moyen" : undefined}
              >
                {formatPrice(level.price)}
              </div>

              {/* Asks (zone >= last) */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.price >= currentPrice && level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price >= currentPrice && "hover:bg-trading-sell/10",
                  pendingSellQty > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={(e) => handleAskClick(e, level.price)}
                title="Clic: BUY Market • Alt+clic: LIMIT SELL • Clic sur bague: Cancel"
              >
                {level.price >= currentPrice && (
                  <>
                    <span>{formatSize(level.askSize)}</span>
                    {pendingSellQty > 0 && <span className="ml-1 text-xs">({pendingSellQty})</span>}
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