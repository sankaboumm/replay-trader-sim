import { useEffect, useMemo, useRef, useState } from "react";
import type { TickLadder as TickLadderType, TickLevel } from "@/lib/orderbook";

/**
 * Infini-scroll pour le ladder :
 * - On maintient une fenêtre [lowTick .. highTick] que l'on étend par pas (batchSize)
 *   quand on atteint le haut/bas du scroll.
 * - On NE MODIFIE PAS les données source : on génère un ladder "étendu" à partir
 *   du ladder reçu, en remplissant les ticks manquants avec des tailles = 0.
 *
 * Notes:
 * - L'ordre des niveaux retournés est du plus haut prix → au plus bas (comme le DOM actuel).
 */
export function useInfiniteTickWindow(
  tickLadder: TickLadderType | null | undefined,
  opts?: {
    /** Taille initiale de fenêtre (nb de lignes visibles). Par défaut: ladder.levels.length ou 101 */
    initialWindow?: number;
    /** Pas de chargement quand on atteint un bord (en nb de ticks). Par défaut: 100 */
    batchSize?: number;
  }
) {
  const initialWindow = opts?.initialWindow ?? (tickLadder?.levels?.length || 101);
  const batchSize = Math.max(1, opts?.batchSize ?? 100);

  // On stocke la fenêtre actuelle en ticks (bas et haut inclus)
  const [lowTick, setLowTick] = useState<number | null>(null);
  const [highTick, setHighTick] = useState<number | null>(null);

  // Mémorise la dernière ladder utilisée pour savoir quand initialiser
  const lastMidTickRef = useRef<number | null>(null);

  // Déduire la taille de tick à partir des niveaux connus
  const tickSize = useMemo(() => {
    if (!tickLadder?.levels?.length) return 0.25; // fallback NQ
    const prices = Array.from(
      new Set(tickLadder.levels.map(l => l.price).filter((p) => Number.isFinite(p)))
    ).sort((a, b) => a - b);
    let minStep = Number.POSITIVE_INFINITY;
    for (let i = 1; i < prices.length; i++) {
      const diff = Math.abs(prices[i] - prices[i - 1]);
      if (diff > 0 && diff < minStep) minStep = diff;
    }
    return Number.isFinite(minStep) ? minStep : 0.25;
  }, [tickLadder]);

  // Initialisation ou reinitialisation de la fenêtre à la réception du ladder
  useEffect(() => {
    if (!tickLadder) return;
    const { midTick, lastTick } = tickLadder;

    // Première initialisation ou si aucune fenêtre encore définie
    if (lowTick == null || highTick == null || lastMidTickRef.current == null) {
      const half = Math.floor(initialWindow / 2);
      // [FIX] On privilégie midTick (ancre) pour le centrage initial
      const centerTick = midTick;
      setLowTick(centerTick - half);
      setHighTick(centerTick + half);
      lastMidTickRef.current = midTick;
      return;
    }

    // Si le mid change, on garde la fenêtre telle quelle (infinite scroll ≠ recentrage),
    // car l'utilisateur est en train de scroller manuellement. On met simplement à jour le ref.
    lastMidTickRef.current = midTick;
  }, [tickLadder, initialWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dictionnaire tick → niveau pour hydrater rapidement + tous les niveaux possibles
  const levelByTick = useMemo(() => {
    const map = new Map<number, TickLevel>();
    if (tickLadder?.levels) {
      // Ajouter tous les niveaux connus
      for (const lvl of tickLadder.levels) {
        map.set(lvl.tick, lvl);
      }
    }
    return map;
  }, [tickLadder]);

  // Helper : convertit tick → price à partir du mid
  const tickToPrice = useMemo(() => {
    if (!tickLadder) {
      return (t: number) => t * tickSize; // fallback peu utilisé
    }
    const baseTick = tickLadder.midTick;
    const basePx = tickLadder.midPrice;
    return (t: number) => basePx + (t - baseTick) * tickSize;
  }, [tickLadder, tickSize]);

  // Construit le ladder étendu retourné
  const extendedLadder: TickLadderType | null = useMemo(() => {
    if (!tickLadder || lowTick == null || highTick == null) return tickLadder ?? null;

    const outLevels: TickLevel[] = [];
    
    for (let t = highTick; t >= lowTick; t--) {
      const known = levelByTick.get(t);
      if (known) {
        outLevels.push(known);
      } else {
        outLevels.push({
          tick: t,
          price: +tickToPrice(t).toFixed(10), // garde une précision décente
          bidSize: 0,
          askSize: 0,
        });
      }
    }

    return {
      midTick: tickLadder.midTick,
      midPrice: tickLadder.midPrice,
      lastTick: tickLadder.lastTick,
      lastPrice: tickLadder.lastPrice,
      levels: outLevels,
    };
  }, [tickLadder, lowTick, highTick, levelByTick, tickToPrice]);

  // Expose des helpers pour étendre la fenêtre
  const extendUp = () => {
    if (highTick == null) return;
    setHighTick(highTick + batchSize);
  };
  const extendDown = () => {
    if (lowTick == null) return;
    setLowTick(lowTick - batchSize);
  };
  const resetAroundMid = (windowSize?: number) => {
    if (!tickLadder) return;
    const half = Math.floor((windowSize ?? initialWindow) / 2);
    setLowTick(tickLadder.midTick - half);
    setHighTick(tickLadder.midTick + half);
  };

  return {
    ladder: extendedLadder,
    extendUp,
    extendDown,
    resetAroundMid,
    // utile pour calculer le décalage de scroll après extension
    batchSize,
  };
}