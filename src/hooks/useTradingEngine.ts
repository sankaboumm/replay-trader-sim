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
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  volume?: number;
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled?: number;
}

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
}

// ---------- helpers ----------
const TICK_SIZE = 0.25;
const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
const toBidTick = (p: number) => Math.floor(p / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil(p / TICK_SIZE) * TICK_SIZE;
const roundToGrid = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;

export function useTradingEngine() {
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);

  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);
  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  const [currentOrderBookData, setCurrentOrderBookData] = useState<{
    book_bid_prices?: number[];
    book_bid_sizes?: number[];
    book_ask_prices?: number[];
    book_ask_sizes?: number[];
  } | null>(null);

  // Top of book (best bid/ask)
  const [topOfBook, setTopOfBook] = useState<{ bid?: number; ask?: number }>({});

  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);

  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);

  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [orders, setOrders] = useState<Order[]>([]);

  const [position, setPosition] = useState<{ symbol: string; quantity: number; averagePrice: number; marketPrice: number }>({
    symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0
  });
  const [pnl, setPnl] = useState<{ unrealized: number; realized: number; total: number }>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);

  // volume by price doit être déclaré avant tout hook qui l'utilise
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // streaming parse
  const fileReaderRef = useRef<FileReader | null>(null);
  const eventsBufferRef = useRef<MarketEvent[]>([]);
  const tradesBufferRef = useRef<OrderBookTrade[]>([]);
  const samplePricesRef = useRef<number[]>([]);
  const tickSizeLockedRef = useRef(false);
  const initialPriceSetRef = useRef(false);

  const [isParsing, setIsParsing] = useState(false);

  const reset = useCallback(() => {
    setMarketData([]);
    setCurrentEventIndex(0);
    setTimeAndSales([]);
    setTrades([]);
    setOrders([]);
    setOrderBook([]);
    setCurrentOrderBookData(null);
    setCurrentTickLadder(null);
    setCurrentPrice(0);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setRealizedPnLTotal(0);
    setTopOfBook({});
    setVolumeByPrice(new Map());
    initialPriceSetRef.current = false;
    orderBookProcessor.resetVolume();
  }, [orderBookProcessor]);

  const normalizeEventType = (v: any): MarketEvent['eventType'] => {
    const s = v?.toString().toUpperCase().trim();
    if (s === 'TRADE' || s === 'T') return 'TRADE';
    if (s === 'BBO' || s === 'QUOTE') return 'BBO';
    if (s === 'ORDERBOOK' || s === 'ORDERBOOK_FULL' || s === 'BOOK' || s === 'OB') return 'ORDERBOOK';
    return 'BBO';
  };

  const normalizeAggressor = (aggressor: any): 'BUY' | 'SELL' | undefined => {
    const a = aggressor?.toString().toUpperCase().trim();
    if (a === 'BUY' || a === 'B') return 'BUY';
    if (a === 'SELL' || a === 'S') return 'SELL';
    return undefined;
  };

  const parseTimestamp = (row: any) => {
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

  const inferTickSize = useCallback((prices: number[]): number => {
    if (prices.length < 2) return TICK_SIZE;
    const sorted = [...prices].sort((a, b) => a - b);
    const diffs = new Set<number>();
    for (let i = 1; i < Math.min(sorted.length, 500); i++) {
      const d = Math.abs(sorted[i] - sorted[i - 1]);
      if (d > 0) diffs.add(Number(d.toFixed(6)));
    }
    const candidates = Array.from(diffs).sort((a, b) => a - b);
    return candidates[0] || TICK_SIZE;
  }, []);

  const flushParsingBuffers = useCallback(() => {
    if (eventsBufferRef.current.length) {
      setMarketData(prev => [...prev, ...eventsBufferRef.current]);
      eventsBufferRef.current = [];
    }
    if (tradesBufferRef.current.length) {
      setTrades(prev => [...prev, ...tradesBufferRef.current]);
      tradesBufferRef.current = [];
    }
    if (samplePricesRef.current.length && !tickSizeLockedRef.current) {
      const inferred = inferTickSize(samplePricesRef.current);
      if (inferred && inferred !== TICK_SIZE) {
        console.log('🔎 Inferred tick size (stream):', inferred);
        orderBookProcessor.setTickSize(inferred as any);
        tickSizeLockedRef.current = true;
      }
    }
  }, [orderBookProcessor, inferTickSize]);

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
  const placeMarketOrder = useCallback((
    side: 'BUY' | 'SELL',
    quantity: number = 1,
    at?: 'BID' | 'ASK'
  ) => {
    let px: number | undefined;
    const bid = topOfBook.bid;
    const ask = topOfBook.ask;

    if (at === 'BID') px = bid;
    else if (at === 'ASK') px = ask;
    else px = (side === 'BUY') ? ask : bid;

    if (px == null || !Number.isFinite(px)) px = currentPrice;
    if (px == null) return;

    setOrders(prev => [...prev, {
      id: `MKT-${++orderIdCounter.current}`,
      side, price: px, quantity, filled: 0
    }]);
  }, [currentPrice, topOfBook]);

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
  }, [aggregationBuffer]);

  const executeLimitFill = useCallback((order: Order, px: number) => {
    const qty = Math.min(order.quantity - (order.filled ?? 0), 1);
    const fillTrade: Trade = {
      id: `fill-${order.id}-${Date.now()}`,
      timestamp: Date.now(),
      price: px,
      size: qty,
      aggressor: order.side === 'BUY' ? 'BUY' : 'SELL'
    };
    setAggregationBuffer(prev => [...prev, fillTrade]);

    const pnlFill = (order.side === 'BUY'
      ? (currentPrice - px) * qty * 20
      : (px - currentPrice) * qty * 20
    );
    setRealizedPnLTotal(prev => prev + pnlFill);

    setPosition(prevPos => {
      const newQty = prevPos.quantity + (order.side === 'BUY' ? qty : -qty);
      let newAvg = prevPos.averagePrice;
      if (newQty === 0) newAvg = 0;
      else if ((prevPos.quantity >= 0 && order.side === 'BUY') || (prevPos.quantity <= 0 && order.side === 'SELL')) {
        const prevAbs = Math.abs(prevPos.quantity);
        const totalQty = prevAbs + (order.side === 'BUY' ? qty : -qty);
        newAvg = (prevPos.averagePrice * prevAbs + px * (order.side === 'BUY' ? qty : -qty)) / (totalQty || 1);
      } else {
        newAvg = prevPos.averagePrice; // réduction de position : on réalise du PnL
      }
      return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: currentPrice || prevPos.marketPrice };
    });
  }, [currentPrice]);

  // ---------- parser + remplissage events ----------
  const processEvent = useCallback((event: MarketEvent) => {
    switch (event.eventType) {
      case 'TRADE': {
        const px = toTick(event.tradePrice!);

        setTimeAndSales(prev => [...prev, {
          id: `TAS-${Date.now()}-${prev.length}`,
          timestamp: event.timestamp,
          price: px,
          size: event.tradeSize!,
          aggressor: event.aggressor!
        }].slice(-1000));

        // volume by price
        const gridPrice = roundToGrid(px);
        setVolumeByPrice(prev => {
          const next = new Map(prev);
          next.set(gridPrice, (next.get(gridPrice) ?? 0) + event.tradeSize!);
          return next;
        });

        setOrderBook(prev =>
          prev.map(level =>
            Math.abs(level.price - gridPrice) < 0.125
              ? { ...level, volume: (level.volume || 0) + (event.tradeSize || 0) }
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
        break;
      }

      case 'BBO': {
        setCurrentOrderBookData(prevData => ({
          book_bid_prices: event.bidPrice ? [toBidTick(event.bidPrice)] : (prevData?.book_bid_prices ?? []),
          book_ask_prices: event.askPrice ? [toAskTick(event.askPrice)] : (prevData?.book_ask_prices ?? []),
          book_bid_sizes:  event.bidSize  ? [event.bidSize]            : (prevData?.book_bid_sizes  ?? []),
          book_ask_sizes:  event.askSize  ? [event.askSize]            : (prevData?.book_ask_sizes  ?? []),
        }));

        // Top-of-book
        setTopOfBook(prev => ({
          bid: event.bidPrice != null ? toBidTick(event.bidPrice) : prev.bid,
          ask: event.askPrice != null ? toAskTick(event.askPrice) : prev.ask,
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
          for (let i = 0; i < event.bookBidPrices.length; i++) {
            const price = toBidTick(event.bookBidPrices[i]);
            const size = event.bookBidSizes[i] || 0;
            const level = priceMap.get(price) || { price, bidSize: 0, askSize: 0 };
            level.bidSize = size;
            priceMap.set(price, level);
          }
        }
        if (event.bookAskPrices && event.bookAskSizes) {
          for (let i = 0; i < event.bookAskPrices.length; i++) {
            const price = toAskTick(event.bookAskPrices[i]);
            const size = event.bookAskSizes[i] || 0;
            const level = priceMap.get(price) || { price, bidSize: 0, askSize: 0 };
            level.askSize = size;
            priceMap.set(price, level);
          }
        }

        const newBook = Array.from(priceMap.values())
          .sort((a, b) => b.price - a.price);
        setOrderBook(newBook);

        setCurrentOrderBookData({
          book_bid_prices: event.bookBidPrices?.map(toBidTick),
          book_bid_sizes:  event.bookBidSizes,
          book_ask_prices: event.bookAskPrices?.map(toAskTick),
          book_ask_sizes:  event.bookAskSizes,
        });

        // Top-of-book depuis book complet
        setTopOfBook(prev => ({
          bid: (event.bookBidPrices && event.bookBidPrices.length > 0) ? toBidTick(event.bookBidPrices[0]) : prev.bid,
          ask: (event.bookAskPrices && event.bookAskPrices.length > 0) ? toAskTick(event.bookAskPrices[0]) : prev.ask,
        }));

        break;
      }
    }
  }, [executeLimitFill, orderBook]);

  // ---------- dérivés best bid/ask & spread ----------
  const bestBid = topOfBook.bid;
  const bestAsk = topOfBook.ask;
  const spread = (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined;
  const spreadTicks = (spread != null) ? Math.round(spread / TICK_SIZE) : undefined;

  // ---------- PnL / Position MTM ----------
  useEffect(() => {
    setPosition(prev => {
      const mp = currentPrice || prev.marketPrice || 0;
      return { ...prev, marketPrice: mp };
    });

    const qty = position.quantity || 0;
    const avg = position.averagePrice || 0;
    const mp = currentPrice || position.marketPrice || 0;
    const unreal = (qty !== 0) ? (mp - avg) * qty * 20 : 0;

    setPnl({
      unrealized: unreal,
      realized: realizedPnLTotal,
      total: realizedPnLTotal + unreal
    });
  }, [currentPrice, position.quantity, position.averagePrice, realizedPnLTotal]);

  // ---------- Refs pour une boucle de replay robuste ----------
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idxRef = useRef(currentEventIndex);
  const speedRef = useRef(playbackSpeed);
  const dataRef = useRef(marketData);
  const flushAggRef = useRef(flushAggregationBuffer);

  useEffect(() => { idxRef.current = currentEventIndex; }, [currentEventIndex]);
  useEffect(() => { speedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { dataRef.current = marketData; }, [marketData]);
  useEffect(() => { flushAggRef.current = flushAggregationBuffer; }, [flushAggregationBuffer]);

  // ---------- playback loop (anti-StrictMode + pas de deps volatiles) ----------
  useEffect(() => {
    if (!isPlaying) {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
      return;
    }

    // Empêche un double démarrage en mode Strict (montage/démontage fantôme)
    if (playbackTimerRef.current) return;

    const tick = () => {
      const data = dataRef.current;
      const idx = idxRef.current;

      if (idx >= data.length) {
        flushAggRef.current?.();
        setIsPlaying(false);
        return;
      }

      const curr = data[idx];
      processEvent(curr);

      let delay = 10;
      if (idx + 1 < data.length) {
        const next = data[idx + 1];
        const timeDiff = Math.max(0, next.timestamp - curr.timestamp);
        const baseDelay = timeDiff / speedRef.current;
        const minDelay = speedRef.current >= 10 ? 1 : (speedRef.current >= 5 ? 5 : 10);
        const maxDelay = 1000;
        delay = Math.max(minDelay, Math.min(baseDelay, maxDelay));
      }

      playbackTimerRef.current = setTimeout(() => {
        playbackTimerRef.current = null; // libère le verrou pour le tick suivant
        setCurrentEventIndex(i => i + 1);
        tick();
      }, delay);
    };

    tick();

    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
    };
  }, [isPlaying, processEvent]);

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
  }, [currentOrderBookData, trades, orderBookProcessor, volumeByPrice]);

  const decorateLadderWithVolume = (ladder: TickLadder, volumeMap: Map<number, number>): TickLadder => {
    return {
      ...ladder,
      levels: ladder.levels.map(level => ({
        ...level,
        volumeCumulative: volumeMap.get(level.price) || 0
      }))
    };
  };

  // ---------- file loading ----------
  const loadMarketData = useCallback((file: File) => {
    reset();
    setIsLoading(true);
    setIsParsing(true);

    Papa.parse<any>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      worker: true,
      chunkSize: 1024 * 128,
      chunk: (results) => {
        const rows = results.data;
        const events: MarketEvent[] = [];

        for (const row of rows) {
          try {
            const eventType = normalizeEventType(row.event_type);
            const timestamp = parseTimestamp(row);

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

                if (!initialPriceSetRef.current) {
                  setCurrentPrice(toTick(price));
                  orderBookProcessor.setAnchorByPrice(price);
                  orderBookProcessor.clearAnchor();
                  initialPriceSetRef.current = true;
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
                events.push({
                  timestamp,
                  eventType: 'BBO',
                  bidPrice: hasB ? bp : undefined,
                  bidSize: !isNaN(bs) ? bs : undefined,
                  askPrice: hasA ? ap : undefined,
                  askSize: !isNaN(as) ? as : undefined
                });
              }
            } else if (eventType === 'ORDERBOOK') {
              const bookBidPrices = parseArrayField(row.book_bid_prices);
              const bookBidSizes  = parseArrayField(row.book_bid_sizes);
              const bookAskPrices = parseArrayField(row.book_ask_prices);
              const bookAskSizes  = parseArrayField(row.book_ask_sizes);

              if (bookBidPrices.length || bookAskPrices.length) {
                events.push({
                  timestamp,
                  eventType: 'ORDERBOOK',
                  bookBidPrices,
                  bookBidSizes,
                  bookAskPrices,
                  bookAskSizes
                });
              }
            }
          } catch {
            // ignore ligne invalide
          }
        }

        if (events.length) eventsBufferRef.current.push(...events);
        flushParsingBuffers();
      },
      complete: () => {
        setIsLoading(false);
        flushParsingBuffers();
        setIsParsing(false);
        setIsPlaying(true); // auto-play comme avant; si tu veux démarrer manuellement, mets false ici.
      },
      error: (err) => {
        console.error('Papa.parse error', err);
        setIsLoading(false);
        setIsParsing(false);
      }
    });
  }, [flushParsingBuffers, orderBookProcessor, reset]);

  // ---------- playback controls ----------
  const togglePlayback = useCallback(() => setIsPlaying(p => !p), []);
  const setPlaybackSpeedWrapper = useCallback((s: number) => setPlaybackSpeed(Math.max(0.25, Math.min(s, 100))), []);

  return {
    // marché
    marketData,
    currentEventIndex,

    // DOM
    orderBook,
    currentTickLadder,
    setViewAnchorPrice,
    bestBid,
    bestAsk,
    spread,
    spreadTicks,

    // TAS & orders
    timeAndSales,
    orders,
    placeLimitOrder,
    cancelOrdersAtPrice,
    placeMarketOrder,

    // prix
    currentPrice,

    // position + PnL
    position,
    pnl,

    // playback
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed: setPlaybackSpeedWrapper,

    // file
    loadMarketData,

    // utils
    orderBookProcessor
  };
}