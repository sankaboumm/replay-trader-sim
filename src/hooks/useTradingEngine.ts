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
  orderBook?: ParsedOrderBook;
  raw?: any;
}

export interface Trade {
  time: number; // timestamp en ms (UTC)
  price: number;
  size: number;
  side: 'BUY' | 'SELL' | 'UNKNOWN';
}

export interface Quote {
  time: number;
  bidPrice?: number;
  bidSize?: number;
  askPrice?: number;
  askSize?: number;
}

export type TickType = 'trade' | 'quote' | 'console';

export interface Tick {
  time: number;
  price: number | null;
  type: TickType;
}

export interface OrderBookData {
  book_bid_prices: number[];
  book_ask_prices: number[];
  book_bid_sizes: number[];
  book_ask_sizes: number[];
}

export interface Position {
  size: number;
  averagePrice: number;
}

export interface PriceAction {
  type: 'BUY' | 'SELL' | 'FLATTEN';
  time: number;
}

type PlaybackState = 'stopped' | 'playing' | 'paused';

interface CSVRow {
  time: string;      // ISO or HH:mm:ss.SSS
  bid?: string;      // number
  ask?: string;      // number
  last?: string;     // number (trade price)
  bidsize?: string;  // number
  asksize?: string;  // number
  lastsize?: string; // number
  type?: string;     // QUOTE | TRADE | CONSOLE
  id?: string | null;
  text?: string | null;
}

interface InfiniteWindow {
  startIndex: number;
  endIndex: number;
  buffer: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

const TICK_SIZE = 0.25;
const ORDERBOOK_CAP = 200;

function toTick(price: number | null, tickSize: number = TICK_SIZE) {
  if (price === null || price === undefined) return null;
  return Math.round(price / tickSize) * tickSize;
}

function parseTimeStringToMs(s: string): number {
  // support either ISO dates or plain HH:mm:ss.SSS (assume today)
  if (!s) return Date.now();
  if (/\d{4}-\d{2}-\d{2}T/.test(s)) {
    return new Date(s).getTime();
  }
  // assume today's date in UTC
  const [hms, msPart] = s.split('.');
  const [hh, mm, ss] = hms.split(':').map(Number);
  const ms = Number(msPart || '0');
  const now = new Date();
  const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, ss, ms);
  return d;
}

function safeNumber(x: any): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function computeMid(bid?: number | null, ask?: number | null, tickSize: number = TICK_SIZE): number | null {
  if (bid == null || ask == null) return null;
  return toTick((bid + ask) / 2, tickSize);
}

function computeMicro(
  bid?: number | null,
  ask?: number | null,
  bidSz?: number | null,
  askSz?: number | null,
  tickSize: number = TICK_SIZE
): number | null {
  if (bid == null || ask == null || bidSz == null || askSz == null || bidSz <= 0 || askSz <= 0) return null;
  const micro = (ask * bidSz + bid * askSz) / (bidSz + askSz);
  return toTick(micro, tickSize);
}

function useInfiniteTickWindow(total: number, initialWindow: number = 2000) {
  const [windowStartIndex, setWindowStartIndex] = useState(0);
  const [windowEndIndex, setWindowEndIndex] = useState(initialWindow);

  const ensureIndexVisible = useCallback((index: number) => {
    if (index < windowStartIndex || index >= windowEndIndex) {
      const half = Math.floor((windowEndIndex - windowStartIndex) / 2);
      const newStart = Math.max(0, index - half);
      const newEnd = Math.min(total, newStart + (windowEndIndex - windowStartIndex));
      setWindowStartIndex(newStart);
      setWindowEndIndex(newEnd);
    }
  }, [windowStartIndex, windowEndIndex, total]);

  useEffect(() => {
    if (windowEndIndex > total) {
      setWindowEndIndex(total);
    }
  }, [total, windowEndIndex]);

  return {
    windowStartIndex,
    windowEndIndex,
    setWindowStartIndex,
    setWindowEndIndex,
    ensureIndexVisible
  };
}

