// src/lib/orderbook.ts
// Petit processeur d’order book + génération d’un ladder ancré.

export type Side = 'BUY' | 'SELL';

export interface ParsedOrderBook {
  bidPrices: number[];
  bidSizes: number[];
  bidOrders?: number[];
  askPrices: number[];
  askSizes: number[];
  askOrders?: number[];
}

export interface TickLadderLevel {
  price: number;
  bidSize: number;
  askSize: number;
  volumeCumulative: number;
  tick: number;
}

export interface TickLadder {
  levels: TickLadderLevel[];
  centerPrice: number;
  tickSize: number;
  minPrice: number;
  maxPrice: number;
}

function roundTo(n: number, step: number) {
  return Math.round(n / step) * step;
}

export class OrderBookProcessor {
  private tickSize: number;
  private bids: Map<number, number>; // price -> size
  private asks: Map<number, number>; // price -> size
  private bestBid?: number;
  private bestAsk?: number;

  constructor(tickSize = 0.25) {
    this.tickSize = tickSize;
    this.bids = new Map();
    this.asks = new Map();
  }

  reset() {
    this.bids.clear();
    this.asks.clear();
    this.bestBid = undefined;
    this.bestAsk = undefined;
  }

  setTickSize(ts: number) {
    if (ts > 0) this.tickSize = ts;
  }

  ingestBBO(bid?: number, bidSize?: number, ask?: number, askSize?: number) {
    if (bid != null) {
      const p = roundTo(bid, this.tickSize);
      this.bids.set(p, Math.max(0, bidSize ?? 0));
      if (this.bestBid == null || p > this.bestBid) this.bestBid = p;
    }
    if (ask != null) {
      const p = roundTo(ask, this.tickSize);
      this.asks.set(p, Math.max(0, askSize ?? 0));
      if (this.bestAsk == null || p < this.bestAsk) this.bestAsk = p;
    }
    if (this.bestBid != null && this.bestAsk != null && this.bestBid >= this.bestAsk) {
      // recalc bests by actual sides
      const bidKeys = [...this.bids.keys()];
      const askKeys = [...this.asks.keys()];
      this.bestBid = bidKeys.length ? Math.max(...bidKeys) : undefined;
      this.bestAsk = askKeys.length ? Math.min(...askKeys) : undefined;
    }
  }

  ingestOrderBookFull(
    bidPrices: number[], bidSizes: number[], bidOrders: number[] | undefined,
    askPrices: number[], askSizes: number[], askOrders: number[] | undefined
  ) {
    this.bids.clear();
    this.asks.clear();
    for (let i = 0; i < Math.min(bidPrices.length, bidSizes.length); i++) {
      const p = roundTo(bidPrices[i], this.tickSize);
      const s = Math.max(0, Number(bidSizes[i]) || 0);
      if (s > 0) this.bids.set(p, (this.bids.get(p) ?? 0) + s);
    }
    for (let i = 0; i < Math.min(askPrices.length, askSizes.length); i++) {
      const p = roundTo(askPrices[i], this.tickSize);
      const s = Math.max(0, Number(askSizes[i]) || 0);
      if (s > 0) this.asks.set(p, (this.asks.get(p) ?? 0) + s);
    }
    const bidKeys = [...this.bids.keys()];
    const askKeys = [...this.asks.keys()];
    this.bestBid = bidKeys.length ? Math.max(...bidKeys) : undefined;
    this.bestAsk = askKeys.length ? Math.min(...askKeys) : undefined;
  }

  getDerived() {
    const spread =
      this.bestBid != null && this.bestAsk != null ? this.bestAsk - this.bestBid : undefined;
    const spreadTicks =
      spread != null ? Math.round(spread / this.tickSize) : undefined;
    return {
      bestBid: this.bestBid,
      bestAsk: this.bestAsk,
      spread,
      spreadTicks,
      tickSize: this.tickSize,
    };
  }

  getSnapshot(): ParsedOrderBook {
    return {
      bidPrices: [...this.bids.keys()].sort((a, b) => b - a),
      bidSizes: [...this.bids.entries()].sort((a, b) => b[0] - a[0]).map((e) => e[1]),
      askPrices: [...this.asks.keys()].sort((a, b) => a - b),
      askSizes: [...this.asks.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
    };
  }

  private priceToTick(price: number): number {
    return Math.round(price / this.tickSize);
  }
  private tickToPrice(tick: number): number {
    return tick * this.tickSize;
  }

  buildTickLadder(anchorPrice?: number, halfWindow = 80): TickLadder {
    const center =
      anchorPrice != null && Number.isFinite(anchorPrice)
        ? anchorPrice
        : this.bestBid != null && this.bestAsk != null
          ? (this.bestBid + this.bestAsk) / 2
          : this.bestBid ?? this.bestAsk ?? NaN;

    const centerTick = Number.isFinite(center) ? this.priceToTick(center) : 0;
    const minTick = centerTick - halfWindow;
    const maxTick = centerTick + halfWindow;

    const levels: TickLadderLevel[] = [];
    let cum = 0;
    for (let t = minTick; t <= maxTick; t++) {
      const price = this.tickToPrice(t);
      const bidSize = this.bids.get(price) ?? 0;
      const askSize = this.asks.get(price) ?? 0;
      cum += bidSize + askSize;
      levels.push({
        price,
        bidSize,
        askSize,
        volumeCumulative: cum,
        tick: t,
      });
    }

    return {
      levels,
      centerPrice: center,
      tickSize: this.tickSize,
      minPrice: this.tickToPrice(minTick),
      maxPrice: this.tickToPrice(maxTick),
    };
  }
}