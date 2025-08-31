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
  bidPrice?: number;
  askPrice?: number;
  bidSize?: number;
  askSize?: number;
  bookBidPrices?: number[];
  bookBidSizes?: number[];
  bookAskPrices?: number[];
  bookAskSizes?: number[];
  [key: string]: any;
}

interface Trade {
  id: string;
  timestamp: number;
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
  volume: number;
}

const TICK_SIZE = 0.25;
const ORDERBOOK_CAP = 200;

const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
const toBidTick = (p: number) => Math.floor(p / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil(p / TICK_SIZE) * TICK_SIZE;
const roundToGrid = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;

const decorateLadderWithVolume = (ladder: TickLadder | null, volumeMap: Map<number, number>) => {
  if (!ladder) return ladder;
  const levels = ladder.levels.map(l => ({
    ...l,
    volumeCumulative: volumeMap.get(roundToGrid(l.price)) ?? 0
  }));
  return { ...ladder, levels };
};

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

  const [position, setPosition] = useState<{ symbol: string; quantity: number; averagePrice: number; marketPrice: number }>({
    symbol: 'NQ',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0
  });
  const [pnl, setPnl] = useState<{ unrealized: number; realized: number; total: number }>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);

  // streaming parse
  const [isLoading, setIsLoading] = useState(false);
  const eventsBufferRef = useRef<MarketEvent[]>([]);
  const tradesBufferRef = useRef<OrderBookTrade[]>([]);
  const samplePricesRef = useRef<number[]>([]);
  const tickSizeLockedRef = useRef(false);

  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // ---------- helpers ----------
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
      if (!isNaN(ssboe) && !isNaN(usecs)) {
        return ssboe * 1000 + Math.floor(usecs / 1000);
      }
    }
    return Date.now();
  };

  const parseArrayField = (value: unknown): number[] => {
    if (value == null) return [];
    if (Array.isArray(value)) return value.map(Number).filter(n => Number.isFinite(n));
    const s = String(value);
    try {
      if (s.trim().startsWith('[')) return (JSON.parse(s) as any[]).map(Number).filter(Number.isFinite);
      const cleaned = value.toString().replace(/^\[|\]$/g, '').trim();
      if (!cleaned) return [];
      return cleaned
        .split(/[\s,]+/)
        .map(v => parseFloat(v))
        .filter(v => !isNaN(v));
    } catch {
      return [];
    }
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

  // ---------- flush buffers (déclaré tôt) ----------
  const flushParsingBuffers = useCallback(() => {
    if (eventsBufferRef.current.length > 0) {
      const chunk = eventsBufferRef.current.splice(0, eventsBufferRef.current.length);
      setMarketData(prev => prev.concat(chunk));
    }
    if (tradesBufferRef.current.length > 0) {
      const tchunk = tradesBufferRef.current.splice(0, tradesBufferRef.current.length);
      setTrades(prev => prev.concat(tchunk));
    }
  }, []);

  // ---------- loader (streaming) ----------
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
    // NOTE: on ne remet PAS realizedPnLTotal à 0 ici - il persiste pendant la session
    setVolumeByPrice(new Map());
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
          const price = parseFloat(row.trade_price);
          const size  = parseFloat(row.trade_size);
          const agg   = normalizeAggressor(row.aggressor);
          if (!isNaN(price) && price > 0 && !isNaN(size) && size > 0 && agg) {
            const t = orderBookProcessor.parseTrade(row);
            if (t) {
              tradesBufferRef.current.push(t);
              samplePricesRef.current.push(t.price);
            }
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
          const bp = parseFloat(row.bid_price);
          const ap = parseFloat(row.ask_price);
          const bs = parseFloat(row.bid_size);
          const as = parseFloat(row.ask_size);
          const hasB = !isNaN(bp) && bp > 0;
          const hasA = !isNaN(ap) && ap > 0;

          if (hasB || hasA) {
            setCurrentOrderBookData(prevData => ({
              book_bid_prices: hasB ? [toBidTick(bp)] : (prevData?.book_bid_prices ?? []),
              book_ask_prices: hasA ? [toAskTick(ap)] : (prevData?.book_ask_prices ?? []),
              book_bid_sizes:  !isNaN(bs) ? [bs] : (prevData?.book_bid_sizes ?? []),
              book_ask_sizes:  !isNaN(as) ? [as] : (prevData?.book_ask_sizes ?? []),
            }));

            if (!initialPriceSet && hasB && hasA) {
              const mid = toTick((toBidTick(bp) + toAskTick(ap)) / 2);
              setCurrentPrice(mid);
              orderBookProcessor.setAnchorByPrice(mid);
              orderBookProcessor.clearAnchor();
              initialPriceSet = true;
              const p0 = (bp + ap) / 2;
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

            eventsBufferRef.current.push({
              timestamp,
              eventType: 'ORDERBOOK',
              bookBidPrices: bidPrices,
              bookBidSizes:  bidSizes,
              bookAskPrices: askPrices,
              bookAskSizes:  askSizes
            });

            // Snapshot courant pour best bid/ask
            setCurrentOrderBookData({
              book_bid_prices: bidPrices.map(toBidTick),
              book_bid_sizes:  bidSizes,
              book_ask_prices: askPrices.map(toAskTick),
              book_ask_sizes:  askSizes,
            });

            if (!initialPriceSet) {
              const bestBid0 = bidPrices.length ? Math.max(...bidPrices) : undefined;
              const bestAsk0 = askPrices.length ? Math.min(...askPrices) : undefined;
              if (bestBid0 && bestAsk0) {
                const p0 = (toBidTick(bestBid0) + toAskTick(bestAsk0)) / 2;
                setCurrentPrice(toTick(p0));
                orderBookProcessor.setAnchorByPrice(p0);
                orderBookProcessor.clearAnchor();
                initialPriceSet = true;
                samplePricesRef.current.push(p0);
              }
            }
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
  const [aggregationBuffer, setAggregationBuffer] = useState<Trade[]>([]);
  const flushAggregationBuffer = useCallback(() => {
    if (aggregationBuffer.length > 0) {
      setTimeAndSales(prev => {
        const merged = [...prev, ...aggregationBuffer];
        return merged.slice(-1000);
      });
      setAggregationBuffer([]);
    }
  }, [aggregationBuffer, setTimeAndSales]);

  // ************** PnL CORRIGÉ **************
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

    // Calcul realized: uniquement si on RÉDUIT la position existante
    let realizedDelta = 0;

    setPosition(prevPos => {
      const sideDir = order.side === 'BUY' ? +1 : -1;
      const prevQty = prevPos.quantity;          // peut être négatif (short)
      const prevAvg = prevPos.averagePrice || 0; // prix moyen de la position actuelle
      const newQty = prevQty + sideDir * fillQty;

      // Même sens ou ouverture (aucun realized)
      if (prevQty === 0 || Math.sign(prevQty) === sideDir) {
        const absPrev = Math.abs(prevQty);
        const absNew = absPrev + fillQty;
        const newAvg = absNew > 0 ? (prevAvg * absPrev + px * fillQty) / absNew : 0;
        return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: px };
      }

      // Sens opposé : on ferme partiellement/totalement
      const closeQty = Math.min(Math.abs(prevQty), fillQty);

      if (prevQty > 0) {
        // On était long, on vend => realized = (px - prevAvg) * closeQty
        realizedDelta += (px - prevAvg) * closeQty * contractMultiplier;
      } else if (prevQty < 0) {
        // On était short, on achète => realized = (prevAvg - px) * closeQty
        realizedDelta += (prevAvg - px) * closeQty * contractMultiplier;
      }

      const remainingQty = fillQty - closeQty; // reliquat pour flip éventuel

      // Cas 1 : on ne flip pas (on reste avec une position du même signe que prevQty)
      if (remainingQty === 0 && newQty !== 0 && Math.sign(newQty) === Math.sign(prevQty)) {
        // moyenne inchangée quand on réduit sans flip
        return { ...prevPos, quantity: newQty, averagePrice: prevAvg, marketPrice: px };
      }

      // Cas 2 : on ferme totalement
      if (newQty === 0) {
        return { ...prevPos, quantity: 0, averagePrice: 0, marketPrice: px };
      }

      // Cas 3 : on flip (on ouvre dans l'autre sens avec le reliquat)
      // la nouvelle moyenne = prix du fill
      return { ...prevPos, quantity: newQty, averagePrice: px, marketPrice: px };
    });

    if (realizedDelta !== 0) {
      setRealizedPnLTotal(prev => prev + realizedDelta);
    }

    // On retire l'ordre de la file (ordre exécuté)
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, []);

  // ---------- Orders ----------
  const orderIdCounter = useRef(0);
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
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
    let bb: number | undefined;
    let ba: number | undefined;
    if (snap) {
      const { book_bid_prices = [], book_bid_sizes = [], book_ask_prices = [], book_ask_sizes = [] } = snap;
      for (let i = 0; i < Math.min(book_bid_prices.length, book_bid_sizes.length); i++) {
        const sz = book_bid_sizes[i];
        const px = book_bid_prices[i];
        if (sz > 0 && Number.isFinite(px)) {
          bb = bb === undefined ? px : (px > bb ? px : bb);
        }
      }
      for (let i = 0; i < Math.min(book_ask_prices.length, book_ask_sizes.length); i++) {
        const sz = book_ask_sizes[i];
        const px = book_ask_prices[i];
        if (sz > 0 && Number.isFinite(px)) {
          ba = ba === undefined ? px : (px < ba ? px : ba);
        }
      }
    }
    return { bb, ba };
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

  // MARKET = best bid/ask (BBO prioritaire) + exécution immédiate
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number = 1) => {
    const { bestBid, bestAsk } = getBestBidAsk();
    const execPx = side === 'BUY' ? (bestBid ?? currentPrice) : (bestAsk ?? currentPrice);
    if (execPx == null) return;

    const ord: Order = {
      id: `MKT-${++orderIdCounter.current}`,
      side,
      price: execPx,
      quantity,
      filled: 0
    };
    executeLimitFill(ord, execPx);
  }, [getBestBidAsk, currentPrice, executeLimitFill]);

  // ---------- periodic UI flush while loading or playing ----------
  useEffect(() => {
    if (!(isLoading || isPlaying)) return;
    const id = setInterval(() => {
      flushAggregationBuffer();
      flushParsingBuffers();
    }, 50);
    return () => clearInterval(id);
  }, [isLoading, isPlaying, flushAggregationBuffer, flushParsingBuffers]);

  // ---------- EVENT PROCESSOR ----------
  const processEvent = useCallback((event: MarketEvent) => {
    if (!event) return;

    switch (event.eventType) {
      case 'TRADE': {
        if (event.tradePrice && event.tradeSize && event.aggressor) {
          const px = toTick(event.tradePrice);
          const trade: Trade = {
            id: `trade-${Date.now()}-${Math.random()}`,
            timestamp: event.timestamp,
            price: px,
            size: event.tradeSize,
            aggressor: event.aggressor
          };

          // alimentation TAS (merge basique si même prix / même agresseur)
          setAggregationBuffer(prev => {
            const last = prev[prev.length - 1];
            if (last && last.price === trade.price && last.aggressor === trade.aggressor) {
              const merged = { ...last, size: last.size + trade.size };
              return [...prev.slice(0, -1), merged];
            }
            return [...prev, trade];
          });

          setCurrentPrice(px);

          const gridPrice = roundToGrid(px);
          setVolumeByPrice(prev => {
            const next = new Map(prev);
            next.set(gridPrice, (next.get(gridPrice) ?? 0) + event.tradeSize);
            return next;
          });

          setOrderBook(prev =>
            prev.map(level =>
              Math.abs(level.price - gridPrice) < 0.125
                ? { ...level, volume: (level.volume || 0) + event.tradeSize! }
                : level
            )
          );

          setOrders(prev => {
            const updated: Order[] = [];
            for (const o of prev) {
              const should =
                (o.side === 'BUY'  && px <= o.price) ||
                (o.side === 'SELL' && px >= o.price);
              if (should) {
                executeLimitFill(o, o.price);
              } else {
                updated.push(o);
              }
            }
            return updated;
          });
        }
        break;
      }

      case 'BBO': {
        setCurrentOrderBookData(prevData => ({
          book_bid_prices: event.bidPrice ? [toBidTick(event.bidPrice)] : (prevData?.book_bid_prices ?? []),
          book_ask_prices: event.askPrice ? [toAskTick(event.askPrice)] : (prevData?.book_ask_prices ?? []),
          book_bid_sizes:  event.bidSize  ? [event.bidSize]            : (prevData?.book_bid_sizes  ?? []),
          book_ask_sizes:  event.askSize  ? [event.askSize]            : (prevData?.book_ask_sizes  ?? []),
        }));

        if (event.bidPrice && event.askPrice) {
          const mid = toTick((toBidTick(event.bidPrice) + toAskTick(event.askPrice)) / 2);
          setCurrentPrice(mid);
        }
        break;
      }

      case 'ORDERBOOK': {
        const priceMap = new Map<number, OrderBookLevel>();
        for (const l of orderBook) priceMap.set(l.price, l);

        if (event.bookBidPrices && event.bookBidSizes) {
          for (let i = 0; i < Math.min(event.bookBidPrices.length, 10); i++) {
            const bp = toBidTick(event.bookBidPrices[i]);
            const bsz = event.bookBidSizes[i] || 0;
            if (bp > 0 && bsz >= 0) {
              const ex = priceMap.get(bp);
              if (ex) ex.bidSize = bsz;
              else {
                const level: OrderBookLevel = { price: bp, bidSize: bsz, askSize: 0, volume: volumeByPrice.get(bp) || 0 };
                priceMap.set(bp, level);
              }
            }
          }
        }

        if (event.bookAskPrices && event.bookAskSizes) {
          for (let i = 0; i < Math.min(event.bookAskPrices.length, 10); i++) {
            const ap = toAskTick(event.bookAskPrices[i]);
            const asz = event.bookAskSizes[i] || 0;
            if (ap > 0 && asz >= 0) {
              const ex = priceMap.get(ap);
              if (ex) ex.askSize = asz;
              else {
                const level: OrderBookLevel = { price: ap, bidSize: 0, askSize: asz, volume: volumeByPrice.get(ap) || 0 };
                priceMap.set(ap, level);
              }
            }
          }
        }

        const newBook = Array.from(priceMap.values());
        newBook.sort((a, b) => b.price - a.price);
        setOrderBook(newBook.slice(0, ORDERBOOK_CAP));

        setCurrentOrderBookData({
          book_bid_prices: event.bookBidPrices?.map(toBidTick),
          book_bid_sizes:  event.bookBidSizes,
          book_ask_prices: event.bookAskPrices?.map(toAskTick),
          book_ask_sizes:  event.bookAskSizes,
        });

        // Reconstruire le ladder avec volume cumulé
        const snapshot: ParsedOrderBook = {
          bidPrices: (event.bookBidPrices || []).map(toBidTick),
          bidSizes:  (event.bookBidSizes  || []),
          askPrices: (event.bookAskPrices || []).map(toAskTick),
          askSizes:  (event.bookAskSizes  || []),
          timestamp: new Date()
        };
        const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
        setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));

        break;
      }
    }
  }, [executeLimitFill, orderBook, volumeByPrice, orderBookProcessor, trades]);

  // ---------- dérivés best bid/ask & spread (BBO prioritaire) ----------
  const { bestBid, bestAsk } = useMemo(() => {
    return getBestBidAsk();
  }, [getBestBidAsk]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);

  // ---------- playback loop ----------
  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) return;

    const currentEvent = marketData[currentEventIndex];
    processEvent(currentEvent);

    const nextIndex = currentEventIndex + 1;
    setCurrentEventIndex(nextIndex);

    if (nextIndex < marketData.length) {
      const nextEvent = marketData[nextIndex];
      const timeDiff = Math.max(0, nextEvent.timestamp - currentEvent.timestamp);
      const baseDelay = timeDiff / playbackSpeed;
      const minDelay = playbackSpeed >= 10 ? 1 : (playbackSpeed >= 5 ? 5 : 10);
      const maxDelay = 1000;
      const delay = Math.min(Math.max(baseDelay, minDelay), maxDelay);

      playbackTimerRef.current = setTimeout(() => {}, delay);
    } else {
      flushAggregationBuffer();
      setIsPlaying(false);
    }

    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent, flushAggregationBuffer]);

  // ---------- View anchor ----------
  const setViewAnchorPrice = useCallback((price: number | null) => {
    if (price == null) orderBookProcessor.clearAnchor();
    else orderBookProcessor.setAnchorByPrice(price);

    if (currentOrderBookData) {
      const snapshot = {
        bidPrices: (currentOrderBookData.book_bid_prices || []),
        bidSizes:  (currentOrderBookData.book_bid_sizes  || []),
        askPrices: (currentOrderBookData.book_ask_prices || []),
        askSizes:  (currentOrderBookData.book_ask_sizes  || []),
        timestamp: new Date()
      } as ParsedOrderBook;
      const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
    }
  }, [orderBookProcessor, currentOrderBookData, trades, volumeByPrice]);

  // ---------- Rebuild ladder ----------
  useEffect(() => {
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
    setPnl({
      unrealized: unreal,
      realized: realizedPnLTotal,
      total: unreal + realizedPnLTotal
    });
  }, [currentPrice, position, realizedPnLTotal]);

  // ---------- contrôles playback ----------
  const togglePlayback = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  const setPlaybackSpeedWrapper = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
  }, []);

  return {
    // état
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