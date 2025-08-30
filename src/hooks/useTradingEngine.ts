import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  OrderBookProcessor,
  ParsedOrderBook,
  TickLadder
} from '@/lib/orderbook';

// --- Types d'évènements en mémoire UI ---
type Aggressor = 'BUY' | 'SELL';
type EventType = 'TRADE' | 'BBO' | 'ORDERBOOK';

interface MarketEvent {
  ts: number; // epoch ms
  type: EventType;
  // TRADE
  tradePrice?: number;
  tradeSize?: number;
  aggressor?: Aggressor;
  // BBO
  bidPrice?: number;
  bidSize?: number;
  askPrice?: number;
  askSize?: number;
  // ORDERBOOK_FULL
  bookBidPrices?: number[];
  bookBidSizes?: number[];
  bookBidOrders?: number[];
  bookAskPrices?: number[];
  bookAskSizes?: number[];
  bookAskOrders?: number[];
}

// --- Types UI (prop-compatibles avec tes composants) ---
interface PositionState {
  quantity: number;
  averagePrice: number;
}
interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price?: number;
  size: number;
  type: 'LIMIT' | 'MARKET';
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'PARTIAL';
}
interface TradeRow {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: Aggressor;
  aggregatedCount?: number;
}
interface PnLObject {
  realized: number;
  unrealized: number;
  total: number;
}

// --------- Helpers parsing ----------
function toEpochMs(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return NaN;
  const s = String(ts).trim();
  const d = new Date(s);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function parseNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function parseArrayField(value: unknown): number[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  const s = String(value).trim();
  if (!s) return [];
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(Number).filter(Number.isFinite);
    }
  } catch {}
  // fallback "v1,v2,..."
  return s
    .replace(/^\[|\]$/g, '')
    .split(/[\s,;]+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x));
}

function byTsAsc(a: MarketEvent, b: MarketEvent) {
  return a.ts - b.ts;
}

