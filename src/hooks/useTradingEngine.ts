import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  OrderBookProcessor,
  ParsedOrderBook,
  Trade as OrderBookTrade,
  TickLadder
} from '@/lib/orderbook';

/** ---------- Types ---------- */
type EVT = 'TRADE' | 'BBO' | 'ORDERBOOK' | 'ORDERBOOK_FULL';
interface MarketEvent {
  ts: number;                    // ms (exchange time)
  et: EVT;                       // event_type
  // BBO
  bidPrice?: number; bidSize?: number;
  askPrice?: number; askSize?: number;
  // L2 (MBP)
  bookBidPrices?: number[]; bookBidSizes?: number[]; bookBidOrders?: number[];
  bookAskPrices?: number[]; bookAskSizes?: number[]; bookAskOrders?: number[];
  // Trades
  tradePrice?: number; tradeSize?: number; aggressor?: 'BUY' | 'SELL';
}
type Frame = { t: number; ob: MarketEvent[]; bbo: MarketEvent[]; trades: MarketEvent[] };

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
}
interface Order { id: string; side: 'BUY'|'SELL'; price: number; quantity: number; filled: number; }
interface OrderBookLevel { price: number; bidSize: number; askSize: number; volume?: number; }

/** ---------- Const ---------- */
const TICK_SIZE = 0.25;
const MIN_FRAME_MS = 0;      // 0 = respecter exactement le delta des timestamps
const MAX_FRAME_MS = 5000;

/** ---------- Helpers ---------- */
const toTickRound = (p: number) => Math.round(p / TICK_SIZE) * TICK_SIZE;
const toBidTick = (p: number) => Math.floor((p + 1e-9) / TICK_SIZE) * TICK_SIZE;
const toAskTick = (p: number) => Math.ceil((p - 1e-9) / TICK_SIZE) * TICK_SIZE;
const roundToGrid = (p: number) => Math.round(p * 4) / 4;

const parseAgg = (a: any): 'BUY' | 'SELL' | undefined => {
  const s = String(a ?? '').trim().toUpperCase();
  if (s === 'BUY' || s === 'B') return 'BUY';
  if (s === 'SELL' || s === 'S') return 'SELL';
  return undefined;
};
const parseListNumbers = (v: unknown): number[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  const s = String(v).trim();
  if (!s || s === '[]') return [];
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
    }
  } catch { /* ignore */ }
  return s.replace(/^\[|\]$/g, '')
    .split(/[\s,;]+/)
    .map(Number)
    .filter(Number.isFinite);
};
const parseExchangeTsMs = (row: any): number => {
  const cands = ['ts_exch_utc', 'ts_exch_madrid', 'ts_utc', 'ts_madrid'];
  for (const k of cands) {
    if (row[k]) {
      const t = new Date(row[k]).getTime();
      if (!isNaN(t)) return t;
    }
  }
  if (row.ssboe && row.usecs) {
    const ss = Number(row.ssboe), uu = Number(row.usecs);
    if (Number.isFinite(ss) && Number.isFinite(uu)) return ss * 1000 + Math.floor(uu / 1000);
  }
  return Date.now();
};
const isBlobLike = (x: any): x is File | Blob =>
  x && typeof x === 'object' && 'size' in x && 'type' in x;

