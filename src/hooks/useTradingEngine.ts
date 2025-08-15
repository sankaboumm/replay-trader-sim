// src/hooks/useTradingEngine.ts
// Lecture CSV, horloge de replay, PnL, ordres, ancrage du ladder et synchro L2+prix

import { useState, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import {
  OrderBookProcessor,
  ParsedOrderBook,
  Trade as OrderBookTrade,
  TickLadder,
} from "@/lib/orderbook";

type Side = "BUY" | "SELL";

interface MarketEvent {
  timestamp: number;
  eventType: "TRADE" | "BBO" | "ORDERBOOK";
  tradePrice?: number;
  tradeSize?: number;
  aggressor?: Side;
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
  aggressor: Side;
  aggregatedCount?: number;
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  volume?: number;
}

interface Order {
  id: string;
  side: Side;
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

export function useTradingEngine() {
  // ---- state principal ----
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
  } | null>(null);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<Position>({
    symbol: "DEMO",
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0,
  });
  const [pnl, setPnl] = useState<PnL>({ unrealized: 0, realized: 0, total: 0 });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(
    new Map()
  );

  // Données pour le ladder robuste
  const [orderBookSnapshots, setOrderBookSnapshots] = useState<
    ParsedOrderBook[]
  >([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(
    null
  );
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(0.25));

  // Refs anti-stale + ancre de centre
  const orderBookSnapshotsRef = useRef<ParsedOrderBook[]>([]);
  const tradesRef = useRef<OrderBookTrade[]>([]);
  const anchorRef = useRef<number | null>(null);

  useEffect(() => {
    orderBookSnapshotsRef.current = orderBookSnapshots;
  }, [orderBookSnapshots]);
  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  // Constantes PnL
  const TICK_SIZE = 0.25;
  const TICK_VALUE = 5.0;
  const AGG_WINDOW_MS = 5;

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // ---------- utils ----------
  const roundToGrid = (price: number) => Math.round(price * 4) / 4;

  const parseTimestamp = (row: any): number => {
    const fields = ["ts_exch_utc", "ts_utc", "ts_exch_madrid", "ts_madrid"];
    for (const f of fields) {
      if (row[f]) {
        const t = new Date(row[f]).getTime();
        if (!isNaN(t)) return t;
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
    if (!value || value === "[]" || value === "") return [];
    try {
      if (value.startsWith("[") && value.endsWith("]")) {
        const j = JSON.parse(value);
        if (Array.isArray(j)) {
          return j.map((v) => parseFloat(v)).filter((n) => !isNaN(n));
        }
      }
    } catch {}
    const cleaned = value.replace(/^\[|\]$/g, "").trim();
    if (!cleaned) return [];
    return cleaned
      .split(/[\s,]+/)
      .map((v) => parseFloat(v))
      .filter((n) => !isNaN(n));
  };

  const normalizeEventType = (s: string) =>
    (s ?? "").toString().toUpperCase().trim();

  const normalizeAggressor = (s: string): Side | undefined => {
    const a = (s ?? "").toString().toUpperCase().trim();
    if (a === "BUY" || a === "B") return "BUY";
    if (a === "SELL" || a === "S") return "SELL";
    return undefined;
  };

  // ---------- chargement fichier ----------
  const loadMarketData = useCallback((file: File) => {
    // reset
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    setOrderBookSnapshots([]);
    setTrades([]);
    setCurrentTickLadder(null);
    setCurrentOrderBookData(null);
    setOrderBook([]);
    orderBookProcessor.resetVolume();
    anchorRef.current = null;
    orderBookProcessor.clearAnchor();

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const raw: Array<MarketEvent & { sortOrder: number }> = [];
          const snaps: ParsedOrderBook[] = [];
          const trs: OrderBookTrade[] = [];

          results.data.forEach((row: any) => {
            if (!row) return;
            const ts = parseTimestamp(row);
            const type = normalizeEventType(row.event_type);
            let sortOrder = 0;
            if (type === "ORDERBOOK") sortOrder = 0;
            else if (type === "BBO") sortOrder = 1;
            else if (type === "TRADE") sortOrder = 2;

            if (type === "TRADE") {
              const p = parseFloat(row.trade_price);
              const s = parseFloat(row.trade_size);
              const a = normalizeAggressor(row.aggressor);
              if (!isFinite(p) || p <= 0 || !isFinite(s) || s <= 0 || !a) return;
              const t = orderBookProcessor.parseTrade(row);
              if (t) trs.push(t);
              raw.push({
                timestamp: ts,
                sortOrder,
                eventType: "TRADE",
                tradePrice: p,
                tradeSize: s,
                aggressor: a,
              });
            } else if (type === "BBO") {
              const bp = parseFloat(row.bid_price);
              const ap = parseFloat(row.ask_price);
              const bs = parseFloat(row.bid_size);
              const asz = parseFloat(row.ask_size);
              const hasBid = isFinite(bp) && bp > 0;
              const hasAsk = isFinite(ap) && ap > 0;
              if (!hasBid && !hasAsk) return;
              raw.push({
                timestamp: ts,
                sortOrder,
                eventType: "BBO",
                bidPrice: hasBid ? bp : undefined,
                askPrice: hasAsk ? ap : undefined,
                bidSize: hasBid && isFinite(bs) ? bs : undefined,
                askSize: hasAsk && isFinite(asz) ? asz : undefined,
              });
            } else if (type === "ORDERBOOK" || type === "ORDERBOOK_FULL") {
              const bP = parseArrayField(row.book_bid_prices);
              const bS = parseArrayField(row.book_bid_sizes);
              const aP = parseArrayField(row.book_ask_prices);
              const aS = parseArrayField(row.book_ask_sizes);
              if (bP.length === 0 && aP.length === 0) return;

              const snap: ParsedOrderBook = {
                bidPrices: bP,
                bidSizes: bS,
                askPrices: aP,
                askSizes: aS,
                bidOrders: [],
                askOrders: [],
                timestamp: new Date(ts),
              };
              snaps.push(snap);
              raw.push({
                timestamp: ts,
                sortOrder,
                eventType: "ORDERBOOK",
                bookBidPrices: bP,
                bookBidSizes: bS,
                bookAskPrices: aP,
                bookAskSizes: aS,
              });
            }
          });

          raw.sort((a, b) =>
            a.timestamp !== b.timestamp
              ? a.timestamp - b.timestamp
              : a.sortOrder - b.sortOrder
          );
          const events: MarketEvent[] = raw.map(({ sortOrder, ...e }) => e);

          // tick size
          const allPrices = [
            ...snaps.flatMap((s) => [...s.bidPrices, ...s.askPrices]),
            ...trs.map((t) => t.price),
          ];
          if (allPrices.length > 0) {
            orderBookProcessor.setTickSize(
              orderBookProcessor.inferTickSize(allPrices)
            );
          }

          // prix initial
          let initialPrice = 19300;
          const ft = events.find(
            (e) => e.eventType === "TRADE" && e.tradePrice && e.tradePrice > 0
          );
          if (ft?.tradePrice) initialPrice = ft.tradePrice;
          else {
            const f = events.find(
              (e) =>
                (e.eventType === "ORDERBOOK" &&
                  ((e.bookBidPrices && e.bookBidPrices.length) ||
                    (e.bookAskPrices && e.bookAskPrices.length))) ||
                (e.eventType === "BBO" && (e.bidPrice || e.askPrice))
            );
            if (f) {
              if (f.eventType === "ORDERBOOK") {
                if (f.bookBidPrices?.length) initialPrice = f.bookBidPrices[0]!;
                else if (f.bookAskPrices?.length)
                  initialPrice = f.bookAskPrices[0]!;
              } else if (f.eventType === "BBO") {
                initialPrice = f.bidPrice ?? f.askPrice ?? initialPrice;
              }
            }
          }

          // ancre fixe
          anchorRef.current = initialPrice;
          orderBookProcessor.setAnchorByPrice(initialPrice);

          // states
          setCurrentPrice(initialPrice);
          setMarketData(events);
          setOrderBookSnapshots(snaps.sort((a, b) => +a.timestamp - +b.timestamp));
          setTrades(trs.sort((a, b) => +a.timestamp - +b.timestamp));

          // ladder initial
          if (snaps.length) {
            const ladder = orderBookProcessor.createTickLadder(snaps[0], trs);
            setCurrentTickLadder(ladder);
          }
        },
      });
    };
    reader.readAsText(file, "UTF-8");
  }, [orderBookProcessor]);

  // ---------- exécution d’événements ----------
  const processEvent = useCallback(
    (event: MarketEvent) => {
      switch (event.eventType) {
        case "TRADE": {
          if (event.tradePrice && event.tradeSize && event.aggressor) {
            // last
            setCurrentPrice(event.tradePrice);

            // TAS (sans sur-aggrégation ici)
            const t: Trade = {
              id: `trade-${Date.now()}-${Math.random()}`,
              timestamp: event.timestamp,
              price: event.tradePrice,
              size: event.tradeSize,
              aggressor: event.aggressor,
            };
            setTimeAndSales((prev) => [t, ...prev.slice(0, 99)]);

            // Volume par prix (grille 0.25)
            const grid = roundToGrid(event.tradePrice);
            setVolumeByPrice((prev) => {
              const next = new Map(prev);
              next.set(grid, (next.get(grid) ?? 0) + event.tradeSize!);
              return next;
            });

            // Partiels LIMIT basés sur prints (optionnel)
            setOrders((prev) =>
              prev.map((o) => {
                if (o.filled >= o.quantity) return o;
                const hit =
                  (o.side === "BUY" && event.tradePrice! <= o.price) ||
                  (o.side === "SELL" && event.tradePrice! >= o.price);
                if (!hit) return o;
                const add = Math.min(o.quantity - o.filled, event.tradeSize!);
                return { ...o, filled: o.filled + add };
              })
            );

            // historise pour ladder
            setTrades((prev) => [
              ...prev,
              {
                timestamp: new Date(event.timestamp),
                price: event.tradePrice!,
                size: event.tradeSize!,
                aggressor: event.aggressor!,
              },
            ]);
          }
          break;
        }

        case "BBO": {
          // met à jour le mini-book + reconstruit le ladder dans **le même frame**
          setCurrentOrderBookData((prev) => {
            const next = {
              book_bid_prices: event.bidPrice ? [event.bidPrice] : prev?.book_bid_prices ?? [],
              book_ask_prices: event.askPrice ? [event.askPrice] : prev?.book_ask_prices ?? [],
              book_bid_sizes:  event.bidSize  ? [event.bidSize]  : prev?.book_bid_sizes  ?? [],
              book_ask_sizes:  event.askSize  ? [event.askSize]  : prev?.book_ask_sizes  ?? [],
            };

            // Reconstruit ladder tout de suite, même ancre
            const snap: ParsedOrderBook = {
              bidPrices: next.book_bid_prices,
              bidSizes: next.book_bid_sizes,
              askPrices: next.book_ask_prices,
              askSizes: next.book_ask_sizes,
              bidOrders: [],
              askOrders: [],
              timestamp: new Date(event.timestamp),
            };
            if (anchorRef.current != null)
              orderBookProcessor.setAnchorByPrice(anchorRef.current);
            const ladder = orderBookProcessor.createTickLadder(
              snap,
              tradesRef.current
            );
            setCurrentTickLadder(ladder);

            // alimente la vue “10 niveaux” locale
            const newBook: OrderBookLevel[] = [];
            const add = (p?: number, s?: number, side?: "bid" | "ask") => {
              if (!p || !s || p <= 0 || s <= 0) return;
              const gp = roundToGrid(p);
              const i = newBook.findIndex((l) => Math.abs(l.price - gp) < 0.125);
              if (i >= 0) {
                if (side === "bid") newBook[i] = { ...newBook[i], bidSize: s };
                else newBook[i] = { ...newBook[i], askSize: s };
              } else {
                newBook.push({
                  price: gp,
                  bidSize: side === "bid" ? s : 0,
                  askSize: side === "ask" ? s : 0,
                  volume: volumeByPrice.get(gp) || 0,
                });
              }
            };
            add(event.bidPrice, event.bidSize, "bid");
            add(event.askPrice, event.askSize, "ask");
            newBook.sort((a, b) => b.price - a.price);
            setOrderBook(newBook);

            return next;
          });
          break;
        }

        case "ORDERBOOK": {
          if (event.bookBidPrices || event.bookAskPrices) {
            const snap: ParsedOrderBook = {
              bidPrices: event.bookBidPrices ?? [],
              bidSizes: event.bookBidSizes ?? [],
              bidOrders: [],
              askPrices: event.bookAskPrices ?? [],
              askSizes: event.bookAskSizes ?? [],
              askOrders: [],
              timestamp: new Date(event.timestamp),
            };

            if (anchorRef.current != null)
              orderBookProcessor.setAnchorByPrice(anchorRef.current);
            const ladder = orderBookProcessor.createTickLadder(
              snap,
              tradesRef.current
            );
            setCurrentTickLadder(ladder);

            // stocke 20 niveaux pour l’UI
            setCurrentOrderBookData({
              book_bid_prices: (event.bookBidPrices ?? []).slice(0, 20),
              book_ask_prices: (event.bookAskPrices ?? []).slice(0, 20),
              book_bid_sizes: (event.bookBidSizes ?? []).slice(0, 20),
              book_ask_sizes: (event.bookAskSizes ?? []).slice(0, 20),
            });

            // reconstruit la vue locale 10 niveaux (affichage)
            const priceMap = new Map<number, OrderBookLevel>();
            const list: OrderBookLevel[] = [];
            const fillSide = (
              prices?: number[],
              sizes?: number[],
              side?: "bid" | "ask"
            ) => {
              if (!prices || !sizes) return;
              const N = Math.min(prices.length, 10);
              for (let i = 0; i < N; i++) {
                const p = prices[i];
                const s = sizes[i] ?? 0;
                if (!(p > 0 && s > 0)) continue;
                const gp = roundToGrid(p);
                const ex = priceMap.get(gp);
                if (ex) {
                  if (side === "bid") ex.bidSize = s;
                  else ex.askSize = s;
                } else {
                  const level: OrderBookLevel = {
                    price: gp,
                    bidSize: side === "bid" ? s : 0,
                    askSize: side === "ask" ? s : 0,
                    volume: volumeByPrice.get(gp) || 0,
                  };
                  priceMap.set(gp, level);
                  list.push(level);
                }
              }
            };
            fillSide(event.bookBidPrices, event.bookBidSizes, "bid");
            fillSide(event.bookAskPrices, event.bookAskSizes, "ask");
            list.sort((a, b) => b.price - a.price);
            setOrderBook(list);
          }
          break;
        }
      }
    },
    [orderBookProcessor, volumeByPrice]
  );

  // ---------- ordres ----------
  const placeLimitOrder = useCallback((side: Side, price: number, quantity: number) => {
    const newOrder: Order = {
      id: `order-${++orderIdCounter.current}`,
      side,
      price,
      quantity,
      filled: 0,
      timestamp: Date.now(),
    };
    setOrders((prev) => [...prev, newOrder]);
  }, []);

  const placeMarketOrder = useCallback(
    (side: Side, quantity: number) => {
      const bestAsk = currentOrderBookData?.book_ask_prices?.[0];
      const bestBid = currentOrderBookData?.book_bid_prices?.[0];
      const fillPrice = side === "BUY" ? (bestAsk ?? currentPrice) : (bestBid ?? currentPrice);

      setPosition((prev) => {
        const newQty = prev.quantity + (side === "BUY" ? quantity : -quantity);

        let realized = 0;
        if (prev.quantity !== 0) {
          const closing =
            (prev.quantity > 0 && side === "SELL") ||
            (prev.quantity < 0 && side === "BUY");
          if (closing) {
            const closeQty = Math.min(quantity, Math.abs(prev.quantity));
            const tickDiff =
              prev.quantity > 0
                ? (fillPrice - prev.averagePrice) / TICK_SIZE
                : (prev.averagePrice - fillPrice) / TICK_SIZE;
            realized = closeQty * tickDiff * TICK_VALUE;
            setRealizedPnLTotal((t) => t + realized);
          }
        }

        let newAvg = prev.averagePrice;
        if (newQty === 0) newAvg = 0;
        else if (
          (prev.quantity >= 0 && side === "BUY") ||
          (prev.quantity <= 0 && side === "SELL")
        ) {
          const prevAbs = Math.abs(prev.quantity);
          const totalQty = prevAbs + quantity;
          const prevVal = prev.averagePrice * prevAbs;
          const addVal = fillPrice * quantity;
          newAvg = totalQty > 0 ? (prevVal + addVal) / totalQty : fillPrice;
        } else {
          newAvg = fillPrice;
        }

        return {
          ...prev,
          quantity: newQty,
          averagePrice: newAvg,
          marketPrice: fillPrice,
        };
      });

      setCurrentPrice(fillPrice);

      const t: Trade = {
        id: `mkt-${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
        price: fillPrice,
        size: quantity,
        aggressor: side,
      };
      setTimeAndSales((prev) => [t, ...prev.slice(0, 99)]);

      const grid = roundToGrid(fillPrice);
      setVolumeByPrice((prev) => {
        const next = new Map(prev);
        next.set(grid, (next.get(grid) ?? 0) + quantity);
        return next;
      });

      // Ajoute aux trades pour que le ladder marque le lastTick
      setTrades((prev) => [
        ...prev,
        { timestamp: new Date(), price: fillPrice, size: quantity, aggressor: side },
      ]);
    },
    [currentOrderBookData, currentPrice, orderBookProcessor]
  );

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders((prev) => prev.filter((o) => Math.abs(o.price - price) >= 0.125));
  }, []);

  // ---------- PnL ----------
  useEffect(() => {
    const tickDiff = (currentPrice - position.averagePrice) / TICK_SIZE;
    const unrealized = position.quantity * tickDiff * TICK_VALUE;
    setPnl({ unrealized, realized: realizedPnLTotal, total: unrealized + realizedPnLTotal });
  }, [position, currentPrice, realizedPnLTotal]);

  // ---------- exécution LIMIT par crossing du last (filet de sécurité) ----------
  useEffect(() => {
    if (currentPrice <= 0) return;
    setOrders((prev) => {
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        const o = updated[i];
        const hit =
          (o.side === "BUY" && currentPrice <= o.price) ||
          (o.side === "SELL" && currentPrice >= o.price);
        if (!hit) continue;

        const qty = o.quantity - o.filled;
        if (qty <= 0) continue;
        const fillPrice = o.price;

        setPosition((prevPos) => {
          const newQty = prevPos.quantity + (o.side === "BUY" ? qty : -qty);
          let realized = 0;
          if (prevPos.quantity !== 0) {
            const closing =
              (prevPos.quantity > 0 && o.side === "SELL") ||
              (prevPos.quantity < 0 && o.side === "BUY");
            if (closing) {
              const closeQty = Math.min(qty, Math.abs(prevPos.quantity));
              const tickDiff =
                prevPos.quantity > 0
                  ? (fillPrice - prevPos.averagePrice) / TICK_SIZE
                  : (prevPos.averagePrice - fillPrice) / TICK_SIZE;
              realized = closeQty * tickDiff * TICK_VALUE;
              setRealizedPnLTotal((t) => t + realized);
            }
          }
          let newAvg = prevPos.averagePrice;
          if (newQty === 0) newAvg = 0;
          else if (
            (prevPos.quantity > 0 && o.side === "BUY") ||
            (prevPos.quantity < 0 && o.side === "SELL")
          ) {
            const prevAbs = Math.abs(prevPos.quantity);
            const total = prevAbs + qty;
            const prevVal = prevPos.averagePrice * prevAbs;
            const addVal = fillPrice * qty;
            newAvg = total > 0 ? (prevVal + addVal) / total : fillPrice;
          } else if (Math.sign(newQty) !== Math.sign(prevPos.quantity)) {
            newAvg = fillPrice;
          }

          return { ...prevPos, quantity: newQty, averagePrice: newAvg, marketPrice: fillPrice };
        });

        // book-keep
        updated.splice(i, 1);

        // Trades synthétiques pour afficher le last dans le ladder
        setTrades((prev) => [
          ...prev,
          { timestamp: new Date(), price: fillPrice, size: qty, aggressor: o.side },
        ]);
      }
      return updated;
    });
  }, [currentPrice]);

  // ---------- boucle de lecture ----------
  useEffect(() => {
    if (isPlaying && currentEventIndex < marketData.length) {
      const cur = marketData[currentEventIndex];
      const next = marketData[currentEventIndex + 1];
      const tick = () => {
        processEvent(cur);
        setCurrentEventIndex((i) => i + 1);
      };
      if (next) {
        const dt = next.timestamp - cur.timestamp;
        const base = Math.min(dt, 5000);
        const delay = Math.max(playbackSpeed === 1 ? 0 : 1, base / playbackSpeed);
        playbackTimerRef.current = setTimeout(tick, delay);
      } else {
        tick();
        setIsPlaying(false);
      }
    }
    return () => {
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent]);

  const togglePlayback = useCallback(() => setIsPlaying((p) => !p), []);

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
    // pour le DOM
    orderBookSnapshots,
    trades,
    currentTickLadder,
    orderBookProcessor,
  };
}