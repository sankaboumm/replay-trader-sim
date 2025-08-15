import { memo, useMemo, useRef, useState, useEffect, useCallback } from 'react';
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
  position: Position; // 🔶 requis pour entourer le prix moyen en jaune
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
  // ---- Sécurité : si pas de données
  if (!tickLadder || !tickLadder.levels || tickLadder.levels.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? 'Snapshots DOM manquants' : 'Chargement des données orderbook...'}
        </div>
      </div>
    );
  }

  // ==== 1) Préparation données ====
  const tickSize = tickLadder.tickSize ?? 0.25;
  const midTick = tickLadder.midTick ?? Math.round(currentPrice / tickSize);

  // Crée un index rapide price -> {bidSize, askSize, volumeCumulative}
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

  // === 2) “Scroll infini” logique (sans dépendances) ===
  // On ne scrolle pas la div : on déplace une “fenêtre” d’affichage de ticks autour du centre.
  // Molette = décalage de +/- 1 tick (Shift = +/-10)
  const [offsetTicks, setOffsetTicks] = useState(0);
  // Nombre de lignes affichées (garde large pour donner la sensation d’infini)
  const ROW_COUNT = 120; // 120 lignes visibles
  const HALF = Math.floor(ROW_COUNT / 2);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dir = Math.sign(e.deltaY); // +1 si on scrolle vers le bas
    // Vers le bas => prix doit DIMINUER dans l’affichage => on ajoute des ticks NEGATIFS côté top
    setOffsetTicks((o) => o + dir * step);
  }, []);

  // Recentrer la “fenêtre” dès que le prix bouge beaucoup (évite de “perdre” le centre)
  useEffect(() => {
    setOffsetTicks(0);
  }, [midTick]);

  // Génère les lignes : du plus HAUT au plus BAS (descendant),
  // et “Price” au MILIEU de la grille.
  const displayedRows = useMemo(() => {
    // On veut la ligne centrale alignée avec le “midTick + offset”
    const centerTick = midTick + offsetTicks;
    // Start (haut) plus grand, puis on descend
    const startTick = centerTick + HALF;
    const rows: Array<{
      price: number;
      bidSize: number;
      askSize: number;
      vol: number;
      isLastPrice: boolean;
      isAvgPrice: boolean;
    }> = [];

    for (let i = 0; i < ROW_COUNT; i++) {
      const tick = startTick - i; // descend
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
  }, [HALF, ROW_COUNT, currentPrice, levelMap, midTick, offsetTicks, position.averagePrice, position.quantity, tickSize]);

  // ---- commandes utilisateur : clics pour ordres ----
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

  // ==== 3) Gabarit : colonnes à largeur FIXE + Price STICKY ====
  // Taille colonnes (px) — IMPORTANT : on a besoin de ces valeurs fixes pour coller la colonne Price.
  const COL_SIZE = 64;   // "Size"
  const COL_BIDS = 96;   // "Bids"
  const COL_PRICE = 88;  // "Price" (colonne qui sera sticky)
  const COL_ASKS = 96;   // "Asks"
  const COL_VOL = 64;    // "Volume"
  const PRICE_LEFT = COL_SIZE + COL_BIDS; // offset à gauche (px) pour coller la colonne Price

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

          {/* Price sticky aussi dans le header */}
          <div
            className="p-2 text-center border-r border-border bg-ladder-price z-20"
            style={{ position: 'sticky', left: PRICE_LEFT }}
          >
            Price
          </div>

          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Ladder Rows (sans scroll natif : onWheel pour “infini”) */}
      <div
        className="flex-1 overflow-hidden trading-scroll"
        onWheel={onWheel}
        // astuce clavier: ↑/↓ pour bouger par tick
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setOffsetTicks((o) => o - 1);
          if (e.key === 'ArrowDown') setOffsetTicks((o) => o + 1);
        }}
        tabIndex={0} // pour capter le clavier
      >
        <div
          className="h-full overflow-hidden"
          style={{ willChange: 'transform' }}
        >
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
                className={cn(
                  "grid text-xs border-b border-border/50 h-6 hover:bg-ladder-row-hover transition-colors",
                )}
                style={{ gridTemplateColumns: gridTemplate }}
              >
                {/* Size (fenêtre d’activité) — ici j’affiche juste vol instantané côté ligne si tu le calcules */}
                <div className="flex items-center justify-center border-r border-border/50">
                  {/* Optionnel: mettre un delta court terme si tu l’as */}
                </div>

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

                {/* Price — STICKY */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                    row.isLastPrice && "text-trading-average font-bold",
                    position.quantity !== 0 && row.isAvgPrice && "ring-2 ring-yellow-400" // 🔶 entoure le prix moyen
                  )}
                  style={{
                    position: 'sticky',
                    left: PRICE_LEFT,
                    zIndex: 10,
                  }}
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

                {/* Volume cumulé (total des lots négociés à ce prix) */}
                <div className="flex items-center justify-center text-muted-foreground">
                  {formatSize(row.vol)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Barre d’aide pour le scroll infini */}
      <div className="h-6 text-[11px] text-muted-foreground px-2 flex items-center justify-between border-t border-border">
        <span>Molette : ±1 tick • Shift+Molette : ±10 ticks • ↑/↓ : ±1 tick</span>
        <span>Centre: {formatPrice((midTick + offsetTicks) * tickSize)}</span>
      </div>
    </div>
  );
});