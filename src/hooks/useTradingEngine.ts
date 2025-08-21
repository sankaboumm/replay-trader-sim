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
  aggregatedCount?: number;
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  volume?: number; // Volume traded at this price level
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
  timestamp: number;
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
}

interface PnL {
  unrealized: number;
  realized: number;
  total: number;
}

const TICK_SIZE = 0.25;   // NQ
const TICK_VALUE = 5.0;   // $/tick
const AGGREGATION_WINDOW_MS = 5;

// [MOD Romi 2025-08-20] Cap d’ingestion pour ORDERBOOK (évite freeze tout en gardant profondeur)
const ORDERBOOK_CAP = 200;


const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;

// Directional snapping to avoid any float drift across the spread
const toBidTick = (p: number) => Math.floor((p + 1e-9) / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil((p - 1e-9) / TICK_SIZE) * TICK_SIZE;

const roundToGrid = (p: number) => Math.round(p * 4) / 4;
// [ADDED]: decorate ladder with cumulative volume by price
const decorateLadderWithVolume = (ladder: TickLadder, volumeMap: Map<number, number>) : TickLadder => {
  if (!ladder) return ladder;
  // clone shallow
  return {
    ...ladder,
    levels: ladder.levels.map(lvl => {
      const grid = roundToGrid(lvl.price);
      const vol = volumeMap.get(grid) ?? 0;
      return { ...lvl, volumeCumulative: vol };
    })
  };
};


export function useTradingEngine() {
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  const [currentOrderBookData, setCurrentOrderBookData] = useState<{
    book_bid_prices: number[];
    book_ask_prices: number[];
    book_bid_sizes: number[];
    book_ask_sizes: number[];
    book_bid_orders?: number[];
    book_ask_orders?: number[];
  } | null>(null);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [aggregationBuffer, setAggregationBuffer] = useState<{
    trades: Trade[];
    lastTimestamp: number;
    key: { price: number; aggressor: 'BUY' | 'SELL' };
  } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<Position>({
    symbol: 'NQ',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0
  });
  const [pnl, setPnl] = useState<PnL>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // Robust order book processing
  const [orderBookSnapshots, setOrderBookSnapshots] = useState<ParsedOrderBook[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(TICK_SIZE));

  // Anti-stale refs
  const orderBookSnapshotsRef = useRef<ParsedOrderBook[]>([]);
  const tradesRef = useRef<OrderBookTrade[]>([]);
  useEffect(() => { orderBookSnapshotsRef.current = orderBookSnapshots; }, [orderBookSnapshots]);
  useEffect(() => { tradesRef.current = trades; }, [trades]);

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // ---------- utils parse ----------
  const parseTimestamp = (row: any): number => {
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

  const parseArrayField = (value: string): number[] => {
    if (!value || value === '[]' || value === '') return [];
    try {
      if (value.startsWith('[') && value.endsWith(']')) {
        const json = JSON.parse(value);
        if (Array.isArray(json)) {
          return json.map((v: any) => parseFloat(v)).filter((v: number) => !isNaN(v));
        }
      }
    } catch { /* fallback below */ }
    const cleaned = value.replace(/^\[|\]$/g, '').trim();
    if (!cleaned) return [];
    return cleaned
      .split(/[\s,]+/)
      .map(v => parseFloat(v))
      .filter(v => !isNaN(v));
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
  const loadMarketData = useCallback((file: File) => {
    // reset
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    setOrderBookSnapshots([]);
    setTrades([]);
    setCurrentTickLadder(null);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setRealizedPnLTotal(0);
    setVolumeByPrice(new Map());
    orderBookProcessor.resetVolume();

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (results) => {
          const rawEvents: Array<MarketEvent & { sortOrder: number }> = [];
          const processedRows = new Set<string>();
          const orderbookSnapshots: ParsedOrderBook[] = [];
          const tradeEvents: OrderBookTrade[] = [];

          results.data.forEach((row: any) => {
            if (!row || Object.keys(row).length === 0) return;
            const key = JSON.stringify(row);
            if (processedRows.has(key)) return;
            processedRows.add(key);

            const timestamp = parseTimestamp(row);
            const eventType = normalizeEventType(row.event_type);

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

          rawEvents.sort((a, b) =>
            a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.sortOrder - b.sortOrder
          );
          const events: MarketEvent[] = rawEvents.map(({ sortOrder, ...e }) => e);

          // infer tick
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

          // initial price
          let initialPrice = 19300;
          const firstTrade = events.find(e => e.eventType === 'TRADE' && e.tradePrice && e.tradePrice > 0);
          if (firstTrade?.tradePrice) {
            initialPrice = firstTrade.tradePrice;
          } else {
            const firstPriceEvent = events.find(e =>
              (e.eventType === 'ORDERBOOK' &&
                ((e.bookBidPrices && e.bookBidPrices.length) ||
                 (e.bookAskPrices && e.bookAskPrices.length))) ||
              (e.eventType === 'BBO' && (e.bidPrice || e.askPrice))
            );
            if (firstPriceEvent) {
              if (firstPriceEvent.eventType === 'ORDERBOOK') {
                if (firstPriceEvent.bookBidPrices?.length) initialPrice = firstPriceEvent.bookBidPrices[0];
                else if (firstPriceEvent.bookAskPrices?.length) initialPrice = firstPriceEvent.bookAskPrices[0];
              } else if (firstPriceEvent.eventType === 'BBO') {
                initialPrice = firstPriceEvent.bidPrice || firstPriceEvent.askPrice || initialPrice;
              }
            }
          }

          setCurrentPrice(toTick(initialPrice));
          setMarketData(events);
          setOrderBookSnapshots(orderbookSnapshots);
          setTrades(tradeEvents);

          // [FIX] Forcer l'ancrage sur le prix initial du fichier pour centrer le DOM
          orderBookProcessor.setAnchorByPrice(initialPrice);
          setCurrentPrice(initialPrice);
          
          // Center DOM on first market price after data is loaded
          setTimeout(() => {
            const spaceEvent = new KeyboardEvent('keydown', { code: 'Space' });
            window.dispatchEvent(spaceEvent);
          }, 100);

          if (orderbookSnapshots.length > 0) {
            const initialLadder = orderBookProcessor.createTickLadder(orderbookSnapshots[0], tradeEvents);
            setCurrentTickLadder(decorateLadderWithVolume(initialLadder, volumeByPrice));
          }
        }
      });
    };
    reader.readAsText(file, 'UTF-8');
  }, [orderBookProcessor]);

  // ---------- derived: bestBid / bestAsk / spread ----------
  const { bestBid, bestAsk, spread, spreadTicks } = useMemo(() => {
    let bid: number | undefined;
    let ask: number | undefined;

    if (currentOrderBookData?.book_bid_prices?.length) {
      bid = currentOrderBookData.book_bid_prices[0];
    } else if (orderBook.length) {
      // max price with bidSize > 0
      bid = orderBook
        .filter(l => (l.bidSize || 0) > 0)
        .reduce((max, l) => Math.max(max, l.price), -Infinity);
      if (!Number.isFinite(bid)) bid = undefined;
    }

    if (currentOrderBookData?.book_ask_prices?.length) {
      ask = currentOrderBookData.book_ask_prices[0];
    } else if (orderBook.length) {
      // min price with askSize > 0
      ask = orderBook
        .filter(l => (l.askSize || 0) > 0)
        .reduce((min, l) => Math.min(min, l.price), Infinity);
      if (!Number.isFinite(ask)) ask = undefined;
    }

    const spr = bid && ask ? Math.max(0, ask - bid) : undefined;
    const sprTicks = spr !== undefined ? Math.round(spr / TICK_SIZE) : undefined;

    return { bestBid: bid, bestAsk: ask, spread: spr, spreadTicks: sprTicks };
  }, [currentOrderBookData, orderBook]);

  // ---------- aggregation flush ----------
  const flushAggregationBuffer = useCallback(() => {
    setAggregationBuffer(prev => {
      if (!prev || prev.trades.length === 0) return null;
      const aggregatedTrade: Trade = {
        id: `agg-${Date.now()}-${Math.random()}`,
        timestamp: prev.trades[prev.trades.length - 1].timestamp,
        price: prev.key.price,
        size: prev.trades.reduce((s, t) => s + t.size, 0),
        aggressor: prev.key.aggressor,
        aggregatedCount: prev.trades.length
      };
      setTimeAndSales(prevTAS => [aggregatedTrade, ...prevTAS.slice(0, 99)]);
      return null;
    });
  }, []);

  // ---------- core event processor ----------
  const executeLimitFill = useCallback((order: Order, fillPrice: number) => {
    const qty = order.quantity - order.filled;
    if (qty <= 0) return;

    const px = toTick(fillPrice);

    setPosition(prevPos => {
      const newQty = prevPos.quantity + (order.side === 'BUY' ? qty : -qty);

      // realized if closing/reducing
      let realized = 0;
      if (prevPos.quantity !== 0) {
        const closing =
          (prevPos.quantity > 0 && order.side === 'SELL') ||
          (prevPos.quantity < 0 && order.side === 'BUY');
        if (closing) {
          const closeQty = Math.min(qty, Math.abs(prevPos.quantity));
          const tickDiff =
            prevPos.quantity > 0
              ? (px - prevPos.averagePrice) / TICK_SIZE
              : (prevPos.averagePrice - px) / TICK_SIZE;
          realized = closeQty * tickDiff * TICK_VALUE;
          setRealizedPnLTotal(t => t + realized);
        }
      }

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

    // last for unrealized
    setCurrentPrice(px);

    
          // [SYNC 2025-08-21] Recenter 20-level ladder on last trade price
          setViewAnchorPrice(px);
// TAS synthétique
    const t: Trade = {
      id: `limit-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      price: px,
      size: qty,
      aggressor: order.side
    };
    setTimeAndSales(prev => [t, ...prev.slice(0, 99)]);

    const grid = roundToGrid(px);
    setVolumeByPrice(prevMap => {
      const next = new Map(prevMap);
      next.set(grid, (next.get(grid) ?? 0) + qty);
      return next;
    });

    setTrades(prevTrades => {
      const nextTrades = [
        ...prevTrades,
        { timestamp: new Date(), price: px, size: qty, aggressor: order.side }
      ];
      const snaps = orderBookSnapshotsRef.current;
      if (snaps.length > 0) {
        const lastSnap = snaps[snaps.length - 1];
        const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
        setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
      }
      return nextTrades;
    });
  }, [orderBookProcessor]);

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
            const key = { price: px, aggressor: event.aggressor! };
            const shouldAggregate =
              prev &&
              prev.key.price === key.price &&
              prev.key.aggressor === key.aggressor &&
              (event.timestamp - prev.lastTimestamp) <= AGGREGATION_WINDOW_MS;

            if (shouldAggregate) {
              return { trades: [...prev.trades, trade], lastTimestamp: event.timestamp, key };
            } else {
              if (prev && prev.trades.length > 0) {
                const aggregatedTrade: Trade = {
                  id: `agg-${Date.now()}-${Math.random()}`,
                  timestamp: prev.trades[prev.trades.length - 1].timestamp,
                  price: prev.key.price,
                  size: prev.trades.reduce((s, t) => s + t.size, 0),
                  aggressor: prev.key.aggressor,
                  aggregatedCount: prev.trades.length
                };
                setTimeAndSales(prevTAS => [aggregatedTrade, ...prevTAS.slice(0, 99)]);
              }
              return { trades: [trade], lastTimestamp: event.timestamp, key };
            }
          });

          // last
          setCurrentPrice(px);

          // volume by price
          const gridPrice = roundToGrid(px);
          setVolumeByPrice(prev => {
            const next = new Map(prev);
            next.set(gridPrice, (next.get(gridPrice) ?? 0) + event.tradeSize);
            return next;
          });

          // bump volume in UI orderbook
          setOrderBook(prev =>
            prev.map(level =>
              Math.abs(level.price - gridPrice) < 0.125
                ? { ...level, volume: (level.volume || 0) + event.tradeSize! }
                : level
            )
          );

          // filet de sécu : exécuter les LIMIT si le last traverse leur prix
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
        // MAJ mini-book pour l'affichage
        if (event.bidPrice || event.askPrice) {
          setOrderBook(prev => {
            const book = [...prev];
            if (event.bidPrice && event.bidPrice > 0) {
              const p = toBidTick(event.bidPrice);
              const i = book.findIndex(l => Math.abs(l.price - p) < 0.125);
              if (i >= 0) book[i] = { ...book[i], bidSize: event.bidSize || 0 };
              else book.push({ price: p, bidSize: event.bidSize || 0, askSize: 0, volume: volumeByPrice.get(p) || 0 });
            }
            if (event.askPrice && event.askPrice > 0) {
              const p = toAskTick(event.askPrice);
              const i = book.findIndex(l => Math.abs(l.price - p) < 0.125);
              if (i >= 0) book[i] = { ...book[i], askSize: event.askSize || 0 };
              else book.push({ price: p, bidSize: 0, askSize: event.askSize || 0, volume: volumeByPrice.get(p) || 0 });
            }
            book.sort((a, b) => b.price - a.price);
            return book;
          });
        }

        
        // [SYNC 2025-08-21] Anchor the 20-level view around current BBO (mid if both sides present)
        (function() {
          const hasBid = typeof event.bidPrice === 'number' && event.bidPrice > 0;
          const hasAsk = typeof event.askPrice === 'number' && event.askPrice > 0;
          let anchorPx: number | null = null;
          if (hasBid && hasAsk) {
            const bb = toBidTick(event.bidPrice!);
            const ba = toAskTick(event.askPrice!);
            anchorPx = toTick((bb + ba) / 2);
          } else if (hasBid) {
            anchorPx = toBidTick(event.bidPrice!);
          } else if (hasAsk) {
            anchorPx = toAskTick(event.askPrice!);
          }
          if (anchorPx != null) setViewAnchorPrice(anchorPx);
        })();
// Exécution LIMIT si top-of-book touche le prix limite
        const bb = event.bidPrice !== undefined ? toBidTick(event.bidPrice) : undefined;
        const ba = event.askPrice !== undefined ? toAskTick(event.askPrice) : undefined;

        if (bb !== undefined || ba !== undefined) {
          setOrders(prev => {
            const updated: Order[] = [];
            for (const o of prev) {
              let should = false;
              if (o.side === 'BUY'  && ba !== undefined && ba <= o.price) should = true;
              if (o.side === 'SELL' && bb !== undefined && bb >= o.price) should = true;

              if (should) {
                executeLimitFill(o, o.price); // exécute au prix limite
              } else {
                updated.push(o);
              }
            }
            return updated;
          });
        }

        // maintenir best bid/ask pour market
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
          // store 20 levels pour affichage
          // [OLD Romi 2025-08-20] setCurrentOrderBookData({
//   book_bid_prices: (event.bookBidPrices || []).slice(0, 20).map(toBidTick),
//   book_ask_prices: (event.bookAskPrices || []).slice(0, 20).map(toAskTick),
//   book_bid_sizes:  (event.bookBidSizes  || []).slice(0, 20),
//   book_ask_sizes:  (event.bookAskSizes  || []).slice(0, 20),
// });
setCurrentOrderBookData({
  book_bid_prices: (event.bookBidPrices || []).slice(0, ORDERBOOK_CAP).map(toBidTick), // [MOD Romi 2025-08-20]
  book_ask_prices: (event.bookAskPrices || []).slice(0, ORDERBOOK_CAP).map(toAskTick), // [MOD Romi 2025-08-20]
  book_bid_sizes:  (event.bookBidSizes  || []).slice(0, ORDERBOOK_CAP),               // [MOD Romi 2025-08-20]
  book_ask_sizes:  (event.bookAskSizes  || []).slice(0, ORDERBOOK_CAP),               // [MOD Romi 2025-08-20]
});

          // Tick ladder
          const currentSnapshot = orderBookSnapshotsRef.current.find(s =>
            Math.abs(s.timestamp.getTime() - event.timestamp) < 1000
          );
          if (currentSnapshot) {
            const snaps = orderBookSnapshotsRef.current;
            const idx = snaps.findIndex(s => s === currentSnapshot);
            const previousSnapshot = idx > 0 ? snaps[idx - 1] : undefined;
            const ladder = orderBookProcessor.createTickLadder(currentSnapshot, tradesRef.current, previousSnapshot?.timestamp);
            setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
          } else {
            const eventSnapshot: ParsedOrderBook = {
              bidPrices: (event.bookBidPrices || []).map(toBidTick),
              bidSizes:  event.bookBidSizes || [],
              bidOrders: [],
              askPrices: (event.bookAskPrices || []).map(toAskTick),
              askSizes:  event.bookAskSizes || [],
              askOrders: [],
              timestamp: new Date(event.timestamp)
            };
            const ladder = orderBookProcessor.createTickLadder(eventSnapshot, tradesRef.current);
            setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
          }

          // mini book 10 niveaux
          const newBook: OrderBookLevel[] = [];
          const priceMap = new Map<number, OrderBookLevel>();

          if (event.bookBidPrices && event.bookBidSizes) {
            for (let i = 0; i < Math.min(event.bookBidPrices.length, 10); i++) {
              const bp = toBidTick(event.bookBidPrices[i]);
              const bs = event.bookBidSizes[i] || 0;
              if (bp > 0 && bs >= 0) {
                const ex = priceMap.get(bp);
                if (ex) ex.bidSize = bs;
                else {
                  const level: OrderBookLevel = { price: bp, bidSize: bs, askSize: 0, volume: volumeByPrice.get(bp) || 0 };
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
  }, [executeLimitFill, orderBookProcessor, volumeByPrice]);

  // ---------- playback ----------
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => {
      if (prev) flushAggregationBuffer();
      return !prev;
    });
  }, [flushAggregationBuffer]);

  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const newOrder: Order = {
      id: `order-${++orderIdCounter.current}`,
      side, price: toTick(price), quantity,
      filled: 0,
      timestamp: Date.now()
    };
    setOrders(prev => [...prev, newOrder]);
  }, []);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    // remplit au meilleur prix opposé (bestAsk ou bestBid) – déjà validé par toi
    const bestAskPx = currentOrderBookData?.book_ask_prices?.[0];
    const bestBidPx = currentOrderBookData?.book_bid_prices?.[0];
    const fillPrice = toTick(side === 'BUY' ? (bestAskPx ?? currentPrice) : (bestBidPx ?? currentPrice));

    // position + realized
    setPosition(prev => {
      const newQty = prev.quantity + (side === 'BUY' ? quantity : -quantity);
      let realized = 0;
      if (prev.quantity !== 0) {
        const closing = (prev.quantity > 0 && side === 'SELL') || (prev.quantity < 0 && side === 'BUY');
        if (closing) {
          const closeQty = Math.min(quantity, Math.abs(prev.quantity));
          const tickDiff =
            prev.quantity > 0
              ? (fillPrice - prev.averagePrice) / TICK_SIZE
              : (prev.averagePrice - fillPrice) / TICK_SIZE;
          realized = closeQty * tickDiff * TICK_VALUE;
          setRealizedPnLTotal(t => t + realized);
        }
      }
      let newAvg = prev.averagePrice;
      if (newQty === 0) newAvg = 0;
      else if ((prev.quantity >= 0 && side === 'BUY') || (prev.quantity <= 0 && side === 'SELL')) {
        const prevAbs = Math.abs(prev.quantity);
        const totalQty = prevAbs + quantity;
        const prevVal = prev.averagePrice * prevAbs;
        const addVal  = fillPrice * quantity;
        newAvg = totalQty > 0 ? toTick((prevVal + addVal) / totalQty) : fillPrice;
      } else {
        newAvg = fillPrice;
      }
      return { ...prev, quantity: newQty, averagePrice: newAvg, marketPrice: fillPrice };
    });

    setCurrentPrice(fillPrice);

    const trade: Trade = {
      id: `mkt-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      price: fillPrice,
      size: quantity,
      aggressor: side
    };
    setTimeAndSales(prev => [trade, ...prev.slice(0, 99)]);

    const grid = roundToGrid(fillPrice);
    setVolumeByPrice(prev => {
      const next = new Map(prev);
      next.set(grid, (next.get(grid) ?? 0) + quantity);
      return next;
    });

    setTrades(prevTrades => {
      const nextTrades = [...prevTrades, { timestamp: new Date(), price: fillPrice, size: quantity, aggressor: side }];
      const snaps = orderBookSnapshotsRef.current;
      if (snaps.length > 0) {
        const lastSnap = snaps[snaps.length - 1];
        const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
        setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
      }
      return nextTrades;
    });
  }, [currentOrderBookData, currentPrice, orderBookProcessor]);

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(order => Math.abs(order.price - price) >= 0.125));
  }, []);

  // PnL
  useEffect(() => {
    const tickDiff = (currentPrice - position.averagePrice) / TICK_SIZE;
    const unrealized = position.quantity * tickDiff * TICK_VALUE;
    setPnl({ unrealized, realized: realizedPnLTotal, total: unrealized + realizedPnLTotal });
  }, [position, currentPrice, realizedPnLTotal]);

  // playback loop
  useEffect(() => {
    if (isPlaying && currentEventIndex < marketData.length) {
      const currentEvent = marketData[currentEventIndex];
      const nextEvent = marketData[currentEventIndex + 1];

      if (nextEvent) {
        const timeDiff = nextEvent.timestamp - currentEvent.timestamp;
        const baseDelay = Math.min(timeDiff, 5000);
        const adjusted = baseDelay / playbackSpeed;
        const minDelay = playbackSpeed === 1 ? 0 : 1;
        const delay = Math.max(minDelay, adjusted);

        playbackTimerRef.current = setTimeout(() => {
          processEvent(currentEvent);
          setCurrentEventIndex(prev => prev + 1);
        }, delay);
      } else {
        processEvent(currentEvent);
        flushAggregationBuffer();
        setIsPlaying(false);
      }
    }
    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent, flushAggregationBuffer]);


  // ---------- View anchor control (FIFO scrolling) ----------
  const setViewAnchorPrice = useCallback((price: number | null) => {
    if (price == null) {
      orderBookProcessor.clearAnchor();
    } else {
      orderBookProcessor.setAnchorByPrice(price);
    }

    // Recompute ladder from the latest available snapshot/trades
    const snaps = orderBookSnapshotsRef.current;
    const tradesLatest = tradesRef.current;

    if (snaps.length > 0) {
      const lastSnap = snaps[snaps.length - 1];
      const ladder = orderBookProcessor.createTickLadder(lastSnap, tradesLatest);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
      return;
    }

    if (currentOrderBookData) {
      const snapshot = {
        bidPrices: (currentOrderBookData.book_bid_prices || []),
        bidSizes:  (currentOrderBookData.book_bid_sizes  || []),
        bidOrders: (currentOrderBookData.book_bid_orders || []),
        askPrices: (currentOrderBookData.book_ask_prices || []),
        askSizes:  (currentOrderBookData.book_ask_sizes  || []),
        askOrders: (currentOrderBookData.book_ask_orders || []),
        timestamp: new Date()
      } as ParsedOrderBook;
      const ladder = orderBookProcessor.createTickLadder(snapshot, tradesLatest);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
      return;
    }

    if (orderBook.length > 0) {
      // Fallback: build a minimal snapshot from mini-book
      const bidLevels = orderBook.filter(l => (l.bidSize || 0) > 0).sort((a,b)=>b.price-a.price);
      const askLevels = orderBook.filter(l => (l.askSize || 0) > 0).sort((a,b)=>a.price-b.price);
      const snapshot: ParsedOrderBook = {
        bidPrices: bidLevels.map(l => l.price),
        bidSizes:  bidLevels.map(l => l.bidSize || 0),
        bidOrders: [],
        askPrices: askLevels.map(l => l.price),
        askSizes:  askLevels.map(l => l.askSize || 0),
        askOrders: [],
        timestamp: new Date()
      };
      const ladder = orderBookProcessor.createTickLadder(snapshot, tradesLatest);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
    }
  }, [orderBookProcessor, currentOrderBookData, orderBook, volumeByPrice]);
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
    placeMarketOrder,
    cancelOrdersAtPrice,
    // position/pnl
    position,
    pnl,
    // playback
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed,
    // file
    loadMarketData,
    // utils (si nécessaire)
    orderBookProcessor,
    setViewAnchorPrice
  };
}