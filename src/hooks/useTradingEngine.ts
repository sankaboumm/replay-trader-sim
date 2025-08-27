// src/hooks/useTradingEngine.ts
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
  timestamp: number | Date;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled?: number;
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

  const toMarketEvent = (row: any): MarketEvent => {
    const timestamp = parseTimestamp(row);
    const eventType = String(row.event_type || '').toUpperCase();
    const evt: MarketEvent = { timestamp, eventType: (eventType === 'ORDERBOOK_FULL' ? 'ORDERBOOK' : eventType) as any };

    if (evt.eventType === 'TRADE') {
      evt.tradePrice = Number(row.trade_price);
      evt.tradeSize = Number(row.trade_size);
      const aggr = String(row.aggressor || '').toUpperCase();
      evt.aggressor = aggr === 'BUY' || aggr === 'B' ? 'BUY' : aggr === 'SELL' || aggr === 'S' ? 'SELL' : undefined;
    } else if (evt.eventType === 'BBO') {
      evt.bidPrice = Number(row.bid_price);
      evt.bidSize = Number(row.bid_size);
      evt.askPrice = Number(row.ask_price);
      evt.askSize = Number(row.ask_size);
    } else if (evt.eventType === 'ORDERBOOK') {
      evt.bookBidPrices = row.book_bid_prices ? String(row.book_bid_prices).replace(/^\[|\]$/g, '').split(/[\s,;]+/).map(Number).filter(Number.isFinite) : [];
      evt.bookBidSizes = row.book_bid_sizes ? String(row.book_bid_sizes).replace(/^\[|\]$/g, '').split(/[\s,;]+/).map(Number).filter(Number.isFinite) : [];
      evt.bookAskPrices = row.book_ask_prices ? String(row.book_ask_prices).replace(/^\[|\]$/g, '').split(/[\s,;]+/).map(Number).filter(Number.isFinite) : [];
      evt.bookAskSizes = row.book_ask_sizes ? String(row.book_ask_sizes).replace(/^\[|\]$/g, '').split(/[\s,;]+/).map(Number).filter(Number.isFinite) : [];
    }
    return evt;
  };

  // ---------- processors ----------
  const orderBookProcessor = useMemo(() => new OrderBookProcessor(TICK_SIZE), []);
  const setViewAnchorPrice = useCallback((price?: number | null) => {
    if (!price && price !== 0) orderBookProcessor.clearAnchor();
    else orderBookProcessor.setAnchorByPrice(price!);
  }, [orderBookProcessor]);

  // ---------- Trade & Volume aggregation ----------
  const [aggregationBuffer, setAggregationBuffer] = useState<Trade[]>([]);
  useEffect(() => {
    const id = setInterval(() => {
      setTimeAndSales(prev => {
        if (aggregationBuffer.length === 0) return prev;
        const next = [...prev, ...aggregationBuffer];
        return next.slice(-300);
      });
      setAggregationBuffer([]);
    }, 100);
    return () => clearInterval(id);
  }, [aggregationBuffer]);

  // ---------- LOAD FILE ----------
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
          if (tradeEvents.length > 0) initialPrice = tradeEvents[0].price;
          else if (orderbookSnapshots.length > 0) {
            const s0 = orderbookSnapshots[0];
            initialPrice = s0.bidPrices?.[0] ?? s0.askPrices?.[0] ?? 0;
          } else if (syncFrames.length > 0) {
            const f0 = syncFrames[0];
            if (f0.ob) initialPrice = f0.ob.bidPrices?.[0] ?? f0.ob.askPrices?.[0] ?? 0;
            else if (f0.bbo) initialPrice = f0.bbo.bidPrice ?? f0.bbo.askPrice ?? 0;
          }
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
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    const px = toTick(currentPrice);
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
        const fillVal = px * qty;
        newAvg = (prevVal + fillVal) / Math.max(1, totalQty);
      } else {
        newAvg = prevPos.averagePrice;
      }
      return {
        ...prevPos,
        quantity: newQty,
        averagePrice: toTick(newAvg),
        marketPrice: currentPrice
      };
    });

    // remove filled order (simplifié)
    setOrders(prev => prev.filter(o => o.id !== order.id));
  }, [currentPrice]);

  useEffect(() => {
    setPnl({
      unrealized: (currentPrice - position.averagePrice) * position.quantity * 20,
      realized: realizedPnLTotal,
      total: (currentPrice - position.averagePrice) * position.quantity * 20 + realizedPnLTotal
    });
  }, [position, currentPrice, realizedPnLTotal]);

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

          setCurrentPrice(px);

          // Limit fills (très simple : exécute si prix atteint)
          setOrders(prev => {
            const updated: Order[] = [];
            for (const o of prev) {
              const shouldExecute = (o.side === 'BUY' && px <= o.price) || (o.side === 'SELL' && px >= o.price);
              if (shouldExecute) {
                executeLimitFill(o, px);
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
  }, [volumeByPrice, executeLimitFill]);

  // ---------- Best bid/ask ----------
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
          const ex = priceMap.get(bp);
          if (ex) ex.bidSize = bsz;
          else {
            const level: OrderBookLevel = { price: bp, bidSize: bsz, askSize: 0, volume: volumeByPrice.get(bp) || 0 };
            priceMap.set(bp, level);
            newBook.push(level);
          }
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
      setAggregationBuffer(prev => {
        const last = prev[prev.length - 1];
        if (last && last.price === px && last.aggressor === trade.aggressor) {
          const merged = { ...last, size: last.size + trade.size };
          return [...prev.slice(0, -1), merged];
        }
        return [...prev, {
          id: `t-${frame.t}-${Math.random()}`,
          timestamp: frame.t,
          price: px,
          size: trade.size,
          aggressor: trade.aggressor || 'BUY'
        }];
      });
      setCurrentPrice(px);

      // fills basiques
      setOrders(prev => {
        const updated: Order[] = [];
        for (const o of prev) {
          const shouldExecute = (o.side === 'BUY' && px <= o.price) || (o.side === 'SELL' && px >= o.price);
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
      
      console.log(`⏱️ Frame ${currentFrameIndex}/${frames.length} → wait=${delay}ms (speed: ${playbackSpeed}x, real delay: ${timeDiff}ms)`);
      
      playbackTimerRef.current = setTimeout(() => {
        // Le useEffect se relancera avec currentFrameIndex mis à jour
      }, delay);
    } else {
      setIsPlaying(false);
    }
  }, [isPlaying, currentFrameIndex, frames, playbackSpeed, processFrame]);

  // ---------- reconstruire un ladder complet (tick ladder) à partir du book courant + trades ----------
  useEffect(() => {
    if (!currentOrderBookData || (!currentOrderBookData.book_bid_prices?.length && !currentOrderBookData.book_ask_prices?.length)) {
      return;
    }
    // sécurité : ne pas saturer l’UI si l’on reçoit un book très profond
    const cap = ORDERBOOK_CAP;
    const bidPrices = (currentOrderBookData.book_bid_prices || []).slice(0, cap);
    const bidSizes  = (currentOrderBookData.book_bid_sizes  || []).slice(0, cap);
    const askPrices = (currentOrderBookData.book_ask_prices || []).slice(0, cap);
    const askSizes  = (currentOrderBookData.book_ask_sizes  || []).slice(0, cap);

    const bidLevels = bidPrices.map((p, i) => ({ price: toBidTick(p), bidSize: bidSizes[i] || 0, askSize: 0, volume: volumeByPrice.get(toBidTick(p)) || 0 }));
    const askLevels = askPrices.map((p, i) => ({ price: toAskTick(p), bidSize: 0, askSize: askSizes[i] || 0, volume: volumeByPrice.get(toAskTick(p)) || 0 }));

    // merge par prix (évite doublons si L1 injecté par BBO)
    const map = new Map<number, OrderBookLevel>();
    for (const b of bidLevels) map.set(b.price, { ...b });
    for (const a of askLevels) {
      const ex = map.get(a.price);
      if (ex) map.set(a.price, { ...ex, askSize: a.askSize });
      else map.set(a.price, a);
    }
    const merged = Array.from(map.values()).sort((a,b)=>b.price-a.price);
    setOrderBook(merged);

    // créer un snapshot pour le processor
    const snapshot: ParsedOrderBook = {
        bidPrices: merged.filter(l=>l.bidSize>0).map(l=>l.price),
        bidSizes:  merged.filter(l=>l.bidSize>0).map(l=>l.bidSize),
        bidOrders: [],
        askPrices: merged.filter(l=>l.askSize>0).map(l=>l.price),
        askSizes:  merged.filter(l=>l.askSize>0).map(l=>l.askSize),
        askOrders: [],
        timestamp: new Date()
      };
      const ladder = orderBookProcessor.createTickLadder(snapshot, trades);
      setCurrentTickLadder(decorateLadderWithVolume(ladder, volumeByPrice));
    }
  }, [orderBookProcessor, currentOrderBookData, orderBook, trades, volumeByPrice]);

  // ---------- toggle playback ----------
  const togglePlayback = useCallback(() => {
    console.log('🎮 Toggle playback called, frames available:', frames.length, 'current index:', currentFrameIndex);
    if (frames.length === 0) {
      console.log('❌ No frames loaded, cannot play');
      return;
    }
    if (currentFrameIndex >= frames.length) {
      console.log('🔄 Resetting to beginning');
      setCurrentFrameIndex(0);
    }
    setIsPlaying(prev => {
      console.log('🎮 Setting playing to:', !prev);
      return !prev;
    });
  }, [frames.length, currentFrameIndex]);
  
  const setPlaybackSpeedSafe = useCallback((speed: number) => setPlaybackSpeed(Math.max(0.1, speed)), []);
  const setPlaybackSpeedWrapper = useCallback((speed: number) => {
    setPlaybackSpeedSafe(speed);
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = undefined;
      if (isPlaying) {
        setIsPlaying(false);
        setTimeout(() => setIsPlaying(true), 0);
      }
    }
  }, [isPlaying, setPlaybackSpeedSafe]);

  // ---------- exports ----------
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
    placeMarketOrder,
    cancelOrdersAtPrice: (price: number) => setOrders(prev => prev.filter(o => o.price !== price)),

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