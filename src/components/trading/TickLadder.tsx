// src/components/TickLadder.tsx
// Affichage ladder sans reverse(), colonne Price fixe, highlight du last uniquement sur la cellule Price

import { memo } from "react";
import { cn } from "@/lib/utils";
import { TickLadder as TickLadderType, TickLevel } from "@/lib/orderbook";

interface Order {
  id: string;
  side: "BUY" | "SELL";
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
  onLimitOrder: (side: "BUY" | "SELL", price: number, quantity: number) => void;
  onMarketOrder: (side: "BUY" | "SELL", quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position?: Position; // pour afficher le prix moyen encadré
}

const fmtPrice = (p: number) => p.toFixed(2).replace(".", ",");

const fmtSize = (n: number) => (n > 0 ? String(n) : "");

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
  const getOpenQty = (price: number, side: "BUY" | "SELL") =>
    orders
      .filter(
        (o) =>
          o.side === side &&
          Math.abs(o.price - price) < 0.125 &&
          o.quantity > o.filled
      )
      .reduce((s, o) => s + (o.quantity - o.filled), 0);

  const handleCellClick = (price: number, col: "bid" | "ask") => {
    if (disabled) return;
    // Règles (ex: un clic déclenche LIMIT par défaut)
    if (col === "bid") {
      // clic sur la colonne bid => BUY limit à ce prix
      onLimitOrder("BUY", price, 1);
    } else {
      // clic sur ask => SELL limit à ce prix
      onLimitOrder("SELL", price, 1);
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
          {disabled ? "Snapshots DOM manquants" : "Chargement des données…"}
        </div>
      </div>
    );
  }

  // clé stable par tick ; NE PAS reverse() ici : le ladder est déjà trié décroissant
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
        {tickLadder.levels.map((level: TickLevel) => {
          const openBuys = getOpenQty(level.price, "BUY");
          const openSells = getOpenQty(level.price, "SELL");
          const isLast = tickLadder.lastTick != null && level.tick === tickLadder.lastTick;

          const isAvg =
            position &&
            position.quantity !== 0 &&
            Math.abs(level.price - position.averagePrice) < 0.125;

          return (
            <div
              key={level.tick}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6 hover:bg-ladder-row-hover"
              )}
            >
              {/* Size window (si vous l’alimentez) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {fmtSize(level.sizeWindow ?? 0)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  openBuys > 0 && "ring-2 ring-trading-buy/50"
                )}
                onClick={() =>
                  openBuys > 0
                    ? handleOrderClick(level.price)
                    : handleCellClick(level.price, "bid")
                }
              >
                {fmtSize(level.bidSize)}
                {openBuys > 0 && <span className="ml-1 text-[10px]">({openBuys})</span>}
              </div>

              {/* Price (seule cellule pouvant avoir un highlight) */}
              <div
                className={cn(
                  "flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price",
                  isLast && "text-trading-average font-bold",
                  isAvg && "outline outline-2 outline-[hsl(var(--trading-average))] outline-offset-[-2px] rounded-[2px]"
                )}
                title={
                  isAvg
                    ? `Prix moyen position: ${position?.averagePrice.toFixed(2)}`
                    : undefined
                }
              >
                {fmtPrice(level.price)}
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  openSells > 0 && "ring-2 ring-trading-sell/50"
                )}
                onClick={() =>
                  openSells > 0
                    ? handleOrderClick(level.price)
                    : handleCellClick(level.price, "ask")
                }
              >
                {fmtSize(level.askSize)}
                {openSells > 0 && (
                  <span className="ml-1 text-[10px]">({openSells})</span>
                )}
              </div>

              {/* Volume cumulé (si alimenté) */}
              <div className="flex items-center justify-center text-muted-foreground">
                {fmtSize(level.volumeCumulative ?? 0)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});