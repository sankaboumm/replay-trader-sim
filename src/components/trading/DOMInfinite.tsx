import { memo, useEffect, useRef, useCallback } from "react";
import { DOM } from "./DOM";
import type { TickLadder as TickLadderType } from "@/lib/orderbook";
import { useInfiniteTickWindow } from "@/hooks/useInfiniteTickWindow";
import { useToast } from "@/hooks/use-toast";

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
  const { toast } = useToast();

  const { ladder, extendUp, extendDown, batchSize, resetAroundMid } = useInfiniteTickWindow(tickLadder, {
    initialWindow: tickLadder?.levels?.length ?? 101,
    batchSize: 100,
  });

  // Centrage sur le midPrice avec la barre espace
  const centerOnMidPrice = useCallback(() => {
    if (!tickLadder?.midPrice || !ladder?.levels) {
      return;
    }
    
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) {
      return;
    }

    // Trouve l'index du niveau le plus proche du midPrice
    const midPriceIndex = ladder.levels.findIndex(level => 
      Math.abs(level.price - tickLadder.midPrice) < 0.125
    );
    
    if (midPriceIndex >= 0) {
      const ROW_HEIGHT = 32;
      const targetScroll = midPriceIndex * ROW_HEIGHT - (scrollEl.clientHeight / 2);
      const finalScroll = Math.max(0, targetScroll);
      
      // FORCER l'affichage immédiat sans animation
      scrollEl.scrollTop = finalScroll;
      
      // Force un re-render en déclenchant un événement scroll
      scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }, [tickLadder?.midPrice, ladder]);

  // Force l'affichage initial du DOM
  const forceInitialDisplay = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    
    const scrollEl = wrapper.querySelector<HTMLElement>('.trading-scroll');
    if (!scrollEl) return;
    
    // Force un scroll minimal pour déclencher l'affichage
    scrollEl.scrollTop = 1;
    setTimeout(() => {
      scrollEl.scrollTop = 0;
      // Puis centre sur le midPrice
      centerOnMidPrice();
    }, 50);
  }, [centerOnMidPrice]);

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

  // Centrage automatique initial sur le midPrice UNIQUEMENT lors du chargement

  useEffect(() => {
    const hasLadder = !!ladder;
    const hasLevels = !!(ladder?.levels);
    const levelsCount = ladder?.levels?.length || 0;
    const hasMidPrice = !!tickLadder?.midPrice;
    const midPrice = tickLadder?.midPrice;
    const hasInitialCentered = hasInitialCenteredRef.current;

    // IMPORTANT: Ne pas repositionner automatiquement pendant la lecture (disabled = false)
    if (!disabled) {
      return;
    }

    if (hasLadder && hasLevels && levelsCount > 0 && hasMidPrice && !hasInitialCentered) {
      hasInitialCenteredRef.current = true;
      
      toast({
        title: "🔄 Affichage DOM",
        description: `DOM chargé avec ${levelsCount} niveaux à ${midPrice}`,
        duration: 2000
      });
      
      // Forcer l'affichage initial du DOM
      setTimeout(() => {
        forceInitialDisplay();
      }, 200);
    }
  }, [ladder, disabled, centerOnMidPrice, forceInitialDisplay, toast]);

  // Reset du flag de centrage quand on change de fichier
  const lastMidPriceRef = useRef<number | null>(null);
  useEffect(() => {
    if (tickLadder?.midPrice) {
      const currentMidPrice = tickLadder.midPrice;
      const lastMidPrice = lastMidPriceRef.current;
      
      // Si c'est un nouveau fichier (midPrice change significativement)
      if (lastMidPrice !== null && Math.abs(currentMidPrice - lastMidPrice) > 50) {
        toast({
          title: "📁 Nouveau fichier détecté",
          description: `Prix: ${lastMidPrice} → ${currentMidPrice}`,
          duration: 2000
        });
        hasInitialCenteredRef.current = false;
      }
      
      lastMidPriceRef.current = currentMidPrice;
    } else {
      // CRITIQUE: Reset quand pas de données (nouveau fichier en cours de chargement)
      hasInitialCenteredRef.current = false;
      lastMidPriceRef.current = null;
    }
  }, [tickLadder?.midPrice, toast]);

  return (
    <div ref={wrapperRef} className="contents">
      <DOM 
        key={`${ladder?.levels?.length || 0}-${tickLadder?.midPrice || 0}`}
        {...props} 
        tickLadder={ladder} 
      />
    </div>
  );
});