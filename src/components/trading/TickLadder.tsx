import React, { memo, useEffect, useMemo, useRef, useState, UIEvent } from "react";
import { cn } from "@/lib/utils";
import { TickLadder as TickLadderType } from "@/lib/orderbook";

/** Types identiques à ton app */
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
  position?: Position; // optionnel
}

/* Constantes */
const TICK_SIZE = 0.25;                 // NQ
const EPS = 0.125;                      // tolérance matching prix
const BIG_SIZE_THRESHOLD = 20;          // cellule >= 20 lots -> surbrillance jaune discrète

/* Virtualisation "vrai infini" */
const ROW_H = 24;                       // hauteur (px) d'une ligne
const TICKS_EACH_SIDE = 10000;          // ~5000 points de scroll de chaque côté
const OVERSCAN_ROWS = 15;               // marge de rendus au-dessus/dessous du viewport

/* Lissage L2 pour éviter spread "faux" (25 ms) */
const L2_COALESCE_MS = 25;

/* Utils */
function roundToGrid(p: number) {
  return Math.round(p / TICK_SIZE) * TICK_SIZE;
}
function formatPrice(price: number): string {
  return price.toFixed(2).replace(".", ",");
}
function formatSize(size?: number): string {
  return size && size > 0 ? String(size) : "";
}

