// src/hooks/useTradingEngine.ts
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  OrderBookProcessor,
  ParsedOrderBook,
  Trade as OrderBookTrade,
  TickLadder
} from '@/lib/orderbook';

interface MarketEvent {
  timestamp: number;
  eventType: 'TRADE' | 'BBO' | 'ORDERBOOK';
  tradePrice?: number;
  tradeSize?: number;
  aggressor?: 'BUY' | 'SELL';
  // BBO snapshot (optionnel)
  best_bid_price?: number;
  best_bid_size?: number;
  best_ask_price?: number;
  best_ask_size?: number;
  // ORDERBOOK snapshot (optionnel)
  book_bid_prices?: string | number[]; // csv "[]" ou tableau
  book_bid_sizes?: string | number[];
  book_ask_prices?: string | number[];
  book_ask_sizes?: string | number[];
}

type Side = 'BUY' | 'SELL';

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: Side;
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  volume: number;
}

interface Order {
  id: string;
  side: Side;
  price: number;
  quantity: number;
  filled?: number;
}

const TICK_SIZE = 0.25;
const ORDERBOOK_CAP = 40;

const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
const toBidTick = (p: number) => Math.floor(p / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil(p / TICK_SIZE) * TICK_SIZE;

export function useTradingEngine() {
  // ---------- états principaux ----------
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  const [currentOrderBookData, setCurrentOrderBookData] = useState<{
    book_bid_prices?: number[];
    book_bid_sizes?: number[];
    book_ask_prices?: number[];
    book_ask_sizes?: number[];
  } | null>(null);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);

  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);

  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [orders, setOrders] = useState<Order[]>([]);

  const [position, setPosition] = useState<{
    symbol: string;
    quantity: number;       // >0 long, <0 short
    averagePrice: number;   // prix moyen de la position en cours
    marketPrice: number;    // dernier prix
  }>({
    symbol: 'NQ',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0
  });

  const [pnl, setPnl] = useState<{ unrealized: number; realized: number; total: number }>({
    unrealized: 0,
    realized: 0,
    total: 0
  });

  // ✅ Cumul du PnL réalisé pendant la session (remis à 0 au nouvel import CSV — option 2)
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);

  // streaming parse
  const [isLoading, setIsLoading] = useState(false);
  const eventsBufferRef = useRef<MarketEvent[]>([]);
  const tradesBufferRef = useRef<OrderBookTrade[]>([]);
  const samplePricesRef = useRef<number[]>([]);
  const tickSizeLockedRef = useRef(false);

  const [aggregationBuffer, setAggregationBuffer] = useState<Trade[]>([]);
  useEffect(() => {
    const id = setInterval(() => {
      if (aggregationBuffer.length > 0) {
        setTimeAndSales(prev => {
          const merged = [...prev, ...aggregationBuffer];
          return merged.slice(-1000);
        });
        setAggregationBuffer([]);
      }
    }, 80);
    return () => clearInterval(id);
  }, [aggregationBuffer]);

  // ---------- helpers parsing ----------
  const parseTimestamp = (row: any): number => {
    if (row.timestamp) {
      const t = +new Date(row.timestamp);
      if (!isNaN(t)) return t;
    }
    if (row.ts || row.time) {
      const t = +new Date(row.ts || row.time);
      if (!isNaN(t)) return t;
    }
    if (row.ssboe && row.usecs) {
      const ssboe = parseInt(row.ssboe, 10);
      const usecs = parseInt(row.usecs, 10);
      if (!isNaN(ssboe) && !isNaN(usecs)) return ssboe * 1000 + Math.floor(usecs / 1000);
    }
    return Date.now();
  };

  const parseNumber = (v: any): number | undefined => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  };

  const parseArrayField = (v: any): number[] => {
    if (Array.isArray(v)) return v.map(Number).filter(x => !isNaN(x));
    if (typeof v === 'string') {
      try {
        const arr = JSON.parse(v);
        if (Array.isArray(arr)) return arr.map(Number).filter(x => !isNaN(x));
      } catch {
        // "1,2,3"
        return v.split(/[,\s]+/).map(Number).filter(x => !isNaN(x));
      }
    }
    return [];
  };

  const normalizeEventType = (et: any): MarketEvent['eventType'] => {
    const s = et?.toString().toUpperCase().trim();
    if (s?.includes('TRADE')) return 'TRADE';
    if (s?.includes('ORDERBOOK') || s?.includes('BOOK')) return 'ORDERBOOK';
    if (s?.includes('BBO') || s?.includes('QUOTE') || s?.includes('NBBO') || s?.includes('OB')) return 'BBO';
    return 'BBO';
  };

  const normalizeAggressor = (aggressor: any): 'BUY' | 'SELL' | undefined => {
    const a = aggressor?.toString().toUpperCase().trim();
    if (a === 'BUY' || a === 'B') return 'BUY';
    if (a === 'SELL' || a === 'S') return 'SELL';
    return undefined;
  };

  // ---------- orderbook processor ----------
  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);

  // ---------- flush buffers ----------
  const flushParsingBuffers = useCallback(() => {
    if (eventsBufferRef.current.length > 0) {
      const chunk = eventsBufferRef.current.splice(0, eventsBufferRef.current.length);
      setMarketData(prev => prev.concat(chunk));
    }
    if (tradesBufferRef.current.length > 0) {
      const chunk = tradesBufferRef.current.splice(0, tradesBufferRef.current.length);
      setTrades(prev => prev.concat(chunk).slice(-5000));
    }
    if (samplePricesRef.current.length > 0 && !tickSizeLockedRef.current) {
      // lock ticksize once we saw enough samples
      if (samplePricesRef.current.length > 50) {
        tickSizeLockedRef.current = true;
      }
    }
  }, []);

  useEffect(() => {
    const id = setInterval(flushParsingBuffers, 60);
    return () => clearInterval(id);
  }, [flushParsingBuffers]);

  // ---------- chargement CSV ----------
  const loadMarketData = useCallback((file: File) => {
    setIsLoading(true);
    setIsPlaying(false);
    setMarketData([]);
    setCurrentEventIndex(0);
    setTimeAndSales([]);
    setTrades([]);
    setCurrentPrice(0);
    setCurrentOrderBookData(null);
    setCurrentTickLadder(null);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setRealizedPnLTotal(0); // reset session cumulative realized on new CSV
    // realizedPnLTotal est remis à 0 au nouvel import (option 2)
    eventsBufferRef.current = [];
    tradesBufferRef.current = [];
    samplePricesRef.current = [];
    tickSizeLockedRef.current = false;

    let initialPriceSet = false;

    Papa.parse(file, {
      header: true,
      worker: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      step: (results) => {
        const row: any = results.data;
        if (!row || Object.keys(row).length === 0) return;

        const timestamp = parseTimestamp(row);
        const eventType = normalizeEventType(row.event_type);

        if (eventType === 'TRADE') {
          const price = parseNumber(row.price) ?? parseNumber(row.trade_price) ?? parseNumber(row.last_price);
          const size = parseNumber(row.size) ?? parseNumber(row.trade_size) ?? 1;
          const agg = normalizeAggressor(row.aggressor);

          if (price != null) {
            const p = toTick(price);
            setCurrentPrice(p);
            samplePricesRef.current.push(price);

            const t: OrderBookTrade | undefined = (price != null && size != null && agg)
              ? { price, size, aggressor: agg }
              : undefined;
            if (t) tradesBufferRef.current.push(t);

            eventsBufferRef.current.push({
              timestamp,
              eventType: 'TRADE',
              tradePrice: price,
              tradeSize: size,
              aggressor: agg
            });

            if (!initialPriceSet) {
              setCurrentPrice(toTick(price));
              orderBookProcessor.setAnchorByPrice(price);
              orderBookProcessor.clearAnchor();
              initialPriceSet = true;
              samplePricesRef.current.push(price);
            }
          }
        } else if (eventType === 'BBO') {
          const bp = parseNumber(row.bid_price);
          const ap = parseNumber(row.ask_price);
          const bs = parseNumber(row.bid_size);
          const as = parseNumber(row.ask_size);
          const hasB = bp != null && !isNaN(bp) && bp > 0;
          const hasA = ap != null && !isNaN(ap) && ap > 0;

          if (hasB || hasA) {
            setCurrentOrderBookData(prevData => ({
              book_bid_prices: hasB ? [toBidTick(bp!)] : (prevData?.book_bid_prices ?? []),
              book_ask_prices: hasA ? [toAskTick(ap!)] : (prevData?.book_ask_prices ?? []),
              book_bid_sizes:  (bs != null && !isNaN(bs)) ? [bs] : (prevData?.book_bid_sizes ?? []),
              book_ask_sizes:  (as != null && !isNaN(as)) ? [as] : (prevData?.book_ask_sizes ?? []),
            }));

            if (!initialPriceSet && hasB && hasA) {
              const mid = toTick((toBidTick(bp!) + toAskTick(ap!)) / 2);
              setCurrentPrice(mid);
              orderBookProcessor.setAnchorByPrice(mid);
              orderBookProcessor.clearAnchor();
              initialPriceSet = true;
              const p0 = (bp! + ap!) / 2;
              samplePricesRef.current.push(p0);
            }
          }
        } else if (eventType === 'ORDERBOOK') {
          const bidPrices = parseArrayField(row.book_bid_prices);
          const bidSizes  = parseArrayField(row.book_bid_sizes);
          const askPrices = parseArrayField(row.book_ask_prices);
          const askSizes  = parseArrayField(row.book_ask_sizes);

          if ((bidPrices.length || askPrices.length) &&
              bidPrices.length === bidSizes.length &&
              askPrices.length === askSizes.length) {

            for (const p of bidPrices) samplePricesRef.current.push(p);
            for (const p of askPrices) samplePricesRef.current.push(p);

            setCurrentOrderBookData({
              book_bid_prices: bidPrices.map(toBidTick),
              book_bid_sizes:  bidSizes,
              book_ask_prices: askPrices.map(toAskTick),
              book_ask_sizes:  askSizes
            });
          }
        }
      },
      chunk: () => {
        flushParsingBuffers();
      },
      complete: () => {
        flushParsingBuffers();
        setIsLoading(false);
      },
      error: () => setIsLoading(false)
    });
  }, [orderBookProcessor, flushParsingBuffers]);

  // ---------- AGRÉGATION TAS ----------
  const [aggregationBuffer, setAggregationBufferState] = useState<Trade[]>([]);
  const flushAggregationBuffer = useCallback(() => {
    if (aggregationBuffer.length === 0) return;
    setTimeAndSales(prev => [...prev, ...aggregationBuffer].slice(-1000));
    setAggregationBufferState([]);
  }, [aggregationBuffer]);
  useEffect(() => {
    const id = setInterval(flushAggregationBuffer, 80);
    return () => clearInterval(id);
  }, [flushAggregationBuffer]);

  // ---------- volume cumul ----------
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    if (trades.length === 0) return;
    setVolumeByPrice(prev => {
      const next = new Map(prev);
      const t = trades[trades.length - 1];
      const k = toTick(t.price);
      next.set(k, (next.get(k) ?? 0) + (t.size ?? 0));
      return next;
    });
  }, [trades]);

  const roundToGrid = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
  const decorateLadderWithVolume = (ladder: TickLadder | null, volumeMap: Map<number, number>) => {
    if (!ladder) return null;
    const levels = ladder.levels.map(l => ({
      ...l,
      volumeCumulative: volumeMap.get(roundToGrid(l.price)) ?? 0
    }));
    return { ...ladder, levels };
  };

  // ************** PnL corrigé (cumulé) **************
  const executeLimitFill = useCallback((order: Order, px: number) => {
    const contractMultiplier = 20; // NQ
    const fillQty = Math.min(order.quantity - (order.filled ?? 0), 1);

    // Ajout TAS (fill)
    const fillTrade: Trade = {
      id: `fill-${order.id}-${Date.now()}`,
      timestamp: Date.now(),
      price: px,
      size: fillQty,
      aggressor: order.side === 'BUY' ? 'BUY' : 'SELL'
    };
    setAggregationBuffer(prev => [...prev, fillTrade]);

    // Calculer le realized PnL AVANT de modifier la position
    let realizedDelta = 0;

    setPosition(prevPos => {
      const sideDir = order.side === 'BUY' ? +1 : -1;
      const prevQty = prevPos.quantity;          // peut être négatif (short)
      const prevAvg = prevPos.averagePrice || 0; // prix moyen
      const newQty = prevQty + sideDir * fillQty;

      // Même sens (ouverture / ajout de taille) => pas de realized
      if (prevQty === 0 || Math.sign(prevQty) === sideDir) {
        const absPrev = Math.abs(prevQty);
        const absNew = absPrev + fillQty;
        const newAvg = absNew > 0 ? (prevAvg * absPrev + px * fillQty) / absNew : 0;
        return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: px };
      }

      // Sens opposé : on ferme partiellement/totalement
      const closeQty = Math.min(Math.abs(prevQty), fillQty);

      if (prevQty > 0) {
        // on était long, on vend => (px - prevAvg) * closeQty
        realizedDelta = (px - prevAvg) * closeQty * contractMultiplier;
      } else if (prevQty < 0) {
        // on était short, on achète => (prevAvg - px) * closeQty
        realizedDelta = (prevAvg - px) * closeQty * contractMultiplier;
      }

      const remainingQty = fillQty - closeQty; // reliquat pour flip éventuel

      // Réduction sans flip
      if (remainingQty === 0 && Math.sign(newQty) === Math.sign(prevQty) && newQty !== 0) {
        return { ...prevPos, quantity: newQty, averagePrice: prevAvg, marketPrice: px };
      }

      // À plat
      if (newQty === 0) {
        return { ...prevPos, quantity: 0, averagePrice: 0, marketPrice: px };
      }

      // Flip : reliquat ouvre position opposée au prix du fill
      const flippedQty = sideDir * remainingQty;
      return { ...prevPos, quantity: flippedQty, averagePrice: px, marketPrice: px };
    });

    // Cumul réalisé de session (ne JAMAIS remettre à 0 en fermant la position; seulement au nouvel import)
    if (realizedDelta !== 0) {
      setRealizedPnLTotal(prev => {
        const newTotal = prev + realizedDelta;
        return newTotal;
      });
    }

    // Retirer l'ordre
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, []);

  // ---------- Orders ----------
  const orderIdCounter = useRef(0);
  const placeLimitOrder = useCallback((side: Side, price: number, quantity: number) => {
    setOrders(prev => [...prev, {
      id: `LMT-${++orderIdCounter.current}`,
      side, price, quantity, filled: 0
    }]);
  }, []);
  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(o => o.price !== price));
  }, []);

  // Helpers best bid/ask
  const bestFromBbo = useCallback((snap: {
    book_bid_prices?: number[];
    book_bid_sizes?: number[];
    book_ask_prices?: number[];
    book_ask_sizes?: number[];
  } | null) => {
    if (!snap) return { bb: undefined, ba: undefined };
    const bids = snap.book_bid_prices ?? [];
    const asks = snap.book_ask_prices ?? [];
    return {
      bb: bids.length ? Math.max(...bids) : undefined,
      ba: asks.length ? Math.min(...asks) : undefined
    };
  }, []);

  const bestFromAggregated = useCallback((book: OrderBookLevel[]) => {
    let bb: number | undefined;
    let ba: number | undefined;
    for (const l of book) {
      if (l.bidSize > 0) bb = bb === undefined ? l.price : (l.price > bb ? l.price : bb);
      if (l.askSize > 0) ba = ba === undefined ? l.price : (l.price < ba ? l.price : ba);
    }
    return { bb, ba };
  }, []);

  const getBestBidAsk = useCallback(() => {
    const { bb: bb1, ba: ba1 } = bestFromBbo(currentOrderBookData);
    if (bb1 !== undefined || ba1 !== undefined) return { bestBid: bb1, bestAsk: ba1 };
    const { bb: bb2, ba: ba2 } = bestFromAggregated(orderBook);
    if (bb2 !== undefined || ba2 !== undefined) return { bestBid: bb2, bestAsk: ba2 };
    return { bestBid: undefined, bestAsk: undefined };
  }, [currentOrderBookData, orderBook, bestFromBbo, bestFromAggregated]);

  // MARKET = on tape le meilleur prix dispo (BBO si dispo sinon last)
  const placeMarketOrder = useCallback((side: Side, quantity: number = 1) => {
    const { bestBid, bestAsk } = getBestBidAsk();
    const execPx = side === 'BUY'
      ? (bestAsk ?? currentPrice)   // on achète au meilleur ask
      : (bestBid ?? currentPrice);  // on vend au meilleur bid
    if (execPx == null) return;

    const ord: Order = {
      id: `MKT-${++orderIdCounter.current}`,
      side,
      price: execPx,
      quantity,
      filled: 0
    };
    executeLimitFill(ord, execPx);
  }, [currentPrice, getBestBidAsk, executeLimitFill]);

  // Simu de matching très simple : si le prix “passe” sur un limit, on exécute au prix de l’ordre
  useEffect(() => {
    if (orders.length === 0) return;
    const last = currentPrice;
    const toFill = orders.filter(o =>
      (o.side === 'BUY'  && last <= o.price) ||
      (o.side === 'SELL' && last >= o.price)
    );
    toFill.forEach(o => executeLimitFill(o, o.price));
  }, [currentPrice, orders, executeLimitFill]);

  // ---------- Order Book (snapshot -> ladder) ----------
  const setViewAnchorPrice = useCallback((price: number) => {
    orderBookProcessor.setAnchorByPrice(price);
  }, [orderBookProcessor]);

  const [bestBid, setBestBid] = useState<number | undefined>(undefined);
  const [bestAsk, setBestAsk] = useState<number | undefined>(undefined);
  const [spread, setSpread] = useState<number | undefined>(undefined);
  const [spreadTicks, setSpreadTicks] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (currentOrderBookData) {
      const { bb, ba } = bestFromBbo(currentOrderBookData);
      setBestBid(bb);
      setBestAsk(ba);
      if (bb != null && ba != null) {
        const s = ba - bb;
        setSpread(s);
        setSpreadTicks(s / TICK_SIZE);
      } else {
        setSpread(undefined);
        setSpreadTicks(undefined);
      }
    } else {
      // fallback sur le book agrégé
      const { bb, ba } = bestFromAggregated(orderBook);
      setBestBid(bb);
      setBestAsk(ba);
      if (bb != null && ba != null) {
        const s = ba - bb;
        setSpread(s);
        setSpreadTicks(s / TICK_SIZE);
      } else {
        setSpread(undefined);
        setSpreadTicks(undefined);
      }
    }
  }, [currentOrderBookData, orderBook, bestFromBbo, bestFromAggregated]);

  useEffect(() => {
    // reconstruire ladder si on a un snapshot valide
    if (currentOrderBookData) {
      const snapshot: ParsedOrderBook = {
        bidPrices: (currentOrderBookData.book_bid_prices || []),
        bidSizes:  (currentOrderBookData.book_bid_sizes  || []),
        askPrices: (currentOrderBookData.book_ask_prices || []),
        askSizes:  (currentOrderBookData.book_ask_sizes  || []),
        timestamp: new Date()
      };
      const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
    }
  }, [currentOrderBookData, orderBookProcessor, trades, volumeByPrice]);

  // ---------- PnL ----------
  useEffect(() => {
    const unreal = (currentPrice - position.averagePrice) * position.quantity * 20;
    const newPnl = {
      unrealized: unreal,
      realized: realizedPnLTotal,
      total: unreal + realizedPnLTotal
    };
    console.log(`📊 PnL Update: unrealized=${unreal.toFixed(2)}, realized=${realizedPnLTotal.toFixed(2)}, total=${newPnl.total.toFixed(2)}`);
    setPnl(newPnl);
  }, [currentPrice, position, realizedPnLTotal]);

  // ---------- contrôles playback ----------
  const togglePlayback = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  const setPlaybackSpeedWrapper = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
      return;
    }
    if (currentEventIndex >= marketData.length - 1) {
      setIsPlaying(false);
      return;
    }
    playbackTimerRef.current = setTimeout(() => {
      const next = currentEventIndex + 1;
      setCurrentEventIndex(next);
      const ev = marketData[next];
      if (ev?.eventType === 'TRADE' && ev.tradePrice != null) {
        setCurrentPrice(toTick(ev.tradePrice));
      } else if (ev?.eventType === 'BBO') {
        const bp = ev.best_bid_price;
        const ap = ev.best_ask_price;
        if (bp != null && ap != null) {
          setCurrentPrice(toTick((toBidTick(bp) + toAskTick(ap)) / 2));
        }
      }
    }, Math.max(10, 120 / playbackSpeed));

    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
    };
  }, [isPlaying, playbackSpeed, currentEventIndex, marketData]);

  return {
    // state
    isLoading,

    marketData,
    currentEventIndex,
    currentPrice,
    orders,
    position,
    pnl,
    timeAndSales,

    // DOM
    currentTickLadder,

    // ordres
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,

    // playback
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed: setPlaybackSpeedWrapper,

    // file
    loadMarketData,

    // utils
    orderBookProcessor,
    setViewAnchorPrice,
    bestBid,
    bestAsk,
    spread,
    spreadTicks,
  };
}