// --------- Hook principal ----------
export function useTradingEngine() {
  // ---------- ÉTATS ----------
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentPrice, setCurrentPrice] = useState<number>(NaN);

  // time & sales + book/ladder
  const [timeAndSales, setTimeAndSales] = useState<TradeRow[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder>({
    levels: [],
    centerPrice: NaN,
    tickSize: 0.25,
    minPrice: NaN,
    maxPrice: NaN,
  });

  // BBO dérivés
  const [bestBid, setBestBid] = useState<number | undefined>(undefined);
  const [bestAsk, setBestAsk] = useState<number | undefined>(undefined);
  const spread = useMemo(
    () => (bestBid != null && bestAsk != null ? bestAsk - bestBid : undefined),
    [bestBid, bestAsk]
  );
  const spreadTicks = useMemo(() => {
    if (spread == null || !Number.isFinite(currentTickLadder.tickSize) || currentTickLadder.tickSize <= 0) return undefined;
    return Math.round(spread / currentTickLadder.tickSize);
  }, [spread, currentTickLadder.tickSize]);

  // ordres & position (simulation simple)
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<PositionState>({ quantity: 0, averagePrice: 0 });
  const [realizedPnl, setRealizedPnl] = useState(0);

  const pnl: PnLObject = useMemo(() => {
    const unreal = Number.isFinite(currentPrice)
      ? (currentPrice - position.averagePrice) * position.quantity
      : 0;
    const realized = realizedPnl;
    return { realized, unrealized: unreal, total: realized + unreal };
  }, [currentPrice, position, realizedPnl]);

  // snapshot order book processor
  const obRef = useRef(new OrderBookProcessor(0.25));
  const anchorPriceRef = useRef<number | undefined>(undefined);

  // timers/states refs pour éviter les closures périmées
  const isPlayingRef = useRef(false);
  const speedRef = useRef(1);
  const idxRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------- DERIVÉS UI ----------
  const canPlay = marketData.length > 0 || Number.isFinite(currentPrice);

  // ---------- ACTIONS ----------
  const setViewAnchorPrice = useCallback((p?: number) => {
    anchorPriceRef.current = p;
  }, []);

  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', size: number = 1) => {
    // enregistre l'ordre (simplement pour l'UI)
    setOrders((prev) => [
      ...prev,
      { id: `ord_${Date.now()}_${prev.length}`, side, size, type: 'MARKET', status: 'FILLED' },
    ]);

    // calcule l'impact sur la position + PnL réalisé
    let realizedDelta = 0;

    setPosition((p) => {
      const q = p.quantity;            // quantité actuelle (signée)
      const ap = p.averagePrice;       // prix moyen actuel
      const signedSize = side === 'BUY' ? size : -size;

      // fill price : currentPrice si dispo, sinon mid BBO, sinon average existant
      const d = obRef.current.getDerived();
      const mid = d.bestBid != null && d.bestAsk != null ? (d.bestBid + d.bestAsk) / 2 : undefined;
      const fp = Number.isFinite(currentPrice) ? currentPrice : (mid ?? ap);

      let newQty = q;
      let newAvg = ap;

      if (q === 0 || Math.sign(q) === Math.sign(signedSize)) {
        // ouverture / augmentation de position
        newQty = q + signedSize;
        if (newQty !== 0) {
          newAvg = ((ap * q) + (fp * signedSize)) / newQty;
        } else {
          newAvg = 0;
        }
      } else {
        // sens opposé => on ferme en partie ou totalement
        const closeQty = Math.min(Math.abs(q), Math.abs(signedSize)); // quantité fermée
        // Profit (long) = (fp - ap) * closeQty ; (short) = (ap - fp) * closeQty
        // => formule unifiée :
        realizedDelta += (fp - ap) * closeQty * Math.sign(q);

        const remainingAfterClose = Math.abs(signedSize) - closeQty;
        if (remainingAfterClose > 0) {
          // reversal : on passe de l'autre côté avec le reste
          newQty = Math.sign(signedSize) * remainingAfterClose;
          newAvg = fp; // nouvelle position ouverte au prix d'exécution
        } else {
          // simple réduction/fermeture partielle/complète
          newQty = q - Math.sign(q) * closeQty;
          newAvg = newQty === 0 ? 0 : ap; // moyenne inchangée si on reste du même côté
        }
      }

      return { quantity: newQty, averagePrice: newAvg };
    });

    if (realizedDelta !== 0) {
      setRealizedPnl((prev) => prev + realizedDelta);
    }
  }, [currentPrice]);

  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, size: number = 1) => {
    setOrders((prev) => [
      ...prev,
      { id: `ord_${Date.now()}_${prev.length}`, side, price, size, type: 'LIMIT', status: 'OPEN' },
    ]);
  }, []);

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders((prev) => prev.map(o => (o.price === price && o.status === 'OPEN' ? { ...o, status: 'CANCELLED' } : o)));
  }, []);

  // ---------- PLAYBACK ----------
  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const applyEvent = useCallback((ev: MarketEvent) => {
    switch (ev.type) {
      case 'BBO': {
        if (ev.bidPrice != null) setBestBid(ev.bidPrice);
        if (ev.askPrice != null) setBestAsk(ev.askPrice);
        if (ev.bidPrice != null || ev.askPrice != null) {
          const mid =
            ev.bidPrice != null && ev.askPrice != null
              ? (ev.bidPrice + ev.askPrice) / 2
              : ev.bidPrice ?? ev.askPrice!;
          if (Number.isFinite(mid)) setCurrentPrice(mid);
        }
        if (ev.bidPrice != null || ev.askPrice != null) {
          obRef.current.ingestBBO(
            ev.bidPrice, ev.bidSize ?? 0,
            ev.askPrice, ev.askSize ?? 0
          );
        }
        break;
      }
      case 'ORDERBOOK': {
        obRef.current.ingestOrderBookFull(
          ev.bookBidPrices ?? [], ev.bookBidSizes ?? [], ev.bookBidOrders ?? [],
          ev.bookAskPrices ?? [], ev.bookAskSizes ?? [], ev.bookAskOrders ?? []
        );
        const d = obRef.current.getDerived();
        if (!Number.isFinite(currentPrice) && d.bestBid != null && d.bestAsk != null) {
          setCurrentPrice((d.bestBid + d.bestAsk) / 2);
          setBestBid(d.bestBid);
          setBestAsk(d.bestAsk);
        }
        break;
      }
      case 'TRADE': {
        if (ev.tradePrice != null) setCurrentPrice(ev.tradePrice);
        if (ev.tradePrice != null && ev.tradeSize != null && ev.aggressor) {
          setTimeAndSales((prev) => [
            ...prev,
            {
              id: `t_${ev.ts}_${prev.length}`,
              timestamp: ev.ts,
              price: ev.tradePrice!,
              size: ev.tradeSize!,
              aggressor: ev.aggressor!,
            },
          ]);
        }
        break;
      }
    }

    // mettre à jour le ladder après chaque évènement qui touche le carnet
    const anchor = anchorPriceRef.current ?? (Number.isFinite(currentPrice) ? currentPrice : undefined);
    const ladder = obRef.current.buildTickLadder(anchor);
    setCurrentTickLadder(ladder);
  }, [currentPrice]);

  const scheduleNext = useCallback(() => {
    clearTimer();
    const idx = idxRef.current;
    const arr = marketData;
    if (!isPlayingRef.current || idx >= arr.length) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      return;
    }
    const ev = arr[idx];
    applyEvent(ev);
    idxRef.current = idx + 1;

    if (idxRef.current >= arr.length) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      return;
    }
    const nowTs = ev.ts;
    const nextTs = arr[idxRef.current].ts;
    const dt = Math.max(0, nextTs - nowTs);
    const delay = dt / (speedRef.current > 0 ? speedRef.current : 1);

    timerRef.current = setTimeout(scheduleNext, delay);
  }, [applyEvent, marketData]);

  const togglePlayback = useCallback(() => {
    if (isPlayingRef.current) {
      // pause
      isPlayingRef.current = false;
      setIsPlaying(false);
      clearTimer();
      return;
    }
    if (!canPlay) return;
    // start / resume
    isPlayingRef.current = true;
    setIsPlaying(true);
    if (idxRef.current >= marketData.length) {
      idxRef.current = 0;
    }
    scheduleNext();
  }, [canPlay, marketData.length, scheduleNext]);

  const loadMarketData = useCallback((file: File) => {
    return new Promise<void>((resolve, reject) => {
      // Reset lecture
      clearTimer();
      isPlayingRef.current = false;
      setIsPlaying(false);
      idxRef.current = 0;
      setCurrentEventIndex(0);
      setTimeAndSales([]);
      setBestBid(undefined);
      setBestAsk(undefined);
      setCurrentPrice(NaN);
      setOrders([]);
      setPosition({ quantity: 0, averagePrice: 0 });
      setRealizedPnl(0);
      obRef.current.reset();

      Papa.parse(file, {
        header: true,
        worker: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        fastMode: true,
        complete: (res) => {
          try {
            const events: MarketEvent[] = [];
            for (const row of res.data as any[]) {
              if (!row) continue;
              const ts = toEpochMs(row.ts_exch_utc ?? row.ts ?? row.timestamp);
              if (!Number.isFinite(ts)) continue;

              const etRaw = (row.event_type ?? row.type ?? '').toString().toUpperCase().trim();
              let type: EventType | null = null;
              if (etRaw === 'TRADE') type = 'TRADE';
              else if (etRaw === 'BBO') type = 'BBO';
              else if (etRaw === 'ORDERBOOK_FULL' || etRaw === 'ORDERBOOK') type = 'ORDERBOOK';

              if (!type) continue;

              const ev: MarketEvent = { ts, type };

              if (type === 'TRADE') {
                ev.tradePrice = parseNum(row.trade_price ?? row.price);
                ev.tradeSize = parseNum(row.trade_size ?? row.size);
                const ag = (row.aggressor ?? row.side ?? '').toString().toUpperCase();
                if (ag === 'BUY' || ag === 'SELL') ev.aggressor = ag as Aggressor;
              } else if (type === 'BBO') {
                ev.bidPrice = parseNum(row.bid_price ?? row.bbo_bid_price ?? row.best_bid_price);
                ev.bidSize = parseNum(row.bid_size ?? row.bbo_bid_size ?? row.best_bid_size);
                ev.askPrice = parseNum(row.ask_price ?? row.bbo_ask_price ?? row.best_ask_price);
                ev.askSize = parseNum(row.ask_size ?? row.bbo_ask_size ?? row.best_ask_size);
              } else if (type === 'ORDERBOOK') {
                ev.bookBidPrices = parseArrayField(row.book_bid_prices ?? row.ob_bid_prices);
                ev.bookBidSizes = parseArrayField(row.book_bid_sizes ?? row.ob_bid_sizes);
                ev.bookBidOrders = parseArrayField(row.book_bid_orders ?? row.ob_bid_orders);
                ev.bookAskPrices = parseArrayField(row.book_ask_prices ?? row.ob_ask_prices);
                ev.bookAskSizes = parseArrayField(row.book_ask_sizes ?? row.ob_ask_sizes);
                ev.bookAskOrders = parseArrayField(row.book_ask_orders ?? row.ob_ask_orders);
              }

              events.push(ev);
            }

            events.sort(byTsAsc);
            setMarketData(events);
            setCurrentEventIndex(0);
            idxRef.current = 0;

            // amorce si snapshot présent au début
            const firstBbo = events.find(e => e.type === 'BBO');
            if (firstBbo && (firstBbo.bidPrice != null || firstBbo.askPrice != null)) {
              applyEvent(firstBbo);
            }
            const firstOb = events.find(e => e.type === 'ORDERBOOK');
            if (firstOb) applyEvent(firstOb);

            resolve();
          } catch (err) {
            reject(err);
          }
        },
        error: (err) => reject(err),
      });
    });
  }, [applyEvent]);

  // suivre vitesse
  useEffect(() => { speedRef.current = playbackSpeed; }, [playbackSpeed]);

  // suivre index courant (exposé si tu veux une progress bar plus tard)
  useEffect(() => { setCurrentEventIndex(idxRef.current); }, [marketData]);

  // stop propre au démontage
  useEffect(() => {
    return () => clearTimer();
  }, []);

  return {
    // état brut
    marketData,
    position,
    pnl, // <-- objet { realized, unrealized, total }
    timeAndSales,
    orders,
    currentPrice,
    currentTickLadder,

    // lecture
    isPlaying,
    playbackSpeed,
    togglePlayback,
    setPlaybackSpeed,

    // actions
    placeLimitOrder,
    cancelOrdersAtPrice,
    placeMarketOrder,
    loadMarketData,

    // dérivés BBO
    bestBid,
    bestAsk,
    spread,
    spreadTicks,

    // util UI
    canPlay,
    setViewAnchorPrice,

    // (compat legacy si tu exposais ces champs)
    orderBook: obRef.current.getSnapshot() as ParsedOrderBook,
    currentOrderBookData: obRef.current.getSnapshot() as ParsedOrderBook,
  };
}