/* Petit hook local de "debounce" (uniquement pour le L2) */
function useDebounced<T>(value: T, delay: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
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
  /** 1) On ne **ralentit pas** le prix (currentPrice).
   *     On **lisse** uniquement le L2 (tickLadder) sur 25 ms.
   *     Ça supprime l’écart visuel éphémère bid/ask sans impacter le last.
   */
  const debouncedLadder = useDebounced(tickLadder, L2_COALESCE_MS);

  /** 2) On met en map les niveaux L2 → accès O(1) par prix */
  const levelMap = useMemo(() => {
    const m = new Map<
      number,
      {
        price: number;
        bidSize: number;
        askSize: number;
        volumeCumulative?: number;
        sizeWindow?: number;
      }
    >();
    const lvls = debouncedLadder?.levels ?? [];
    for (const l of lvls) {
      const p = roundToGrid(l.price);
      const prev = m.get(p);
      const merged = {
        price: p,
        bidSize: Math.max(prev?.bidSize ?? 0, l.bidSize ?? 0),
        askSize: Math.max(prev?.askSize ?? 0, l.askSize ?? 0),
        volumeCumulative: l.volumeCumulative ?? prev?.volumeCumulative,
        sizeWindow: l.sizeWindow ?? prev?.sizeWindow
      };
      m.set(p, merged);
    }
    return m;
  }, [debouncedLadder]);

  /** 3) Virtualisation "vrai infini"
   *     - On fabrique une fenêtre **logique** [minPrice..maxPrice] très large.
   *     - On calcule seulement les lignes visibles + overscan.
   *     - La colonne Price reste fixe (pas de recentrage auto).
   */
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const didInitScroll = useRef(false);

  const centerPrice = roundToGrid(currentPrice || 0);
  const maxPrice = centerPrice + TICK_SIZE * TICKS_EACH_SIDE; // en haut
  const minPrice = centerPrice - TICK_SIZE * TICKS_EACH_SIDE; // en bas
  const totalRows = Math.floor((maxPrice - minPrice) / TICK_SIZE) + 1;

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  };

  // Mesure du container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setContainerH(el.clientHeight));
    obs.observe(el);
    setContainerH(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  // Scroll initial : place le currentPrice au centre une seule fois (par charge)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || didInitScroll.current === true || containerH === 0) return;
    const centerIdx = Math.round((maxPrice - centerPrice) / TICK_SIZE);
    const target = centerIdx * ROW_H - (containerH / 2) + ROW_H / 2;
    el.scrollTop = Math.max(0, Math.min(target, totalRows * ROW_H - containerH));
    setScrollTop(el.scrollTop);
    didInitScroll.current = true;
  }, [containerH, centerPrice, maxPrice, totalRows]);

  // Calcul de la fenêtre visible
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN_ROWS);
  const visibleCount = Math.ceil(containerH / ROW_H) + 2 * OVERSCAN_ROWS;
  const endIdx = Math.min(totalRows - 1, startIdx + visibleCount);

  const padTop = startIdx * ROW_H;
  const padBottom = Math.max(0, (totalRows - 1 - endIdx) * ROW_H);

  // Accès aux ordres à un prix
  const getOrdersAtPrice = (price: number, side: "BUY" | "SELL") =>
    orders.filter(
      (o) =>
        o.side === side &&
        Math.abs(o.price - price) < EPS &&
        o.quantity > o.filled
    );

  // Click mapping identique (market/limit 1 clic)
  const handleCellClick = (price: number, column: "bid" | "ask") => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < EPS;

    if (column === "bid") {
      // clic au-dessus/égal du last dans Bids = MARKET BUY
      if (isAbove || isAt) onMarketOrder("BUY", 1);
      else onLimitOrder("BUY", price, 1);
    } else {
      // clic au-dessous/égal du last dans Asks = MARKET SELL
      if (isBelow || isAt) onMarketOrder("SELL", 1);
      else onLimitOrder("SELL", price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!debouncedLadder) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <div className="text-muted-foreground">
          {disabled ? "Snapshots DOM manquants" : "Chargement des données orderbook..."}
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

      {/* Rows (virtualisés) */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto trading-scroll"
        onScroll={handleScroll}
        style={{ willChange: "transform" }}
      >
        {/* padding haut */}
        {padTop > 0 && <div style={{ height: padTop }} />}

        {Array.from({ length: endIdx - startIdx + 1 }).map((_, k) => {
          const idx = startIdx + k;
          // Ligne idx correspond à un prix qui descend du haut vers le bas
          const price = maxPrice - idx * TICK_SIZE;
          const lvl = levelMap.get(roundToGrid(price));
          const bidSize = lvl?.bidSize ?? 0;
          const askSize = lvl?.askSize ?? 0;
          const volumeCumulative = lvl?.volumeCumulative ?? 0;
          const sizeWindow = lvl?.sizeWindow ?? 0;

          const isLastPrice = Math.abs(price - currentPrice) < EPS;
          const isAvgPos =
            position &&
            position.quantity !== 0 &&
            Math.abs(price - position.averagePrice) < EPS;

          const buyOrders = getOrdersAtPrice(price, "BUY");
          const sellOrders = getOrdersAtPrice(price, "SELL");
          const totalBuy = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
          const totalSell = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

          const bigBid = bidSize >= BIG_SIZE_THRESHOLD;
          const bigAsk = askSize >= BIG_SIZE_THRESHOLD;

          return (
            <div
              key={`row-${price}`}
              className={cn(
                "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50",
                "h-6",
                "hover:bg-ladder-row-hover transition-none"
              )}
            >
              {/* Size (fenêtre de trades si dispo) */}
              <div className="flex items-center justify-center border-r border-border/50">
                {formatSize(sizeWindow)}
              </div>

              {/* Bids */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  bidSize > 0 && "bg-ladder-bid",
                  bigBid && "bg-[hsl(var(--trading-average)/0.35)]"
                )}
                onClick={() =>
                  totalBuy > 0
                    ? handleOrderClick(price)
                    : handleCellClick(price, "bid")
                }
              >
                <>
                  <span>{formatSize(bidSize)}</span>
                  {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                </>
              </div>

              {/* Price (fixe), last en jaune, avg position encadré en jaune */}
              <div className="flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price">
                <span
                  className={cn(
                    isLastPrice && "text-trading-average font-bold",
                    isAvgPos &&
                      "outline outline-2 outline-[hsl(var(--trading-average))] rounded-sm px-1"
                  )}
                >
                  {formatPrice(price)}
                </span>
              </div>

              {/* Asks */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  askSize > 0 && "bg-ladder-ask",
                  bigAsk && "bg-[hsl(var(--trading-average)/0.35)]"
                )}
                onClick={() =>
                  totalSell > 0
                    ? handleOrderClick(price)
                    : handleCellClick(price, "ask")
                }
              >
                <>
                  <span>{formatSize(askSize)}</span>
                  {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                </>
              </div>

              {/* Volume cumulé par niveau */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(volumeCumulative)}
              </div>
            </div>
          );
        })}

        {/* padding bas */}
        {padBottom > 0 && <div style={{ height: padBottom }} />}
      </div>
    </div>
  );
});