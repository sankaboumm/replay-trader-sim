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
    console.log('🎯 centerOnMidPrice: Starting centering process', {
      hasMidPrice: !!tickLadder?.midPrice,
      hasLadder: !!ladder?.levels,
      levelsCount: ladder?.levels?.length
    });
    
    if (!tickLadder?.midPrice || !ladder?.levels) {
      console.log('🎯 centerOnMidPrice: Missing data, aborting');
      return;
    }
    
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      console.log('🎯 centerOnMidPrice: No wrapper found');
      return;
    }
    
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) {
      console.log('🎯 centerOnMidPrice: No scroll element found');
      return;
    }

    console.log('🎯 centerOnMidPrice: Found scroll element', {
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      midPrice: tickLadder.midPrice
    });

    // Trouve l'index du niveau le plus proche du midPrice
    const midPriceIndex = ladder.levels.findIndex(level => 
      Math.abs(level.price - tickLadder.midPrice) < 0.125
    );
    
    console.log('🎯 centerOnMidPrice: Found midPrice index', {
      midPriceIndex,
      targetPrice: tickLadder.midPrice,
      foundPrice: midPriceIndex >= 0 ? ladder.levels[midPriceIndex].price : 'not found'
    });
    
    if (midPriceIndex >= 0) {
      const ROW_HEIGHT = 32;
      const targetScroll = midPriceIndex * ROW_HEIGHT - (scrollEl.clientHeight / 2);
      console.log('🎯 centerOnMidPrice: Scrolling to position', {
        targetScroll: Math.max(0, targetScroll),
        rowHeight: ROW_HEIGHT,
        clientHeight: scrollEl.clientHeight
      });
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
    if (ladder && ladder.levels && ladder.levels.length > 0 && tickLadder?.midPrice && !hasInitialCenteredRef.current) {
      console.log('🔧 DOMInfinite: Initial auto-centering triggered', { 
        midPrice: tickLadder.midPrice,
        levelsCount: ladder.levels.length,
        hasInitialCentered: hasInitialCenteredRef.current
      });
      
      hasInitialCenteredRef.current = true;
      // Délai plus long pour s'assurer que le DOM est complètement rendu
      setTimeout(() => {
        console.log('🔧 DOMInfinite: Executing centerOnMidPrice after delay');
        centerOnMidPrice();
      }, 500);
    } else {
      console.log('🔧 DOMInfinite: Auto-centering conditions not met', {
        hasLadder: !!ladder,
        hasLevels: !!(ladder?.levels?.length),
        levelsCount: ladder?.levels?.length,
        hasMidPrice: !!tickLadder?.midPrice,
        hasInitialCentered: hasInitialCenteredRef.current
      });
    }
  }, [ladder, centerOnMidPrice]);

  // Reset du flag de centrage quand on change de fichier
  const lastMidPriceRef = useRef<number | null>(null);
  useEffect(() => {
    if (tickLadder?.midPrice) {
      const currentMidPrice = tickLadder.midPrice;
      const lastMidPrice = lastMidPriceRef.current;
      
      // Si c'est un nouveau fichier (midPrice change significativement)
      if (lastMidPrice !== null && Math.abs(currentMidPrice - lastMidPrice) > 50) {
        console.log('🔧 DOMInfinite: New file detected, resetting centered flag', {
          lastMidPrice,
          currentMidPrice
        });
        hasInitialCenteredRef.current = false;
      }
      
      lastMidPriceRef.current = currentMidPrice;
    } else {
      // Reset quand pas de données
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