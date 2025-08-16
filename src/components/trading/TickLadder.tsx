/* ===== TickLadder.tsx — version avec surlignage Cmd/Ctrl + clic gauche sur la colonne Price ===== */
/* Ajouts uniquement : injections de styles, handlers en capture, détection sans dépendre d’une classe,
   et fallbacks robustes pour identifier la cellule Price par structure (grid 5 colonnes → 3e enfant). */

import { memo, useMemo, useRef, useCallback } from 'react';
import { useEffect, useState } from 'react';
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
  pnl: number;
}

interface TickLevel {
  price: number;
  bidSize?: number;
  askSize?: number;
  sizeWindow?: number;
  volumeCumulative?: number;
  tick?: number;
}

interface TickLadderProps {
  tickLadder: TickLadderType;
  currentPrice: number;
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position;
  setViewAnchorPrice?: (price: number | null) => void;
}

const fmtPrice = (p: number) => p.toFixed(2).replace('.', ',');
const fmtSize = (s: number) => (s > 0 ? s.toString() : '');

export const TickLadder = memo(function TickLadder({
  tickLadder,
  currentPrice,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled = false,
  position,
  setViewAnchorPrice
}: TickLadderProps) {
  const getOrdersAtPrice = (price: number, side: 'BUY' | 'SELL') =>
    orders.filter(o => o.side === side && Math.abs(o.price - price) < 0.125 && o.quantity > o.filled);

  // FIFO scroll state
  const scrollWrapperRef = useRef<HTMLDivElement | null>(null);
  const wheelRemainderRef = useRef(0);
  const ROW_HEIGHT_PX = 24; // Tailwind h-6
  const tickSize = useMemo(() => {
    if (tickLadder?.levels && tickLadder.levels.length >= 2) {
      return Math.abs(tickLadder.levels[0].price - tickLadder.levels[1].price) || 0.25;
    }
    return 0.25;
  }, [tickLadder]);

  /* =========================== AJOUTS (sans suppression) =========================== */

  // Set de clés de prix (string à deux décimales) surlignés
  const [highlightedPriceKeys, setHighlightedPriceKeys] = useState<Set<string>>(new Set());

  // Parsing robuste FR/US depuis texte (ex: "15.234,50" → "15234.50" → Number)
  const getPriceKeyFromCellRobust = useCallback((cell: HTMLElement) => {
    let txt = (cell.innerText || cell.textContent || '').trim();
    if (!txt) return '';
    let s = txt.replace(/[^0-9,\.]/g, '');
    if (s.includes('.') && s.includes(',')) {
      s = s.replace(/\./g, '').replace(/,/g, '.');
    } else if (s.includes(',') && !s.includes('.')) {
      s = s.replace(/,/g, '.');
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(2);
  }, []);

  // Classe CSS d’override pour le jaune
  useEffect(() => {
    const id = 'tickladder-highlight-style';
    if (!document.getElementById(id)) {
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `.tick-price--highlight { background-color: #fde047 !important; }`;
      document.head.appendChild(style);
    }
  }, []);

  // Handler capture (élément target) : Cmd/Ctrl + left click → toggle
  useEffect(() => {
    const root = scrollWrapperRef.current;
    if (!root) return;

    const onMouseDownElem = (e: MouseEvent) => {
      if (e.button !== 0) return; // left click only
      const me = e as MouseEvent & { metaKey?: boolean; ctrlKey?: boolean };
      if (!(me.metaKey || me.ctrlKey)) return; // Cmd sur Mac, Ctrl sur PC

      const target = e.target as HTMLElement | null;
      if (!target || (target as any).nodeType !== 1) return;

      // 1) On tente via classe existante (si présente dans un autre build)
      let cell = target.closest('div.bg-ladder-price') as HTMLElement | null;

      // 2) Fallback structure : grille avec 5 colonnes → 3e enfant = Price
      if (!cell) {
        const path = (e.composedPath?.() || []) as any[];
        for (const n of path) {
          if (!(n instanceof HTMLElement)) continue;
          const cs = getComputedStyle(n);
          if (cs.display === 'grid' && n.children?.length >= 5) {
            const c = n.children[2];
            if (c instanceof HTMLElement) {
              cell = c;
              break;
            }
          }
        }
      }

      if (!cell) return;
      e.preventDefault();

      const key = getPriceKeyFromCellRobust(cell);
      if (!key) return;

      setHighlightedPriceKeys(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    root.addEventListener('mousedown', onMouseDownElem, true); // capture
    return () => root.removeEventListener('mousedown', onMouseDownElem, true);
  }, [scrollWrapperRef, getPriceKeyFromCellRobust]);

  // Handler capture (texte target) : couvre le cas TextNode
  useEffect(() => {
    const root = scrollWrapperRef.current;
    if (!root) return;
    const onMouseDownText = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const me = e as MouseEvent & { metaKey?: boolean; ctrlKey?: boolean };
      if (!(me.metaKey || me.ctrlKey)) return;

      const t = e.target as any;
      if (!t || t.nodeType === 1) return; // si Element, on laisse l’autre handler gérer

      const parent: HTMLElement | null = t.parentElement ?? null;
      if (!parent) return;

      // Classe si présente
      let cell = parent.closest('div.bg-ladder-price') as HTMLElement | null;

      // Fallback structure (grid 5 colonnes)
      if (!cell) {
        const path = (e.composedPath?.() || []) as any[];
        for (const n of path) {
          if (!(n instanceof HTMLElement)) continue;
          const cs = getComputedStyle(n);
          if (cs.display === 'grid' && n.children?.length >= 5) {
            const c = n.children[2];
            if (c instanceof HTMLElement) {
              cell = c;
              break;
            }
          }
        }
      }

      if (!cell) return;
      e.preventDefault();

      const key = getPriceKeyFromCellRobust(cell);
      if (!key) return;

      setHighlightedPriceKeys(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };
    root.addEventListener('mousedown', onMouseDownText, true);
    return () => root.removeEventListener('mousedown', onMouseDownText, true);
  }, [scrollWrapperRef, getPriceKeyFromCellRobust]);

  // Application de la classe jaune après rendu (avec fallback structure)
  useEffect(() => {
    const root = scrollWrapperRef.current;
    if (!root) return;

    // D’abord, si une classe connue existe dans ce build
    let cells = Array.from(root.querySelectorAll('div.bg-ladder-price')) as HTMLElement[];

    // Si aucune, on reconstruit via la structure grid 5 colonnes
    if (cells.length === 0) {
      const allDivs = Array.from(root.querySelectorAll('div')) as HTMLElement[];
      const priceCells: HTMLElement[] = [];
      for (const el of allDivs) {
        try {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'grid' && el.children.length === 5) {
            const priceEl = el.children[2] as HTMLElement;
            if (priceEl) {
              const key = getPriceKeyFromCellRobust(priceEl);
              if (key) priceCells.push(priceEl);
            }
          }
        } catch {}
      }
      cells = priceCells;
    }

    // Toggle classe selon l’état
    for (const cell of cells) {
      const key = getPriceKeyFromCellRobust(cell);
      if (key && highlightedPriceKeys.has(key)) {
        cell.classList.add('tick-price--highlight');
      } else {
        cell.classList.remove('tick-price--highlight');
      }
    }
  }, [tickLadder, currentPrice, highlightedPriceKeys, getPriceKeyFromCellRobust]);

  /* ========================= FIN DES AJOUTS (aucune suppression) ========================= */

  const computeBasePrice = () => {
    if (tickLadder && (tickLadder as any).midPrice != null) return (tickLadder as any).midPrice as number;
    if (tickLadder?.levels?.length) {
      const first = tickLadder.levels[0].price;
      const last  = tickLadder.levels[tickLadder.levels.length - 1].price;
      return (first + last) / 2;
    }
    return currentPrice;
  };

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice || !tickLadder) return;
    e.preventDefault();

    const deltaY = e.deltaY;
    const mode = (e.nativeEvent as any)?.deltaMode ?? 0; // 0: pixel, 1: line, 2: page
    let steps = 0;

    if (mode === 1) {
      // LINE mode: 1 line = 1 tick, invert sign so: up (deltaY<0) => +ticks (price up)
      steps = deltaY < 0 ? +1 : -1;
    } else {
      // PIXEL mode: convert wheel delta to rows, keep fractional remainder
      const rows = deltaY / ROW_HEIGHT_PX;
      const withRemainder = wheelRemainderRef.current + rows;
      steps = Math.trunc(withRemainder);
      wheelRemainderRef.current = withRemainder - steps;
    }

    // anchor adjustment
    const base = computeBasePrice();
    setViewAnchorPrice(base + steps * tickSize);
  }, [setViewAnchorPrice, tickLadder]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!setViewAnchorPrice) return;
    if (e.code === 'Space') {
      e.preventDefault();
      setViewAnchorPrice(null);
    }
  }, [setViewAnchorPrice]);

  const avgPrice = position.quantity !== 0 ? position.averagePrice : null;

  const handleCellClick = (price: number, column: 'bid' | 'ask') => {
    if (disabled) return;

    const above = price > currentPrice;
    const below = price < currentPrice;

    if (column === 'bid') {
      if (above) return onMarketOrder('BUY', 1);
      return onLimitOrder('BUY', price, 1);
    }
    if (column === 'ask') {
      if (below) return onMarketOrder('SELL', 1);
      return onLimitOrder('SELL', price, 1);
    }
  };

  const handleOrderClick = (price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  };

  if (!tickLadder) {
    return (
      <div className="border rounded-lg overflow-hidden">
        <div className="p-6 text-center text-muted-foreground">No data</div>
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden flex flex-col">
      {/* Header */}
      <div className="border-b border-border">
        <div className="grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs bg-muted/30">
          <div className="p-2 text-center border-r border-border">Size</div>
          <div className="p-2 text-center border-r border-border">Bids</div>
          <div className="p-2 text-center border-r border-border">Price</div>
          <div className="p-2 text-center border-r border-border">Asks</div>
          <div className="p-2 text-center">Volume</div>
        </div>
      </div>

      {/* Body - wrap with a listener to avoid editing existing inner div */}
      <div ref={scrollWrapperRef} onWheel={handleWheel} onKeyDown={handleKeyDown} tabIndex={0}>
        <div className="flex-1 overflow-y-auto">
          {(tickLadder.levels as TickLevel[]).slice().sort((a, b) => b.price - a.price).map((level) => {
            const isLastPrice = Math.abs(level.price - currentPrice) < 0.125;
            const isAvgPrice  = avgPrice !== null && Math.abs(level.price - (avgPrice as number)) < 0.125;

            const buyOrders  = getOrdersAtPrice(level.price, 'BUY');
            const sellOrders = getOrdersAtPrice(level.price, 'SELL');
            const totalBuy   = buyOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);
            const totalSell  = sellOrders.reduce((s, o) => s + (o.quantity - o.filled), 0);

            return (
              <div
                key={`${level.price}-${(level as any).tick}`}
                className={cn(
                  "grid [grid-template-columns:64px_1fr_88px_1fr_64px] text-xs border-b border-border/50 h-6"
                )}
              >
                {/* Size (window) */}
                <div className="flex items-center justify-center border-r border-border/50">
                  {fmtSize((level as any).sizeWindow ?? 0)}
                </div>

                {/* Bids */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price <= currentPrice && "bg-ladder-bid"
                  )}
                  onClick={() => totalBuy > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'bid')}
                >
                  {level.price <= currentPrice && (
                    <>
                      <span>{fmtSize((level as any).bidSize ?? 0)}</span>
                      {totalBuy > 0 && <span className="ml-1 text-xs">({totalBuy})</span>}
                    </>
                  )}
                </div>

                {/* Price */}
                <div
                  className={cn(
                    "flex items-center justify-center font-mono font-medium border-r border-border/50",
                    // Note : on ne dépend pas d'une classe spécifique ici pour le jaune,
                    // le highlight est appliqué dynamiquement par les effets.
                    "bg-ladder-price", // si présente dans d’autres builds, sinon n’affecte pas le fonctionnement
                    isLastPrice && "text-trading-average font-bold",
                    isAvgPrice && "ring-2 ring-trading-average rounded-sm"
                  )}
                  onDoubleClick={() => setViewAnchorPrice && setViewAnchorPrice(null)}
                  title="Double-clique pour recentrer"
                  // NB : pas d’onClick ajouté ici pour respecter la contrainte “pas de modif/suppression” ;
                  // tout est capturé en phase capture au niveau wrapper.
                >
                  {fmtPrice(level.price)}
                </div>

                {/* Asks */}
                <div
                  className={cn(
                    "flex items-center justify-center cursor-pointer border-r border-border/50",
                    level.price >= currentPrice && "bg-ladder-ask"
                  )}
                  onClick={() => totalSell > 0 ? handleOrderClick(level.price) : handleCellClick(level.price, 'ask')}
                >
                  {level.price >= currentPrice && (
                    <>
                      <span>{fmtSize((level as any).askSize ?? 0)}</span>
                      {totalSell > 0 && <span className="ml-1 text-xs">({totalSell})</span>}
                    </>
                  )}
                </div>

                {/* Volume cumulé à ce prix */}
                <div className="flex items-center justify-center text-muted-foreground">
                  {fmtSize((level as any).volumeCumulative ?? 0)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});