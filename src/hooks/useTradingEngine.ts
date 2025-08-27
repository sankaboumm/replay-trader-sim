import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  OrderBookProcessor,
  ParsedOrderBook,
  Trade as OrderBookTrade,
  TickLadder
} from '@/lib/orderbook';
import { buildFramesSynced, Frame } from '@/lib/replayFrames';

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
  const [frames, setFrames] = useState<Frame[]>([]);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
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
    setFrames([]);
    setCurrentFrameIndex(0);
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
        dynamicTyping: true,
        skipEmptyLines: true,
        worker: true,
        complete: (results) => {
          console.log('🔥 Papa.parse complete, building synchronized frames...');
          console.log('🔥 Number of rows:', results.data.length);
          
          // Construire les frames synchrones avec le nouveau système
          const syncFrames = buildFramesSynced(results.data as any[]);
          console.log('🔥 Synchronized frames created:', syncFrames.length);
          
          setFrames(syncFrames);
          
          // Préparer les données pour la compatibilité arrière
          const tradeEvents: OrderBookTrade[] = [];
          const orderbookSnapshots: ParsedOrderBook[] = [];

          // Traiter les frames pour extraire les données nécessaires
          for (const frame of syncFrames) {
            if (frame.trades.length > 0) {
              for (const trade of frame.trades) {
                tradeEvents.push({
                  price: trade.price,
                  size: trade.size,
                  timestamp: new Date(frame.t),
                  aggressor: trade.aggressor || 'BUY'
                });
              }
            }
            
            if (frame.ob) {
              orderbookSnapshots.push({
                bidPrices: frame.ob.bidPrices,
                bidSizes: frame.ob.bidSizes,
                bidOrders: [],
                askPrices: frame.ob.askPrices,
                askSizes: frame.ob.askSizes,
                askOrders: [],
                timestamp: new Date(frame.t)
              });
            }
          }
          
          setTrades(tradeEvents);
          
          // Inférer tick size
          const allPrices = [
            ...tradeEvents.map(t => t.price),
            ...orderbookSnapshots.flatMap(s => [...s.bidPrices, ...s.askPrices])
          ];
          if (allPrices.length > 0) {
            const inferred = orderBookProcessor.inferTickSize(allPrices);
            orderBookProcessor.setTickSize(inferred);
          }

          // Prix initial
          let initialPrice = 0;
          if (syncFrames.length > 0) {
            const firstFrame = syncFrames[0];
            if (firstFrame.bbo?.bidPrice) initialPrice = firstFrame.bbo.bidPrice;
            else if (firstFrame.bbo?.askPrice) initialPrice = firstFrame.bbo.askPrice;
            else if (firstFrame.ob?.bidPrices?.[0]) initialPrice = firstFrame.ob.bidPrices[0];
            else if (firstFrame.ob?.askPrices?.[0]) initialPrice = firstFrame.ob.askPrices[0];
            else if (firstFrame.trades?.[0]?.price) initialPrice = firstFrame.trades[0].price;
          }

          console.log('🔥 Initial price found:', initialPrice);
          
          setCurrentPrice(toTick(initialPrice));

          // Ancre initiale
          orderBookProcessor.setAnchorByPrice(initialPrice);
          orderBookProcessor.clearAnchor();

          // Centrer l'affichage
          setTimeout(() => {
            const spaceEvent = new KeyboardEvent('keydown', { code: 'Space' });
            window.dispatchEvent(spaceEvent);
          }, 100);

          // Snapshot initial
          if (orderbookSnapshots.length > 0) {
            const initialLadder = orderBookProcessor.createTickLadder(orderbookSnapshots[0], tradeEvents);
            setCurrentTickLadder(decorateLadderWithVolume(initialLadder, volumeByPrice));
          }
          
          console.log('🔥 File loaded with synchronized frames, ready for playback');
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

  // ---------- PROCESS FRAME (ordre ORDERBOOK → BBO → TRADES) ----------
  const processFrame = useCallback((frame: Frame) => {
    console.log(`🎬 Processing frame at ${new Date(frame.t).toISOString()}`);
    
    // 1. ORDERBOOK (mise à jour des niveaux L2)
    if (frame.ob) {
      const priceMap = new Map<number, OrderBookLevel>();
      const newBook: OrderBookLevel[] = [];

      // Traitement des bids
      for (let i = 0; i < Math.min(frame.ob.bidPrices.length, 10); i++) {
        const bp = toBidTick(frame.ob.bidPrices[i]);
        const bsz = frame.ob.bidSizes[i] || 0;
        if (bp > 0 && bsz >= 0) {
          const level: OrderBookLevel = { price: bp, bidSize: bsz, askSize: 0, volume: volumeByPrice.get(bp) || 0 };
          priceMap.set(bp, level);
          newBook.push(level);
        }
      }

      // Traitement des asks
      for (let i = 0; i < Math.min(frame.ob.askPrices.length, 10); i++) {
        const ap = toAskTick(frame.ob.askPrices[i]);
        const asz = frame.ob.askSizes[i] || 0;
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

      newBook.sort((a, b) => b.price - a.price);
      setOrderBook(newBook);

      // Mise à jour des données de book pour compatibilité
      setCurrentOrderBookData({
        book_bid_prices: frame.ob.bidPrices,
        book_ask_prices: frame.ob.askPrices,
        book_bid_sizes: frame.ob.bidSizes,
        book_ask_sizes: frame.ob.askSizes,
      });
    }

    // 2. BBO (mise à jour du L1 et alignement)
    if (frame.bbo) {
      setCurrentOrderBookData(prevData => ({
        book_bid_prices: frame.bbo?.bidPrice ? [toBidTick(frame.bbo.bidPrice)] : (prevData?.book_bid_prices ?? []),
        book_ask_prices: frame.bbo?.askPrice ? [toAskTick(frame.bbo.askPrice)] : (prevData?.book_ask_prices ?? []),
        book_bid_sizes: frame.bbo?.bidSize ? [frame.bbo.bidSize] : (prevData?.book_bid_sizes ?? []),
        book_ask_sizes: frame.bbo?.askSize ? [frame.bbo.askSize] : (prevData?.book_ask_sizes ?? []),
      }));
    }

    // 3. TRADES (mise à jour T&S et prix courant)
    for (const trade of frame.trades) {
      const px = toTick(trade.price);
      const tradeObj: Trade = {
        id: `trade-${frame.t}-${Math.random()}`,
        timestamp: frame.t,
        price: px,
        size: trade.size,
        aggressor: trade.aggressor || 'BUY'
      };

      // TAS aggregation
      setAggregationBuffer(prev => {
        const last = prev[prev.length - 1];
        if (last && last.price === tradeObj.price && last.aggressor === tradeObj.aggressor) {
          const merged = { ...last, size: last.size + tradeObj.size };
          return [...prev.slice(0, -1), merged];
        }
        return [...prev, tradeObj];
      });

      // Mise à jour du prix courant
      setCurrentPrice(px);

      // Volume par prix
      const gridPrice = roundToGrid(px);
      setVolumeByPrice(prev => {
        const next = new Map(prev);
        next.set(gridPrice, (next.get(gridPrice) ?? 0) + trade.size);
        return next;
      });

      // Mise à jour du volume dans le ladder
      setOrderBook(prev =>
        prev.map(level =>
          Math.abs(level.price - gridPrice) < 0.125
            ? { ...level, volume: (level.volume || 0) + trade.size }
            : level
        )
      );

      // Exécution des ordres limites
      setOrders(prev => {
        const updated: Order[] = [];
        for (const o of prev) {
          const shouldExecute =
            (o.side === 'BUY' && px <= o.price) ||
            (o.side === 'SELL' && px >= o.price);
          if (shouldExecute) {
            executeLimitFill(o, o.price);
          } else {
            updated.push(o);
          }
        }
        return updated;
      });
    }
  }, [volumeByPrice, executeLimitFill]);

  // ---------- playback loop : **FRAME BY FRAME** ----------
  // Traite une frame complète (OB → BBO → TRADES) puis attend le timing réel
  useEffect(() => {
    if (!isPlaying || currentFrameIndex >= frames.length) return;

    const currentFrame = frames[currentFrameIndex];
    
    // Traite la frame complète dans l'ordre synchrone
    processFrame(currentFrame);
    
    const nextIndex = currentFrameIndex + 1;
    setCurrentFrameIndex(nextIndex);

    if (nextIndex < frames.length) {
      const nextFrame = frames[nextIndex];
      const timeDiff = Math.max(0, nextFrame.t - currentFrame.t);
      
      // Délai ajusté selon la vitesse de playback
      const baseDelay = timeDiff / playbackSpeed;
      const minDelay = playbackSpeed >= 10 ? 1 : (playbackSpeed >= 5 ? 10 : 50);
      const maxDelay = 5000; // Cap à 5 secondes
      const delay = Math.max(minDelay, Math.min(baseDelay, maxDelay));
      
      console.log(`⏱️ Frame ${currentFrameIndex}/${frames.length}, next in ${delay}ms (speed: ${playbackSpeed}x, real delay: ${timeDiff}ms)`);
      
      playbackTimerRef.current = setTimeout(() => {
        // l'effet se relancera avec l'index mis à jour
      }, delay);
    } else {
      flushAggregationBuffer();
      setIsPlaying(false);
      console.log('🏁 Playback terminé - toutes les frames traitées');
    }

    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [isPlaying, currentFrameIndex, frames, playbackSpeed, processFrame, flushAggregationBuffer]);

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
    frames,
    currentFrameIndex,
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