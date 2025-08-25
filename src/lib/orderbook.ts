// src/lib/orderbook.ts
// Moteur d’order book + génération d’un ladder ancré (anti-jitter) + clamp dans le spread

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
  timestamp: Date;
}

export interface TickLevel {
  tick: number;
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  sizeWindow?: number;
  volumeCumulative?: number;
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

  constructor(tickSize = 0.25) { this.tickSize = tickSize; }
  public setTickSize(n: number) { this.tickSize = n > 0 ? n : this.tickSize; }
  public inferTickSize(prices: number[]): number {
    const s = [...new Set(prices.filter(Number.isFinite))].sort((a,b)=>a-b);
    let min = Infinity;
    for (let i=1;i<s.length;i++) {
      const d = +(s[i]-s[i-1]).toFixed(8);
      if (d>0 && d<min) min = d;
    }
    return Number.isFinite(min) && min>0 ? min : this.tickSize;
  }

  public setAnchorByPrice(price: number) { this.anchorTick = Math.round(price / this.tickSize); }
  public clearAnchor() { this.anchorTick = null; }

  private toTick(price: number) { return Math.round(price / this.tickSize); }
  private fromTick(t: number) { return +(t * this.tickSize).toFixed(8); }

  public parseOrderBookSnapshot(row: any): ParsedOrderBook | null {
    const arr = (v: any): number[] => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.map(Number).filter(n=>Number.isFinite(n));
      const s = String(v).trim();
      if (!s) return [];
      try {
        if (s.startsWith('[')) return (JSON.parse(s) as any[]).map(Number).filter(Number.isFinite);
      } catch {}
      return s.replace(/^\[|\]$/g, '')
        .split(/[\s,;]+/)
        .map(Number)
        .filter(Number.isFinite);
    };
    const tsStr = row.ts_exch_utc || row.ts_exch_madrid || row.ts_utc || row.ts_madrid;
    const ts = tsStr ? new Date(tsStr) : new Date();
    return {
      bidPrices: arr(row.book_bid_prices) ?? [],
      bidSizes:  arr(row.book_bid_sizes)  ?? [],
      bidOrders: arr(row.book_bid_orders) ?? [],
      askPrices: arr(row.book_ask_prices) ?? [],
      askSizes:  arr(row.book_ask_sizes)  ?? [],
      askOrders: arr(row.book_ask_orders) ?? [],
      timestamp: ts
    };
  }

  public parseTrade(row: any): Trade | null {
    const tsStr = row.ts_exch_utc || row.ts_exch_madrid || row.ts_utc || row.ts_madrid;
    const ts = tsStr ? new Date(tsStr) : new Date();
    const p = Number(row.trade_price);
    const s = Number(row.trade_size);
    const a = String(row.aggressor ?? '').toUpperCase().startsWith('B') ? 'BUY'
          : String(row.aggressor ?? '').toUpperCase().startsWith('S') ? 'SELL' : undefined;
    if (!Number.isFinite(p) || !Number.isFinite(s) || !a) return null;
    return { timestamp: ts, price: p, size: s, aggressor: a as Side };
  }

  public createTickLadder(snapshot: ParsedOrderBook, trades: Trade[] = []): TickLadder {
    const bidByTick = new Map<number, { size: number; orders?: number }>();
    const askByTick = new Map<number, { size: number; orders?: number }>();

    const bidPrices = snapshot.bidPrices ?? [];
    const bidSizes  = snapshot.bidSizes  ?? [];
    const bidOrders = snapshot.bidOrders ?? [];
    const askPrices = snapshot.askPrices ?? [];
    const askSizes  = snapshot.askSizes  ?? [];
    const askOrders = snapshot.askOrders ?? [];

    for (let i = 0; i < Math.min(bidPrices.length, bidSizes.length); i++) {
      const t = Math.floor((bidPrices[i] + 1e-9) / this.tickSize);
      const s = bidSizes[i] ?? 0;
      bidByTick.set(t, { size: s, orders: bidOrders[i] });
    }
    for (let i = 0; i < Math.min(askPrices.length, askSizes.length); i++) {
      const t = Math.ceil((askPrices[i] - 1e-9) / this.tickSize);
      const s = askSizes[i] ?? 0;
      askByTick.set(t, { size: s, orders: askOrders[i] });
    }

    let centerTick = this.anchorTick;
    if (centerTick == null) {
      const lastTrade = trades.length ? trades[trades.length - 1] : undefined;
      if (lastTrade) centerTick = this.toTick(lastTrade.price);
      else {
        const bidKeys = Array.from(bidByTick.keys());
        const askKeys = Array.from(askByTick.keys());
        const bestBidTick = bidKeys.length ? Math.max(...bidKeys) : 0;
        const bestAskTick = askKeys.length ? Math.min(...askKeys) : 0;
        centerTick = Math.round((bestBidTick + bestAskTick) / 2);
      }
    }
    if (centerTick == null) centerTick = 0;

    const HALF = 80;
    const minTick = centerTick - HALF;
    const maxTick = centerTick + HALF;

    // clamp: rien “dans” le spread
    const bidKeys = Array.from(bidByTick.keys());
    const askKeys = Array.from(askByTick.keys());
    const bestBidTick = bidKeys.length ? Math.max(...bidKeys) : Number.NEGATIVE_INFINITY;
    const bestAskTick = askKeys.length ? Math.min(...askKeys) : Number.POSITIVE_INFINITY;

    const levels: TickLevel[] = [];
    for (let t = maxTick; t >= minTick; t--) {
      const bid = bidByTick.get(t);
      const ask = askByTick.get(t);
      levels.push({
        tick: t,
        price: this.fromTick(t),
        bidSize: (isFinite(bestBidTick) && t > bestBidTick) ? 0 : (bid?.size ?? 0),
        askSize: (isFinite(bestAskTick) && t < bestAskTick) ? 0 : (ask?.size ?? 0),
        bidOrders: (isFinite(bestBidTick) && t > bestBidTick) ? 0 : (bid?.orders ?? 0),
        askOrders: (isFinite(bestAskTick) && t < bestAskTick) ? 0 : (ask?.orders ?? 0),
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
}