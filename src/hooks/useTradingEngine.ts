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
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentPrice, setCurrentPrice] = useState(0);

  // mini carnet pour l’UI (optionnel)
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

  const [orderBookSnapshots, setOrderBookSnapshots] = useState<
    ParsedOrderBook[]
  >([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(
    null
  );
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(0.25));

  const orderBookSnapshotsRef = useRef<ParsedOrderBook[]>([]);
  const tradesRef = useRef<OrderBookTrade[]>([]);
  const anchorRef = useRef<number | null>(null);

  useEffect(() => {
    orderBookSnapshotsRef.current = orderBookSnapshots;
  }, [orderBookSnapshots]);
  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  const TICK_SIZE = 0.25;
  const TICK_VALUE = 5.0;
  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  const roundToGrid = (price: number) => Math.round(price * 4) / 4;

  // ---------- UTIL ----------
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
        if (Array.isArray(j)) return j.map((v) => +v).filter((n) => isFinite(n));
      }
    } catch {}
    const cleaned = value.replace(/^\[|\]$/g, "").trim();
    if (!cleaned) return [];
    return cleaned
      .split(/[\s,]+/)
      .map((v) => +v)
      .filter((n) => isFinite(n));
  };

  const normalizeEventType = (s: string) =>
    (s ?? "").toString().toUpperCase().trim();
  const normalizeAggressor = (s: string): Side | undefined => {
    const a = (s ?? "").toString().toUpperCase().trim();
    if (a === "BUY" || a === "B") return "BUY";
    if (a === "SELL" || a === "S") return "SELL";
    return undefined;
  };

  // ---------- APPLY FILL (centralisé) ----------
  const applyFill = useCallback(
    (side: Side, fillPrice: number, qty: number, why: string) => {
      if (!(qty > 0)) return;

      // 1) Position & PnL réalisé (si on réduit/ferme)
      setPosition((prev) => {
        const newQty = prev.quantity + (side === "BUY" ? qty : -qty);

        let realized = 0;
        if (prev.quantity !== 0) {
          const closing =
            (prev.quantity > 0 && side === "SELL") ||
            (prev.quantity < 0 && side === "BUY");
          if (closing) {
            const closeQty = Math.min(qty, Math.abs(prev.quantity));
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
          // on ajoute à la position existante
          const prevAbs = Math.abs(prev.quantity);
          const totalQty = prevAbs + qty;
          const prevVal = prev.averagePrice * prevAbs;
          const addVal = fillPrice * qty;
          newAvg = totalQty > 0 ? (prevVal + addVal) / totalQty : fillPrice;
        } else {
          // on inverse : nouveau prix moyen = prix du fill
          newAvg = fillPrice;
        }

        return {
          ...prev,
          quantity: newQty,
          averagePrice: newAvg,
          marketPrice: fillPrice,
        };
      });

      // 2) “Last” (pour PnL latent) + TAS
      setCurrentPrice(fillPrice);
      setTimeAndSales((prev) => [
        {
          id: `fill-${why}-${Date.now()}-${Math.random()}`,
          timestamp: Date.now(),
          price: fillPrice,
          size: qty,
          aggressor: side,
        },
        ...prev.slice(0, 99),
      ]);

      // 3) Volume par prix
      const grid = roundToGrid(fillPrice);
      setVolumeByPrice((prev) => {
        const next = new Map(prev);
        next.set(grid, (next.get(grid) ?? 0) + qty);
        return next;
      });

      // 4) “Trade” pour le ladder (marque le last)
      setTrades((prev) => [
        ...prev,
        { timestamp: new Date(), price: fillPrice, size: qty, aggressor: side },
      ]);
    },
    []
  );

  // ---------- LOAD ----------
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
    setOrders([]);
    setTimeAndSales([]);

    setPosition({ symbol: "DEMO", quantity: 0, averagePrice: 0, marketPrice: 0 });
    setRealizedPnLTotal(0);
    setPnl({ unrealized: 0, realized: 0, total: 0 });

    setVolumeByPrice(new Map());
    orderBookProcessor.resetVolume();
    orderBookProcessor.clearAnchor();
    anchorRef.current = null;

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

          anchorRef.current = initialPrice;
          orderBookProcessor.setAnchorByPrice(initialPrice);

          setCurrentPrice(initialPrice);
          setMarketData(events);
          setOrderBookSnapshots(snaps.sort((a, b) => +a.timestamp - +b.timestamp));
          setTrades(trs.sort((a, b) => +a.timestamp - +b.timestamp));

          if (snaps.length) {
            const ladder = orderBookProcessor.createTickLadder(snaps[0], trs);
            setCurrentTickLadder(ladder);
          }
        },
      });
    };
    reader.readAsText(file, "UTF-8");
  }, [orderBookProcessor]);

  // ---------- CORE ----------
  const processEvent = useCallback(
    (event: MarketEvent) => {
      switch (event.eventType) {
        case "TRADE": {
          if (event.tradePrice && event.tradeSize && event.aggressor) {
            setCurrentPrice(event.tradePrice);

            // TAS + volume + ladder
            setTimeAndSales((prev) => [
              {
                id: `trade-${Date.now()}-${Math.random()}`,
                timestamp: event.timestamp,
                price: event.tradePrice,
                size: event.tradeSize,
                aggressor: event.aggressor,
              },
              ...prev.slice(0, 99),
            ]);

            const grid = roundToGrid(event.tradePrice);
            setVolumeByPrice((prev) => {
              const next = new Map(prev);
              next.set(grid, (next.get(grid) ?? 0) + event.tradeSize!);
              return next;
            });

            setTrades((prev) => [
              ...prev,
              {
                timestamp: new Date(event.timestamp),
                price: event.tradePrice!,
                size: event.tradeSize!,
                aggressor: event.aggressor!,
              },
            ]);

            // partial fills contre “last”
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
          }
          break;
        }

        case "BBO": {
          // met à jour l’UI book + ladder
          setCurrentOrderBookData((prev) => {
            const next = {
              book_bid_prices: event.bidPrice
                ? [event.bidPrice]
                : prev?.book_bid_prices ?? [],
              book_ask_prices: event.askPrice
                ? [event.askPrice]
                : prev?.book_ask_prices ?? [],
              book_bid_sizes: event.bidSize
                ? [event.bidSize]
                : prev?.book_bid_sizes ?? [],
              book_ask_sizes: event.askSize
                ? [event.askSize]
                : prev?.book_ask_sizes ?? [],
            };

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

            // mini book pour l’affichage
            const list: OrderBookLevel[] = [];
            const add = (p?: number, s?: number, side?: "bid" | "ask") => {
              if (!p || !s || p <= 0 || s <= 0) return;
              const gp = roundToGrid(p);
              const i = list.findIndex((l) => Math.abs(l.price - gp) < 0.125);
              if (i >= 0) {
                if (side === "bid") list[i] = { ...list[i], bidSize: s };
                else list[i] = { ...list[i], askSize: s };
              } else {
                list.push({
                  price: gp,
                  bidSize: side === "bid" ? s : 0,
                  askSize: side === "ask" ? s : 0,
                  volume: volumeByPrice.get(gp) || 0,
                });
              }
            };
            add(event.bidPrice, event.bidSize, "bid");
            add(event.askPrice, event.askSize, "ask");
            list.sort((a, b) => b.price - a.price);
            setOrderBook(list);

            return next;
          });

          // *** EXÉCUTION LIMIT via top-of-book ***
          const bestBid = event.bidPrice;
          const bestAsk = event.askPrice;

          if (Number.isFinite(bestBid as number) || Number.isFinite(bestAsk as number)) {
            const hits: Array<{ side: Side; price: number; qty: number }> = [];
            setOrders((prev) => {
              const remaining: Order[] = [];
              for (const o of prev) {
                const remainingQty = o.quantity - o.filled;
                if (remainingQty <= 0) continue;

                let cross = false;
                if (o.side === "BUY" && Number.isFinite(bestAsk as number) && (bestAsk as number) <= o.price) cross = true;
                if (o.side === "SELL" && Number.isFinite(bestBid as number) && (bestBid as number) >= o.price) cross = true;

                if (cross) {
                  hits.push({ side: o.side, price: o.price, qty: remainingQty });
                } else {
                  remaining.push(o);
                }
              }
              return remaining;
            });

            // Appliquer les fills hors du setOrders
            for (const h of hits) {
              applyFill(h.side, h.price, h.qty, "limit-bbo");
            }
          }
          break;
        }

        case "ORDERBOOK": {
          if (event.bookBidPrices || event.bookAskPrices) {
            const snap: ParsedOrderBook = {
              bidPrices: event.bookBidPrices ?? [],
              bidSizes: event.bookBidSizes ?? [],
              askPrices: event.bookAskPrices ?? [],
              askSizes: event.bookAskSizes ?? [],
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

            setCurrentOrderBookData({
              book_bid_prices: (event.bookBidPrices ?? []).slice(0, 20),
              book_ask_prices: (event.bookAskPrices ?? []).slice(0, 20),
              book_bid_sizes: (event.bookBidSizes ?? []).slice(0, 20),
              book_ask_sizes: (event.bookAskSizes ?? []).slice(0, 20),
            });

            // mini book 10 niveaux
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
    [applyFill, orderBookProcessor, volumeByPrice]
  );

  // ---------- PLAYBACK ----------
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

  // ---------- COMMANDES ----------
  const togglePlayback = useCallback(() => setIsPlaying((p) => !p), []);
  const setPlaybackSpeedSafe = useCallback((v: number) => setPlaybackSpeed(v), []);

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
      const fillPrice =
        side === "BUY" ? (bestAsk ?? currentPrice) : (bestBid ?? currentPrice);
      applyFill(side, fillPrice, quantity, "market");
    },
    [currentOrderBookData, currentPrice, applyFill]
  );

  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders((prev) => prev.filter((o) => Math.abs(o.price - price) >= 0.125));
  }, []);

  // ---------- PnL latent ----------
  useEffect(() => {
    const tickDiff = (currentPrice - position.averagePrice) / TICK_SIZE;
    const unrealized = position.quantity * tickDiff * TICK_VALUE;
    setPnl({
      unrealized,
      realized: realizedPnLTotal,
      total: unrealized + realizedPnLTotal,
    });
  }, [position, currentPrice, realizedPnLTotal]);

  // ---------- Filet de sécurité LIMIT vs last ----------
  useEffect(() => {
    if (currentPrice <= 0) return;

    const hits: Array<{ side: Side; price: number; qty: number }> = [];
    setOrders((prev) => {
      const remaining: Order[] = [];
      for (const o of prev) {
        const rest = o.quantity - o.filled;
        if (rest <= 0) continue;
        const cross =
          (o.side === "BUY" && currentPrice <= o.price) ||
          (o.side === "SELL" && currentPrice >= o.price);
        if (cross) hits.push({ side: o.side, price: o.price, qty: rest });
        else remaining.push(o);
      }
      return remaining;
    });

    for (const h of hits) {
      applyFill(h.side, h.price, h.qty, "limit-last");
    }
  }, [currentPrice, applyFill]);

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
    setPlaybackSpeed: setPlaybackSpeedSafe,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,
    orderBookSnapshots,
    trades,
    currentTickLadder,
    orderBookProcessor,
  };
}