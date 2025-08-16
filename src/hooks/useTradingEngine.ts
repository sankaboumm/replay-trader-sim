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
  bookBidOrders?: number[];
  bookAskPrices?: number[];
  bookAskSizes?: number[];
  bookAskOrders?: number[];
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
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
}

interface PnL {
  unrealized: number;
  realized: number;
  total: number;
}

const TICK_SIZE = 0.25;
const toTick = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;

function parseTimestamp(row: any): number {
  const cands = ['timestamp', 'time', 'ts', 'event_time', 'datetime', 'ts_utc', 'ts_exch_utc', 'ts_madrid', 'ts_exch_madrid'];
  for (const k of cands) {
    if (row[k]) {
      const v = row[k];
      const n = typeof v === 'number' ? v : Date.parse(String(v));
      if (!isNaN(n)) return typeof v === 'number' && v < 1e12 ? v * 1000 : n;
    }
  }
  return Date.now();
}

function normalizeEventType(v: any): MarketEvent['eventType'] | null {
  const s = String(v || '').toUpperCase();
  if (s.includes('TRADE')) return 'TRADE';
  if (s.includes('BBO')) return 'BBO';
  if (s.includes('ORDERBOOK')) return 'ORDERBOOK';
  if (s.includes('ORDERBOOK_FULL')) return 'ORDERBOOK';
  return null;
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
  const [timeAndSales, setTimeAndSales] = useState<OrderBookTrade[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<Position>({
    symbol: 'NQ',
    quantity: 0,
    averagePrice: 0,
  });
  const [pnl, setPnL] = useState<PnL>({ unrealized: 0, realized: 0, total: 0 });

  const [totalTrades, setTotalTrades] = useState(0);

  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(TICK_SIZE));
  const lastSnapshotRef = useRef<ParsedOrderBook | null>(null);
  const volumeByPriceRef = useRef<Map<number, number>>(new Map());
  const [windowHalf, setWindowHalf] = useState(300);
  const bboTsRef = useRef<{ bidTs: number; askTs: number }>({ bidTs: 0, askTs: 0 });

  const loadMarketData = useCallback((file: File) => {
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    setCurrentPrice(0);
    setOrderBook([]);
    setCurrentOrderBookData(null);
    setTimeAndSales([]);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0 });
    setPnL({ unrealized: 0, realized: 0, total: 0 });
    setCurrentTickLadder(null);
    setTotalTrades(0);
    orderBookProcessor.resetVolume();
    lastSnapshotRef.current = null;
    volumeByPriceRef.current = new Map();
    setWindowHalf(300);
    orderBookProcessor.setWindowHalf(300);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (results) => {
          const events: MarketEvent[] = [];
          const processedRows = new Set<string>();

          results.data.forEach((row: any) => {
            if (!row || Object.keys(row).length === 0) return;
            const key = JSON.stringify(row);
            if (processedRows.has(key)) return;
            processedRows.add(key);

            const timestamp = parseTimestamp(row);
            const t = normalizeEventType(row.event_type ?? row.type ?? row.kind);
            if (!t) return;

            if (t === 'TRADE') {
              const price = Number(row.trade_price ?? row.price ?? row.last_price);
              const size  = Number(row.trade_size  ?? row.size  ?? row.last_size);
              const aggressor = (String(row.aggressor || row.side || '').toUpperCase().includes('BUY') ? 'BUY' : 'SELL') as 'BUY'|'SELL';
              if (isFinite(price) && isFinite(size)) {
                events.push({ timestamp, eventType: 'TRADE', tradePrice: price, tradeSize: size, aggressor });
              }
            } else if (t === 'BBO') {
              const bidPrice = Number(row.bid_price ?? row.best_bid_price);
              const askPrice = Number(row.ask_price ?? row.best_ask_price);
              const bidSize  = Number(row.bid_size  ?? row.best_bid_size);
              const askSize  = Number(row.ask_size  ?? row.best_ask_size);
              if (isFinite(bidPrice) || isFinite(askPrice)) {
                events.push({ timestamp, eventType: 'BBO', bidPrice, askPrice, bidSize, askSize });
              }
            } else if (t === 'ORDERBOOK') {
              const snap = orderBookProcessor.parseOrderBookSnapshot({
                book_bid_prices: row.book_bid_prices,
                book_bid_sizes:  row.book_bid_sizes,
                book_bid_orders: row.book_bid_orders,
                book_ask_prices: row.book_ask_prices,
                book_ask_sizes:  row.book_ask_sizes,
                book_ask_orders: row.book_ask_orders,
              });
              if (snap) {
                events.push({
                  timestamp,
                  eventType: 'ORDERBOOK',
                  bookBidPrices: snap.bidPrices,
                  bookBidSizes:  snap.bidSizes,
                  bookBidOrders: snap.bidOrders,
                  bookAskPrices: snap.askPrices,
                  bookAskSizes:  snap.askSizes,
                  bookAskOrders: snap.askOrders,
                });
              }
            }
          });

          // sort by timestamp, then by type ORDERBOOK -> BBO -> TRADE
          const rank: Record<MarketEvent['eventType'], number> = { ORDERBOOK: 0, BBO: 1, TRADE: 2 };
          events.sort((a, b) => a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : rank[a.eventType] - rank[b.eventType]);

          // anchor + seed ladder immediately (so DOM shows even before first book)
          const firstMid = (() => {
            for (const e of events) {
              if (e.eventType === 'TRADE' && e.tradePrice) return e.tradePrice;
              if (e.eventType === 'BBO' && e.bidPrice && e.askPrice) return (e.bidPrice + e.askPrice) / 2;
              if (e.eventType === 'ORDERBOOK' && e.bookBidPrices && e.bookAskPrices && e.bookBidPrices.length && e.bookAskPrices.length) {
                return (e.bookBidPrices[0] + e.bookAskPrices[0]) / 2;
              }
            }
            return undefined;
          })();
          if (firstMid) {
            orderBookProcessor.setAnchorByPrice(firstMid);
            orderBookProcessor.setWindowHalf(300);
            const emptySnap: ParsedOrderBook = { bidPrices: [], bidSizes: [], askPrices: [], askSizes: [], bidOrders: [], askOrders: [] };
            const seed = orderBookProcessor.makeTickLadder(emptySnap, []);
            setCurrentTickLadder(seed);
          }

          setMarketData(events);
          setCurrentEventIndex(0);
          setIsPlaying(true);
        },
      });
    };
    reader.readAsText(file);
  }, [orderBookProcessor]);

  const applyCumulativeToLadder = useCallback((ladder: TickLadder | null): TickLadder | null => {
    if (!ladder) return ladder;
    const vol = volumeByPriceRef.current;
    const newLevels = ladder.levels.map(lvl => ({ ...lvl, volumeCumulative: vol.get(lvl.price) || 0 }));
    return { ...ladder, levels: newLevels };
  }, []);

  const expandLadderWindow = useCallback((deltaTicks: number) => {
    const newHalf = Math.max(50, windowHalf + Math.max(1, Math.floor(deltaTicks)));
    setWindowHalf(newHalf);
    orderBookProcessor.setWindowHalf(newHalf);
    const snap = lastSnapshotRef.current;
    if (snap) {
      const ladder = orderBookProcessor.makeTickLadder(snap, timeAndSales);
      setCurrentTickLadder(applyCumulativeToLadder(ladder));
    } else {
      // rebuild from empty snap with current anchor
      const emptySnap: ParsedOrderBook = { bidPrices: [], bidSizes: [], askPrices: [], askSizes: [], bidOrders: [], askOrders: [] };
      const seed = orderBookProcessor.makeTickLadder(emptySnap, []);
      setCurrentTickLadder(applyCumulativeToLadder(seed));
    }
  }, [windowHalf, orderBookProcessor, timeAndSales, applyCumulativeToLadder]);

  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) return;
    const interval = Math.max(16, 1000 / 60);
    const id = setInterval(() => {
      const step = Math.max(1, Math.round(playbackSpeed));
      const end = Math.min(currentEventIndex + step, marketData.length);
      for (let i = currentEventIndex; i < end; i++) {
        const event = marketData[i];
        switch (event.eventType) {
          case 'ORDERBOOK': {
            const snap: ParsedOrderBook = {
              bidPrices: event.bookBidPrices || [],
              bidSizes:  event.bookBidSizes  || [],
              bidOrders: event.bookBidOrders || [],
              askPrices: event.bookAskPrices || [],
              askSizes:  event.bookAskSizes  || [],
              askOrders: event.bookAskOrders || [],
            };
            lastSnapshotRef.current = snap;

            // top-of-book mini view (optional)
            const newBook: OrderBookLevel[] = [];
            const priceMap = new Map<number, OrderBookLevel>();
            for (let i = 0; i < Math.min(snap.bidPrices.length, 10); i++) {
              const p = toTick(snap.bidPrices[i]);
              const s = snap.bidSizes[i] || 0;
              if (p > 0 && s >= 0) {
                const ex = priceMap.get(p);
                if (ex) ex.bidSize = s; else { const lvl: OrderBookLevel = { price: p, bidSize: s, askSize: 0, volume: 0 }; priceMap.set(p, lvl); newBook.push(lvl); }
              }
            }
            for (let i = 0; i < Math.min(snap.askPrices.length, 10); i++) {
              const p = toTick(snap.askPrices[i]);
              const s = snap.askSizes[i] || 0;
              if (p > 0 && s >= 0) {
                const ex = priceMap.get(p);
                if (ex) ex.askSize = s; else { const lvl: OrderBookLevel = { price: p, bidSize: 0, askSize: s, volume: 0 }; priceMap.set(p, lvl); newBook.push(lvl); }
              }
            }
            newBook.sort((a,b) => b.price - a.price);
            setOrderBook(newBook);

            const ladder = orderBookProcessor.makeTickLadder(snap, timeAndSales);
            setCurrentTickLadder(applyCumulativeToLadder(ladder));
            break;
          }
          case 'BBO': {
            setCurrentOrderBookData(prev => ({
              book_bid_prices: typeof event.bidPrice === 'number' ? [toTick(event.bidPrice)] : (prev?.book_bid_prices ?? []),
              book_ask_prices: typeof event.askPrice === 'number' ? [toTick(event.askPrice)] : (prev?.book_ask_prices ?? []),
              book_bid_sizes:  typeof event.bidSize  === 'number' ? [event.bidSize]         : (prev?.book_bid_sizes  ?? []),
              book_ask_sizes:  typeof event.askSize  === 'number' ? [event.askSize]         : (prev?.book_ask_sizes  ?? []),
              book_bid_orders: prev?.book_bid_orders,
              book_ask_orders: prev?.book_ask_orders,
            }));

            // build ladder from BBO if no full book yet
            try {
              const bidP = event.bidPrice;
              const askP = event.askPrice;
              const bidS = event.bidSize ?? 0;
              const askS = event.askSize ?? 0;
              if ((typeof bidP === 'number') || (typeof askP === 'number')) {
                const snap: ParsedOrderBook = {
                  bidPrices: typeof bidP === 'number' ? [bidP] : [],
                  bidSizes:  typeof bidS === 'number' ? [bidS] : [],
                  bidOrders: [],
                  askPrices: typeof askP === 'number' ? [askP] : [],
                  askSizes:  typeof askS === 'number' ? [askS] : [],
                  askOrders: [],
                };
                lastSnapshotRef.current = snap;
                const ladder = orderBookProcessor.makeTickLadder(snap, timeAndSales);
                setCurrentTickLadder(applyCumulativeToLadder(ladder));
              }
            } catch {}
            break;
          }
          case 'TRADE': {
            const px = toTick(event.tradePrice!);
            const size = Math.max(1, Math.floor(event.tradeSize || 0));
            const aggressor = event.aggressor as 'BUY' | 'SELL';

            const m = volumeByPriceRef.current;
            m.set(px, (m.get(px) || 0) + size);

            setTimeAndSales(prev => {
              const next = prev.length >= 100 ? prev.slice(-99) : prev.slice(0);
              next.push({ timestamp: new Date(event.timestamp), price: px, size, aggressor });
              return next;
            });
            setTotalTrades(c => c + 1);

            setCurrentPrice(px);

            setOrders(prev => {
              const updated: Order[] = [];
              for (const o of prev) {
                const hit = (o.side === 'BUY'  && px <= o.price) || (o.side === 'SELL' && px >= o.price);
                if (hit) {
                  const newFilled = Math.min(o.quantity, o.filled + size);
                  updated.push({ ...o, filled: newFilled });
                } else {
                  updated.push(o);
                }
              }
              return updated;
            });

            setCurrentTickLadder(cur => applyCumulativeToLadder(cur));
            break;
          }
        }
      }
      setCurrentEventIndex(end);
      if (end >= marketData.length) setIsPlaying(false);
    }, interval);
    return () => clearInterval(id);
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, orderBookProcessor, timeAndSales, applyCumulativeToLadder]);

  const { bestBid, bestAsk, spread, spreadTicks } = useMemo(() => {
    const realBid = currentOrderBookData?.book_bid_prices?.[0];
    const realAsk = currentOrderBookData?.book_ask_prices?.[0];

    const fallbackBid = !realBid && orderBook.length
      ? (() => {
          const v = orderBook.filter(l => (l.bidSize || 0) > 0).reduce((max, l) => Math.max(max, l.price), -Infinity);
          return Number.isFinite(v) ? v : undefined;
        })()
      : undefined;
    const fallbackAsk = !realAsk && orderBook.length
      ? (() => {
          const v = orderBook.filter(l => (l.askSize || 0) > 0).reduce((min, l) => Math.min(min, l.price), Infinity);
          return Number.isFinite(v) ? v : undefined;
        })()
      : undefined;

    let bid = realBid ?? fallbackBid;
    let ask = realAsk ?? fallbackAsk;

    const tsB = bboTsRef.current.bidTs;
    const tsA = bboTsRef.current.askTs;

    if (bid !== undefined && ask !== undefined) {
      const spreadRaw = ask - bid;
      if (spreadRaw > TICK_SIZE) {
        if (Math.abs(tsA - tsB) <= 1000) {
          if (tsA > tsB && (Date.now() - tsA) <= 2000) {
            bid = Math.max(bid, ask - TICK_SIZE);
          } else if (tsB > tsA && (Date.now() - tsB) <= 2000) {
            ask = Math.min(ask, bid + TICK_SIZE);
          }
        }
      }
    }

    const spr = (bid !== undefined && ask !== undefined) ? Math.max(0, ask - bid) : undefined;
    const sprTicks = spr !== undefined ? Math.round(spr / TICK_SIZE) : undefined;

    return { bestBid: bid, bestAsk: ask, spread: spr, spreadTicks: sprTicks };
  }, [currentOrderBookData, orderBook]);

  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setOrders(prev => [...prev, { id, side, price, quantity, filled: 0 }]);
  }, []);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    const px = side === 'BUY' ? (bestAsk ?? currentPrice) : (bestBid ?? currentPrice);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setOrders(prev => [...prev, { id, side, price: px || currentPrice, quantity, filled: quantity }]);
  }, [bestAsk, bestBid, currentPrice]);

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(o => Math.abs(o.price - price) >= 0.125));
  }, []);

  useEffect(() => {
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : currentPrice;
    const qty = orders.reduce((q, o) => q + (o.side === 'BUY' ? 1 : -1) * o.filled, 0);
    const avgBuy = (() => {
      let sum=0, qty=0;
      for (const o of orders) if (o.side==='BUY') { sum += o.price * o.filled; qty += o.filled; }
      return qty>0 ? sum/qty : 0;
    })();
    const avgSell = (() => {
      let sum=0, qty=0;
      for (const o of orders) if (o.side==='SELL') { sum += o.price * o.filled; qty += o.filled; }
      return qty>0 ? sum/qty : 0;
    })();
    const avg = qty!==0 ? (qty>0?avgBuy:avgSell) : 0;

    setPosition({ symbol: 'NQ', quantity: qty, averagePrice: avg });
    const unreal = (mid - avg) * qty;
    setPnL(p => ({ ...p, unrealized: unreal, total: p.realized + unreal }));
  }, [orders, bestBid, bestAsk, currentPrice]);

  const togglePlayback = useCallback(() => setIsPlaying(v => !v), []);
  const setSpeed = useCallback((s: number) => setPlaybackSpeed(Math.max(0.25, Math.min(16, s))), []);

  return {
    marketData,
    timeAndSales,
    currentPrice,
    orderBook,
    currentOrderBookData,
    orders,
    tickLadder: currentTickLadder,

    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,

    position,
    pnl,

    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed: setSpeed,

    loadMarketData,

    bestBid,
    bestAsk,
    spread,
    spreadTicks,

    totalTrades,

    expandLadderWindow,
  };
}