export function useTradingEngine() {
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('stopped');
  const [speed, setSpeed] = useState(1);
  const [tickSize, setTickSize] = useState(TICK_SIZE);
  const [domRange, setDomRange] = useState(20);
  const [orderBookData, setOrderBookData] = useState<OrderBookData | null>(null);
  const [tickData, setTickData] = useState<Tick[]>([]);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [position, setPosition] = useState<Position>({ size: 0, averagePrice: 0 });

  // 👉 currentPrice = LTP uniquement (suivi des trades)
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  // 👉 Nouveau : markPrice (mid ou micro, mis à jour par le BBO) — optionnel pour l’UI/PnL
  const [markPrice, setMarkPrice] = useState<number | null>(null);

  const [priceAction, setPriceAction] = useState<PriceAction | null>(null);
  const [lastEventTime, setLastEventTime] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [showMicroPrice, setShowMicroPrice] = useState(false);
  const [autoCenter, setAutoCenter] = useState(true);
  const [windowSize, setWindowSize] = useState<number>(2000);

  const { windowStartIndex, windowEndIndex, setWindowStartIndex, setWindowEndIndex, ensureIndexVisible } =
    useInfiniteTickWindow(events.length, windowSize);

  const isPlaying = playbackState === 'playing';

  const processEvent = useCallback((event: MarketEvent) => {
    setLastEventTime(event.timestamp);

    if (event.eventType === 'BBO') {
      // --- BBO: on met à jour le carnet (indépendamment), un côté à la fois ---
      setOrderBookData(prev => {
        const bidPrices = event.bidPrice != null ? [event.bidPrice] : (prev?.book_bid_prices || []);
        const askPrices = event.askPrice != null ? [event.askPrice] : (prev?.book_ask_prices || []);
        const bidSizes  = event.bidSize  != null ? [event.bidSize]  : (prev?.book_bid_sizes  || []);
        const askSizes  = event.askSize  != null ? [event.askSize]  : (prev?.book_ask_sizes  || []);
        return {
          book_bid_prices: bidPrices.slice(0, ORDERBOOK_CAP),
          book_ask_prices: askPrices.slice(0, ORDERBOOK_CAP),
          book_bid_sizes : bidSizes.slice(0, ORDERBOOK_CAP),
          book_ask_sizes : askSizes.slice(0, ORDERBOOK_CAP),
        };
      });

      const mid = computeMid(event.bidPrice, event.askPrice, tickSize);
      const micro = computeMicro(event.bidPrice, event.askPrice, event.bidSize, event.askSize, tickSize);

      // On logge un "quote tick" pour visualiser les mouvements du BBO (on préfère mid si dispo)
      setTickData(prev => ([
        ...prev,
        {
          time: event.timestamp,
          price: mid !== null ? mid : currentPrice,
          type: 'quote',
        }
      ]));

      // 🔁 Mise à jour du markPrice (mid/micro) pour l’UI/PnL si souhaité
      if (showMicroPrice && micro !== null) {
        setMarkPrice(micro);
      } else if (!showMicroPrice && mid !== null) {
        setMarkPrice(mid);
      }

      // ❌ Avant: on mettait currentPrice = mid/micro ici.
      // ⛔ Désormais, currentPrice ne bouge PAS sur BBO (LTP uniquement).
      // if (showMicroPrice && micro !== null) setCurrentPrice(micro);
      // else if (!showMicroPrice && mid !== null) setCurrentPrice(mid);

    } else if (event.eventType === 'TRADE') {
      // --- TRADE: seul endroit où currentPrice est mis à jour ---
      const tradePrice = toTick(event.tradePrice ?? null, tickSize);
      if (tradePrice !== null) {
        setCurrentPrice(tradePrice); // LTP
        setTimeAndSales(prev => ([
          ...prev,
          {
            time: event.timestamp,
            price: tradePrice,
            size: event.tradeSize || 0,
            side: event.aggressor || 'UNKNOWN',
          }
        ]));
        setTickData(prev => ([
          ...prev,
          {
            time: event.timestamp,
            price: tradePrice,
            type: 'trade',
          }
        ]));
      }
    } else if (event.eventType === 'ORDERBOOK') {
      const ob = event.orderBook;
      if (ob) {
        const ladd = ob.tickLadder as TickLadder | undefined;
        if (ladd) {
          setOrderBookData({
            book_bid_prices: ladd.bids.map(l => l.price),
            book_ask_prices: ladd.asks.map(l => l.price),
            book_bid_sizes : ladd.bids.map(l => l.size),
            book_ask_sizes : ladd.asks.map(l => l.size),
          });
        }
      }
      // Console tick pour visualiser (ne touche pas currentPrice)
      setTickData(prev => ([
        ...prev,
        {
          time: event.timestamp,
          price: currentPrice,
          type: 'console',
        }
      ]));
    }
  }, [tickSize, showMicroPrice, currentPrice]);

  const play = useCallback(() => {
    if (events.length === 0) return;
    setPlaybackState('playing');
  }, [events]);

  const pause = useCallback(() => {
    setPlaybackState('paused');
  }, []);

  const stop = useCallback(() => {
    setPlaybackState('stopped');
    setCurrentIndex(0);
    setTickData([]);
    setTimeAndSales([]);
    setPosition({ size: 0, averagePrice: 0 });
    setOrderBookData(null);
    setCurrentPrice(null);
    setMarkPrice(null); // reset mark aussi
    setPriceAction(null);
    setWindowStartIndex(0);
    setWindowEndIndex(windowSize);
  }, [windowSize, setWindowStartIndex, setWindowEndIndex]);

  const stepForward = useCallback(() => {
    setCurrentIndex(i => (i < events.length - 1 ? i + 1 : i));
  }, [events.length]);

  const stepBackward = useCallback(() => {
    setCurrentIndex(i => (i > 0 ? i - 1 : i));
  }, []);

  const skipForward = useCallback((amount: number = 100) => {
    setCurrentIndex(i => clamp(i + amount, 0, events.length - 1));
  }, [events.length]);

  const skipBackward = useCallback((amount: number = 100) => {
    setCurrentIndex(i => clamp(i - amount, 0, events.length - 1));
  }, [events.length]);

  const handleSpeedChange = useCallback((newSpeed: number[]) => {
    setSpeed(newSpeed[0]);
  }, []);

  const handleTickSizeChange = useCallback((newTickSize: number[]) => {
    setTickSize(newTickSize[0]);
  }, []);

  const handleDomRangeChange = useCallback((newRange: number[]) => {
    setDomRange(newRange[0]);
  }, []);

  const handleToggleMicroPrice = useCallback((checked: boolean) => {
    setShowMicroPrice(checked);
  }, []);

  const handleAutoCenterChange = useCallback((checked: boolean) => {
    setAutoCenter(checked);
  }, []);

  const handleWindowSizeChange = useCallback((newSize: number[]) => {
    setWindowSize(newSize[0]);
    setWindowStartIndex(0);
    setWindowEndIndex(newSize[0]);
  }, [setWindowStartIndex, setWindowEndIndex]);

  // Playback loop
  useEffect(() => {
    if (playbackState !== 'playing') return;
    const interval = setInterval(() => {
      setCurrentIndex(prevIndex => {
        const step = Math.max(1, Math.floor(speed));
        const nextIndex = prevIndex + step;
        if (nextIndex < events.length) {
          return nextIndex;
        } else {
          setPlaybackState('stopped');
          return prevIndex;
        }
      });
    }, 100);
    return () => clearInterval(interval);
  }, [playbackState, speed, events.length]);

  // Process current event
  useEffect(() => {
    const event = events[currentIndex];
    if (event) {
      processEvent(event);
      ensureIndexVisible(currentIndex);
    }
  }, [currentIndex, events, processEvent, ensureIndexVisible]);

  // CSV loader
  const loadCSVFile = useCallback(async (file: File) => {
    setIsLoading(true);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = Papa.parse<CSVRow>(text, { header: true, skipEmptyLines: true });
      const rows = (parsed.data || []) as CSVRow[];

      const parsedEvents: MarketEvent[] = rows.map(r => {
        const timeMs = parseTimeStringToMs(r.time);
        const bid = safeNumber(r.bid);
        const ask = safeNumber(r.ask);
        const last = safeNumber(r.last);
        const bidsize = safeNumber(r.bidsize);
        const asksize = safeNumber(r.asksize);
        const lastsize = safeNumber(r.lastsize);
        const type = (r.type || '').toUpperCase();

        if (type === 'TRADE') {
          return {
            timestamp: timeMs,
            eventType: 'TRADE',
            tradePrice: last ?? undefined,
            tradeSize: lastsize ?? undefined,
            aggressor: 'UNKNOWN'
          };
        } else if (type === 'QUOTE' || type === 'BBO') {
          return {
            timestamp: timeMs,
            eventType: 'BBO',
            bidPrice: bid ?? undefined,
            askPrice: ask ?? undefined,
            bidSize: bidsize ?? undefined,
            askSize: asksize ?? undefined,
          };
        } else {
          return {
            timestamp: timeMs,
            eventType: 'ORDERBOOK',
            raw: r
          };
        }
      });

      setEvents(parsedEvents);
      setCurrentIndex(0);
      setTickData([]);
      setTimeAndSales([]);
      setOrderBookData(null);
      setCurrentPrice(null);
      setMarkPrice(null);
      setPriceAction(null);
      setPlaybackState('stopped');
      setWindowStartIndex(0);
      setWindowEndIndex(windowSize);
    } catch (e) {
      console.error('CSV load error', e);
    } finally {
      setIsLoading(false);
    }
  }, [windowSize, setWindowStartIndex, setWindowEndIndex]);

  // Console CSV loader (raw text)
  const loadConsoleCSV = useCallback((csvText: string) => {
    try {
      const parsed = Papa.parse<CSVRow>(csvText, { header: true, skipEmptyLines: true });
      const rows = (parsed.data || []) as CSVRow[];

      const parsedEvents: MarketEvent[] = rows.map(r => {
        const timeMs = parseTimeStringToMs(r.time);
        const bid = safeNumber(r.bid);
        const ask = safeNumber(r.ask);
        const last = safeNumber(r.last);
        const bidsize = safeNumber(r.bidsize);
        const asksize = safeNumber(r.asksize);
        const lastsize = safeNumber(r.lastsize);
        const type = (r.type || '').toUpperCase();

        if (type === 'TRADE') {
          return {
            timestamp: timeMs,
            eventType: 'TRADE',
            tradePrice: last ?? undefined,
            tradeSize: lastsize ?? undefined,
            aggressor: 'UNKNOWN'
          };
        } else if (type === 'QUOTE' || type === 'BBO') {
          return {
            timestamp: timeMs,
            eventType: 'BBO',
            bidPrice: bid ?? undefined,
            askPrice: ask ?? undefined,
            bidSize: bidsize ?? undefined,
            askSize: asksize ?? undefined,
          };
        } else {
          return {
            timestamp: timeMs,
            eventType: 'ORDERBOOK',
            raw: r
          };
        }
      });

      setEvents(parsedEvents);
      setCurrentIndex(0);
      setTickData([]);
      setTimeAndSales([]);
      setOrderBookData(null);
      setCurrentPrice(null);
      setMarkPrice(null);
      setPriceAction(null);
      setPlaybackState('stopped');
      setWindowStartIndex(0);
      setWindowEndIndex(windowSize);
    } catch (e) {
      console.error('Console CSV parse error', e);
    }
  }, [windowSize, setWindowStartIndex, setWindowEndIndex]);

  const exportTickData = useCallback(() => {
    const header = 'time,price,type';
    const rows = tickData.map(d => `${new Date(d.time).toISOString()},${d.price ?? ''},${d.type}`);
    const csvContent = [header, ...rows].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const filename = fileName ? fileName.replace(/\.csv$/i, '_ticks.csv') : 'ticks_export.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [tickData, fileName]);

  return {
    events,
    currentIndex,
    setCurrentIndex,
    playbackState,
    play,
    pause,
    stop,
    stepForward,
    stepBackward,
    skipForward,
    skipBackward,
    speed,
    setSpeed: (v: number[]) => setSpeed(v[0]),
    tickSize,
    setTickSize: (v: number[]) => setTickSize(v[0]),
    domRange,
    setDomRange: (v: number[]) => setDomRange(v[0]),
    orderBookData,
    tickData,
    timeAndSales,
    position,
    setPosition,
    currentPrice,   // LTP uniquement (mis à jour sur TRADE)
    markPrice,      // mid/micro dérivé du BBO (optionnel)
    priceAction,
    lastEventTime,
    isLoading,
    loadCSVFile,
    loadConsoleCSV,
    exportTickData,
    showMicroPrice,
    setShowMicroPrice: (c: boolean) => setShowMicroPrice(c),
    autoCenter,
    setAutoCenter: (c: boolean) => setAutoCenter(c),
    windowStartIndex,
    windowEndIndex,
    setWindowStartIndex,
    setWindowEndIndex,
    windowSize,
    setWindowSize: (v: number[]) => {
      setWindowSize(v[0]);
      setWindowStartIndex(0);
      setWindowEndIndex(v[0]);
    },
  };
}