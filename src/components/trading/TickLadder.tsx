import { memo, useMemo, useRef, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';

/** Surligner en jaune les cellules >= 20 lots */
const HIGHLIGHT_SIZE = 20;

/** Fenêtrage (scroll infini) – incréments de 200 lignes */
const WINDOW_ROWS_INITIAL = 200;
const WINDOW_ROWS_STEP = 200;

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
  position: Position;

  /** ✅ AJOUT : volume cumulé depuis le début de la lecture pour un prix donné */
  getVolumeForPrice?: (price: number) => number;
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}
function formatSize(size?: number): string {
  const n = Number(size ?? 0);
  return n > 0 ? String(n) : '';
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
  /** ✅ AJOUT */
  getVolumeForPrice,
}: TickLadderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelTopRef = useRef<HTMLDivElement | null>(null);
  const sentinelBottomRef = useRef<HTMLDivElement | null>(null);

  // Fenêtrage (scroll infini)
  const [windowStartIndex, setWindowStartIndex] = useState(0);
  const [windowCount, setWindowCount] = useState(WINDOW_ROWS_INITIAL);

  // Recentrage manuel (barre espace) — on garde le comportement existant
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (!containerRef.current) return;
        // centre approximativement la vue (colonne Price est fixe)
        containerRef.current.scrollTo({
          top: Math.max(0, containerRef.current.scrollHeight / 2 - 200),
          behavior: 'auto'
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Observer haut/bas pour charger +200 lignes (FIFO)
  useEffect(() => {
    if (!containerRef.current) return;

    const loadMoreTop = () => {
      const nextStart = Math.max(0, windowStartIndex - WINDOW_ROWS_STEP);
      if (nextStart !== windowStartIndex) setWindowStartIndex(nextStart);
      else setWindowCount(prev => prev + WINDOW_ROWS_STEP);
    };
    const loadMoreBottom = () => {
      setWindowCount(prev => prev + WINDOW_ROWS_STEP);
    };

    const topObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) loadMoreTop(); });
    }, { root: containerRef.current, threshold: 0.01 });

    const bottomObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) loadMoreBottom(); });
    }, { root: containerRef.current, threshold: 0.01 });

    if (sentinelTopRef.current) topObserver.observe(sentinelTopRef.current);
    if (sentinelBottomRef.current) bottomObserver.observe(sentinelBottomRef.current);

    return () => {
      topObserver.disconnect();
      bottomObserver.disconnect();
    };
  }, [windowStartIndex]);

  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o =>
      o.side === side &&
      Math.abs(o.price - price) < 0.125 &&
      o.quantity > o.filled
    );

  // Surlignage du prix moyen lorsqu’on a une position
  const isAvgPriceAtLevel = useMemo(() => {
    if (!position || !position.averagePrice) return () => false;
    const avg = Math.round(position.averagePrice * 4) / 4; // grid 0.25
    return (p: number) => Math.abs(p - avg) < 0.125 && position.quantity !== 0;
  }, [position]);

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < 0.125;

    if (column === 'bid') {
      // Clic au-dessus du last dans Bids => MARKET BUY (inchangé)
      if (isAbove || isAt) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      // Clic en-dessous du last dans Asks => MARKET SELL (inchangé)
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

  const levels = tickLadder.levels;
  const sliceStart = Math.max(0, windowStartIndex);
  const sliceEnd = Math.min(levels.length, sliceStart + windowCount);
  const visible = levels.slice(sliceStart, sliceEnd);

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header – 4 colonnes: Bids | Price | Asks | Volume */}
      <div className="bg-ladder-header border-b border-border">
        <div className="grid [grid-template-columns:1fr_88px_1fr_72px] text-xs font-semibold text-muted-foreground">
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Ladder Rows */}
      <div ref={containerRef} className="flex-1 overflow-y-auto trading-scroll">
        {/* Sentinelle haut */}
        <div ref={sentinelTopRef} className="h-1" />

        {visible.map((level) => {
          const bidQty = level.bidSize ?? 0;
          const askQty = level.askSize ?? 0;
          const hasBid = level.price <= currentPrice && bidQty > 0;
          const hasAsk = level.price >= currentPrice && askQty > 0;
          const buyOrders = getOrdersAtPrice(level.price, 'BUY');
          const sellOrders = getOrdersAtPrice(level.price, 'SELL');
          const totalBuyQty = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSellQty = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const lastTick = Math.abs(level.price - currentPrice) < 0.125;
          const avgHere = isAvgPriceAtLevel(level.price);

          /** ✅ AJOUT : volume cumulé (priorité au hook, fallback volumeCumulative/0) */
          const cumulativeVolume =
            (typeof getVolumeForPrice === 'function'
              ? getVolumeForPrice(level.price)
              : undefined) ??
            (level as any).volumeCumulative ??
            0;

          return (
            <div
              key={level.tick}
              className="grid [grid-template-columns:1fr_88px_1fr_72px] text-xs border-b border-border/50 h-6"
            >
              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  hasBid && "bg-ladder-bid text-trading-buy",
                  hasBid && bidQty >= HIGHLIGHT_SIZE && "bg-[hsl(var(--trading-average)/0.35)]",
                  totalBuyQty > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() => totalBuyQty > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
                title={hasBid ? `Bids @ ${formatPrice(level.price)} : ${bidQty}` : ''}
              >
                {hasBid && (
                  <>
                    <span>{formatSize(bidQty)}</span>
                    {totalBuyQty > 0 && <span className="ml-1 text-[10px]">({totalBuyQty})</span>}
                  </>
                )}
              </div>

              {/* Price (fixe) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  lastTick && "text-trading-average font-bold",
                  avgHere && "ring-2 ring-trading-average/80 ring-offset-1 ring-offset-background rounded-sm"
                )}
                title={avgHere ? `Average price: ${formatPrice(position.averagePrice)}` : ''}
              >
                {formatPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  hasAsk && "bg-ladder-ask text-trading-sell",
                  hasAsk && askQty >= HIGHLIGHT_SIZE && "bg-[hsl(var(--trading-average)/0.35)]",
                  totalSellQty > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() => totalSellQty > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
                title={hasAsk ? `Asks @ ${formatPrice(level.price)} : ${askQty}` : ''}
              >
                {hasAsk && (
                  <>
                    <span>{formatSize(askQty)}</span>
                    {totalSellQty > 0 && <span className="ml-1 text-[10px]">({totalSellQty})</span>}
                  </>
                )}
              </div>

              {/* Volume cumulé (depuis début du fichier) */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(cumulativeVolume)}
              </div>
            </div>
          );
        })}

        {/* Sentinelle bas */}
        <div ref={sentinelBottomRef} className="h-1" />
      </div>
    </div>
  );
});