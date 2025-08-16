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
const roundToGrid = (p: number) => Math.round(p * 4) / 4; // 0.25 grid

function parseTimestamp(row: any): number {
  // try common columns
  const cands = ['timestamp', 'time', 'ts', 'event_time', 'datetime'];
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

  // Robust order book processing
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(TICK_SIZE));

  // BBO stabilizer refs (to avoid temporary visual holes)
  const bboTsRef = useRef<{ bidTs: number; askTs: number }>({ bidTs: 0, askTs: 0 });
  const lastRealBBORef = useRef<{ bid?: number; ask?: number }>({});

  // LOAD CSV
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
    orderBookProcessor.resetVolume();

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

          // anchor on FIRST available price (from earliest event)
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
          }

          setMarketData(events);
          setCurrentEventIndex(0);
          setIsPlaying(true); // auto play on load
        },
      });
    };
    reader.readAsText(file);
  }, [orderBookProcessor]);

  // PLAYBACK LOOP
  useEffect(() => {
    if (!isPlaying || currentEventIndex >= marketData.length) return;
    const interval = Math.max(16, 1000 / 60); // ~60 FPS
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
            // build mini book for UI (top 10 on each side)
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
            setCurrentOrderBookData({
              book_bid_prices: snap.bidPrices.slice(0, 1).map(toTick),
              book_ask_prices: snap.askPrices.slice(0, 1).map(toTick),
              book_bid_sizes:  snap.bidSizes.slice(0, 1),
              book_ask_sizes:  snap.askSizes.slice(0, 1),
              book_bid_orders: snap.bidOrders?.slice(0, 1),
              book_ask_orders: snap.askOrders?.slice(0, 1),
            });
            // refresh ladder
            const tradesSoFar: OrderBookTrade[] = timeAndSales; // approximate
            const ladder = orderBookProcessor.makeTickLadder(snap, tradesSoFar);
            setCurrentTickLadder(ladder);
            break;
          }
          case 'BBO': {
            // update one-level data
            setCurrentOrderBookData(prev => ({
              book_bid_prices: event.bidPrice ? [toTick(event.bidPrice)] : (prev?.book_bid_prices ?? []),
              book_ask_prices: event.askPrice ? [toTick(event.askPrice)] : (prev?.book_ask_prices ?? []),
              book_bid_sizes:  event.bidSize  ? [event.bidSize]         : (prev?.book_bid_sizes  ?? []),
              book_ask_sizes:  event.askSize  ? [event.askSize]         : (prev?.book_ask_sizes  ?? []),
              book_bid_orders: prev?.book_bid_orders,
              book_ask_orders: prev?.book_ask_orders,
            }));
            if (event.bidPrice) { lastRealBBORef.current.bid = toTick(event.bidPrice); bboTsRef.current.bidTs = event.timestamp; }
            if (event.askPrice) { lastRealBBORef.current.ask = toTick(event.askPrice); bboTsRef.current.askTs = event.timestamp; }
            break;
          }
          case 'TRADE': {
            const px = toTick(event.tradePrice!);
            const size = Math.max(1, Math.floor(event.tradeSize || 0));
            const aggressor = event.aggressor as 'BUY' | 'SELL';

            setTimeAndSales(prev => {
              const next = prev.slice(-999);
              next.push({ timestamp: new Date(event.timestamp), price: px, size, aggressor });
              return next;
            });

            setCurrentPrice(px);

            // execute market fills vs resting orders
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

            break;
          }
        }
      }
      setCurrentEventIndex(end);
      if (end >= marketData.length) setIsPlaying(false);
    }, interval);
    return () => clearInterval(id);
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, orderBookProcessor, timeAndSales]);

  // DERIVED: bestBid / bestAsk / spread with short clamp
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
        // clamp visually to 1 tick if sides are within ~1s freshness
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

  // ORDERS
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setOrders(prev => [...prev, { id, side, price, quantity, filled: 0 }]);
  }, []);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    // fill at current best price
    const px = side === 'BUY' ? (bestAsk ?? currentPrice) : (bestBid ?? currentPrice);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setOrders(prev => [...prev, { id, side, price: px || currentPrice, quantity, filled: quantity }]);
  }, [bestAsk, bestBid, currentPrice]);

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(o => Math.abs(o.price - price) >= 0.125));
  }, []);

  // POSITION & PNL (very simple)
  useEffect(() => {
    // compute realized PnL from fully filled orders matched against each other (fifo)
    // simplified: ignored; we keep unrealized PnL only
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

  // PLAYBACK controls
  const togglePlayback = useCallback(() => setIsPlaying(v => !v), []);
  const setSpeed = useCallback((s: number) => setPlaybackSpeed(Math.max(0.25, Math.min(16, s))), []);

  return {
    // state for UI
    marketData,
    timeAndSales,
    currentPrice,
    orderBook,
    currentOrderBookData,
    orders,
    tickLadder: currentTickLadder,

    // order actions
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
    setPlaybackSpeed: setSpeed,

    // file
    loadMarketData,

    // nouveaux dérivés
    bestBid,
    bestAsk,
    spread,
    spreadTicks
  };
}
