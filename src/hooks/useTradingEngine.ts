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
  // champs bruts éventuels
  [key: string]: any;
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

  // ---------- chargeur CSV ----------
  const loadMarketData = useCallback((file: File) => {
    setIsLoading(true);

    let initialPriceSet = false;

    Papa.parse(file, {
      header: true,
      worker: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      step: (results) => {
        const row = results.data as any;

        // Détection type d’event
        const eventTypeRaw = (row.eventType || row.type || row.EVENT || '').toString().toUpperCase();
        let eventType: MarketEvent['eventType'] | undefined;
        if (eventTypeRaw.includes('TRADE')) eventType = 'TRADE';
        else if (eventTypeRaw.includes('BBO')) eventType = 'BBO';
        else if (eventTypeRaw.includes('ORDERBOOK') || eventTypeRaw.includes('BOOK')) eventType = 'ORDERBOOK';
        else eventType = undefined;

        const timestamp = parseTimestamp(row);

        if (eventType === 'TRADE') {
          // Support colonnes fréquentes
          const price = parseFloat(row.price ?? row.tradePrice ?? row.px);
          const size = parseFloat(row.size ?? row.tradeSize ?? row.qty);
          const aggrRaw = (row.aggressor || row.side || '').toString().toUpperCase();
          const agg: 'BUY' | 'SELL' | undefined = aggrRaw.includes('B') ? 'BUY' : aggrRaw.includes('S') ? 'SELL' : undefined;

          if (!isNaN(price) && !isNaN(size) && agg) {
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

            if (!initialPriceSet && hasB && hasA) {
              setCurrentPrice(toTick((toBidTick(bp) + toAskTick(ap)) / 2));
              orderBookProcessor.setAnchorByPrice((bp + ap) / 2);
              orderBookProcessor.clearAnchor();
              initialPriceSet = true;
            }
          }
        } else if (eventType === 'ORDERBOOK') {
          const bidPrices = parseArrayField(row.book_bid_prices ?? row.bidPrices);
          const bidSizes = parseArrayField(row.book_bid_sizes ?? row.bidSizes);
          const askPrices = parseArrayField(row.book_ask_prices ?? row.askPrices);
          const askSizes = parseArrayField(row.book_ask_sizes ?? row.askSizes);

          if (bidPrices.length || askPrices.length) {
            eventsBufferRef.current.push({
              timestamp,
              eventType: 'ORDERBOOK',
              bookBidPrices: bidPrices,
              bookBidSizes: bidSizes,
              bookAskPrices: askPrices,
              bookAskSizes: askSizes
            });

            if (!initialPriceSet) {
              const bestBid = bidPrices.length ? Math.max(...bidPrices) : undefined;
              const bestAsk = askPrices.length ? Math.min(...askPrices) : undefined;
              if (bestBid && bestAsk) {
                const mid = toTick((toBidTick(bestBid) + toAskTick(bestAsk)) / 2);
                setCurrentPrice(mid);
                orderBookProcessor.setAnchorByPrice(mid);
                orderBookProcessor.clearAnchor();
                initialPriceSet = true;
              }
            }
          }
        }
      },
      complete: () => {
        if (eventsBufferRef.current.length) {
          setMarketData(prev => [...prev, ...eventsBufferRef.current]);
          eventsBufferRef.current = [];
        }
        setIsLoading(false);
      },
      error: () => setIsLoading(false),
    });
  }, [orderBookProcessor]);

  // ---------- OrderBookProcessor / TickLadder ----------
  const orderBookProcessor = useRef(new OrderBookProcessor(TICK_SIZE)).current;

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

  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // MODIF MINIMALE : Market = meilleur bid/ask + exécution immédiate
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number = 1) => {
    // Exécution MKT au meilleur prix offert :
    // BUY -> meilleur bid, SELL -> meilleur ask.
    // On n'altère pas la lecture CSV, le play button ni l'animation DOM.
    let bestBidPx: number | undefined;
    let bestAskPx: number | undefined;

    // L'orderBook est trié par prix décroissant ; on prend le 1er niveau
    // ayant de la taille du côté concerné.
    for (const level of orderBook) {
      if (bestBidPx === undefined && level.bidSize > 0) bestBidPx = level.price;
      if (bestAskPx === undefined && level.askSize > 0) bestAskPx = level.price;
      if (bestBidPx !== undefined && bestAskPx !== undefined) break;
    }

    const execPx = side === 'BUY'
      ? (bestBidPx ?? currentPrice)
      : (bestAskPx ?? currentPrice);

    if (!execPx) return;

    // Un market ne s'empile pas dans la file d'ordres : on exécute immédiatement
    const ord: Order = {
      id: `MKT-${++orderIdCounter.current}`,
      side,
      price: execPx,
      quantity,
      filled: 0
    };
    executeLimitFill(ord, execPx);
  }, [orderBook, currentPrice, executeLimitFill]);
  // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

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

          // alimentation TAS (avec merge basique si même prix / même agresseur)
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

  // ---------- flush buffers pendant chargement/lecture ----------
  const flushParsingBuffers = useCallback(() => {
    if (eventsBufferRef.current.length > 0) {
      setMarketData(prev => [...prev, ...eventsBufferRef.current]);
      eventsBufferRef.current = [];
    }
    if (tradesBufferRef.current.length > 0) {
      setTrades(prev => [...prev, ...tradesBufferRef.current]);
      tradesBufferRef.current = [];
    }
  }, []);

  // ---------- playback loop ----------
  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) {
      if (!isPlaying) flushAggregationBuffer();
      return;
    }

    const currentEvent = marketData[currentEventIndex];
    processEvent(currentEvent);

    const delay = Math.max(1, Math.round(1000 / playbackSpeed));
    playbackTimerRef.current = setTimeout(() => {
      setCurrentEventIndex(i => i + 1);
    }, delay);

    if (currentEventIndex + 1 >= marketData.length) {
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
    setViewAnchorPrice
  };
}