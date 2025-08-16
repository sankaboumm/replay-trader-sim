import { useState, useCallback, useRef, useEffect } from 'react';
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
  volume?: number;
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

const TICK_SIZE = 0.25;
const TICK_VALUE = 5.0;
const AGGREGATION_WINDOW_MS = 5;

// ★ Micro-batching L2/BBO pour affichage cohérent (25ms)
const L2_COALESCE_MS = 25;

type L2Buffer = {
  ob?: {
    bidPrices: number[];
    bidSizes: number[];
    askPrices: number[];
    askSizes: number[];
    ts: number;
  };
  bbo?: {
    bidPrice?: number;
    bidSize?: number;
    askPrice?: number;
    askSize?: number;
    ts: number;
  };
};

export function useTradingEngine() {
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const [currentPrice, setCurrentPrice] = useState(0);

  // Orderbook “affiché” (10 niveaux)
  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  // Snapshot compact pour BBO / market
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
    symbol: 'DEMO',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0
  });
  const [pnl, setPnl] = useState<PnL>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // Robust L2 → Tick ladder
  const [orderBookSnapshots, setOrderBookSnapshots] = useState<ParsedOrderBook[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(TICK_SIZE));

  // Anti-stale refs
  const orderBookSnapshotsRef = useRef<ParsedOrderBook[]>([]);
  const tradesRef = useRef<OrderBookTrade[]>([]);
  const volumeByPriceRef = useRef<Map<number, number>>(new Map());

  useEffect(() => { orderBookSnapshotsRef.current = orderBookSnapshots; }, [orderBookSnapshots]);
  useEffect(() => { tradesRef.current = trades; }, [trades]);
  useEffect(() => { volumeByPriceRef.current = volumeByPrice; }, [volumeByPrice]);

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // --- Utils -----------------------------------------------------
  const roundToGrid = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;

  const parseTimestamp = (row: any): number => {
    const fields = ['ts_exch_utc', 'ts_exch_madrid', 'ts_utc', 'ts_madrid'];
    for (const f of fields) {
      if (row[f]) {
        const ts = new Date(row[f]).getTime();
        if (!isNaN(ts)) return ts;
      }
    }
    if (row.ssboe && row.usecs) {
      const ss = parseInt(row.ssboe, 10);
      const us = parseInt(row.usecs, 10);
      if (!isNaN(ss) && !isNaN(us)) return ss * 1000 + Math.floor(us / 1000);
    }
    return Date.now();
  };

  const parseArrayField = (value: string): number[] => {
    if (!value || value === '[]' || value === '') return [];
    try {
      if (value.startsWith('[') && value.endsWith(']')) {
        const j = JSON.parse(value);
        if (Array.isArray(j)) return j.map((v) => parseFloat(v)).filter((v) => !isNaN(v));
      }
    } catch { /* fallback */ }
    const cleaned = value.replace(/^\[|\]$/g, '').trim();
    if (!cleaned) return [];
    return cleaned.split(/[\s,]+/).map((v) => parseFloat(v)).filter((v) => !isNaN(v));
  };

  const normalizeEventType = (s: string) => s?.toString().toUpperCase().trim() || '';
  const normalizeAggressor = (a: string): 'BUY' | 'SELL' | undefined => {
    const x = a?.toString().toUpperCase().trim();
    if (x === 'BUY' || x === 'B') return 'BUY';
    if (x === 'SELL' || x === 'S') return 'SELL';
    return undefined;
  };

  // --- Loader ----------------------------------------------------
  const loadMarketData = useCallback((file: File) => {
    // reset
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    setOrderBookSnapshots([]);
    setTrades([]);
    setCurrentTickLadder(null);
    orderBookProcessor.resetVolume();
    setVolumeByPrice(new Map());

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (results) => {
          const rawEvents: Array<MarketEvent & { sortOrder: number }> = [];
          const processed = new Set<string>();
          const snaps: ParsedOrderBook[] = [];
          const tlist: OrderBookTrade[] = [];

          results.data.forEach((row: any) => {
            if (!row || Object.keys(row).length === 0) return;
            const key = JSON.stringify(row);
            if (processed.has(key)) return;
            processed.add(key);

            const timestamp = parseTimestamp(row);
            const eventType = normalizeEventType(row.event_type);

            let sortOrder = 0;
            if (eventType === 'ORDERBOOK') sortOrder = 0;
            else if (eventType === 'BBO') sortOrder = 1;
            else if (eventType === 'TRADE') sortOrder = 2;

            if (eventType === 'TRADE') {
              const price = parseFloat(row.trade_price);
              const size = parseFloat(row.trade_size);
              const aggr = normalizeAggressor(row.aggressor);
              if (isNaN(price) || price <= 0 || isNaN(size) || size <= 0 || !aggr) return;

              const t = orderBookProcessor.parseTrade(row);
              if (t) tlist.push(t);

              rawEvents.push({
                timestamp, sortOrder, eventType: 'TRADE',
                tradePrice: price, tradeSize: size, aggressor: aggr
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
              const bidSizes = parseArrayField(row.book_bid_sizes);
              const askPrices = parseArrayField(row.book_ask_prices);
              const askSizes = parseArrayField(row.book_ask_sizes);

              if (bidPrices.length !== bidSizes.length || askPrices.length !== askSizes.length) return;
              if (bidPrices.length === 0 && askPrices.length === 0) return;

              const snapshot: ParsedOrderBook = {
                bidPrices, bidSizes, bidOrders: [],
                askPrices, askSizes, askOrders: [],
                timestamp: new Date(timestamp)
              };
              snaps.push(snapshot);

              rawEvents.push({
                timestamp, sortOrder, eventType: 'ORDERBOOK',
                bookBidPrices: bidPrices, bookBidSizes: bidSizes,
                bookAskPrices: askPrices, bookAskSizes: askSizes
              });
            }
          });

          rawEvents.sort((a, b) => a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.sortOrder - b.sortOrder);
          const events: MarketEvent[] = rawEvents.map(({ sortOrder, ...r }) => r);

          // infer tick
          const allPrices = [
            ...tlist.map(t => t.price),
            ...snaps.flatMap(s => [...s.bidPrices, ...s.askPrices])
          ];
          if (allPrices.length > 0) {
            const inferred = orderBookProcessor.inferTickSize(allPrices);
            orderBookProcessor.setTickSize(inferred || TICK_SIZE);
          }

          snaps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          tlist.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          // initial price
          let initialPrice = 19300;
          const ft = events.find(e => e.eventType === 'TRADE' && e.tradePrice && e.tradePrice > 0);
          if (ft?.tradePrice) initialPrice = ft.tradePrice;
          else {
            const fe = events.find(e =>
              (e.eventType === 'ORDERBOOK' && ((e.bookBidPrices?.length ?? 0) > 0 || (e.bookAskPrices?.length ?? 0) > 0)) ||
              (e.eventType === 'BBO' && (e.bidPrice || e.askPrice))
            );
            if (fe) {
              if (fe.eventType === 'ORDERBOOK') {
                if (fe.bookBidPrices?.length) initialPrice = fe.bookBidPrices[0];
                else if (fe.bookAskPrices?.length) initialPrice = fe.bookAskPrices[0];
              } else if (fe.eventType === 'BBO') {
                initialPrice = fe.bidPrice || fe.askPrice || initialPrice;
              }
            }
          }

          setCurrentPrice(initialPrice);
          setMarketData(events);
          setOrderBookSnapshots(snaps);
          setTrades(tlist);

          if (snaps.length > 0) {
            const ladder = orderBookProcessor.createTickLadder(snaps[0], tlist);
            setCurrentTickLadder(ladder);
          }
        }
      });
    };
    reader.readAsText(file, 'UTF-8');
  }, [orderBookProcessor]);

  // --- Aggregation flush (T&S) ----------------------------------
  const flushAggregationBuffer = useCallback(() => {
    setAggregationBuffer(prev => {
      if (!prev || prev.trades.length === 0) return null;
      const aggregated: Trade = {
        id: `agg-${Date.now()}-${Math.random()}`,
        timestamp: prev.trades[prev.trades.length - 1].timestamp,
        price: prev.key.price,
        size: prev.trades.reduce((s, t) => s + t.size, 0),
        aggressor: prev.key.aggressor,
        aggregatedCount: prev.trades.length
      };
      setTimeAndSales(prevTAS => [aggregated, ...prevTAS.slice(0, 99)]);
      return null;
    });
  }, []);

  // --- L2/BBO coalescer (25ms) ----------------------------------
  const l2BufferRef = useRef<L2Buffer | null>(null);
  const l2TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleL2Flush = useCallback(() => {
    if (l2TimerRef.current) return;
    l2TimerRef.current = setTimeout(() => {
      l2TimerRef.current = null;
      const buf = l2BufferRef.current;
      if (!buf) return;

      // Priorité au snapshot ORDERBOOK le plus récent ; sinon fallback BBO
      let bidPrices: number[] = buf.ob?.bidPrices ? [...buf.ob.bidPrices] : [];
      let bidSizes: number[] = buf.ob?.bidSizes ? [...buf.ob.bidSizes] : [];
      let askPrices: number[] = buf.ob?.askPrices ? [...buf.ob.askPrices] : [];
      let askSizes: number[] = buf.ob?.askSizes ? [...buf.ob.askSizes] : [];

      // Si pas de snapshot, on construit un “mini” à partir du BBO
      if (bidPrices.length === 0 && (buf.bbo?.bidPrice ?? 0) > 0) {
        bidPrices = [buf.bbo!.bidPrice!];
        bidSizes = [buf.bbo!.bidSize || 0];
      }
      if (askPrices.length === 0 && (buf.bbo?.askPrice ?? 0) > 0) {
        askPrices = [buf.bbo!.askPrice!];
        askSizes = [buf.bbo!.askSize || 0];
      }

      // Tri (sécurité)
      bidPrices = bidPrices.slice(0, 20).sort((a, b) => b - a);
      askPrices = askPrices.slice(0, 20).sort((a, b) => a - b);
      bidSizes = bidSizes.slice(0, 20);
      askSizes = askSizes.slice(0, 20);

      const bestBid = bidPrices[0];
      const bestAsk = askPrices[0];

      // Clamp de secours si MAJ partielle : éviter spread négatif en affichage
      if (bestBid && bestAsk && bestAsk < bestBid) {
        // On force un spread nul côté display compact (n’altère pas nos données historiques)
        if (askPrices.length > 0) askPrices[0] = Math.max(askPrices[0], bestBid);
      }

      // 1) Compact snapshot pour UI + market
      setCurrentOrderBookData({
        book_bid_prices: bidPrices,
        book_ask_prices: askPrices,
        book_bid_sizes: bidSizes,
        book_ask_sizes: askSizes
      });

      // 2) OrderBook (10 niveaux) pour le Ladder “simple” (la vraie grille 20 niveaux vient du TickLadder)
      const newBook: OrderBookLevel[] = [];
      const map = new Map<number, OrderBookLevel>();

      for (let i = 0; i < Math.min(bidPrices.length, 10); i++) {
        const p = roundToGrid(bidPrices[i]);
        const s = bidSizes[i] || 0;
        if (p > 0) {
          const ex = map.get(p);
          if (ex) ex.bidSize = s; else {
            map.set(p, { price: p, bidSize: s, askSize: 0, volume: volumeByPriceRef.current.get(p) || 0 });
            newBook.push(map.get(p)!);
          }
        }
      }
      for (let i = 0; i < Math.min(askPrices.length, 10); i++) {
        const p = roundToGrid(askPrices[i]);
        const s = askSizes[i] || 0;
        if (p > 0) {
          const ex = map.get(p);
          if (ex) ex.askSize = s; else {
            map.set(p, { price: p, bidSize: 0, askSize: s, volume: volumeByPriceRef.current.get(p) || 0 });
            newBook.push(map.get(p)!);
          }
        }
      }
      newBook.sort((a, b) => b.price - a.price);
      setOrderBook(newBook);

      // 3) Tick ladder à partir du snapshot coalescé (source unique)
      const ts = Math.max(buf.ob?.ts ?? 0, buf.bbo?.ts ?? 0) || Date.now();
      const snap: ParsedOrderBook = {
        bidPrices, bidSizes, bidOrders: [],
        askPrices, askSizes, askOrders: [],
        timestamp: new Date(ts)
      };
      const ladder = orderBookProcessor.createTickLadder(snap, tradesRef.current);
      setCurrentTickLadder(ladder);

      // Clear buffer
      l2BufferRef.current = null;
    }, L2_COALESCE_MS);
  }, [orderBookProcessor]);

  // --- Core event processor -------------------------------------
  const processEvent = useCallback((event: MarketEvent) => {
    switch (event.eventType) {
      case 'TRADE': {
        if (event.tradePrice && event.tradeSize && event.aggressor) {
          const trade: Trade = {
            id: `trade-${Date.now()}-${Math.random()}`,
            timestamp: event.timestamp,
            price: event.tradePrice,
            size: event.tradeSize,
            aggressor: event.aggressor
          };

          // TAS aggregation
          setAggregationBuffer(prev => {
            const key = { price: event.tradePrice!, aggressor: event.aggressor! };
            const ok =
              prev && prev.key.price === key.price &&
              prev.key.aggressor === key.aggressor &&
              (event.timestamp - prev.lastTimestamp) <= AGGREGATION_WINDOW_MS;

            if (ok) return { trades: [...prev!.trades, trade], lastTimestamp: event.timestamp, key };
            if (prev && prev.trades.length > 0) {
              const aggregated: Trade = {
                id: `agg-${Date.now()}-${Math.random()}`,
                timestamp: prev.trades[prev.trades.length - 1].timestamp,
                price: prev.key.price,
                size: prev.trades.reduce((s, t) => s + t.size, 0),
                aggressor: prev.key.aggressor,
                aggregatedCount: prev.trades.length
              };
              setTimeAndSales(prevTAS => [aggregated, ...prevTAS.slice(0, 99)]);
            }
            return { trades: [trade], lastTimestamp: event.timestamp, key };
          });

          // last
          setCurrentPrice(event.tradePrice);

          // volume grid
          const gp = roundToGrid(event.tradePrice);
          setVolumeByPrice(prev => {
            const next = new Map(prev);
            next.set(gp, (next.get(gp) ?? 0) + event.tradeSize);
            return next;
          });

          // order fills via prints (on conserve tel quel si tu les utilises)
          setOrders(prevOrders =>
            prevOrders.map(o => {
              if (o.filled >= o.quantity) return o;
              const should = (o.side === 'BUY' && event.tradePrice! <= o.price) ||
                             (o.side === 'SELL' && event.tradePrice! >= o.price);
              if (!should) return o;
              const fill = Math.min(o.quantity - o.filled, event.tradeSize!);
              return { ...o, filled: o.filled + fill };
            })
          );
        }
        break;
      }

      case 'BBO': {
        // ★ On ne met plus à jour l'affichage directement : on bufferise pour coalescer
        l2BufferRef.current = {
          ...(l2BufferRef.current || {}),
          bbo: {
            bidPrice: event.bidPrice,
            bidSize: event.bidSize,
            askPrice: event.askPrice,
            askSize: event.askSize,
            ts: event.timestamp
          }
        };
        scheduleL2Flush();

        // ★ On conserve ta logique d’exécution LIMIT via BBO (qui marche bien chez toi)
        const bestBid = event.bidPrice;
        const bestAsk = event.askPrice;
        if (Number.isFinite(bestBid as number) || Number.isFinite(bestAsk as number)) {
          setOrders(prev => {
            const updated: Order[] = [];
            for (const order of prev) {
              let exec = false;
              if (order.side === 'BUY' && Number.isFinite(bestAsk as number) && (bestAsk as number) <= order.price) exec = true;
              if (order.side === 'SELL' && Number.isFinite(bestBid as number) && (bestBid as number) >= order.price) exec = true;
              if (!exec) { updated.push(order); continue; }

              const qty = order.quantity - order.filled;
              if (qty <= 0) continue;
              const fillPrice = roundToGrid(order.price);

              setPosition(prevPos => {
                const newQty = prevPos.quantity + (order.side === 'BUY' ? qty : -qty);
                let realized = 0;
                if (prevPos.quantity !== 0) {
                  const closing = (prevPos.quantity > 0 && order.side === 'SELL') || (prevPos.quantity < 0 && order.side === 'BUY');
                  if (closing) {
                    const closeQty = Math.min(qty, Math.abs(prevPos.quantity));
                    const tickDiff =
                      prevPos.quantity > 0
                        ? (fillPrice - prevPos.averagePrice) / TICK_SIZE
                        : (prevPos.averagePrice - fillPrice) / TICK_SIZE;
                    realized = closeQty * tickDiff * TICK_VALUE;
                    setRealizedPnLTotal(t => t + realized);
                  }
                }

                let newAvg = prevPos.averagePrice;
                if (newQty === 0) newAvg = 0;
                else if ((prevPos.quantity >= 0 && order.side === 'BUY') || (prevPos.quantity <= 0 && order.side === 'SELL')) {
                  const prevAbs = Math.abs(prevPos.quantity);
                  const total = prevAbs + qty;
                  const prevVal = prevPos.averagePrice * prevAbs;
                  const addVal = fillPrice * qty;
                  newAvg = total > 0 ? (prevVal + addVal) / total : fillPrice;
                } else {
                  newAvg = fillPrice;
                }
                return { ...prevPos, quantity: newQty, averagePrice: roundToGrid(newAvg), marketPrice: fillPrice };
              });

              setCurrentPrice(fillPrice);

              const t: Trade = {
                id: `limit-bbo-${Date.now()}-${Math.random()}`,
                timestamp: Date.now(),
                price: fillPrice,
                size: qty,
                aggressor: order.side
              };
              setTimeAndSales(prevTnS => [t, ...prevTnS.slice(0, 99)]);

              const gp = roundToGrid(fillPrice);
              setVolumeByPrice(prevMap => {
                const next = new Map(prevMap);
                next.set(gp, (next.get(gp) ?? 0) + qty);
                return next;
              });

              setTrades(prevTrades => {
                const nextTrades = [...prevTrades, { timestamp: new Date(), price: fillPrice, size: qty, aggressor: order.side }];
                const snaps = orderBookSnapshotsRef.current;
                if (snaps.length > 0) {
                  const lastSnap = snaps[snaps.length - 1];
                  const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
                  setCurrentTickLadder(ladder);
                }
                return nextTrades;
              });

              // ordre exécuté → on ne le remet pas
            }
            return updated;
          });

          setPosition(prev => ({ ...prev })); // small nudge
        }

        // Maintenir currentOrderBookData minimal pour market (en cas d’absence d’ORDERBOOK)
        setCurrentOrderBookData(prevData => ({
          book_bid_prices: (event.bidPrice ? [event.bidPrice] : (prevData?.book_bid_prices ?? [])),
          book_ask_prices: (event.askPrice ? [event.askPrice] : (prevData?.book_ask_prices ?? [])),
          book_bid_sizes: (event.bidSize ? [event.bidSize] : (prevData?.book_bid_sizes ?? [])),
          book_ask_sizes: (event.askSize ? [event.askSize] : (prevData?.book_ask_sizes ?? []))
        }));
        break;
      }

      case 'ORDERBOOK': {
        // ★ Bufferise le snapshot complet et flush dans la frame 25ms
        l2BufferRef.current = {
          ...(l2BufferRef.current || {}),
          ob: {
            bidPrices: event.bookBidPrices || [],
            bidSizes: event.bookBidSizes || [],
            askPrices: event.bookAskPrices || [],
            askSizes: event.bookAskSizes || [],
            ts: event.timestamp
          }
        };
        scheduleL2Flush();
        break;
      }
    }
  }, [orderBookProcessor, scheduleL2Flush]);

  // --- Playback toggle ------------------------------------------
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => {
      if (prev) flushAggregationBuffer();
      return !prev;
    });
  }, [flushAggregationBuffer]);

  // --- Place LIMIT ----------------------------------------------
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const newOrder: Order = {
      id: `order-${++orderIdCounter.current}`,
      side, price: roundToGrid(price), quantity,
      filled: 0, timestamp: Date.now()
    };
    setOrders(prev => [...prev, newOrder]);
  }, []);

  // --- Place MARKET @ BBO ---------------------------------------
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    const bestAsk = currentOrderBookData?.book_ask_prices?.[0];
    const bestBid = currentOrderBookData?.book_bid_prices?.[0];
    const fillPrice = roundToGrid(side === 'BUY' ? (bestAsk ?? currentPrice) : (bestBid ?? currentPrice));

    setPosition(prev => {
      const newQty = prev.quantity + (side === 'BUY' ? quantity : -quantity);

      let realized = 0;
      if (prev.quantity !== 0) {
        const closing = (prev.quantity > 0 && side === 'SELL') || (prev.quantity < 0 && side === 'BUY');
        if (closing) {
          const closeQty = Math.min(quantity, Math.abs(prev.quantity));
          const tickDiff = prev.quantity > 0
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
        const addVal = fillPrice * quantity;
        newAvg = totalQty > 0 ? (prevVal + addVal) / totalQty : fillPrice;
      } else {
        newAvg = fillPrice;
      }

      return { ...prev, quantity: newQty, averagePrice: roundToGrid(newAvg), marketPrice: fillPrice };
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

    const gp = roundToGrid(fillPrice);
    setVolumeByPrice(prev => {
      const next = new Map(prev);
      next.set(gp, (next.get(gp) ?? 0) + quantity);
      return next;
    });

    setTrades(prev => {
      const nextTrades = [...prev, { timestamp: new Date(), price: fillPrice, size: quantity, aggressor: side }];
      const snaps = orderBookSnapshotsRef.current;
      if (snaps.length > 0) {
        const lastSnap = snaps[snaps.length - 1];
        const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
        setCurrentTickLadder(ladder);
      }
      return nextTrades;
    });
  }, [currentOrderBookData, currentPrice, orderBookProcessor]);

  // --- Cancel LIMIT at price ------------------------------------
  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(order => Math.abs(order.price - price) >= TICK_SIZE / 2));
  }, []);

  // --- PnL update ------------------------------------------------
  useEffect(() => {
    const tickDiff = (currentPrice - position.averagePrice) / TICK_SIZE;
    const unrealized = position.quantity * tickDiff * TICK_VALUE;
    setPnl({ unrealized, realized: realizedPnLTotal, total: unrealized + realizedPnLTotal });
  }, [position, currentPrice, realizedPnLTotal]);

  // --- Playback loop --------------------------------------------
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

  return {
    marketData,
    position,
    pnl,
    timeAndSales,
    isPlaying,
    playbackSpeed,
    currentPrice,
    orderBook,
    currentOrderBookData,
    orders,
    loadMarketData,
    togglePlayback,
    setPlaybackSpeed,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,
    // DOM ladder
    orderBookSnapshots,
    trades,
    currentTickLadder,
    orderBookProcessor
  };
}