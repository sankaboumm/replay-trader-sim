// src/lib/orderbook.ts
// Moteur d’order book + génération d’un ladder ancré (anti-jitter)

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
  sizeWindow: number;       // réservé (peut être utilisé pour cumuls)
  volumeCumulative: number; // réservé
}

export interface TickLadder {
  midTick: number;          // tick d’ancrage (centre visuel)
  midPrice: number;
  lastTick?: number;        // dernier tick traded
  lastPrice?: number;
  levels: TickLevel[];      // du plus haut prix (index 0) au plus bas (dernier)
}

export class OrderBookProcessor {
  private tickSize = 0.25;
  private anchorTick: number | null = null;
  private windowHalf: number = 300; // par défaut ±300 ticks (600 de hauteur logique)

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

  public inferTickSize(prices: number[]): number {
    const uniq = Array.from(new Set(prices.filter(Number.isFinite))).sort((a,b)=>a-b);
    if (uniq.length < 2) return this.tickSize;
    let minDiff = Infinity;
    for (let i=1;i<uniq.length;i++) {
      const d = +(uniq[i] - uniq[i-1]).toFixed(8);
      if (d > 0 && d < minDiff) minDiff = d;
    }
    // mappe vers ticks usuels
    const candidates = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
    let best = candidates[0];
    let bestErr = Math.abs(minDiff - best);
    for (const c of candidates) {
      const err = Math.abs(minDiff - c);
      if (err < bestErr) { bestErr = err; best = c; }
    }
    this.tickSize = best;
    return best;
  }

  // Parse une ligne CSV orderbook_* en arrays numériques (supporte JSON, listes séparées par virgules/espaces)
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

  // Construit un ladder ancré et figé autour d’un centre
  public makeTickLadder(
    snapshot: ParsedOrderBook,
    trades: Trade[] = []
  ): TickLadder {
    // 1) indexation par tick
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

    // 2) centre ancré (ne bouge pas tout seul)
    let centerTick = this.anchorTick;
    if (centerTick == null) {
      // priorité : dernier trade s'il existe au moment du premier render
      const lastTrade = trades.length ? trades[trades.length - 1] : undefined;
      if (lastTrade) {
        centerTick = this.toTick(lastTrade.price);
      } else {
        // sinon, milieu simple entre meilleur bid/ask si cohérent
        const bestBid = Math.max(...Array.from(bidByTick.keys()).concat([-Infinity]));
        const bestAsk = Math.min(...Array.from(askByTick.keys()).concat([+Infinity]));
        centerTick = isFinite(bestBid) && isFinite(bestAsk) && bestBid <= bestAsk
          ? Math.floor((bestBid + bestAsk) / 2)
          : 0;
      }
      this.anchorTick = centerTick;
    }

    // 3) fenêtre autour du centre (large, l’UI peut en afficher une partie)
    const HALF = this.windowHalf;          // fenêtre ±windowHalf ticks
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

  public resetVolume() { /* no-op pour l’instant */ }
}