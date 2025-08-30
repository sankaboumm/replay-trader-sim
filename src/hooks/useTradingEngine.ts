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

export function useTradingEngine() {
  // ---------- ETAT PRINCIPAL ----------
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [currentPrice, setCurrentPrice] = useState<number>(0);

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
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') {
      // parse "1,2,3" or "[1,2,3]"
      try {
        if (value.trim().startsWith('[')) {
          const arr = JSON.parse(value) as any[];
          return arr.map(Number);
        }
        return value.split(/[;,\s]+/).map(Number).filter(v => !isNaN(v));
      } catch {
        return [];
      }
    }
    return [];
  };

  // ---------- chargeur CSV ----------
  const loadMarketData = useCallback((file: File) => {
    setIsLoading(true);

    Papa.parse(file, {
      header: true,
      worker: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      step: (results) => {
        const row = results.data as any;

        const eventTypeRaw = (row.eventType || row.type || row.EVENT || '').toString().toUpperCase();
        let eventType: MarketEvent['eventType'] | undefined;
        if (eventTypeRaw.includes('TRADE')) eventType = 'TRADE';
        else if (eventTypeRaw.includes('BBO')) eventType = 'BBO';
        else if (eventTypeRaw.includes('ORDERBOOK') || eventTypeRaw.includes('BOOK')) eventType = 'ORDERBOOK';
        else eventType = 'TRADE'; // fallback minimal

        const timestamp = parseTimestamp(row);

        const event: MarketEvent = {
          timestamp,
          eventType,
        };

        // TRADE
        if (eventType === 'TRADE') {
          event.tradePrice = Number(row.price ?? row.tradePrice ?? row.px);
          event.tradeSize = Number(row.size ?? row.tradeSize ?? row.qty);
          const aggrRaw = (row.aggressor || row.side || '').toString().toUpperCase();
          event.aggressor = aggrRaw.includes('B') ? 'BUY' : 'SELL';
        }

        // BBO
        if (eventType === 'BBO') {
          event.bidPrice = Number(row.bidPrice ?? row.bid);
          event.askPrice = Number(row.askPrice ?? row.ask);
          event.bidSize = Number(row.bidSize ?? row.bidsz ?? row.bidSize0);
          event.askSize = Number(row.askSize ?? row.asksz ?? row.askSize0);
        }

        // ORDERBOOK (top 10 de chaque côté par défaut)
        if (eventType === 'ORDERBOOK') {
          event.bookBidPrices = parseArrayField(row.book_bid_prices ?? row.bidPrices);
          event.bookBidSizes = parseArrayField(row.book_bid_sizes ?? row.bidSizes);
          event.bookAskPrices = parseArrayField(row.book_ask_prices ?? row.askPrices);
          event.bookAskSizes = parseArrayField(row.book_ask_sizes ?? row.askSizes);
        }

        eventsBufferRef.current.push(event);
        if (eventsBufferRef.current.length >= 500) {
          setMarketData(prev => [...prev, ...eventsBufferRef.current]);
          eventsBufferRef.current = [];
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
  }, []);

  // ---------- OrderBookProcessor / TickLadder ----------
  const orderBookProcessor = useRef(new OrderBookProcessor(TICK_SIZE)).current;
  const setViewAnchorPrice = useCallback((price: number | null) => {
    if (price == null) orderBookProcessor.clearAnchor();
    else orderBookProcessor.setAnchorByPrice(price);
  }, [orderBookProcessor]);

  const rebuildTickLadder = useCallback(() => {
    if (!currentOrderBookData) return;

    const parsed: ParsedOrderBook = {
      bidPrices: currentOrderBookData.book_bid_prices || [],
      bidSizes: currentOrderBookData.book_bid_sizes || [],
      askPrices: currentOrderBookData.book_ask_prices || [],
      askSizes: currentOrderBookData.book_ask_sizes || [],
      // orders & trades facultatifs dans cette implémentation
    };
    const ladder = orderBookProcessor.buildTickLadder(parsed);
    setCurrentTickLadder(ladder);
  }, [currentOrderBookData, orderBookProcessor]);

  useEffect(() => {
    rebuildTickLadder();
  }, [rebuildTickLadder]);

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

  // *** MODIFIÉ ***
  // Exécution "market" au meilleur prix offert : BUY -> best bid, SELL -> best ask
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number = 1) => {
    // Détermination du prix d'exécution "market"
    const bb = orderBook.find(l => l.bidSize > 0)?.price; // meilleur bid (prix le plus haut côté acheteurs)
    const ba = orderBook.find(l => l.askSize > 0)?.price; // meilleur ask (prix le plus bas côté vendeurs)

    let execPx: number | undefined;
    if (side === 'BUY') {
      execPx = bb ?? currentPrice;
    } else {
      execPx = ba ?? currentPrice;
    }
    if (execPx == null) return;

    // Simule une exécution immédiate au meilleur prix disponible
    const ord: Order = {
      id: `MKT-${++orderIdCounter.current}`,
      side,
      price: execPx,
      quantity,
      filled: 0
    };
    // Un ordre "market" ne reste pas dans le carnet : on l'exécute tout de suite
    executeLimitFill(ord, execPx);
  }, [orderBook, currentPrice, executeLimitFill]);

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
    }, 100);
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
  const bestBid = useMemo(() => orderBook.find(l => l.bidSize > 0)?.price, [orderBook]);
  const bestAsk = useMemo(() => orderBook.find(l => l.askSize > 0)?.price, [orderBook]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);

  // ---------- playback loop ----------
  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) return;

    const currentEvent = marketData[currentEventIndex];
    processEvent(currentEvent);

    const delay = Math.max(1, Math.round(1000 / playbackSpeed));
    playbackTimerRef.current = setTimeout(() => {
      setCurrentEventIndex(i => i + 1);
    }, delay);

    return () => {
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent]);

  // ---------- flush buffers pendant chargement/lecture ----------
  const flushParsingBuffers = useCallback(() => {
    if (eventsBufferRef.current.length > 0) {
      setMarketData(prev => [...prev, ...eventsBufferRef.current]);
      eventsBufferRef.current = [];
    }
    if (tradesBufferRef.current.length > 0) {
      tradesBufferRef.current = [];
    }
  }, []);

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

    // nouveaux dérivés
    orderBookProcessor,
    setViewAnchorPrice,
    bestBid,
    bestAsk,
    spread,
    spreadTicks,
  };
}