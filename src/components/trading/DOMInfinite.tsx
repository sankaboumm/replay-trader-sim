import { memo, useEffect, useRef, useCallback } from "react";
import { DOM } from "./DOM";
import type { TickLadder as TickLadderType } from "@/lib/orderbook";
import { useInfiniteTickWindow } from "@/hooks/useInfiniteTickWindow";

interface TradeLite {
  price: number;
  size: number;
  aggressor?: 'BUY' | 'SELL';
  timestamp?: number | Date;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
}

interface DOMProps {
  tickLadder: TickLadderType | null;
  currentPrice: number;
  trades?: TradeLite[];
  orders?: Order[];
  disabled?: boolean;
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number) => void;
  onCancelOrders?: (price: number) => void;
  position?: { averagePrice: number; quantity: number };
}

/**
 * DOMInfinite :
 * - Fournit une fenêtre de ticks “extensible” autour du ladder courant (scroll infini).
 * - Etend la fenêtre de ticks vers le haut/bas par pas de 100 (par défaut)
 *   en écoutant les événements de scroll sur le conteneur interne (.trading-scroll).
 * - Ne modifie pas le composant DOM original: on lui passe juste un ladder étendu.
 */
export const DOMInfinite = memo(function DOMInfinite(props: DOMProps) {
  const { tickLadder, currentPrice } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { ladder, extendUp, extendDown, batchSize, resetAroundMid } = useInfiniteTickWindow(tickLadder, {
    initialWindow: tickLadder?.levels?.length ?? 101,
    batchSize: 100,
  });

  // Auto-centrage une fois au premier ladder reçu
  const didAutoCenterRef = useRef(false);
  useEffect(() => {
    if (didAutoCenterRef.current) return;
    if (!ladder?.levels || ladder.levels.length === 0) return;
    didAutoCenterRef.current = true;
    // Recentre la fenêtre de ticks autour du mid, puis scroll sur le prix cible
    resetAroundMid(ladder.levels.length);
    // Laisse le temps au DOM de se mettre à jour
    requestAnimationFrame(() => {
      centerOnCurrentPrice();
    });
  }, [ladder, resetAroundMid, centerOnCurrentPrice]);

  // Centrage sur le prix courant avec la barre espace (et au chargement via useEffect ci-dessus)
  const centerOnCurrentPrice = useCallback(() => {
    if (!ladder?.levels) return;
    
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) return;

    // Cible: currentPrice, sinon lastPrice, sinon midPrice
    const target = (currentPrice && Number.isFinite(currentPrice) && currentPrice)
      || (ladder.lastPrice && Number.isFinite(ladder.lastPrice) && ladder.lastPrice)
      || ladder.midPrice;

    if (!target) return;

    // Trouve l'index du niveau le plus proche de la cible
    const targetIndex = ladder.levels.findIndex(level => 
      Math.abs(level.price - target) < 0.125
    );
    
    if (targetIndex >= 0) {
      const ROW_HEIGHT = 32;
      const rowTop = targetIndex * ROW_HEIGHT;
      const centerTop = rowTop - (scrollEl.clientHeight / 2) + ROW_HEIGHT / 2;
      scrollEl.scrollTo({ top: Math.max(0, centerTop), behavior: 'smooth' });
    }
  }, [currentPrice, ladder]);

  // Gestion du scroll infini : étendre en haut/bas selon la proximité des bords
  const pendingScrollAdjustRef = useRef<number | null>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const distToTop = scrollTop;
      const distToBottom = scrollHeight - (scrollTop + clientHeight);

      const THRESHOLD = 200; // px
      const ROW_HEIGHT = 32;

      // Haut → on étend vers les prix plus hauts (ajout en haut → décale le scroll)
      if (distToTop < THRESHOLD) {
        // On programmera un ajustement égal à batch * rowHeight pour conserver la vue
        pendingScrollAdjustRef.current = (pendingScrollAdjustRef.current ?? 0) + batchSize * ROW_HEIGHT;
        extendUp();
      }
      // Bas → on étend vers les prix plus bas (ajout en bas)
      else if (distToBottom < THRESHOLD) {
        extendDown();
      }
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
    };
  }, [ladder, extendUp, extendDown, batchSize]);

  // Après re-render suite à une extension en haut, on corrige le scrollTop
  useEffect(() => {
    if (pendingScrollAdjustRef.current == null || pendingScrollAdjustRef.current <= 0) return;

    const wrapper = wrapperRef.current;
    if (!wrapper) {
      pendingScrollAdjustRef.current = 0;
      return;
    }
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) {
      pendingScrollAdjustRef.current = 0;
      return;
    }

    const adjust = pendingScrollAdjustRef.current;
    pendingScrollAdjustRef.current = 0;
    scrollEl.scrollTop += adjust;
  }, [ladder]);

  // Espace = centrer sur current/last/mid
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        centerOnCurrentPrice();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [centerOnCurrentPrice]);

  return (
    <div ref={wrapperRef} className="contents">
      <DOM {...props} tickLadder={ladder} />
    </div>
  );
});