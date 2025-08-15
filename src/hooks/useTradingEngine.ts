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

export interface Position {
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
    symbol: 'DEMO',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0
  });
  const [pnl, setPnl] = useState<PnL>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // Order book processor / data
  const [orderBookSnapshots, setOrderBookSnapshots] = useState<ParsedOrderBook[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(0.25));

  // Refs pour éviter les states "stale"
  const orderBookSnapshotsRef = useRef<ParsedOrderBook[]>([]);
  const tradesRef = useRef<OrderBookTrade[]>([]);
  useEffect(() => { orderBookSnapshotsRef.current = orderBookSnapshots; }, [orderBookSnapshots]);
  useEffect(() => { tradesRef.current = trades; }, [trades]);

  // Constantes NQ
  const TICK_SIZE = 0.25;
  const TICK_VALUE = 5.0;
  const AGGREGATION_WINDOW_MS = 5;

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // ----------------------- Utils -----------------------
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
          return json.map(v => parseFloat(v)).filter(v => !isNaN(v));
        }
      }
    } catch { /* ignore JSON fail */ }
    const cleaned = value.replace(/^\[|\]$/g, '').trim();
    if (!cleaned) return [];
    return cleaned.split(/[\s,]+/).map(v => parseFloat(v)).filter(v => !isNaN(v));
  };

  const normalizeEventType = (eventType: string): string =>
    eventType?.toString().toUpperCase().trim() || '';

  const normalizeAggressor = (aggressor: string): 'BUY' | 'SELL' | undefined => {
    const a = aggressor?.toString().toUpperCase().trim();
    if (a === 'BUY' || a === 'B') return 'BUY';
    if (a === 'SELL' || a === 'S') return 'SELL';
    return undefined;
  };

  const roundToGrid = (price: number): number => Math.round(price * 4) / 4; // 0.25

  // BBO robuste pour ordres market
  const getBestPrices = useCallback((): { bestBid?: number; bestAsk?: number } => {
    let bestBid = Number.NEGATIVE_INFINITY;
    let bestAsk = Number.POSITIVE_INFINITY;

    // 1) top-of-book conservé (BBO)
    if (currentOrderBookData?.book_bid_prices?.length) {
      const bids = currentOrderBookData.book_bid_prices;
      const sizes = currentOrderBookData.book_bid_sizes || [];
      for (let i = 0; i < bids.length; i++) {
        const p = bids[i];
        const s = sizes[i] ?? 0;
        if (Number.isFinite(p) && s > 0) bestBid = Math.max(bestBid, p);
      }
    }
    if (currentOrderBookData?.book_ask_prices?.length) {
      const asks = currentOrderBookData.book_ask_prices;
      const sizes = currentOrderBookData.book_ask_sizes || [];
      for (let i = 0; i < asks.length; i++) {
        const p = asks[i];
        const s = sizes[i] ?? 0;
        if (Number.isFinite(p) && s > 0) bestAsk = Math.min(bestAsk, p);
      }
    }

    // 2) fallback : ladder local
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
      for (const lvl of orderBook) {
        if ((lvl.bidSize ?? 0) > 0) bestBid = Math.max(bestBid, lvl.price);
        if ((lvl.askSize ?? 0) > 0) bestAsk = Math.min(bestAsk, lvl.price);
      }
    }

    return {
      bestBid: Number.isFinite(bestBid) ? bestBid : undefined,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : undefined,
    };
  }, [currentOrderBookData, orderBook]);

  // ----------------------- Load CSV -----------------------
  const loadMarketData = useCallback((file: File) => {
    // reset
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    setOrderBookSnapshots([]);
    setTrades([]);
    setCurrentTickLadder(null);
    orderBookProcessor.resetVolume();

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (results) => {
          try {
            const rawEvents: Array<MarketEvent & { sortOrder: number }> = [];
            const processedRows = new Set<string>();
            const snaps: ParsedOrderBook[] = [];
            const tEvents: OrderBookTrade[] = [];

            results.data.forEach((row: any) => {
              if (!row || Object.keys(row).length === 0) return;
              const key = JSON.stringify(row);
              if (processedRows.has(key)) return;
              processedRows.add(key);

              const timestamp = parseTimestamp(row);
              const eventType = normalizeEventType(row.event_type);

              let sortOrder = 0;
              if (eventType === 'ORDERBOOK') sortOrder = 0;
              else if (eventType === 'BBO') sortOrder = 1;
              else if (eventType === 'TRADE') sortOrder = 2;

              if (eventType === 'TRADE') {
                const price = parseFloat(row.trade_price);
                const size = parseFloat(row.trade_size);
                const aggressor = normalizeAggressor(row.aggressor);
                if (isNaN(price) || price <= 0 || isNaN(size) || size <= 0 || !aggressor) return;

                const t = orderBookProcessor.parseTrade(row);
                if (t) tEvents.push(t);

                rawEvents.push({ timestamp, sortOrder, eventType: 'TRADE', tradePrice: price, tradeSize: size, aggressor });
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
                const bidOrders = parseArrayField(row.book_bid_orders);
                const askPrices = parseArrayField(row.book_ask_prices);
                const askSizes = parseArrayField(row.book_ask_sizes);
                const askOrders = parseArrayField(row.book_ask_orders);

                const bidValid = bidPrices.length === bidSizes.length &&
                  (bidOrders.length === 0 || bidOrders.length === bidPrices.length);
                const askValid = askPrices.length === askSizes.length &&
                  (askOrders.length === 0 || askOrders.length === askPrices.length);
                if (!bidValid || !askValid) return;
                if (bidPrices.length === 0 && askPrices.length === 0) return;

                const snap = orderBookProcessor.parseOrderBookSnapshot(row);
                if (snap) snaps.push(snap);

                rawEvents.push({
                  timestamp, sortOrder, eventType: 'ORDERBOOK',
                  bookBidPrices: bidPrices, bookAskPrices: askPrices,
                  bookBidSizes: bidSizes, bookAskSizes: askSizes
                });
              }
            });

            rawEvents.sort((a, b) => a.timestamp !== b.timestamp
              ? a.timestamp - b.timestamp
              : a.sortOrder - b.sortOrder);

            const events: MarketEvent[] = rawEvents.map(({ sortOrder, ...e }) => e);

            // tick size
            const allPrices = [
              ...tEvents.map(t => t.price),
              ...snaps.flatMap(s => [...s.bidPrices, ...s.askPrices])
            ];
            if (allPrices.length > 0) {
              const inferred = orderBookProcessor.inferTickSize(allPrices);
              orderBookProcessor.setTickSize(inferred);
            }

            snaps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
            tEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

            // initial price
            let initialPrice = 19300;
            const firstTrade = events.find(e => e.eventType === 'TRADE' && e.tradePrice && e.tradePrice > 0);
            if (firstTrade?.tradePrice) {
              initialPrice = firstTrade.tradePrice;
            } else {
              const firstPriceEvent = events.find(e =>
                (e.eventType === 'ORDERBOOK' && ((e.bookBidPrices?.length ?? 0) > 0 || (e.bookAskPrices?.length ?? 0) > 0)) ||
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

            setCurrentPrice(initialPrice);
            setMarketData(events);
            setOrderBookSnapshots(snaps);
            setTrades(tEvents);

            if (snaps.length > 0) {
              const initialLadder = orderBookProcessor.createTickLadder(snaps[0], tEvents);
              setCurrentTickLadder(initialLadder);
            }
          } catch (err) {
            console.error('CSV processing error:', err);
            throw err;
          }
        }
      });
    };
    reader.readAsText(file, 'UTF-8');
  }, [orderBookProcessor]);

  // ---------------- Flush TAS aggregation ----------------
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

  // ---------------- Core event processor ----------------
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

          // aggregation TAS
          setAggregationBuffer(prev => {
            const key = { price: event.tradePrice!, aggressor: event.aggressor! };
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
          setCurrentPrice(event.tradePrice);

          // volume cumulé par prix
          const gridPrice = roundToGrid(event.tradePrice);
          setVolumeByPrice(prev => {
            const next = new Map(prev);
            next.set(gridPrice, (next.get(gridPrice) ?? 0) + event.tradeSize);
            return next;
          });

          // UI volume
          setOrderBook(prev => prev.map(level =>
            Math.abs(level.price - gridPrice) < 0.125
              ? { ...level, volume: (level.volume || 0) + event.tradeSize! }
              : level
          ));

          // filets de sécurité : remplir des limites via prints
          setOrders(prevOrders =>
            prevOrders.map(order => {
              if (order.filled >= order.quantity) return order;
              const shouldFill =
                (order.side === 'BUY' && event.tradePrice! <= order.price) ||
                (order.side === 'SELL' && event.tradePrice! >= order.price);
              if (!shouldFill) return order;
              const fillSize = Math.min(order.quantity - order.filled, event.tradeSize!);
              return { ...order, filled: order.filled + fillSize };
            })
          );
        }
        break;
      }

      case 'BBO': {
        // mini-book
        if (event.bidPrice || event.askPrice) {
          setOrderBook(prev => {
            const book = [...prev];
            if (event.bidPrice && event.bidPrice > 0) {
              const p = roundToGrid(event.bidPrice);
              const i = book.findIndex(l => Math.abs(l.price - p) < 0.125);
              if (i >= 0) book[i] = { ...book[i], bidSize: event.bidSize || 0 };
              else book.push({ price: p, bidSize: event.bidSize || 0, askSize: 0, volume: volumeByPrice.get(p) || 0 });
            }
            if (event.askPrice && event.askPrice > 0) {
              const p = roundToGrid(event.askPrice);
              const i = book.findIndex(l => Math.abs(l.price - p) < 0.125);
              if (i >= 0) book[i] = { ...book[i], askSize: event.askSize || 0 };
              else book.push({ price: p, bidSize: 0, askSize: event.askSize || 0, volume: volumeByPrice.get(p) || 0 });
            }
            book.sort((a, b) => b.price - a.price);
            return book;
          });
        }

        // top-of-book → limite
        const bestBid = event.bidPrice;
        const bestAsk = event.askPrice;

        if (Number.isFinite(bestBid as number) || Number.isFinite(bestAsk as number)) {
          setOrders(prev => {
            const updated: Order[] = [];

            for (const order of prev) {
              let shouldExecute = false;
              if (order.side === 'BUY' && Number.isFinite(bestAsk as number) && (bestAsk as number) <= order.price) {
                shouldExecute = true;
              }
              if (order.side === 'SELL' && Number.isFinite(bestBid as number) && (bestBid as number) >= order.price) {
                shouldExecute = true;
              }
              if (!shouldExecute) { updated.push(order); continue; }

              const qty = order.quantity - order.filled;
              if (qty <= 0) continue;
              const fillPrice = order.price;

              // Position + realized
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

                return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: fillPrice };
              });

              setCurrentPrice(fillPrice);

              // TAS synthétique
              const t: Trade = {
                id: `limit-bbo-${Date.now()}-${Math.random()}`,
                timestamp: Date.now(),
                price: fillPrice,
                size: qty,
                aggressor: order.side
              };
              setTimeAndSales(prevTnS => [t, ...prevTnS.slice(0, 99)]);

              // Volume cumulé
              const grid = roundToGrid(fillPrice);
              setVolumeByPrice(prevMap => {
                const next = new Map(prevMap);
                next.set(grid, (next.get(grid) ?? 0) + qty);
                return next;
              });

              // Ladder avec trade synthétique
              setTrades(prevTrades => {
                const nextTrades = [
                  ...prevTrades,
                  { timestamp: new Date(), price: fillPrice, size: qty, aggressor: order.side }
                ];
                const snaps = orderBookSnapshotsRef.current;
                if (snaps.length > 0) {
                  const lastSnap = snaps[snaps.length - 1];
                  const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
                  setCurrentTickLadder(ladder);
                }
                return nextTrades;
              });
              // (ordre rempli ⇒ on ne le remet pas)
            }

            return updated;
          });

          setPosition(prev => ({ ...prev })); // force rerender
        }

        // Maintenir currentOrderBookData pour market @ BBO
        setCurrentOrderBookData(prevData => ({
          book_bid_prices: event.bidPrice ? [event.bidPrice] : (prevData?.book_bid_prices ?? []),
          book_ask_prices: event.askPrice ? [event.askPrice] : (prevData?.book_ask_prices ?? []),
          book_bid_sizes: event.bidSize ? [event.bidSize] : (prevData?.book_bid_sizes ?? []),
          book_ask_sizes: event.askSize ? [event.askSize] : (prevData?.book_ask_sizes ?? [])
        }));

        break;
      }

      case 'ORDERBOOK': {
        if (event.bookBidPrices || event.bookAskPrices) {
          // garder 20 niveaux
          setCurrentOrderBookData({
            book_bid_prices: event.bookBidPrices?.slice(0, 20) || [],
            book_ask_prices: event.bookAskPrices?.slice(0, 20) || [],
            book_bid_sizes: event.bookBidSizes?.slice(0, 20) || [],
            book_ask_sizes: event.bookAskSizes?.slice(0, 20) || []
          });

          // ladder depuis snapshot le plus proche
          const currentSnapshot = orderBookSnapshotsRef.current.find(s =>
            Math.abs(s.timestamp.getTime() - event.timestamp) < 1000
          );

          if (currentSnapshot) {
            const list = orderBookSnapshotsRef.current;
            const idx = list.findIndex(s => s === currentSnapshot);
            const prevSnap = idx > 0 ? list[idx - 1] : undefined;
            const ladder = orderBookProcessor.createTickLadder(currentSnapshot, tradesRef.current, prevSnap?.timestamp);
            setCurrentTickLadder(ladder);
          } else {
            const snap: ParsedOrderBook = {
              bidPrices: event.bookBidPrices || [],
              bidSizes: event.bookBidSizes || [],
              bidOrders: [],
              askPrices: event.bookAskPrices || [],
              askSizes: event.bookAskSizes || [],
              askOrders: [],
              timestamp: new Date(event.timestamp)
            };
            const ladder = orderBookProcessor.createTickLadder(snap, tradesRef.current);
            setCurrentTickLadder(ladder);
          }

          // mini-book local (10 niveaux)
          const newBook: OrderBookLevel[] = [];
          const priceMap = new Map<number, OrderBookLevel>();

          if (event.bookBidPrices && event.bookBidSizes) {
            for (let i = 0; i < Math.min(event.bookBidPrices.length, 10); i++) {
              const bp = event.bookBidPrices[i];
              const bs = event.bookBidSizes[i] || 0;
              if (bp > 0 && bs > 0) {
                const gp = roundToGrid(bp);
                const ex = priceMap.get(gp);
                if (ex) ex.bidSize = bs;
                else {
                  const level: OrderBookLevel = {
                    price: gp, bidSize: bs, askSize: 0,
                    volume: volumeByPrice.get(gp) || 0
                  };
                  priceMap.set(gp, level);
                  newBook.push(level);
                }
              }
            }
          }

          if (event.bookAskPrices && event.bookAskSizes) {
            for (let i = 0; i < Math.min(event.bookAskPrices.length, 10); i++) {
              const ap = event.bookAskPrices[i];
              const asz = event.bookAskSizes[i] || 0;
              if (ap > 0 && asz > 0) {
                const gp = roundToGrid(ap);
                const ex = priceMap.get(gp);
                if (ex) ex.askSize = asz;
                else {
                  const level: OrderBookLevel = {
                    price: gp, bidSize: 0, askSize: asz,
                    volume: volumeByPrice.get(gp) || 0
                  };
                  priceMap.set(gp, level);
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
  }, [AGGREGATION_WINDOW_MS, orderBookProcessor, volumeByPrice]);

  // ---------------- Playback toggle ----------------
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => {
      if (prev) flushAggregationBuffer();
      return !prev;
    });
  }, [flushAggregationBuffer]);

  // ---------------- Place LIMIT ----------------
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const newOrder: Order = {
      id: `order-${++orderIdCounter.current}`,
      side, price, quantity,
      filled: 0,
      timestamp: Date.now()
    };
    setOrders(prev => [...prev, newOrder]);
  }, []);

  // ---------------- Place MARKET @ BBO (fix) ----------------
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    const { bestBid, bestAsk } = getBestPrices();

    let fillPrice =
      side === 'BUY'
        ? (bestAsk ?? currentPrice)
        : (bestBid ?? currentPrice);

    fillPrice = roundToGrid(fillPrice);

    // Position + realized
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
        const addVal = fillPrice * quantity;
        newAvg = totalQty > 0 ? (prevVal + addVal) / totalQty : fillPrice;
      } else {
        newAvg = fillPrice; // inversion
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

    setTrades(prev => {
      const nextTrades = [
        ...prev,
        { timestamp: new Date(), price: fillPrice, size: quantity, aggressor: side }
      ];
      const snaps = orderBookSnapshotsRef.current;
      if (snaps.length > 0) {
        const lastSnap = snaps[snaps.length - 1];
        const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
        setCurrentTickLadder(ladder);
      }
      return nextTrades;
    });
  }, [getBestPrices, currentPrice, orderBookProcessor]);

  // ---------------- Cancel LIMIT @ price ----------------
  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(order => Math.abs(order.price - price) >= 0.125));
  }, []);

  // ---------------- PnL (unrealized) ----------------
  useEffect(() => {
    const tickDiff = (currentPrice - position.averagePrice) / TICK_SIZE;
    const unrealized = position.quantity * tickDiff * TICK_VALUE;
    setPnl({ unrealized, realized: realizedPnLTotal, total: unrealized + realizedPnLTotal });
  }, [position, currentPrice, realizedPnLTotal]);

  // ---------------- Filet de sécu LIMIT via currentPrice ----------------
  useEffect(() => {
    if (currentPrice <= 0) return;

    setOrders(prevOrders => {
      const updated = [...prevOrders];

      for (let i = updated.length - 1; i >= 0; i--) {
        const order = updated[i];
        let shouldExecute = false;

        if (order.side === 'BUY' && currentPrice <= order.price) shouldExecute = true;
        else if (order.side === 'SELL' && currentPrice >= order.price) shouldExecute = true;

        if (!shouldExecute) continue;

        const fillPrice = order.price;
        const quantity = order.quantity - order.filled;

        setPosition(prev => {
          const newQty = prev.quantity + (order.side === 'BUY' ? quantity : -quantity);

          let realized = 0;
          if (prev.quantity !== 0) {
            const closing = (prev.quantity > 0 && order.side === 'SELL') || (prev.quantity < 0 && order.side === 'BUY');
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
          else if ((prev.quantity > 0 && order.side === 'BUY') || (prev.quantity < 0 && order.side === 'SELL')) {
            const prevAbs = Math.abs(prev.quantity);
            const total = prevAbs + quantity;
            const prevVal = prev.averagePrice * prevAbs;
            const addVal = fillPrice * quantity;
            newAvg = total > 0 ? (prevVal + addVal) / total : fillPrice;
          } else if (Math.sign(newQty) !== Math.sign(prev.quantity)) {
            newAvg = fillPrice;
          }

          return { ...prev, quantity: newQty, averagePrice: newAvg, marketPrice: fillPrice };
        });

        // TAS + volume + ladder
        const t: Trade = {
          id: `limit-trade-${Date.now()}-${i}`,
          timestamp: Date.now(),
          price: fillPrice,
          size: quantity,
          aggressor: order.side
        };
        setTimeAndSales(prev => [t, ...prev]);

        const grid = roundToGrid(fillPrice);
        setVolumeByPrice(prevMap => {
          const next = new Map(prevMap);
          next.set(grid, (next.get(grid) ?? 0) + quantity);
          return next;
        });

        setTrades(prevTrades => {
          const nextTrades = [
            ...prevTrades,
            { timestamp: new Date(), price: fillPrice, size: quantity, aggressor: order.side }
          ];
          const snaps = orderBookSnapshotsRef.current;
          if (snaps.length > 0) {
            const lastSnap = snaps[snaps.length - 1];
            const ladder = orderBookProcessor.createTickLadder(lastSnap, nextTrades);
            setCurrentTickLadder(ladder);
          }
          return nextTrades;
        });

        updated.splice(i, 1);
      }

      return updated;
    });
  }, [currentPrice, orderBookProcessor]);

  // ---------------- Playback loop ----------------
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
    orderBookSnapshots,
    trades,
    currentTickLadder,
    orderBookProcessor
  };
}