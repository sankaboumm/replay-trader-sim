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

function decorateLadderWithVolume(ladder: TickLadder | null, volumeMap: Map<number, number>) {
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
    symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0
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

  // ---------- orderbook processor ----------
  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);

  // ---------- FIX: déclarer flushParsingBuffers AVANT loadMarketData ----------
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
    console.log('🔥 loadMarketData (streaming) called with file:', file.name);

    // reset UI state
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    setTrades([]);
    setCurrentTickLadder(null);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setRealizedPnLTotal(0);
    setVolumeByPrice(new Map());
    orderBookProcessor.resetVolume();

    // reset streaming helpers
    eventsBufferRef.current = [];
    tradesBufferRef.current = [];
    samplePricesRef.current = [];
    tickSizeLockedRef.current = false;

    setIsLoading(true);
    let initialPriceSet = false;

    Papa.parse(file, {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      worker: true,
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
              const centeredPrice = toTick(price);
              setCurrentPrice(centeredPrice);
              orderBookProcessor.setAnchorByPrice(centeredPrice);
              initialPriceSet = true;
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
            eventsBufferRef.current.push({
              timestamp,
              eventType: 'BBO',
              bidPrice: hasB ? bp : undefined,
              bidSize: !isNaN(bs) ? bs : undefined,
              askPrice: hasA ? ap : undefined,
              askSize: !isNaN(as) ? as : undefined
            });

            if (!initialPriceSet) {
              const p0 = hasB ? bp : (hasA ? ap : 0);
              if (p0 > 0) {
                const centeredPrice = toTick(p0);
                setCurrentPrice(centeredPrice);
                orderBookProcessor.setAnchorByPrice(centeredPrice);
                initialPriceSet = true;
                samplePricesRef.current.push(p0);
              }
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

            if (!initialPriceSet) {
              const p0 = bidPrices[0] ?? askPrices[0] ?? 0;
              if (p0 > 0) {
                const centeredPrice = toTick(p0);
                setCurrentPrice(centeredPrice);
                orderBookProcessor.setAnchorByPrice(centeredPrice);
                initialPriceSet = true;
              }
            }
          }
        }

        if (!tickSizeLockedRef.current && samplePricesRef.current.length >= 64) {
          const inferred = orderBookProcessor.inferTickSize(samplePricesRef.current);
          if (inferred && inferred > 0) {
            console.log('🔎 Inferred tick size (stream):', inferred);
            orderBookProcessor.setTickSize(inferred as any);
            tickSizeLockedRef.current = true;
          }
        }
      },
      complete: () => {
        setIsLoading(false);
        flushParsingBuffers();
        console.log('✅ Streaming parse complete');
      },
      error: (err) => {
        console.error('❌ Papa.parse error', err);
        setIsLoading(false);
      }
    });
  }, [orderBookProcessor, flushParsingBuffers]);

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
  // ---------- dérivés best bid/ask & spread (déclarés ici) ----------
  const bestBid = useMemo(() => orderBook.find(l => l.bidSize > 0)?.price, [orderBook]);
  const bestAsk = useMemo(() => orderBook.find(l => l.askSize > 0)?.price, [orderBook]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number = 1) => {
    // Pour un ordre market, on prend le meilleur prix disponible
    const bestPrice = side === 'BUY' ? bestAsk : bestBid;
    if (!bestPrice) return;
    
    setOrders(prev => [...prev, {
      id: `MKT-${++orderIdCounter.current}`,
      side, price: bestPrice, quantity, filled: 0
    }]);
  }, [bestBid, bestAsk]);

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
        newAvg = px;
      }
      return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: px };
    });

    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, [currentPrice]);

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
        setOrderBook(newBook);

        setCurrentOrderBookData({
          book_bid_prices: event.bookBidPrices?.map(toBidTick),
          book_bid_sizes:  event.bookBidSizes,
          book_ask_prices: event.bookAskPrices?.map(toAskTick),
          book_ask_sizes:  event.bookAskSizes,
        });

        break;
      }
    }
  }, [executeLimitFill, orderBook, volumeByPrice]);

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
      const delay = Math.max(minDelay, Math.min(baseDelay, maxDelay));

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
        bidPrices: currentOrderBookData.book_bid_prices || [],
        bidSizes:  currentOrderBookData.book_bid_sizes  || [],
        askPrices: currentOrderBookData.book_ask_prices || [],
        askSizes:  currentOrderBookData.book_ask_sizes  || [],
        timestamp: new Date()
      };
      const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
      return;
    }

    if (orderBook.length > 0) {
      const bidLevels = orderBook.filter(l => (l.bidSize || 0) > 0).sort((a,b)=>b.price-a.price);
      const askLevels = orderBook.filter(l => (l.askSize || 0) > 0).sort((a,b)=>a.price-b.price);
      const snapshot: ParsedOrderBook = {
        bidPrices: bidLevels.map(l=>l.price),
        bidSizes:  bidLevels.map(l=>l.bidSize),
        bidOrders: [],
        askPrices: askLevels.map(l=>l.price),
        askSizes:  askLevels.map(l=>l.askSize),
        askOrders: [],
        timestamp: new Date()
      };
      const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
    }
  }, [orderBookProcessor, currentOrderBookData, orderBook, trades, volumeByPrice]);

  // ---------- controls ----------
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => !prev);
  }, []);
  const setPlaybackSpeedSafe = useCallback((speed: number) => setPlaybackSpeed(Math.max(0.1, speed)), []);
  const setPlaybackSpeedWrapper = useCallback((speed: number) => setPlaybackSpeedSafe(speed), [setPlaybackSpeedSafe]);

  // ---------- rendu ----------
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

    // position/pnl
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
    orderBookProcessor,
    currentPrice,
    currentOrderBookData
  };
}