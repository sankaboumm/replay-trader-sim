import { memo, useEffect, useRef, useCallback } from "react";
import { DOM } from "./DOM";
import type { TickLadder as TickLadderType } from "@/lib/orderbook";
import { useInfiniteTickWindow } from "@/hooks/useInfiniteTickWindow";

interface TradeLite {
  price: number;
  size: number;
  aggressor?: 'BUY' | 'SELL';
  timestamp?: number;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled?: number;
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
 * Wrapper "drop-in" pour activer le scroll infini:
 * - Etend la fenêtre de ticks vers le haut/bas par pas de 100 (par défaut)
 *   en écoutant les événements de scroll sur le conteneur interne (.trading-scroll).
 * - Ne modifie pas le composant DOM original: on lui passe juste un ladder étendu.
 */
export const DOMInfinite = memo(function DOMInfinite(props: DOMProps) {
  const { tickLadder, currentPrice, disabled } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hasInitialCenteredRef = useRef(false);

  const { ladder, extendUp, extendDown, batchSize, resetAroundMid } = useInfiniteTickWindow(tickLadder, {
    initialWindow: tickLadder?.levels?.length ?? 101,
    batchSize: 100,
  });

  // Centrage sur le midPrice avec la barre espace
  const centerOnMidPrice = useCallback(() => {
    if (!tickLadder?.midPrice || !ladder?.levels) return;
    
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) return;

    // Trouve l'index du niveau le plus proche du midPrice
    const midPriceIndex = ladder.levels.findIndex(level => 
      Math.abs(level.price - tickLadder.midPrice) < 0.125
    );
    
    if (midPriceIndex >= 0) {
      const ROW_HEIGHT = 32;
      const targetScroll = midPriceIndex * ROW_HEIGHT - (scrollEl.clientHeight / 2);
      scrollEl.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
    }
  }, [tickLadder?.midPrice, ladder]);

  // Ajustement du scrollTop après extension en haut pour éviter les "sauts"
  const pendingScrollAdjustRef = useRef<number | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) return;

    const THRESHOLD = 40; // px du bord avant déclenchement
    const ROW_HEIGHT = 32; // h-8 ≈ 2rem ≈ 32px (suffisant)

    const onScroll = () => {
      console.log('🔧 DOMInfinite: Scroll event triggered', { scrollTop: scrollEl.scrollTop });
      const top = scrollEl.scrollTop;
      const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
      const distToBottom = maxScrollTop - top;

      // Haut → on étend vers les prix plus élevés (ajout en haut)
      if (top < THRESHOLD) {
        console.log('🔧 DOMInfinite: Extending up');
        // On programmera un ajustement égal à batch * rowHeight pour conserver la vue
        pendingScrollAdjustRef.current = (pendingScrollAdjustRef.current ?? 0) + batchSize * ROW_HEIGHT;
        extendUp();
      }
      // Bas → on étend vers les prix plus bas (ajout en bas)
      else if (distToBottom < THRESHOLD) {
        console.log('🔧 DOMInfinite: Extending down');
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

    const delta = pendingScrollAdjustRef.current;
    // On reset avant de l'appliquer, pour éviter une accumulation
    pendingScrollAdjustRef.current = 0;

    // Appliquer au prochain frame pour que le DOM ait bien inséré les nouvelles lignes
    requestAnimationFrame(() => {
      scrollEl.scrollTop = scrollEl.scrollTop + delta;
    });
  }, [ladder]);

  // Gestion des événements clavier pour la barre espace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        centerOnMidPrice();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [centerOnMidPrice]);

  // Centrage automatique initial sur le midPrice 
  useEffect(() => {
    if (ladder && ladder.levels && ladder.levels.length > 0 && tickLadder?.midPrice) {
      console.log('🔧 DOMInfinite: Initial auto-centering on midPrice', { 
        midPrice: tickLadder.midPrice,
        levelsCount: ladder.levels.length,
        hasInitialCentered: hasInitialCenteredRef.current
      });
      
      // Toujours centrer si pas encore fait, ou si nouveau fichier détecté
      if (!hasInitialCenteredRef.current) {
        hasInitialCenteredRef.current = true;
        // Délai pour s'assurer que le DOM est complètement rendu
        setTimeout(() => {
          console.log('🔧 DOMInfinite: Executing centerOnMidPrice after delay');
          centerOnMidPrice();
        }, 100);
      }
    }
  }, [ladder, tickLadder?.midPrice, centerOnMidPrice]);

  // Reset du flag de centrage quand le midPrice change significativement (nouveau fichier)
  const lastMidPriceRef = useRef<number | null>(null);
  useEffect(() => {
    if (tickLadder?.midPrice) {
      const currentMidPrice = tickLadder.midPrice;
      const lastMidPrice = lastMidPriceRef.current;
      
      // Si c'est un nouveau fichier (midPrice change significativement)
      if (lastMidPrice !== null && Math.abs(currentMidPrice - lastMidPrice) > 100) {
        console.log('🔧 DOMInfinite: Detected new file, resetting centered flag', {
          lastMidPrice,
          currentMidPrice,
          diff: Math.abs(currentMidPrice - lastMidPrice)
        });
        hasInitialCenteredRef.current = false;
      }
      
      lastMidPriceRef.current = currentMidPrice;
    } else {
      // Reset quand pas de données
      if (hasInitialCenteredRef.current) {
        console.log('🔧 DOMInfinite: Resetting initial centered flag - no data');
      }
      hasInitialCenteredRef.current = false;
      lastMidPriceRef.current = null;
    }
  }, [tickLadder?.midPrice]);

  return (
    <div ref={wrapperRef} className="contents">
      <DOM {...props} tickLadder={ladder} />
    </div>
  );
});