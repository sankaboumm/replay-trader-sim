import { memo, useMemo, useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { TickLadder as TickLadderType } from '@/lib/orderbook';

type Side = 'BUY' | 'SELL';

interface Order {
  id: string;
  side: Side;
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
  onLimitOrder: (side: Side, price: number, quantity: number) => void;
  onMarketOrder: (side: Side, quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position; // pour entourer le prix moyen
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
  if (!tickLadder || !tickLadder.levels || tickLadder.levels.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  // === Ticks & centre ===
  const tickSize = tickLadder.tickSize ?? 0.25;

  // “mid” vivant issu du prix courant ; fallback sur midTick reçu si besoin
  const liveMidTick =
    Number.isFinite(currentPrice) && currentPrice > 0
      ? Math.round(currentPrice / tickSize)
      : (tickLadder.midTick ?? 0);

  // On sépare : 
  // - baseCenterTick : point d’ancrage du centre (ne suit PAS automatiquement le marché)
  // - offsetTicks    : décalage utilisateur via scroll/clavier
  const [baseCenterTick, setBaseCenterTick] = useState<number>(liveMidTick);
  const [offsetTicks, setOffsetTicks] = useState<number>(0);
  const [autoCenter, setAutoCenter] = useState<boolean>(true);

  // Quand autoCenter est actif, on suit le prix : baseCenterTick suit liveMidTick
  useEffect(() => {
    if (autoCenter) {
      setBaseCenterTick(liveMidTick);
      setOffsetTicks(0);
    }
  }, [liveMidTick, autoCenter]);

  // Centre effectif affiché
  const centerTick = baseCenterTick + offsetTicks;

  // === Index price -> sizes/volume ===
  const levelMap = useMemo(() => {
    const m = new Map<number, { bidSize: number; askSize: number; vol: number }>();
    for (const lv of tickLadder.levels) {
      m.set(lv.price, {
        bidSize: lv.bidSize ?? 0,
        askSize: lv.askSize ?? 0,
        vol: (lv as any).volumeCumulative ?? (lv as any).volume ?? 0,
      });
    }
    return m;
  }, [tickLadder.levels]);

  // === Fenêtre d’affichage “scroll infini” ===
  const ROW_COUNT = 120;
  const HALF = Math.floor(ROW_COUNT / 2);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dir = Math.sign(e.deltaY); // +1 vers le bas
    setAutoCenter(false);            // sortir du mode auto
    setOffsetTicks((o) => o + dir * step);
  }, []);

  // Flèches ↑/↓ pour bouger 1 tick ; barre d’espace pour recentrer
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp') {
      setAutoCenter(false);
      setOffsetTicks((o) => o - 1);
    } else if (e.key === 'ArrowDown') {
      setAutoCenter(false);
      setOffsetTicks((o) => o + 1);
    } else if (e.key === ' ') {
      // RECENTRAGE EXPLICITE SUR PRIX ACTUEL
      e.preventDefault();
      setAutoCenter(true);
      setBaseCenterTick(liveMidTick);
      setOffsetTicks(0);
    }
  }, [liveMidTick]);

  // Reconstruire les lignes du plus haut au plus bas
  const displayedRows = useMemo(() => {
    const startTick = centerTick + HALF; // top = plus haut
    const rows: Array<{
      price: number;
      bidSize: number;
      askSize: number;
      vol: number;
      isLastPrice: boolean;
      isAvgPrice: boolean;
    }> = [];

    for (let i = 0; i < ROW_COUNT; i++) {
      const tick = startTick - i; // on descend
      const price = tick * tickSize;
      const lv = levelMap.get(price) ?? { bidSize: 0, askSize: 0, vol: 0 };
      const isLastPrice = Math.abs(price - currentPrice) < tickSize / 2;
      const isAvgPrice =
        position.quantity !== 0 &&
        Math.abs(price - position.averagePrice) < tickSize / 2;

      rows.push({
        price,
        bidSize: lv.bidSize,
        askSize: lv.askSize,
        vol: lv.vol,
        isLastPrice,
        isAvgPrice,
      });
    }
    return rows;
  }, [HALF, ROW_COUNT, centerTick, currentPrice, levelMap, position.averagePrice, position.quantity, tickSize]);

  // === interactions cellules ===
  const getOrdersAtPrice = useCallback(
    (price: number, side: Side) =>
      orders.filter(
        (o) =>
          o.side === side &&
          Math.abs(o.price - price) < tickSize / 2 &&
          o.quantity > o.filled
      ),
    [orders, tickSize]
  );

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;
    const isAboveCurrentPrice = price > currentPrice;
    const isBelowCurrentPrice = price < currentPrice;
    const isAtCurrentPrice = Math.abs(price - currentPrice) < tickSize / 2;
    if (column === 'bid') {
      if (isAboveCurrentPrice || isAtCurrentPrice) onMarketOrder('BUY', 1);
      else onLimitOrder('BUY', price, 1);
    } else {
      if (isBelowCurrentPrice || isAtCurrentPrice) onMarketOrder('SELL', 1);
      else onLimitOrder('SELL', price, 1);
    }
  };
  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  // === Layout : colonnes fixes + Price sticky ===
  const COL_SIZE = 64;
  const COL_BIDS = 96;
  const COL_PRICE = 88;
  const COL_ASKS = 96;
  const COL_VOL = 64;
  const PRICE_LEFT = COL_SIZE + COL_BIDS;
  const gridTemplate = `${COL_SIZE}px ${COL_BIDS}px ${COL_PRICE}px ${COL_ASKS}px ${COL_VOL}px`;

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div
          className="grid text-xs font-semibold text-muted-foreground"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>

          <div
            className="p-2 text-center border-r border-border bg-ladder-price ladder-price-shadow z-20"
            style={{ position: 'sticky', left: PRICE_LEFT }}
          >
            Price
          </div>

          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Ladder (focusable pour capter espace/↑/↓) */}
      <div
        className="flex-1 overflow-hidden trading-scroll"
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        tabIndex={0}
        title={"Molette ±1 tick (Shift=±10) • Espace = recentrer"}
      >
        <div className="h-full overflow-hidden" style={{ willChange: 'transform' }}>
          {displayedRows.map((row) => {
            const buyOrders = getOrdersAtPrice(row.price, 'BUY');
            const sellOrders = getOrdersAtPrice(row.price, 'SELL');
            const totalBuyQuantity = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const totalSellQuantity = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const atOrBelow = row.price <= currentPrice;
            const atOrAbove = row.price >= currentPrice;

            return (
              <div
                key={row.price}
                className={cn("grid text-xs border-b border-border/50 h-6 hover:bg-ladder-row-hover transition-colors")}
                style={{ gridTemplateColumns: gridTemplate }}
              >
                {/* Size (libre pour delta court terme si besoin) */}
                <div className="flex items-center justify-center border-r border-border/50" />

                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    atOrBelow && row.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                    atOrBelow && "hover:bg-trading-buy/10",
                    totalBuyQuantity > 0 && "ring-2 ring-trading-buy/50"
                  )}
                  onClick={() =>
                    totalBuyQuantity > 0
                      ? handleOrderClick(row.price)
                      : handleCellClick(row.price, 'bid')
                  }
                >
                  {atOrBelow && (
                    <>
                      <span>{formatSize(row.bidSize)}</span>
                      {totalBuyQuantity > 0 && (
                        <span className="ml-1 text-[10px]">({totalBuyQuantity})</span>
                      )}
                    </>
                  )}
                </div>

                {/* Price sticky */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price ladder-price-shadow",
                    row.isLastPrice && "text-trading-average font-bold",
                    position.quantity !== 0 && row.isAvgPrice && "ring-2 ring-yellow-400"
                  )}
                  style={{ position: 'sticky', left: PRICE_LEFT, zIndex: 10 }}
                >
                  {formatPrice(row.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    atOrAbove && row.askSize > 0 && "bg-ladder-ask text-trading-sell",
                    atOrAbove && "hover:bg-trading-sell/10",
                    totalSellQuantity > 0 && "ring-2 ring-trading-sell/50"
                  )}
                  onClick={() =>
                    totalSellQuantity > 0
                      ? handleOrderClick(row.price)
                      : handleCellClick(row.price, 'ask')
                  }
                >
                  {atOrAbove && (
                    <>
                      <span>{formatSize(row.askSize)}</span>
                      {totalSellQuantity > 0 && (
                        <span className="ml-1 text-[10px]">({totalSellQuantity})</span>
                      )}
                    </>
                  )}
                </div>

                {/* Volume cumulé */}
                <div className="flex items-center justify-center text-muted-foreground">
                  {formatSize(row.vol)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Barre d’aide */}
      <div className="h-6 text-[11px] text-muted-foreground px-2 flex items-center justify-between border-t border-border">
        <span>Molette: ±1 tick • Shift+Molette: ±10 • ↑/↓: ±1 • <b>Espace</b>: recentrer</span>
        <span>Centre: {formatPrice(centerTick * tickSize)}</span>
      </div>
    </div>
  );
});