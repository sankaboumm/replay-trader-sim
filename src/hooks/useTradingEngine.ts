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
  bidSize?: number;
  askPrice?: number;
  askSize?: number;
  bookBidPrices?: number[];
  bookBidSizes?: number[];
  bookAskPrices?: number[];
  bookAskSizes?: number[];
}

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
  let initialPriceSet = false;

  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  const parseTimestamp = (row: any): number => {
    const t = row?.timestamp ?? row?.time ?? row?.ts;
    const n = typeof t === 'string' ? Date.parse(t) : (typeof t === 'number' ? t : 0);
    return Number.isFinite(n) ? n : Date.now();
  };

  const parseArrayField = (v: any): number[] => {
    try {
      const cleaned = (v ?? '').toString().replace(/[\[\]]/g, '');
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
      setMarketData(prev => {
        const merged = [...prev, ...eventsBufferRef.current];
        return merged;
      });
      eventsBufferRef.current = [];
    }
    if (tradesBufferRef.current.length > 0) {
      setTrades(prev => {
        const merged = [...prev, ...tradesBufferRef.current];
        return merged;
      });
      tradesBufferRef.current = [];
    }
    if (samplePricesRef.current.length > 0) {
      // agrège un volume total par niveau de prix pour l’affichage latéral
      setVolumeByPrice(prev => {
        const next = new Map(prev);
        for (const p of samplePricesRef.current) {
          const gp = roundToGrid(p);
          next.set(gp, (next.get(gp) ?? 0) + 1);
        }
        return next;
      });
      samplePricesRef.current = [];
    }
  }, []);

  const loadMarketData = useCallback((file: File) => {
    setIsLoading(true);
    setMarketData([]);
    setTimeAndSales([]);
    setTrades([]);
    setOrderBook([]);
    setCurrentOrderBookData(null);
    setCurrentTickLadder(null);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setCurrentPrice(0);
    initialPriceSet = false;

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
              setCurrentPrice(toTick(price));
              orderBookProcessor.setAnchorByPrice(price);
              orderBookProcessor.clearAnchor();
              initialPriceSet = true;
            }
          }
        } else if (eventType === 'BBO') {
          const bid = parseFloat(row.bid_price);
          const ask = parseFloat(row.ask_price);
          const bsz = parseFloat(row.bid_size);
          const asz = parseFloat(row.ask_size);

          if (!isNaN(bid) && !isNaN(ask) && bid > 0 && ask > 0) {
            eventsBufferRef.current.push({
              timestamp,
              eventType: 'BBO',
              bidPrice: bid, bidSize: bsz,
              askPrice: ask, askSize: asz
            });

            if (!initialPriceSet) {
              const mid0 = toTick((toBidTick(bid) + toAskTick(ask)) / 2);
              setCurrentPrice(mid0);
              orderBookProcessor.setAnchorByPrice(mid0);
              orderBookProcessor.clearAnchor();
              initialPriceSet = true;
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
                setCurrentPrice(toTick(p0));
                orderBookProcessor.setAnchorByPrice(p0);
                orderBookProcessor.clearAnchor();
                initialPriceSet = true;
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
      error: () => {
        setIsLoading(false);
      }
    });
  }, [flushParsingBuffers, orderBookProcessor]);

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

  // ---------- FILL LIMIT (déclaré AVANT placeMarketOrder pour éviter TDZ) ----------
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
      ? (currentPrice ? currentPrice - px : 0)
      : (currentPrice ? px - currentPrice : 0)
    ) * qty;

    setPnl(prev => {
      const realized = prev.realized + pnlFill;
      const total = realized + prev.unrealized;
      return { ...prev, realized, total };
    });

    setPosition(prevPos => {
      const prevAbs = Math.abs(prevPos.quantity);
      const newQty = prevPos.quantity + (order.side === 'BUY' ? qty : -qty);
      let newAvg = prevPos.averagePrice;
      if (prevAbs !== 0 && Math.sign(prevPos.quantity) === Math.sign(newQty)) {
        const totalQty = prevAbs + (order.side === 'BUY' ? qty : -qty);
        newAvg = (prevPos.averagePrice * prevAbs + px * (order.side === 'BUY' ? qty : -qty)) / (totalQty || 1);
      } else {
        newAvg = px;
      }
      return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: px };
    });

    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, [currentPrice]);

  // ---------- ORDRES ----------
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
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL') => {
    // Exécuter immédiatement au meilleur prix offert
    const bookPx = side === 'BUY' ? bestAskRef.current : bestBidRef.current;
    const px = (bookPx ?? currentPrice);
    if (!px || !Number.isFinite(px)) return;

    const order: Order = {
      id: `MKT-${++orderIdCounter.current}`,
      side,
      price: px,
      quantity: 1,
      filled: 0,
    };

    // Ajoute puis exécute instantanément pour conserver les side-effects homogènes
    setOrders(prev => [...prev, order]);
    executeLimitFill(order, px);
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, [currentPrice, executeLimitFill]);

  // ---------- periodic UI flush while loading or playing ----------
  useEffect(() => {
    if (!(isLoading || isPlaying)) return;
    const id = setInterval(() => {
      flushAggregationBuffer();
    }, 50);
    return () => clearInterval(id);
  }, [isLoading, isPlaying, flushAggregationBuffer]);

  // ---------- event processor ----------
  const processEvent = useCallback((event: MarketEvent) => {
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

          // exécutions limites
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
            return updated.slice(0, ORDERBOOK_CAP);
          });
        }
        break;
      }

      case 'BBO': {
        if (event.bidPrice != null && event.askPrice != null) {
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

  // ---------- dérivés best bid/ask & spread ----------
  const bestBid = useMemo(() => {
    let maxPx = -Infinity;
    for (const l of orderBook) if ((l.bidSize ?? 0) > 0 && l.price > maxPx) maxPx = l.price;
    return Number.isFinite(maxPx) ? maxPx : undefined;
  }, [orderBook]);
  const bestAsk = useMemo(() => {
    let minPx = Infinity;
    for (const l of orderBook) if ((l.askSize ?? 0) > 0 && l.price < minPx) minPx = l.price;
    return Number.isFinite(minPx) ? minPx : undefined;
  }, [orderBook]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);
  
  // Garde BBO dans des refs pour usage immédiat (MARKET)
  const bestBidRef = useRef<number | undefined>(undefined);
  const bestAskRef = useRef<number | undefined>(undefined);
  useEffect(() => { bestBidRef.current = bestBid; bestAskRef.current = bestAsk; }, [bestBid, bestAsk]);
  
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
    if (price == null) {
      orderBookProcessor.clearAnchor();
    } else {
      orderBookProcessor.setAnchorByPrice(price);
    }

    if (currentOrderBookData) {
      const snapshot: ParsedOrderBook = {
        bidPrices: currentOrderBookData.book_bid_prices ?? [],
        bidSizes:  currentOrderBookData.book_bid_sizes  ?? [],
        bidOrders: [],
        askPrices: currentOrderBookData.book_ask_prices ?? [],
        askSizes:  currentOrderBookData.book_ask_sizes  ?? [],
        askOrders: [],
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
    trades,
    currentPrice,
    orders,
    position,
    pnl,
    realizedPnLTotal,

    // ordres
    placeLimitOrder,
    cancelOrdersAtPrice,
    placeMarketOrder,

    // playback
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed: setPlaybackSpeedWrapper,

    // file
    loadMarketData,

    // utils
    orderBookProcessor,
    setViewAnchorPrice
  };
}