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
  timestamp?: number | Date;
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
}

export function useTradingEngine() {
  // ---------- ÉTATS ----------
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

  const [isLoading, setIsLoading] = useState(false);
  const eventsBufferRef = useRef<MarketEvent[]>([]);
  const tradesBufferRef = useRef<OrderBookTrade[]>([]);
  const samplePricesRef = useRef<number[]>([]);
  const tickSizeLockedRef = useRef(false);

  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());
  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);

  // ---------- HELPERS ----------
  function parseTimestamp(row: any): number {
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
  }

  function parseArrayField(value: unknown): number[] {
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
  }

  function normalizeEventType(v: any): MarketEvent['eventType'] {
    const s = v?.toString().toUpperCase().trim();
    if (s === 'TRADE' || s === 'T') return 'TRADE';
    if (s === 'BBO' || s === 'QUOTE') return 'BBO';
    if (s === 'ORDERBOOK' || s === 'ORDERBOOK_FULL' || s === 'BOOK' || s === 'OB') return 'ORDERBOOK';
    return 'BBO';
  }

  function normalizeAggressor(aggressor: any): 'BUY' | 'SELL' | undefined {
    const a = aggressor?.toString().toUpperCase().trim();
    if (a === 'BUY' || a === 'B') return 'BUY';
    if (a === 'SELL' || a === 'S') return 'SELL';
    return undefined;
  }

  // ---------- AGRÉGATION T&S (functions HOISTED) ----------
  const [aggregationBuffer, setAggregationBuffer] = useState<Trade[]>([]);
  function flushAggregationBuffer() {
    if (aggregationBuffer.length === 0) return;
    setTimeAndSales(prev => {
      const merged = [...prev, ...aggregationBuffer];
      return merged.slice(-1000);
    });
    setAggregationBuffer([]);
  }

  // ---------- FILLS (function HOISTED) ----------
  const orderIdCounter = useRef(0);

  function executeLimitFill(order: Order, px: number) {
    const qty = Math.min(order.quantity - (order.filled ?? 0), 1);

    // Enregistrer le fill côté T&S
    const fillTrade: Trade = {
      id: `fill-${order.id}-${Date.now()}`,
      timestamp: Date.now(),
      price: px,
      size: qty,
      aggressor: order.side === 'BUY' ? 'BUY' : 'SELL'
    };
    setAggregationBuffer(prev => [...prev, fillTrade]);

    // Position + realized PnL
    setPosition(prevPos => {
      const prevQty = prevPos.quantity;
      const prevAvg = prevPos.averagePrice;

      const delta = order.side === 'BUY' ? qty : -qty;
      const newQty = prevQty + delta;

      let realizedDelta = 0;
      const isClosing = (prevQty > 0 && order.side === 'SELL') || (prevQty < 0 && order.side === 'BUY');
      if (isClosing) {
        const closedQty = Math.min(Math.abs(prevQty), qty);
        if (closedQty > 0) {
          if (prevQty > 0 && order.side === 'SELL') {
            realizedDelta += (px - prevAvg) * closedQty * 20;
          } else if (prevQty < 0 && order.side === 'BUY') {
            realizedDelta += (prevAvg - px) * closedQty * 20;
          }
        }
      }

      if (realizedDelta !== 0) setRealizedPnLTotal(prev => prev + realizedDelta);

      let newAvg = prevAvg;
      if (newQty === 0) {
        newAvg = 0;
      } else if ((prevQty > 0 && newQty < 0) || (prevQty < 0 && newQty > 0)) {
        // flip
        newAvg = px;
      } else if ((prevQty >= 0 && order.side === 'BUY') || (prevQty <= 0 && order.side === 'SELL')) {
        // même sens → moyenne pondérée
        const prevAbs = Math.abs(prevQty);
        const addAbs  = qty;
        const totalAbs = prevAbs + addAbs;
        newAvg = totalAbs > 0 ? ((prevAvg * prevAbs) + (px * addAbs)) / totalAbs : px;
      }

      return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: px };
    });

    // retirer l’ordre “travaillant” s’il existait
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }

  // ---------- ORDERS (callbacks légers ; dépendent de fonctions hoistées) ----------
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
    // BBO en priorité, sinon book, sinon prix courant
    const bboBid = currentOrderBookData?.book_bid_prices?.[0] != null
      ? toBidTick(currentOrderBookData.book_bid_prices[0]!)
      : undefined;
    const bboAsk = currentOrderBookData?.book_ask_prices?.[0] != null
      ? toAskTick(currentOrderBookData.book_ask_prices[0]!)
      : undefined;

    const obBestBid = orderBook.find(l => l.bidSize > 0)?.price;
    const obBestAsk = orderBook.find(l => l.askSize > 0)?.price;

    // Market-at-touch : BUY => bestBid ; SELL => bestAsk
    const px = side === 'BUY'
      ? (bboBid ?? obBestBid ?? currentPrice)
      : (bboAsk ?? obBestAsk ?? currentPrice);

    if (!px || !Number.isFinite(px)) return;

    const tmpOrder: Order = { id: `MKT-${++orderIdCounter.current}`, side, price: px, quantity: 1, filled: 0 };
    executeLimitFill(tmpOrder, px);
  }, [currentOrderBookData, orderBook, currentPrice]); // executeLimitFill est hoisté (pas de TDZ)

  // ---------- PARSING (function HOISTED) ----------
  function flushParsingBuffers() {
    if (tradesBufferRef.current.length > 0) {
      setTrades(prev => {
        const merged = [...prev, ...tradesBufferRef.current];
        return merged.slice(-2000);
      });
      tradesBufferRef.current = [];
    }

    if (eventsBufferRef.current.length > 0) {
      setMarketData(prev => [...prev, ...eventsBufferRef.current]);
      eventsBufferRef.current = [];
    }
  }

  // ---------- LOAD MARKET DATA (function HOISTED) ----------
  function loadMarketData(file: File) {
    // reset UI
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
          const price = parseFloat(row.price ?? row.trade_price ?? row.last_price);
          const size = parseFloat(row.size ?? row.trade_size ?? row.last_size);
          const agg = normalizeAggressor(row.aggressor ?? row.side ?? row.buy_sell);
          if (!isNaN(price) && !isNaN(size) && agg) {
            tradesBufferRef.current.push({ timestamp, price, size, aggressor: agg });
            eventsBufferRef.current.push({ timestamp, eventType: 'TRADE', tradePrice: price, tradeSize: size, aggressor: agg });

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
              bidSize:  !isNaN(bs) ? bs : undefined,
              askPrice: hasA ? ap : undefined,
              askSize:  !isNaN(as) ? as : undefined
            });

            if (!initialPriceSet) {
              const p0 = hasB ? bp : (hasA ? ap : 0);
              if (p0 > 0) {
                setCurrentPrice(toTick(p0));
                orderBookProcessor.setAnchorByPrice(p0);
                orderBookProcessor.clearAnchor();
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

          if ((bidPrices.length && bidSizes.length) || (askPrices.length && askSizes.length)) {
            eventsBufferRef.current.push({
              timestamp,
              eventType: 'ORDERBOOK',
              bookBidPrices: bidPrices,
              bookBidSizes: bidSizes,
              bookAskPrices: askPrices,
              bookAskSizes: askSizes
            });

            if (!initialPriceSet) {
              const p0 = [...bidPrices, ...askPrices][0];
              if (p0) {
                setCurrentPrice(toTick(p0));
                orderBookProcessor.setAnchorByPrice(p0);
                orderBookProcessor.clearAnchor();
                initialPriceSet = true;
                samplePricesRef.current.push(p0);
              }
            }
          }
        }

        if (!tickSizeLockedRef.current && samplePricesRef.current.length >= 64) {
          const inferred = orderBookProcessor.inferTickSize(samplePricesRef.current);
          if (inferred && inferred > 0) {
            // eslint-disable-next-line no-console
            console.log('🔎 Inferred tick size (stream):', inferred);
            orderBookProcessor.setTickSize(inferred as any);
            tickSizeLockedRef.current = true;
          }
        }
      },
      complete: () => {
        setIsLoading(false);
        flushParsingBuffers();
        // eslint-disable-next-line no-console
        console.log('✅ Streaming parse complete');
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.error('❌ Papa.parse error', err);
        setIsLoading(false);
      }
    });
  }

  // ---------- EVENT PROCESSOR (function HOISTED) ----------
  function processEvent(event: MarketEvent) {
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
              else priceMap.set(bp, { price: bp, bidSize: bsz, askSize: 0, volume: volumeByPrice.get(bp) || 0 });
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
              else priceMap.set(ap, { price: ap, bidSize: 0, askSize: asz, volume: volumeByPrice.get(ap) || 0 });
            }
          }
        }

        const newBook = Array.from(priceMap.values()).sort((a, b) => b.price - a.price);
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
  }

  // ---------- PNL (recalc continu) ----------
  useEffect(() => {
    const multiplier = 20; // $/point
    const unreal = (currentPrice - position.averagePrice) * position.quantity * multiplier;
    const realized = realizedPnLTotal;
    const total = unreal + realized;
    setPnl({ unrealized: unreal, realized, total });
  }, [currentPrice, position.averagePrice, position.quantity, realizedPnLTotal]);

  // ---------- FLUSH PENDANT LECTURE/CHARGEMENT ----------
  useEffect(() => {
    if (!(isLoading || isPlaying)) return;
    const id = setInterval(() => {
      flushAggregationBuffer();
      flushParsingBuffers();
    }, 50);
    return () => clearInterval(id);
  }, [isLoading, isPlaying, aggregationBuffer]); // flush* sont hoistés → pas de TDZ

  // ---------- VIEW ANCHOR ----------
  const setViewAnchorPrice = useCallback((price: number | null) => {
    if (price == null) orderBookProcessor.clearAnchor();
    else orderBookProcessor.setAnchorByPrice(price);

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
    }
  }, [orderBookProcessor, currentOrderBookData, trades, volumeByPrice]);

  // ---------- REBUILD LADDER SUR MÀJ BBO/BOOK ----------
  useEffect(() => {
    if (!currentOrderBookData) return;
    const snapshot: ParsedOrderBook = {
      bidPrices: currentOrderBookData.book_bid_prices || [],
      bidSizes:  currentOrderBookData.book_bid_sizes  || [],
      askPrices: currentOrderBookData.book_ask_prices || [],
      askSizes:  currentOrderBookData.book_ask_sizes  || [],
      timestamp: new Date()
    };
    const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
    setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
  }, [currentOrderBookData, orderBookProcessor, trades, volumeByPrice]);

  // ---------- LOOP DE LECTURE ----------
  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) return;

    const currentEvent = marketData[currentEventIndex];
    processEvent(currentEvent);

    const nextIndex = currentEventIndex + 1;
    setCurrentEventIndex(nextIndex);

    if (nextIndex < marketData.length) {
      const dt = Math.max(1, Math.floor(10 / playbackSpeed));
      playbackTimerRef.current = setTimeout(() => {}, dt);
    } else {
      flushAggregationBuffer();
      setIsPlaying(false);
    }

    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed]); // processEvent hoisté

  // ---------- DÉRIVÉS BEST BID/ASK + SPREAD ----------
  const bestBid = useMemo(() => {
    const fromBbo = currentOrderBookData?.book_bid_prices?.[0];
    if (fromBbo != null) return toBidTick(fromBbo);
    return orderBook.find(l => l.bidSize > 0)?.price;
  }, [currentOrderBookData, orderBook]);

  const bestAsk = useMemo(() => {
    const fromBbo = currentOrderBookData?.book_ask_prices?.[0];
    if (fromBbo != null) return toAskTick(fromBbo);
    return orderBook.find(l => l.askSize > 0)?.price;
  }, [currentOrderBookData, orderBook]);

  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);

  // ---------- API PUBLIQUE ----------
  const togglePlayback = useCallback(() => setIsPlaying(p => !p), []);
  const setPlaybackSpeedWrapper = useCallback((s: number) => setPlaybackSpeed(s), []);

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
    orderBookProcessor
  };
}