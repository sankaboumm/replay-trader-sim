// src/hooks/useTradingEngine.ts
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  OrderBookProcessor,
  ParsedOrderBook,
  Trade as OrderBookTrade,
  TickLadder,
} from '@/lib/orderbook';
import { buildFramesSynced, Frame } from '@/lib/replayFrames';

/** ===================== Types UI ===================== */
interface Trade {
  id: string;
  timestamp: number | Date;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
}
interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled?: number;
}
interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  volume?: number;
}

/** ===================== Constantes ===================== */
const TICK_SIZE = 0.25;
const ORDERBOOK_CAP = 200; // cap de sécurité pour le processor/DOM
const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
const toBidTick = (p: number) => Math.floor((p + 1e-9) / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil((p - 1e-9) / TICK_SIZE) * TICK_SIZE;
const roundToGrid = (p: number) => Math.round(p * 4) / 4;

/** ===================== Helpers ===================== */
const decorateLadderWithVolume = (ladder: TickLadder, volumeMap: Map<number, number>): TickLadder => {
  if (!ladder) return ladder;
  const levels = ladder.levels.map(l => ({
    ...l,
    volumeCumulative: volumeMap.get(roundToGrid(l.price)) ?? 0,
  }));
  return { ...ladder, levels };
};

/** ===================== Hook principal ===================== */
export function useTradingEngine() {
  // --- lecture / frames ---
  const [frames, setFrames] = useState<Frame[]>([]);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [loaded, setLoaded] = useState(false);

  // --- données UI ---
  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  const [currentOrderBookData, setCurrentOrderBookData] = useState<{
    book_bid_prices?: number[];
    book_ask_prices?: number[];
    book_bid_sizes?: number[];
    book_ask_sizes?: number[];
  } | null>(null);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<{ symbol: string; quantity: number; averagePrice: number; marketPrice: number }>({
    symbol: 'NQ',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0,
  });
  const [pnl, setPnl] = useState<{ unrealized: number; realized: number; total: number }>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // --- timers / refs ---
  const playbackTimerRef = useRef<number | undefined>(undefined);
  const orderIdCounter = useRef(0);

  // --- processor L2 ---
  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);
  const setViewAnchorPrice = useCallback((price?: number | null) => {
    if (!price && price !== 0) orderBookProcessor.clearAnchor();
    else orderBookProcessor.setAnchorByPrice(price!);
  }, [orderBookProcessor]);

  /** ===================== Agrégation TAS ===================== */
  const [aggregationBuffer, setAggregationBuffer] = useState<Trade[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (aggregationBuffer.length === 0) return;
      setTimeAndSales(prev => {
        const next = [...prev, ...aggregationBuffer];
        return next.slice(-300);
      });
      setAggregationBuffer([]);
    }, 100);
    return () => window.clearInterval(id);
  }, [aggregationBuffer]);

  /** ===================== Chargement CSV ===================== */
  const loadMarketData = useCallback((file: File) => {
    // reset
    setFrames([]);
    setCurrentFrameIndex(0);
    setIsPlaying(false);
    setLoaded(false);

    setTrades([]);
    setCurrentTickLadder(null);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setRealizedPnLTotal(0);
    setVolumeByPrice(new Map());
    orderBookProcessor.resetVolume();

    const reader = new FileReader();
    reader.onload = () => {
      Papa.parse(reader.result as string, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        worker: true,
        complete: (results) => {
          const rows = (results.data as any[]) || [];
          const syncFrames = buildFramesSynced(rows);
          setFrames(syncFrames);
          setLoaded(syncFrames.length > 0);

          // extraire trades & snapshots pour init
          const tradeEvents: OrderBookTrade[] = [];
          const orderbookSnapshots: ParsedOrderBook[] = [];
          for (const f of syncFrames) {
            if (f.trades.length) {
              for (const tr of f.trades) {
                tradeEvents.push({
                  price: tr.price,
                  size: tr.size,
                  aggressor: tr.aggressor || 'BUY',
                  timestamp: new Date(f.t),
                });
              }
            }
            if (f.ob) {
              orderbookSnapshots.push({
                bidPrices: f.ob.bidPrices,
                bidSizes: f.ob.bidSizes,
                bidOrders: [],
                askPrices: f.ob.askPrices,
                askSizes: f.ob.askSizes,
                askOrders: [],
                timestamp: new Date(f.t),
              });
            }
          }
          setTrades(tradeEvents);

          // inférer tick size
          const allPrices = [
            ...tradeEvents.map(t => t.price),
            ...orderbookSnapshots.flatMap(s => [...s.bidPrices, ...s.askPrices]),
          ];
          if (allPrices.length) {
            const inferred = orderBookProcessor.inferTickSize(allPrices);
            orderBookProcessor.setTickSize(inferred);
          }

          // prix initial
          let initialPrice = 0;
          if (tradeEvents.length) initialPrice = tradeEvents[0].price;
          else if (orderbookSnapshots.length) {
            const s0 = orderbookSnapshots[0];
            initialPrice = s0.bidPrices?.[0] ?? s0.askPrices?.[0] ?? 0;
          } else if (syncFrames.length) {
            const f0 = syncFrames[0];
            if (f0.ob) initialPrice = f0.ob.bidPrices?.[0] ?? f0.ob.askPrices?.[0] ?? 0;
            else if (f0.bbo) initialPrice = f0.bbo.bidPrice ?? f0.bbo.askPrice ?? 0;
          }
          setCurrentPrice(toTick(initialPrice));

          // ancre (centrage)
          orderBookProcessor.setAnchorByPrice(initialPrice);

          // ladder initial si dispo
          if (orderbookSnapshots.length) {
            const ladder0 = orderBookProcessor.createTickLadder(orderbookSnapshots[0], tradeEvents);
            setCurrentTickLadder(decorateLadderWithVolume(ladder0, volumeByPrice));
          }
        },
      });
    };
    reader.readAsText(file);
  }, [orderBookProcessor, volumeByPrice]);

  /** ===================== Exécution d'ordres (simplifiée) ===================== */
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    setOrders(prev => [...prev, {
      id: `LMT-${++orderIdCounter.current}`,
      side, price: toTick(price), quantity, filled: 0,
    }]);
  }, []);
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    const px = toTick(currentPrice);
    setOrders(prev => [...prev, {
      id: `MKT-${++orderIdCounter.current}`,
      side, price: px, quantity, filled: 0,
    }]);
  }, [currentPrice]);

  const executeLimitFill = useCallback((order: Order, fillPrice: number) => {
    const px = toTick(fillPrice);
    const qty = order.quantity * (order.side === 'BUY' ? 1 : -1);

    // realized
    const pnlFill = (currentPrice - px) * qty * 20;
    setRealizedPnLTotal(prev => prev + pnlFill);

    // position
    setPosition(prevPos => {
      const newQty = prevPos.quantity + qty;
      let newAvg = prevPos.averagePrice;
      if (newQty === 0) newAvg = 0;
      else {
        const prevAbs = Math.abs(prevPos.quantity);
        const totalQty = prevAbs + qty;
        const prevVal = prevPos.averagePrice * prevAbs;
        const fillVal = px * qty;
        newAvg = (prevVal + fillVal) / Math.max(1, totalQty);
      }
      return { ...prevPos, quantity: newQty, averagePrice: toTick(newAvg), marketPrice: currentPrice };
    });

    // remove order
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, [currentPrice]);

  useEffect(() => {
    setPnl({
      unrealized: (currentPrice - position.averagePrice) * position.quantity * 20,
      realized: realizedPnLTotal,
      total: (currentPrice - position.averagePrice) * position.quantity * 20 + realizedPnLTotal,
    });
  }, [position, currentPrice, realizedPnLTotal]);

  /** ===================== Traitement d’une frame ===================== */
  const processFrame = useCallback((frame: Frame) => {
    // 1) ORDERBOOK → construit le DOM book (quelques niveaux)
    if (frame.ob) {
      const priceMap = new Map<number, OrderBookLevel>();
      const newBook: OrderBookLevel[] = [];

      // bids
      for (let i = 0; i < Math.min(frame.ob.bidPrices.length, 10); i++) {
        const bp = toBidTick(frame.ob.bidPrices[i]);
        const bsz = frame.ob.bidSizes[i] || 0;
        if (bp > 0 && bsz >= 0) {
          const ex = priceMap.get(bp);
          if (ex) ex.bidSize = bsz;
          else {
            const level: OrderBookLevel = { price: bp, bidSize: bsz, askSize: 0, volume: volumeByPrice.get(bp) || 0 };
            priceMap.set(bp, level);
            newBook.push(level);
          }
        }
      }

      // asks
      for (let i = 0; i < Math.min(frame.ob.askPrices.length, 10); i++) {
        const ap = toAskTick(frame.ob.askPrices[i]);
        const asz = frame.ob.askSizes[i] || 0;
        if (ap > 0 && asz >= 0) {
          const ex = priceMap.get(ap);
          if (ex) ex.askSize = asz;
          else {
            const level: OrderBookLevel = { price: ap, bidSize: 0, askSize: asz, volume: volumeByPrice.get(ap) || 0 };
            priceMap.set(ap, level);
            newBook.push(level);
          }
        }
      }

      newBook.sort((a, b) => b.price - a.price);
      setOrderBook(newBook);

      // snapshot compact pour l'effet ladder
      setCurrentOrderBookData({
        book_bid_prices: frame.ob.bidPrices,
        book_ask_prices: frame.ob.askPrices,
        book_bid_sizes: frame.ob.bidSizes,
        book_ask_sizes: frame.ob.askSizes,
      });
    }

    // 2) BBO → L1 aligne prix courant / tailles L1
    if (frame.bbo) {
      setCurrentOrderBookData(prevData => ({
        book_bid_prices: frame.bbo?.bidPrice ? [toBidTick(frame.bbo.bidPrice)] : (prevData?.book_bid_prices ?? []),
        book_ask_prices: frame.bbo?.askPrice ? [toAskTick(frame.bbo.askPrice)] : (prevData?.book_ask_prices ?? []),
        book_bid_sizes: frame.bbo?.bidSize ? [frame.bbo.bidSize] : (prevData?.book_bid_sizes ?? []),
        book_ask_sizes: frame.bbo?.askSize ? [frame.bbo.askSize] : (prevData?.book_ask_sizes ?? []),
      }));

      // prix courant (si info côté bid/ask)
      if (frame.bbo.bidPrice != null) setCurrentPrice(toTick(frame.bbo.bidPrice));
      else if (frame.bbo.askPrice != null) setCurrentPrice(toTick(frame.bbo.askPrice));
    }

    // 3) TRADES → TAS + volume + fills
    if (frame.trades?.length) {
      for (const tr of frame.trades) {
        const px = toTick(tr.price);

        // TAS (merge agressor+price)
        setAggregationBuffer(prev => {
          const last = prev[prev.length - 1];
          if (last && last.price === px && last.aggressor === (tr.aggressor || 'BUY')) {
            const merged = { ...last, size: last.size + tr.size };
            return [...prev.slice(0, -1), merged];
          }
          return [
            ...prev,
            {
              id: `t-${frame.t}-${Math.random()}`,
              timestamp: frame.t,
              price: px,
              size: tr.size,
              aggressor: tr.aggressor || 'BUY',
            },
          ];
        });

        // volume par prix (pour heatmap ladder)
        setVolumeByPrice(prev => {
          const next = new Map(prev);
          const gp = roundToGrid(px);
          next.set(gp, (next.get(gp) ?? 0) + tr.size);
          return next;
        });

        // fills très simplifiés
        setOrders(prev => {
          const updated: Order[] = [];
          for (const o of prev) {
            const shouldExecute = (o.side === 'BUY' && px <= o.price) || (o.side === 'SELL' && px >= o.price);
            if (shouldExecute) {
              // exécute à prix de l'ordre (hypothèse simple)
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              executeLimitFill(o, o.price);
            } else {
              updated.push(o);
            }
          }
          return updated;
        });

        // prix courant suit aussi la dernière transaction
        setCurrentPrice(px);
      }
    }
  }, [volumeByPrice, executeLimitFill]);

  /** ===================== Best bid/ask & spread ===================== */
  const bestBid = useMemo(() => orderBook.find(l => l.bidSize > 0)?.price, [orderBook]);
  const bestAsk = useMemo(() => orderBook.find(l => l.askSize > 0)?.price, [orderBook]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null ? bestAsk - bestBid : undefined), [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null ? Math.round(spread / TICK_SIZE) : undefined), [spread]);

  /** ===================== Rebuild Ladder à chaque MAJ de book ===================== */
  useEffect(() => {
    if (
      !currentOrderBookData ||
      (!currentOrderBookData.book_bid_prices?.length &&
        !currentOrderBookData.book_ask_prices?.length)
    ) {
      return;
    }

    // sécurité : cap profondeur
    const cap = ORDERBOOK_CAP;
    const bidPrices = (currentOrderBookData.book_bid_prices || []).slice(0, cap);
    const bidSizes = (currentOrderBookData.book_bid_sizes || []).slice(0, cap);
    const askPrices = (currentOrderBookData.book_ask_prices || []).slice(0, cap);
    const askSizes = (currentOrderBookData.book_ask_sizes || []).slice(0, cap);

    // snapshot compact pour le processor
    const snapshot: ParsedOrderBook = {
      bidPrices,
      bidSizes,
      bidOrders: [],
      askPrices,
      askSizes,
      askOrders: [],
      timestamp: new Date(),
    };

    const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
    setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
  }, [currentOrderBookData, orderBookProcessor, trades, volumeByPrice]);

  /** ===================== Boucle de lecture (scheduler frames) ===================== */
  useEffect(() => {
    // nettoyage timer au démontage / changement
    return () => {
      if (playbackTimerRef.current) {
        window.clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    if (currentFrameIndex >= frames.length) {
      setIsPlaying(false);
      return;
    }

    const f = frames[currentFrameIndex];
    // traiter la frame courante maintenant
    processFrame(f);

    // planifier la suivante
    if (currentFrameIndex === frames.length - 1) {
      setIsPlaying(false);
      return;
    }
    const nextFrame = frames[currentFrameIndex + 1];
    const dtReal = Math.max(0, nextFrame.t - f.t);
    const baseDelay = dtReal / Math.max(0.1, playbackSpeed);
    const minDelay = playbackSpeed >= 10 ? 1 : playbackSpeed >= 5 ? 10 : 16; // 60fps mini
    const maxDelay = 5000;
    const delay = Math.max(minDelay, Math.min(baseDelay, maxDelay));

    if (playbackTimerRef.current) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = undefined;
    }
    playbackTimerRef.current = window.setTimeout(() => {
      setCurrentFrameIndex(i => i + 1);
    }, delay);
  }, [isPlaying, currentFrameIndex, frames, playbackSpeed, processFrame]);

  /** ===================== Contrôles lecture ===================== */
  const togglePlayback = useCallback(() => {
    if (!loaded || !frames.length) return;
    // si on est à la fin, repartir du début
    if (currentFrameIndex >= frames.length) setCurrentFrameIndex(0);
    setIsPlaying(prev => !prev);
  }, [loaded, frames.length, currentFrameIndex]);

  const setPlaybackSpeedSafe = useCallback((speed: number) => {
    const s = Math.max(0.1, speed);
    setPlaybackSpeed(s);
    // re-scheduler immédiatement si on joue
    if (isPlaying && playbackTimerRef.current) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = undefined;
      // on laisse l'effet planifier avec le nouveau speed au prochain render
      // (processFrame a déjà été appliqué pour l'index courant)
    }
  }, [isPlaying]);

  /** ===================== Export API du hook ===================== */
  return {
    // état lecture
    loaded,
    frames,
    currentFrameIndex,
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed: setPlaybackSpeedSafe,

    // données UI
    orderBook,
    currentOrderBookData,
    currentTickLadder,
    trades,
    timeAndSales,

    // prix & spread
    currentPrice,
    bestBid,
    bestAsk,
    spread,
    spreadTicks,

    // ordres
    orders,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice: (price: number) => setOrders(prev => prev.filter(o => o.price !== price)),

    // position/pnl
    position,
    pnl,

    // fichiers
    loadMarketData,

    // util
    orderBookProcessor,
    setViewAnchorPrice,
  };
}