/** ---------- Hook principal ---------- */
export function useTradingEngine() {
  /** ÉTATS exposés (compat UI) */
  const [marketData, setMarketData] = useState<MarketEvent[]>([]); // toujours un array
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const emptyLadder: TickLadder = useMemo(() => ({ midTick: 0, midPrice: 0, levels: [] }), []);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder>(emptyLadder); // jamais null
  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
  const [pnl, setPnl] = useState({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  // lecture
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [loaded, setLoaded] = useState(false);

  // Processor
  const obProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);

  // Player internals
  const framesRef = useRef<Frame[]>([]);
  const idxRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(1);

  // ---------- LOADER (CSV / URL / string safe) ----------
  const loadMarketData = useCallback((input?: File | string) => {
    // garde-fous pour éviter Papa.parse(undefined)
    if (input == null) {
      console.warn('[replay] loadMarketData called without file/string — ignored.');
      // reset visibles pour que le UI ne crashe pas
      setMarketData([]);
      setLoaded(false);
      return;
    }

    // reset état
    framesRef.current = [];
    idxRef.current = 0;
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    playingRef.current = false;
    setIsPlaying(false);
    setLoaded(false);

    setMarketData([]);
    setTrades([]);
    setCurrentTickLadder(emptyLadder);
    setOrderBook([]);
    setOrders([]);
    setPosition({ symbol: 'NQ', quantity: 0, averagePrice: 0, marketPrice: 0 });
    setPnl({ unrealized: 0, realized: 0, total: 0 });
    setRealizedPnLTotal(0);
    setTimeAndSales([]);
    setVolumeByPrice(new Map());
    obProcessor.clearAnchor();

    const raw: MarketEvent[] = [];
    const obSnaps: ParsedOrderBook[] = [];
    const tradeRows: OrderBookTrade[] = [];

    const parseRows = (rows: any[]) => {
      for (const row of rows) {
        if (!row) continue;
        const ts = parseExchangeTsMs(row);
        const etRaw = String(row.event_type ?? '').toUpperCase().trim();
        const et: EVT =
          etRaw === 'BBO' ? 'BBO' :
          (etRaw === 'ORDERBOOK_FULL' || etRaw === 'ORDERBOOK') ? 'ORDERBOOK' :
          'TRADE';

        if (et === 'TRADE') {
          const price = Number(row.trade_price);
          const size = Number(row.trade_size);
          const aggr = parseAgg(row.aggressor);
          if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || !aggr) continue;
          tradeRows.push({ timestamp: new Date(ts), price, size, aggressor: aggr });
          raw.push({ ts, et: 'TRADE', tradePrice: price, tradeSize: size, aggressor: aggr });
        } else if (et === 'BBO') {
          const bp = Number(row.bid_price);
          const ap = Number(row.ask_price);
          const bs = Number(row.bid_size);
          const asz = Number(row.ask_size);
          const hasBid = Number.isFinite(bp) && bp > 0;
          const hasAsk = Number.isFinite(ap) && ap > 0;
          if (!hasBid && !hasAsk) continue;
          raw.push({
            ts, et: 'BBO',
            bidPrice: hasBid ? bp : undefined,
            askPrice: hasAsk ? ap : undefined,
            bidSize: hasBid && Number.isFinite(bs) ? bs : undefined,
            askSize: hasAsk && Number.isFinite(asz) ? asz : undefined
          });
        } else {
          const bidP = parseListNumbers(row.book_bid_prices);
          const bidS = parseListNumbers(row.book_bid_sizes);
          const bidO = parseListNumbers(row.book_bid_orders);
          const askP = parseListNumbers(row.book_ask_prices);
          const askS = parseListNumbers(row.book_ask_sizes);
          const askO = parseListNumbers(row.book_ask_orders);
          if (bidP.length === 0 && askP.length === 0) continue;

          obSnaps.push({
            bidPrices: bidP, bidSizes: bidS, bidOrders: bidO,
            askPrices: askP, askSizes: askS, askOrders: askO,
            timestamp: new Date(ts)
          });

          raw.push({
            ts, et: 'ORDERBOOK',
            bookBidPrices: bidP, bookBidSizes: bidS, bookBidOrders: bidO,
            bookAskPrices: askP, bookAskSizes: askS, bookAskOrders: askO
          });
        }
      }

      // Tri global: (ts, tie) => ORDERBOOK → BBO → TRADE
      const TIE: Record<EVT, number> = { ORDERBOOK:0, ORDERBOOK_FULL:0, BBO:1, TRADE:2 } as any;
      raw.sort((a,b) => (a.ts - b.ts) || (TIE[a.et] - TIE[b.et]));

      // Expose pour UI (marketData existe)
      setMarketData(raw);

      // Frames groupées par ts
      const frames: Frame[] = [];
      let cur: Frame | null = null;
      for (const e of raw) {
        if (!cur || e.ts !== cur.t) {
          cur = { t: e.ts, ob: [], bbo: [], trades: [] };
          frames.push(cur);
        }
        if (e.et === 'ORDERBOOK') cur.ob.push(e);
        else if (e.et === 'BBO') cur.bbo.push(e);
        else cur.trades.push(e);
      }
      framesRef.current = frames;

      // Tick size & prix initial
      const allPrices = [
        ...tradeRows.map(t => t.price),
        ...obSnaps.flatMap(s => [...s.bidPrices, ...s.askPrices])
      ];
      if (allPrices.length) {
        const inferred = obProcessor.inferTickSize(allPrices);
        obProcessor.setTickSize(inferred);
      }

      let p0 = 0;
      if (tradeRows.length > 0) p0 = tradeRows[0].price;
      else if (obSnaps.length > 0) {
        const s0 = obSnaps[0];
        p0 = s0.bidPrices?.[0] ?? s0.askPrices?.[0] ?? 0;
      } else if (frames.length > 0) {
        const f0 = frames[0];
        if (f0.ob.length) p0 = f0.ob[0].bookBidPrices?.[0] ?? f0.ob[0].bookAskPrices?.[0] ?? 0;
        else if (f0.bbo.length) p0 = f0.bbo[0].bidPrice ?? f0.bbo[0].askPrice ?? 0;
      }
      setCurrentPrice(toTickRound(p0));

      // Ladder initial
      if (obSnaps.length) {
        const ladder0 = obProcessor.createTickLadder(obSnaps[0], tradeRows);
        setCurrentTickLadder(ladder0);
      } else {
        setCurrentTickLadder(emptyLadder);
      }

      // stock trades
      tradeRows.sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime());
      setTrades(tradeRows);

      setLoaded(true);
    };

    // Choix du mode d’entrée (File / URL / string CSV)
    if (isBlobLike(input)) {
      Papa.parse(input as File, {
        header: true,
        dynamicTyping: true,
        worker: true,
        skipEmptyLines: true,
        complete: (res) => parseRows((res.data as any[]) || []),
        error: () => setLoaded(false)
      });
    } else if (typeof input === 'string') {
      if (/^https?:\/\//i.test(input)) {
        Papa.parse(input, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          download: true,
          complete: (res) => parseRows((res.data as any[]) || []),
          error: () => setLoaded(false)
        });
      } else {
        Papa.parse(input, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          complete: (res) => parseRows((res.data as any[]) || []),
          error: () => setLoaded(false)
        });
      }
    } else {
      console.warn('[replay] Unsupported input type for loadMarketData:', typeof input);
      setLoaded(false);
    }
  }, [obProcessor, emptyLadder]);

  /** ---------- Player (cadencé par timestamps) ---------- */
  const applyOrderbookFrame = useCallback((e: MarketEvent) => {
    const map = new Map<number, OrderBookLevel>();
    const addBid = (p: number, s: number) => {
      const px = toBidTick(p);
      const ex = map.get(px);
      if (ex) ex.bidSize = s;
      else map.set(px, { price: px, bidSize: s, askSize: 0, volume: 0 });
    };
    const addAsk = (p: number, s: number) => {
      const px = toAskTick(p);
      const ex = map.get(px);
      if (ex) ex.askSize = s;
      else map.set(px, { price: px, bidSize: 0, askSize: s, volume: 0 });
    };

    const { bookBidPrices, bookBidSizes, bookAskPrices, bookAskSizes } = e;
    if (bookBidPrices && bookBidSizes) {
      const n = Math.min(bookBidPrices.length, bookBidSizes.length, 20);
      for (let i=0;i<n;i++) addBid(bookBidPrices[i], bookBidSizes[i] ?? 0);
    }
    if (bookAskPrices && bookAskSizes) {
      const n = Math.min(bookAskPrices.length, bookAskSizes.length, 20);
      for (let i=0;i<n;i++) addAsk(bookAskPrices[i], bookAskSizes[i] ?? 0);
    }

    const arr = Array.from(map.values()).sort((a,b)=>b.price-a.price);
    setOrderBook(arr);
  }, []);

  const applyBBOFrame = useCallback((e: MarketEvent) => {
    setOrderBook(prev => {
      let bids = prev.filter(l => l.bidSize > 0).sort((a,b)=>b.price-a.price);
      let asks = prev.filter(l => l.askSize > 0).sort((a,b)=>a.price-b.price);

      if (e.bidPrice != null && e.bidSize != null) {
        const px = toBidTick(e.bidPrice);
        if (!bids.length || bids[0].price !== px) bids.unshift({ price: px, bidSize: e.bidSize, askSize: 0, volume: 0 });
        else bids[0] = { ...bids[0], bidSize: e.bidSize };
      }
      if (e.askPrice != null && e.askSize != null) {
        const px = toAskTick(e.askPrice);
        if (!asks.length || asks[0].price !== px) asks.unshift({ price: px, bidSize: 0, askSize: e.askSize, volume: 0 });
        else asks[0] = { ...asks[0], askSize: e.askSize };
      }

      const bestBid = bids[0]?.price;
      const bestAsk = asks[0]?.price;
      if (bestAsk != null) bids = bids.filter(l => l.price <= bestBid!);
      if (bestBid != null) asks = asks.filter(l => l.price >= bestAsk!);

      const m = new Map<number, OrderBookLevel>();
      for (const b of bids) m.set(b.price, { ...b });
      for (const a of asks) {
        const ex = m.get(a.price);
        if (ex) m.set(a.price, { ...ex, askSize: a.askSize });
        else m.set(a.price, a);
      }
      return Array.from(m.values()).sort((a,b)=>b.price-a.price);
    });

    if (e.bidPrice != null) setCurrentPrice(toTickRound(e.bidPrice));
    else if (e.askPrice != null) setCurrentPrice(toTickRound(e.askPrice));
  }, []);

  const applyTradesFrame = useCallback((arr: MarketEvent[]) => {
    if (!arr.length) return;
    setTimeAndSales(prev => {
      const next = [...prev];
      for (const ev of arr) {
        if (!ev.tradePrice || !ev.tradeSize || !ev.aggressor) continue;
        const t: Trade = {
          id: `t-${ev.ts}-${Math.random()}`,
          timestamp: ev.ts,
          price: toTickRound(ev.tradePrice),
          size: ev.tradeSize,
          aggressor: ev.aggressor
        };
        const last = next[next.length - 1];
        if (last && last.price === t.price && last.aggressor === t.aggressor) {
          last.size += t.size;
        } else {
          next.push(t);
        }
      }
      return next.slice(-300);
    });

    setVolumeByPrice(prev => {
      const next = new Map(prev);
      for (const ev of arr) {
        if (!ev.tradePrice || !ev.tradeSize) continue;
        const gp = roundToGrid(ev.tradePrice);
        next.set(gp, (next.get(gp) ?? 0) + ev.tradeSize);
      }
      return next;
    });
  }, []);

  const playFromIndex = useCallback((start: number) => {
    if (!framesRef.current.length) return;
    idxRef.current = start;

    const step = () => {
      if (!playingRef.current) return;
      const frames = framesRef.current;
      const i = idxRef.current;
      if (i >= frames.length) { playingRef.current = false; setIsPlaying(false); return; }

      const f = frames[i];

      for (const e of f.ob) applyOrderbookFrame(e); // 1) ORDERBOOK
      for (const e of f.bbo) applyBBOFrame(e);       // 2) BBO
      applyTradesFrame(f.trades);                     // 3) TRADES

      const nextIdx = i + 1;
      idxRef.current = nextIdx;
      if (nextIdx >= frames.length) { playingRef.current = false; setIsPlaying(false); return; }

      const dt = Math.max(0, frames[nextIdx].t - f.t);
      const waitMsRaw = dt / speedRef.current;
      const waitMs = Math.max(MIN_FRAME_MS, waitMsRaw);
      console.log(`[DEBUG] Frame ${i}: dt=${dt}ms, speed=${speedRef.current}x, wait=${waitMs}ms`);
      timerRef.current = window.setTimeout(step, waitMs);
    };

    timerRef.current = window.setTimeout(step, 0);
  }, [applyOrderbookFrame, applyBBOFrame, applyTradesFrame]);

  /** ---------- Contrôles lecture ---------- */
  const togglePlayback = useCallback(() => {
    if (!loaded || !framesRef.current.length) return;
    const now = !playingRef.current;
    playingRef.current = now;
    setIsPlaying(now);
    if (now) {
      if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      playFromIndex(idxRef.current);
    } else {
      if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    }
  }, [loaded, playFromIndex]);

  const setPlaybackSpeedSafe = useCallback((x: number) => {
    const s = Math.max(0.1, x);
    speedRef.current = s;
    setPlaybackSpeed(s);
  }, []);

  /** ---------- Best bid/ask + spread (compat UI) ---------- */
  const bestBid = useMemo(() => orderBook.find(l => l.bidSize > 0)?.price, [orderBook]);
  const bestAsk = useMemo(() => orderBook.find(l => l.askSize > 0)?.price, [orderBook]);
  const spread = useMemo(() => (bestBid != null && bestAsk != null) ? (bestAsk - bestBid) : undefined, [bestBid, bestAsk]);
  const spreadTicks = useMemo(() => (spread != null) ? Math.round(spread / TICK_SIZE) : undefined, [spread]);

  /** ---------- Ancrage vue ---------- */
  const setViewAnchorPrice = useCallback((price: number | null) => {
    if (price == null) obProcessor.clearAnchor();
    else obProcessor.setAnchorByPrice(price);
  }, [obProcessor]);

  /** ---------- PnL dérivé ---------- */
  useEffect(() => {
    setPnl({
      unrealized: (currentPrice - position.averagePrice) * position.quantity * 20,
      realized: realizedPnLTotal,
      total: (currentPrice - position.averagePrice) * position.quantity * 20 + realizedPnLTotal
    });
  }, [position, currentPrice, realizedPnLTotal]);

  /** ---------- Fonctions ordres (stubs pour compatibilité) ---------- */
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    console.log('Ordre limite placé:', { side, price, quantity });
  }, []);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    console.log('Ordre marché placé:', { side, quantity });
  }, []);

  const cancelOrdersAtPrice = useCallback((price: number) => {
    console.log('Ordres annulés au prix:', price);
  }, []);

  /** ---------- API hook ---------- */
  return {
    // données (compat UI)
    marketData,
    trades,
    currentTickLadder,      // toujours défini
    orderBook,
    currentPrice,
    bestBid, bestAsk, spread, spreadTicks,
    timeAndSales,
    orders,
    position,
    pnl,

    // lecture
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed: setPlaybackSpeedSafe,

    // fichiers
    loadMarketData,

    // ordres
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,

    // ancrage
    setViewAnchorPrice,
  };
}