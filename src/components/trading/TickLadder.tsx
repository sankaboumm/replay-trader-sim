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
  position: Position;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}

function formatSize(size?: number): string {
  return size && size > 0 ? String(size) : '';
}

const TICK = 0.25;
const roundTick = (p: number) => Math.round(p / TICK) * TICK;
const near = (a: number, b: number) => Math.abs(a - b) < TICK / 2;

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
  // 1) Dédup niveaux par prix (évite le triple)
  const levels = useMemo(() => {
    if (!tickLadder?.levels?.length) return [];
    const seen = new Set<number>();
    const out: typeof tickLadder.levels = [];
    // Affichage du haut vers le bas (prix décroissants)
    for (const lvl of tickLadder.levels.slice().reverse()) {
      const k = roundTick(lvl.price);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(lvl);
      }
    }
    return out;
  }, [tickLadder]);

  // 2) Ordres restants à un niveau
  const pendingQtyAt = (price: number, side: 'BUY' | 'SELL') =>
    orders
      .filter(o => o.side === side && near(o.price, price) && (o.quantity - o.filled) > 0)
      .reduce((s, o) => s + (o.quantity - o.filled), 0);

  // 3) Prix moyen arrondi (surligné uniquement dans la cellule Price)
  const avgPriceRounded = useMemo(() => {
    if (!position || position.quantity === 0) return undefined;
    return roundTick(position.averagePrice);
  }, [position]);

  // 4) Clics :
  //   BID col : au-dessus du last => MARKET BUY, en-dessous/égal => LIMIT BUY, toggle cancel si ordre présent
  //   ASK col : en-dessous du last => MARKET SELL, au-dessus/égal => LIMIT SELL, toggle cancel si ordre présent
  const handleBidClick = (e: MouseEvent, price: number) => {
    if (disabled) return;
    const pending = pendingQtyAt(price, 'BUY');
    if (pending > 0) {
      onCancelOrders(price);
      return;
    }
    if (price > currentPrice) {
      // Market LONG (au-dessus du last sur Bids)
      onMarketOrder('BUY', 1);
    } else {
      // Limit BUY au niveau (<= last)
      onLimitOrder('BUY', price, 1);
    }
  };

  const handleAskClick = (e: MouseEvent, price: number) => {
    if (disabled) return;
    const pending = pendingQtyAt(price, 'SELL');
    if (pending > 0) {
      onCancelOrders(price);
      return;
    }
    if (price < currentPrice) {
      // Market SHORT (en-dessous du last sur Asks)
      onMarketOrder('SELL', 1);
    } else {
      // Limit SELL au niveau (>= last)
      onLimitOrder('SELL', price, 1);
    }
  };

  if (!levels.length) {
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
        {levels.map((lvl) => {
          const price = roundTick(lvl.price);
          const isLast = near(price, currentPrice);
          const isAvg = avgPriceRounded !== undefined && near(price, avgPriceRounded);

          const pendingBuy = pendingQtyAt(price, 'BUY');
          const pendingSell = pendingQtyAt(price, 'SELL');

          return (
            <div
              key={lvl.tick}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-colors"
              )}
            >
              {/* Size = dernier trade sur ce prix (fenêtre) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {formatSize(lvl.sizeWindow)}
              </div>

              {/* BIDS */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  price <= currentPrice && lvl.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  price <= currentPrice && "hover:bg-trading-buy/10",
                  pendingBuy > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={(e) => handleBidClick(e, price)}
                title={
                  pendingBuy > 0
                    ? "Annuler les ordres BUY à ce prix"
                    : (price > currentPrice ? "Market BUY" : "Limit BUY à ce prix")
                }
              >
                {price <= currentPrice && (
                  <>
                    <span>{formatSize(lvl.bidSize)}</span>
                    {pendingBuy > 0 && <span className="ml-1 text-xs">({pendingBuy})</span>}
                  </>
                )}
              </div>

              {/* PRICE (cellule fixe uniquement) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLast && "text-trading-average font-bold",
                  isAvg && "ring-2 ring-trading-average rounded-sm" // surlignage uniquement la cellule Price
                )}
                title={isAvg ? "Votre prix moyen" : undefined}
              >
                {formatPrice(price)}
              </div>

              {/* ASKS */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  price >= currentPrice && lvl.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  price >= currentPrice && "hover:bg-trading-sell/10",
                  pendingSell > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={(e) => handleAskClick(e, price)}
                title={
                  pendingSell > 0
                    ? "Annuler les ordres SELL à ce prix"
                    : (price < currentPrice ? "Market SELL" : "Limit SELL à ce prix")
                }
              >
                {price >= currentPrice && (
                  <>
                    <span>{formatSize(lvl.askSize)}</span>
                    {pendingSell > 0 && <span className="ml-1 text-xs">({pendingSell})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé par niveau */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(lvl.volumeCumulative)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});