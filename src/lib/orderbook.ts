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
  timestamp: Date;
}

export interface TickLevel {
  tick: number;             // index en ticks (0.25 pour le NQ)
  price: number;            // prix calculé depuis tick
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  // champs optionnels utilisés par l'UI
  sizeWindow?: number;
  volumeCumulative?: number;
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

  constructor(tickSize = 0.25) {
    this.tickSize = tickSize;
  }

  public setTickSize(size: number) {
    if (size > 0) this.tickSize = size;
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
      if (err < bestErr) { best = c; bestErr = err; }
    }
    return best;
  }

  public setAnchorByPrice(price: number) {
    this.anchorTick = this.toTick(price);
  }
  public clearAnchor() { this.anchorTick = null; }

  public priceToTick(price: number) { return this.toTick(price); }

  // [OLD Romi 2025-08-20]
  // private toTick(price: number): number {
  //   return Math.round(price / this.tickSize);
  // }
  private toTick(price: number): number {
    // [MOD Romi 2025-08-20] Conserve pour ancrage (utilisé sur lastTrade),
    // mais le mapping par côté est géré directement dans createTickLadder (floor/ceil).
    return Math.round(price / this.tickSize);
  }
  private fromTick(tick: number): number {
    return +(tick * this.tickSize).toFixed(8);
  }

  /** Optionnel : parse d’un snapshot depuis une ligne CSV déjà chargée */
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

    const ts = row.ts_exch_utc ?? row.ts_utc ?? Date.now();
    const timestamp = new Date(ts);

    return { bidPrices, bidSizes, bidOrders, askPrices, askSizes, askOrders, timestamp };
  }

  /** Optionnel : parse d’un trade depuis une ligne CSV */
  public parseTrade(row: any): Trade | null {
    const p = Number(row.trade_price);
    const s = Number(row.trade_size);
    const aRaw = (row.aggressor ?? "").toString().toUpperCase();
    const a: Side | null = aRaw === "BUY" || aRaw === "B" ? "BUY"
                        : aRaw === "SELL" || aRaw === "S" ? "SELL" : null;
    if (!isFinite(p) || p <= 0 || !isFinite(s) || s <= 0 || !a) return null;
    const ts = row.ts_exch_utc ?? row.ts_utc ?? Date.now();
    return { timestamp: new Date(ts), price: p, size: s, aggressor: a };
  }

  /** Génére un ladder anti-jitter : centre ancré, niveaux par tick */
  public createTickLadder(
    snapshot: ParsedOrderBook,
    trades: Trade[] = [],
    _prevTs?: Date
  ): TickLadder {
    // 1) regroupe par tick (évite doublons/arrondis)
    const bidByTick = new Map<number, { size: number; orders?: number }>();
    const askByTick = new Map<number, { size: number; orders?: number }>();

    for (let i = 0; i < snapshot.bidPrices.length; i++) {
      // [OLD Romi 2025-08-20] const t = this.toTick(snapshot.bidPrices[i]);
      const t = Math.floor((snapshot.bidPrices[i] + 1e-9) / this.tickSize); // [MOD Romi 2025-08-20] floor pour BID
      const s = snapshot.bidSizes[i] ?? 0;
      bidByTick.set(t, { size: s, orders: snapshot.bidOrders?.[i] });
    }
    for (let i = 0; i < snapshot.askPrices.length; i++) {
      // [OLD Romi 2025-08-20] const t = this.toTick(snapshot.askPrices[i]);
      const t = Math.ceil((snapshot.askPrices[i] - 1e-9) / this.tickSize); // [MOD Romi 2025-08-20] ceil pour ASK
      const s = snapshot.askSizes[i] ?? 0;
      askByTick.set(t, { size: s, orders: snapshot.askOrders?.[i] });
    }

    // 2) centre ancré (ne bouge pas tout seul)
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
      // [PATCH 2025-08-21] Ne pas figer l'ancre automatiquement : rester en mode follow tant que l'utilisateur n'ancre pas.
      // this.anchorTick = centerTick;
    }

    // 3) fenêtre autour du centre (large, l’UI en affiche 20)
    // [OLD Romi 2025-08-20] const HALF = 40;
const HALF = 80; // [MOD Romi 2025-08-20] fenêtre ±80 ticks
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

  // (facultatif) Remise à zéro de compteurs internes si vous en ajoutez plus tard
  public resetVolume() { /* no-op pour l’instant */ }
}