import React, { memo, useEffect, useMemo, useRef, useState, UIEvent } from "react";
import { cn } from "@/lib/utils";
import { TickLadder as TickLadderType } from "@/lib/orderbook";

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
  position?: Position;
}

const TICK_SIZE = 0.25;
const EPS = 0.125;
const BIG_SIZE_THRESHOLD = 20;

const ROW_H = 24;
const TICKS_EACH_SIDE = 10000;
const OVERSCAN_ROWS = 15;
const L2_COALESCE_MS = 25;

function roundToGrid(p: number) {
  return Math.round(p / TICK_SIZE) * TICK_SIZE;
}
function formatPrice(p: number) {
  return p.toFixed(2).replace(".", ",");
}
function formatSize(s?: number) {
  return s && s > 0 ? String(s) : "";
}

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
  // 1) Lissage L2 uniquement (le last reste live)
  const debouncedLadder = useDebounced(tickLadder, L2_COALESCE_MS);

  // 2) Map prix -> niveau pour lookup O(1)
  const levelMap = useMemo(() => {
    const m = new Map<
      number,
      { price: number; bidSize: number; askSize: number; volumeCumulative?: number; sizeWindow?: number }
    >();
    const lvls = debouncedLadder?.levels ?? [];
    for (const l of lvls) {
      const p = roundToGrid(l.price);
      const prev = m.get(p);
      m.set(p, {
        price: p,
        bidSize: Math.max(prev?.bidSize ?? 0, l.bidSize ?? 0),
        askSize: Math.max(prev?.askSize ?? 0, l.askSize ?? 0),
        volumeCumulative: l.volumeCumulative ?? prev?.volumeCumulative,
        sizeWindow: l.sizeWindow ?? prev?.sizeWindow
      });
    }
    return m;
  }, [debouncedLadder]);

  // 3) Virtualisation "infini"
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const didInitScroll = useRef(false);

  const alivePrice = currentPrice > 0 ? currentPrice : 0; // protège le centrage
  const centerPrice = roundToGrid(alivePrice);
  const maxPrice = centerPrice + TICK_SIZE * TICKS_EACH_SIDE;
  const minPrice = centerPrice - TICK_SIZE * TICKS_EACH_SIDE;
  const totalRows = Math.max(1, Math.floor((maxPrice - minPrice) / TICK_SIZE) + 1);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  };

  // mesurer conteneur
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setContainerH(el.clientHeight));
    obs.observe(el);
    setContainerH(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  // Fonction de recentrage (utilisée au boot + barre espace)
  const centerOnPrice = (price: number) => {
    const el = containerRef.current;
    if (!el || containerH === 0 || price <= 0) return;
    const p = roundToGrid(price);
    const idx = Math.round((maxPrice - p) / TICK_SIZE);
    const target = idx * ROW_H - containerH / 2 + ROW_H / 2;
    el.scrollTop = Math.max(0, Math.min(target, totalRows * ROW_H - containerH));
    setScrollTop(el.scrollTop);
  };

  // centrage initial : ATTEND que currentPrice>0 ET qu’on ait un ladder
  useEffect(() => {
    if (didInitScroll.current) return;
    if (containerH === 0) return;
    if (alivePrice <= 0) return;
    if (!debouncedLadder || !debouncedLadder.levels?.length) return;
    centerOnPrice(alivePrice);
    didInitScroll.current = true;
  }, [containerH, alivePrice, debouncedLadder]);

  // barre espace = recentrer sur le last courant
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        // évite si focus dans input/textarea
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        centerOnPrice(currentPrice);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentPrice, containerH, totalRows, maxPrice]);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN_ROWS);
  const visibleCount = Math.ceil(containerH / ROW_H) + 2 * OVERSCAN_ROWS;
  const endIdx = Math.min(totalRows - 1, startIdx + visibleCount);
  const padTop = startIdx * ROW_H;
  const padBottom = Math.max(0, (totalRows - 1 - endIdx) * ROW_H);

  const getOrdersAtPrice = (price: number, side: "BUY" | "SELL") =>
    orders.filter((o) => o.side === side && Math.abs(o.price - price) < EPS && o.quantity > o.filled);

  const handleCellClick = (price: number, column: "bid" | "ask") => {
    if (disabled) return;
    const isAbove = price > currentPrice;
    const isBelow = price < currentPrice;
    const isAt = Math.abs(price - currentPrice) < EPS;

    if (column === "bid") {
      if (isAbove || isAt) onMarketOrder("BUY", 1);
      else onLimitOrder("BUY", price, 1);
    } else {
      if (isBelow || isAt) onMarketOrder("SELL", 1);
      else onLimitOrder("SELL", price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  // Affichage “en attente” tant qu’on n’a pas un last + un ladder
  if (!debouncedLadder || !debouncedLadder.levels?.length || alivePrice <= 0) {
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

      {/* Rows virtualisées */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto trading-scroll"
        onScroll={handleScroll}
        style={{ willChange: "transform" }}
      >
        {padTop > 0 && <div style={{ height: padTop }} />}

        {Array.from({ length: endIdx - startIdx + 1 }).map((_, k) => {
          const idx = startIdx + k;
          const price = maxPrice - idx * TICK_SIZE;

          const lvl = levelMap.get(roundToGrid(price));
          const bidSize = lvl?.bidSize ?? 0;
          const askSize = lvl?.askSize ?? 0;
          const volumeCumulative = lvl?.volumeCumulative ?? 0;
          const sizeWindow = lvl?.sizeWindow ?? 0;

          const isLastPrice = Math.abs(price - currentPrice) < EPS;
          const isAvgPos =
            position && position.quantity !== 0 && Math.abs(price - position.averagePrice) < EPS;

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
                "h-6"
              )}
            >
              {/* Size */}
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
                  totalBuy > 0 ? handleOrderClick(price) : handleCellClick(price, "bid")
                }
              >
                <>
                  <span>{formatSize(bidSize)}</span>
                  {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                </>
              </div>

              {/* Price (fixe) */}
              <div className="flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price">
                <span
                  className={cn(
                    isLastPrice && "text-trading-average font-bold",
                    isAvgPos && "outline outline-2 outline-[hsl(var(--trading-average))] rounded-sm px-1"
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
                  totalSell > 0 ? handleOrderClick(price) : handleCellClick(price, "ask")
                }
              >
                <>
                  <span>{formatSize(askSize)}</span>
                  {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                </>
              </div>

              {/* Volume cumulé */}
              <div className="flex items-center justify-center text-muted-foreground">
                {formatSize(volumeCumulative)}
              </div>
            </div>
          );
        })}

        {padBottom > 0 && <div style={{ height: padBottom }} />}
      </div>
    </div>
  );
});