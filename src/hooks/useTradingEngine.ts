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
  filled: number;
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  volume?: number;
}

const TICK_SIZE = 0.25;
// [MOD] cap d'ingestion ORDERBOOK (sécurité UI)
const ORDERBOOK_CAP = 200;

const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
const toBidTick = (p: number) => Math.floor((p + 1e-9) / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil((p - 1e-9) / TICK_SIZE) * TICK_SIZE;
const roundToGrid = (p: number) => Math.round(p * 4) / 4;

const decorateLadderWithVolume = (ladder: TickLadder, volumeMap: Map<number, number>) : TickLadder => {
  if (!ladder) return ladder;
  const levels = ladder.levels.map(l => ({
    ...l,
    volumeCumulative: volumeMap.get(roundToGrid(l.price)) ?? 0
  }));
  return { ...ladder, levels };
};

export function useTradingEngine() {
  // ---------- state ----------
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

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
    symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0
  });
  const [pnl, setPnl] = useState<{ unrealized: number; realized: number; total: number }>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);

  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // ---------- utils parse ----------
  const parseTimestamp = (row: any): number => {
    // Prioriser ts_exch_utc pour la synchronisation
    const fields = ['ts_exch_utc', 'ts_exch_madrid', 'ts_utc', 'ts_madrid'];
    for (const f of fields) {
      if (row[f]) {
        const ts = new Date(row[f]).getTime();
        if (!isNaN(ts)) return ts;
      }
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
      // accepte "[1,2,3]" ou "1,2,3"
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

  const normalizeEventType = (eventType: string): string =>
    eventType?.toString().toUpperCase().trim() || '';

  const normalizeAggressor = (aggressor: string): 'BUY' | 'SELL' | undefined => {
    const a = aggressor?.toString().toUpperCase().trim();
    if (a === 'BUY' || a === 'B') return 'BUY';
    if (a === 'SELL' || a === 'S') return 'SELL';
    return undefined;
  };

  // ---------- loader ----------
  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);

  const loadMarketData = useCallback((file: File) => {
    console.log('🔥 loadMarketData called with file:', file.name);
    
    // reset
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

    const reader = new FileReader();

    reader.onload = () => {
      Papa.parse(reader.result as string, {
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        worker: true,
        complete: (results) => {
          console.log('🔥 Papa.parse complete, results:', results);
          console.log('🔥 Number of rows:', results.data.length);
          console.log('🔥 First few rows:', results.data.slice(0, 3));
          
          const rawEvents: Array<MarketEvent & { sortOrder: number }> = [];
          const orderbookSnapshots: ParsedOrderBook[] = [];
          const tradeEvents: OrderBookTrade[] = [];

          results.data.forEach((row: any) => {
            if (!row || Object.keys(row).length === 0) return;

            const timestamp = parseTimestamp(row);
            const eventType = normalizeEventType(row.event_type);

            // Ordre de priorité pour synchronisation parfaite: ORDERBOOK_FULL → BBO → TRADE
            let sortOrder = 0;
            if (eventType === 'ORDERBOOK' || eventType === 'ORDERBOOK_FULL') sortOrder = 0;
            else if (eventType === 'BBO') sortOrder = 1;
            else if (eventType === 'TRADE') sortOrder = 2;

            if (eventType === 'TRADE') {
              const price = parseFloat(row.trade_price);
              const size = parseFloat(row.trade_size);
              const aggressor = normalizeAggressor(row.aggressor);
              if (isNaN(price) || price <= 0 || isNaN(size) || size <= 0 || !aggressor) return;

              const t = orderBookProcessor.parseTrade(row);
              if (t) tradeEvents.push(t);

              rawEvents.push({
                timestamp, sortOrder, eventType: 'TRADE',
                tradePrice: price, tradeSize: size, aggressor
              });
            } else if (eventType === 'BBO') {
              const bidPrice = parseFloat(row.bid_price);
              const askPrice = parseFloat(row.ask_price);
              const bidSize = parseFloat(row.bid_size);
              const askSize = parseFloat(row.ask_size);
              const hasBid = !isNaN(bidPrice) && bidPrice > 0;
              const hasAsk = !isNaN(askPrice) && askPrice > 0;
              if (!hasBid && !hasAsk) return;

              rawEvents.push({
                timestamp, sortOrder, eventType: 'BBO',
                bidPrice: hasBid ? bidPrice : undefined,
                askPrice: hasAsk ? askPrice : undefined,
                bidSize: hasBid && !isNaN(bidSize) ? bidSize : undefined,
                askSize: hasAsk && !isNaN(askSize) ? askSize : undefined
              });
            } else if (eventType === 'ORDERBOOK' || eventType === 'ORDERBOOK_FULL') {
              const bidPrices = parseArrayField(row.book_bid_prices);
              const bidSizes  = parseArrayField(row.book_bid_sizes);
              const askPrices = parseArrayField(row.book_ask_prices);
              const askSizes  = parseArrayField(row.book_ask_sizes);

              if (bidPrices.length === 0 && askPrices.length === 0) return;
              if (bidPrices.length !== bidSizes.length) return;
              if (askPrices.length !== askSizes.length) return;

              const snapshot = orderBookProcessor.parseOrderBookSnapshot(row);
              if (snapshot) orderbookSnapshots.push(snapshot);

              rawEvents.push({
                timestamp, sortOrder, eventType: 'ORDERBOOK',
                bookBidPrices: bidPrices, bookAskPrices: askPrices,
                bookBidSizes: bidSizes, bookAskSizes: askSizes
              });
            }
          });

          // Tri synchrone: (ts_exch_utc, ordre ORDERBOOK → BBO → TRADE)
          rawEvents.sort((a, b) =>
            a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.sortOrder - b.sortOrder
          );
          const events: MarketEvent[] = rawEvents.map(({ sortOrder, ...e }) => e);
          console.log('🔥 Final events:', events.length);
          console.log('🔥 Trade events:', tradeEvents.length);
          console.log('🔥 Orderbook snapshots:', orderbookSnapshots.length);

          // tick size infer
          const allPrices = [
            ...tradeEvents.map(t => t.price),
            ...orderbookSnapshots.flatMap(s => [...s.bidPrices, ...s.askPrices])
          ];
          if (allPrices.length > 0) {
            const inferred = orderBookProcessor.inferTickSize(allPrices);
            orderBookProcessor.setTickSize(inferred);
          }

          orderbookSnapshots.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          tradeEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          // prix initial
          let initialPrice = 0;
          if (tradeEvents.length > 0) initialPrice = tradeEvents[0].price;
          else if (orderbookSnapshots.length > 0) {
            const firstSnap = orderbookSnapshots[0];
            if (firstSnap.bidPrices?.length) initialPrice = firstSnap.bidPrices[0];
            else if (firstSnap.askPrices?.length) initialPrice = firstSnap.askPrices[0];
          } else if (events.length > 0) {
            const firstPriceEvent = events.find(e => e.eventType === 'ORDERBOOK' || e.eventType === 'BBO');
            if (firstPriceEvent) {
              if (firstPriceEvent.eventType === 'ORDERBOOK') {
                initialPrice =
                  firstPriceEvent.bookBidPrices?.[0] ??
                  firstPriceEvent.bookAskPrices?.[0] ?? 0;
              } else if (firstPriceEvent.eventType === 'BBO') {
                initialPrice = firstPriceEvent.bidPrice || firstPriceEvent.askPrice || initialPrice;
              }
            }
          }

          console.log('🔥 Initial price found:', initialPrice);
          
          setCurrentPrice(toTick(initialPrice));
          setMarketData(events);
          setTrades(tradeEvents);

          // ancre initiale puis suivi dynamique
          orderBookProcessor.setAnchorByPrice(initialPrice);
          orderBookProcessor.clearAnchor();
          

          // centre l'affichage sur le prix initial (barre espace simulée)
          setTimeout(() => {
            const spaceEvent = new KeyboardEvent('keydown', { code: 'Space' });
            window.dispatchEvent(spaceEvent);
          }, 100);

          // snapshot initial si dispo
          if (orderbookSnapshots.length > 0) {
            const initialLadder = orderBookProcessor.createTickLadder(orderbookSnapshots[0], tradeEvents);
            setCurrentTickLadder(decorateLadderWithVolume(initialLadder, volumeByPrice));
          }
          
          console.log('🔥 File loaded successfully, ready for manual playback');
        }
      });
    };
    reader.readAsText(file);
  }, [orderBookProcessor, volumeByPrice]);

  // ---------- ORDRES ----------
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    setOrders(prev => [...prev, {
      id: `LMT-${++orderIdCounter.current}`,
      side, price: toTick(price), quantity, filled: 0
    }]);
  }, []);

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(o => o.price !== toTick(price)));
  }, []);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    const px = currentPrice;
    if (!px) return;
    setOrders(prev => [...prev, {
      id: `MKT-${++orderIdCounter.current}`,
      side, price: px, quantity, filled: 0
    }]);
  }, [currentPrice]);

  // ---------- PnL & position ----------
  const executeLimitFill = useCallback((order: Order, fillPrice: number) => {
    const px = toTick(fillPrice);
    const qty = order.quantity * (order.side === 'BUY' ? 1 : -1);

    // realised
    const pnlFill = (currentPrice - px) * qty * 20; // multiplier (exemple)
    setRealizedPnLTotal(prev => prev + pnlFill);

    // position
    setPosition(prevPos => {
      const newQty = prevPos.quantity + qty;
      // new average
      let newAvg = prevPos.averagePrice;
      if (newQty === 0) newAvg = 0;
      else if ((prevPos.quantity >= 0 && order.side === 'BUY') || (prevPos.quantity <= 0 && order.side === 'SELL')) {
        const prevAbs = Math.abs(prevPos.quantity);
        const totalQty = prevAbs + qty;
        const prevVal = prevPos.averagePrice * prevAbs;
        const addVal  = px * qty;
        newAvg = totalQty > 0 ? toTick((prevVal + addVal) / totalQty) : px;
      } else {
        // reverse
        newAvg = px;
      }

      return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: px };
    });

    // remove filled order
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, [currentPrice]);

  // ---------- AGRÉGATION TAS (petit buffer UI) ----------
  const [aggregationBuffer, setAggregationBuffer] = useState<Trade[]>([]);
  const flushAggregationBuffer = useCallback(() => {
    if (aggregationBuffer.length > 0) {
      setTimeAndSales(prev => {
        const next = [...prev, ...aggregationBuffer];
        return next.slice(-300);
      });
      setAggregationBuffer([]);
    }
  }, [aggregationBuffer]);

  // ---------- PROCESS EVENT ----------
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

          // TAS aggregation
          setAggregationBuffer(prev => {
            const last = prev[prev.length - 1];
            if (last && last.price === trade.price && last.aggressor === trade.aggressor) {
              const merged = { ...last, size: last.size + trade.size };
              return [...prev.slice(0, -1), merged];
            }
            return [...prev, trade];
          });

          // last price
          setCurrentPrice(px);

          // vol by price
          const gridPrice = roundToGrid(px);
          setVolumeByPrice(prev => {
            const next = new Map(prev);
            next.set(gridPrice, (next.get(gridPrice) ?? 0) + event.tradeSize);
            return next;
          });

          // bump volume in UI ladder
          setOrderBook(prev =>
            prev.map(level =>
              Math.abs(level.price - gridPrice) < 0.125
                ? { ...level, volume: (level.volume || 0) + event.tradeSize! }
                : level
            )
          );

          // sécurité : execution limites si le last traverse le prix
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
        // MAJ best bid/ask immédiate + L1
        setCurrentOrderBookData(prevData => ({
          book_bid_prices: event.bidPrice ? [toBidTick(event.bidPrice)] : (prevData?.book_bid_prices ?? []),
          book_ask_prices: event.askPrice ? [toAskTick(event.askPrice)] : (prevData?.book_ask_prices ?? []),
          book_bid_sizes:  event.bidSize  ? [event.bidSize]  : (prevData?.book_bid_sizes ?? []),
          book_ask_sizes:  event.askSize  ? [event.askSize]  : (prevData?.book_ask_sizes ?? []),
        }));
        break;
      }

      case 'ORDERBOOK': {
        if (event.bookBidPrices || event.bookAskPrices) {
          // mini book pour DOM (quelques niveaux)
          const priceMap = new Map<number, OrderBookLevel>();
          const newBook: OrderBookLevel[] = [];

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
                  newBook.push(level);
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
                  newBook.push(level);
                }
              }
            }
          }

          newBook.sort((a, b) => b.price - a.price);
          setOrderBook(newBook);
        }
        break;
      }
    }
  }, [executeLimitFill, volumeByPrice]);

  // ---------- dérivés best bid/ask & spread ----------
  const bestBid = useMemo(() => orderBook.find(l => l.bidSize > 0)?.price, [orderBook]);
  const bestAsk = useMemo(() => orderBook.find(l => l.askSize > 0)?.price, [orderBook]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);

  // ---------- playback loop : **EVENT BY EVENT** ----------
  // Traite un événement à la fois pour respecter le timing réel
  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) return;

    const currentEvent = marketData[currentEventIndex];
    
    // Traite l'événement actuel
    processEvent(currentEvent);
    
    const nextIndex = currentEventIndex + 1;
    setCurrentEventIndex(nextIndex);

    if (nextIndex < marketData.length) {
      const nextEvent = marketData[nextIndex];
      const timeDiff = Math.max(0, nextEvent.timestamp - currentEvent.timestamp);
      
      // Délai ajusté selon la vitesse de playback
      const baseDelay = timeDiff / playbackSpeed;
      const minDelay = playbackSpeed >= 10 ? 1 : (playbackSpeed >= 5 ? 5 : 10);
      const maxDelay = 1000; // Cap à 1 seconde
      const delay = Math.max(minDelay, Math.min(baseDelay, maxDelay));
      
      console.log(`⏱️ Playback: event ${currentEventIndex}/${marketData.length}, delay: ${delay}ms (speed: ${playbackSpeed}x)`);
      
      playbackTimerRef.current = setTimeout(() => {
        // l'effet se relancera avec l'index mis à jour
      }, delay);
    } else {
      flushAggregationBuffer();
      setIsPlaying(false);
      console.log('🏁 Playback terminé');
    }

    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent, flushAggregationBuffer]);

  // ---------- View anchor (centrage DOM) ----------
  const setViewAnchorPrice = useCallback((price: number | null) => {
    if (price == null) orderBookProcessor.clearAnchor();
    else orderBookProcessor.setAnchorByPrice(price);

    // refresh immédiat depuis currentOrderBookData si dispo
    if (currentOrderBookData) {
      const snapshot = {
        bidPrices: (currentOrderBookData.book_bid_prices || []),
        bidSizes:  (currentOrderBookData.book_bid_sizes  || []),
        bidOrders: [],
        askPrices: (currentOrderBookData.book_ask_prices || []),
        askSizes:  (currentOrderBookData.book_ask_sizes  || []),
        askOrders: [],
        timestamp: new Date()
      } as ParsedOrderBook;
      const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
      return;
    }

    // fallback mini-book
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

  // ---------- toggle playback ----------
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => !prev);
  }, []);
  const setPlaybackSpeedSafe = useCallback((speed: number) => setPlaybackSpeed(Math.max(0.1, speed)), []);
  const setPlaybackSpeedWrapper = useCallback((speed: number) => setPlaybackSpeedSafe(speed), [setPlaybackSpeedSafe]);

  // ---------- PnL dérivé ----------
  useEffect(() => {
    setPnl({
      unrealized: (currentPrice - position.averagePrice) * position.quantity * 20,
      realized: realizedPnLTotal,
      total: (currentPrice - position.averagePrice) * position.quantity * 20 + realizedPnLTotal
    });
  }, [position, currentPrice, realizedPnLTotal]);

  return {
    // data
    marketData,
    orderBook,
    currentOrderBookData,
    currentTickLadder,
    trades,
    // prices
    currentPrice,
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
    setViewAnchorPrice
  };
}