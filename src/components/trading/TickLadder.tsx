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

const TICK_SIZE = 0.25;          // NQ
const TICKS_AROUND = 400;        // ± 400 ticks → ~200 points de scroll
const BIG_SIZE_THRESHOLD = 20;   // surbrillance jaune si taille ≥ 20
const EPS = 0.125;               // tolérance de matching de prix (1/2 tick)

// Helpers
function roundToGrid(p: number) {
  return Math.round(p / TICK_SIZE) * TICK_SIZE;
}
function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}
function formatSize(size: number | undefined): string {
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
  position
}: TickLadderProps) {
  // 1) Construire une MAP prix → { bidSize, askSize, volumeCumulative, sizeWindow }
  const priceMap = useMemo(() => {
    const m = new Map<number, {
      price: number;
      bidSize: number;
      askSize: number;
      volumeCumulative?: number;
      sizeWindow?: number;
    }>();

    if (tickLadder?.levels?.length) {
      for (const lvl of tickLadder.levels) {
        const p = roundToGrid(lvl.price);
        const prev = m.get(p);
        if (prev) {
          // merge au cas où (sécurité)
          m.set(p, {
            price: p,
            bidSize: Math.max(prev.bidSize, lvl.bidSize || 0),
            askSize: Math.max(prev.askSize, lvl.askSize || 0),
            volumeCumulative: (lvl.volumeCumulative ?? prev.volumeCumulative),
            sizeWindow: (lvl.sizeWindow ?? prev.sizeWindow)
          });
        } else {
          m.set(p, {
            price: p,
            bidSize: lvl.bidSize || 0,
            askSize: lvl.askSize || 0,
            volumeCumulative: lvl.volumeCumulative,
            sizeWindow: lvl.sizeWindow
          });
        }
      }
    }
    return m;
  }, [tickLadder]);

  // 2) Construire une grille CONTIGUË de prix autour du last : du plus HAUT (top) vers le plus BAS (bottom)
  const rows = useMemo(() => {
    const center = roundToGrid(currentPrice || 0);
    const top = center + TICK_SIZE * TICKS_AROUND;
    const bottom = center - TICK_SIZE * TICKS_AROUND;
    const arr: Array<{
      price: number;
      bidSize: number;
      askSize: number;
      volumeCumulative?: number;
      sizeWindow?: number;
    }> = [];

    // Descendant : top → bottom
    for (let p = top; p >= bottom - 1e-9; p -= TICK_SIZE) {
      const key = roundToGrid(p);
      const v = priceMap.get(key);
      if (v) {
        arr.push({
          price: key,
          bidSize: v.bidSize || 0,
          askSize: v.askSize || 0,
          volumeCumulative: v.volumeCumulative,
          sizeWindow: v.sizeWindow
        });
      } else {
        // ligne “vide” mais présente dans la grille → jamais de “trou” entre best bid/ask et le Last
        arr.push({
          price: key,
          bidSize: 0,
          askSize: 0,
          volumeCumulative: 0,
          sizeWindow: 0
        });
      }
    }
    return arr;
  }, [priceMap, currentPrice]);

  // 3) Outils UI
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < EPS && o.quantity > o.filled);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < EPS;

    if (column === 'bid') {
      // au-dessus (ou égal) du last dans Bids = MARKET BUY @ bestAsk
      if (isAbove || isAt) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      // au-dessous (ou égal) du last dans Asks = MARKET SELL @ bestBid
      if (isBelow || isAt) onMarketOrder('SELL', 1);
      else onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!tickLadder || rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  // 4) Rendu
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

      {/* Ladder Rows (grand scroll sans recentrage auto) */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {rows.map((level) => {
          const isLastPrice = Math.abs(level.price - currentPrice) < EPS;

          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuy = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSell = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          const bigBid = level.bidSize >= BIG_SIZE_THRESHOLD;
          const bigAsk = level.askSize >= BIG_SIZE_THRESHOLD;
          const isAvgPos =
            position && position.quantity !== 0 && Math.abs(level.price - position.averagePrice) < EPS;

          return (
            <div
              key={`px-${level.price}`} // clé stable = prix
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6",
                "hover:bg-ladder-row-hover transition-none"
              )}
            >
              {/* Size (fenêtre de trades si dispo) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {formatSize(level.sizeWindow)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.bidSize > 0 && "bg-ladder-bid",
                  bigBid && "bg-[hsl(var(--trading-average)/0.35)]"
                )}
                onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
              >
                <>
                  <span>{formatSize(level.bidSize)}</span>
                  {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                </>
              </div>

              {/* Price (fixe, avec highlight du last et encadrement du prix moyen) */}
              <div className="flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price">
                <span
                  className={cn(
                    isLastPrice && "text-trading-average font-bold",
                    isAvgPos && "outline outline-2 outline-[hsl(var(--trading-average))] rounded-sm px-1"
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
                  bigAsk && "bg-[hsl(var(--trading-average)/0.35)]"
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
                {formatSize(level.volumeCumulative)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});