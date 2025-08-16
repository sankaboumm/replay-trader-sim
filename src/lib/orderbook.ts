// src/lib/orderbook.ts
// Order book processor + anchored ladder (stable price column)

export type Side = "BUY" | "SELL";

export interface Trade {
  timestamp: Date;
  price: number;
  size: number;
  aggressor: Side;
}

export interface ParsedOrderBook {
  bidPrices: number[];
  bidSizes: number[];
  bidOrders?: number[];
  askPrices: number[];
  askSizes: number[];
  askOrders?: number[];
}

export interface TickLevel {
  tick: number;
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  sizeWindow: number;
  volumeCumulative: number;
}

export interface TickLadder {
  midTick: number;
  midPrice: number;
  lastTick?: number;
  lastPrice?: number;
  levels: TickLevel[];
}

export class OrderBookProcessor {
  private tickSize = 0.25;
  private anchorTick: number | null = null;
  private windowHalf: number = 300;

  constructor(tickSize = 0.25) {
    this.tickSize = tickSize;
  }

  public setTickSize(size: number) {
    if (size > 0) this.tickSize = size;
  }

  public setWindowHalf(n: number) {
    if (Number.isFinite(n) && n > 0) this.windowHalf = Math.floor(n);
  }

  public toTick(price: number): number {
    return Math.round(price / this.tickSize);
  }

  public fromTick(tick: number): number {
    return +(tick * this.tickSize).toFixed(8);
  }

  public setAnchorByPrice(price: number) {
    if (Number.isFinite(price)) {
      this.anchorTick = this.toTick(price);
    }
  }

  // robust parser for arrays stored as JSON or comma/space sep
  public parseOrderBookSnapshot(row: any): ParsedOrderBook | null {
    const arr = (v: any): number[] => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.map(Number).filter(n=>!isNaN(n));
      const s = String(v).trim();
      if (!s) return [];
      try {
        if (s.startsWith("[") && s.endsWith("]")) {
          const j = JSON.parse(s);
          if (Array.isArray(j)) return j.map(Number).filter(n=>!isNaN(n));
        }
      } catch {}
      const cleaned = s.replace(/^\[|\]$/g, "");
      if (!cleaned) return [];
      return cleaned.split(/[\s,]+/).map(Number).filter(n=>!isNaN(n));
    };

    const bidPrices = arr(row.book_bid_prices);
    const bidSizes  = arr(row.book_bid_sizes);
    const bidOrders = arr(row.book_bid_orders);
    const askPrices = arr(row.book_ask_prices);
    const askSizes  = arr(row.book_ask_sizes);
    const askOrders = arr(row.book_ask_orders);

    const okB = bidPrices.length === bidSizes.length &&
                (bidOrders.length === 0 || bidOrders.length === bidPrices.length);
    const okA = askPrices.length === askSizes.length &&
                (askOrders.length === 0 || askOrders.length === askPrices.length);
    if (!okB || !okA) return null;

    return { bidPrices, bidSizes, bidOrders, askPrices, askSizes, askOrders };
  }

  public makeTickLadder(snapshot: ParsedOrderBook, trades: Trade[] = []): TickLadder {
    const bidByTick = new Map<number, { size: number; orders?: number }>();
    const askByTick = new Map<number, { size: number; orders?: number }>();

    for (let i = 0; i < snapshot.bidPrices.length; i++) {
      const t = this.toTick(snapshot.bidPrices[i]);
      const s = snapshot.bidSizes[i] ?? 0;
      bidByTick.set(t, { size: s, orders: snapshot.bidOrders?.[i] });
    }
    for (let i = 0; i < snapshot.askPrices.length; i++) {
      const t = this.toTick(snapshot.askPrices[i]);
      const s = snapshot.askSizes[i] ?? 0;
      askByTick.set(t, { size: s, orders: snapshot.askOrders?.[i] });
    }

    // choose anchor (fixed)
    let centerTick = this.anchorTick;
    if (centerTick == null) {
      const lastTrade = trades.length ? trades[trades.length - 1] : undefined;
      if (lastTrade) {
        centerTick = this.toTick(lastTrade.price);
      } else {
        const bestBid = Math.max(...Array.from(bidByTick.keys()).concat([-Infinity]));
        const bestAsk = Math.min(...Array.from(askByTick.keys()).concat([+Infinity]));
        centerTick = isFinite(bestBid) && isFinite(bestAsk) && bestBid <= bestAsk
          ? Math.floor((bestBid + bestAsk) / 2)
          : 0;
      }
      this.anchorTick = centerTick;
    }

    const HALF = this.windowHalf;
    const minTick = centerTick - HALF;
    const maxTick = centerTick + HALF;

    const levels: TickLevel[] = [];
    for (let t = maxTick; t >= minTick; t--) {
      const bid = bidByTick.get(t);
      const ask = askByTick.get(t);
      levels.push({
        tick: t,
        price: this.fromTick(t),
        bidSize: bid?.size ?? 0,
        askSize: ask?.size ?? 0,
        bidOrders: bid?.orders ?? 0,
        askOrders: ask?.orders ?? 0,
        sizeWindow: 0,
        volumeCumulative: 0,
      });
    }

    const lastTrade = trades.length ? trades[trades.length - 1] : undefined;
    const lastTick = lastTrade ? this.toTick(lastTrade.price) : undefined;

    return {
      midTick: centerTick,
      midPrice: this.fromTick(centerTick),
      lastTick,
      lastPrice: lastTrade?.price,
      levels,
    };
  }

  public resetVolume() { /* reserved */ }
}
