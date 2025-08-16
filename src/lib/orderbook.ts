// src/lib/orderbook.ts
// Moteur d'order book + génération d'un ladder ancré (anti-jitter)

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
  midTick: number;          // tick d'ancrage (centre visuel)
  midPrice: number;
  lastTick?: number;        // dernier tick traded
  lastPrice?: number;
  levels: TickLevel[];      // du plus haut prix (index 0) au plus bas (dernier)
}

export class OrderBookProcessor {
  private tickSize = 0.25;
  private anchorTick: number | null = null;
  private cumulativeVolume = new Map<number, number>(); // tick -> volume cumulé

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

  
  /** Déplace l'ancre du ladder d'un nombre de ticks (positif = vers le haut) */
  public scrollAnchor(deltaTicks: number) {
    if (!Number.isFinite(deltaTicks) || !deltaTicks) return;
    const d = Math.trunc(deltaTicks);
    if (this.anchorTick == null) {
      this.anchorTick = 0;
    }
    this.anchorTick = (this.anchorTick ?? 0) + d;
  }

  /** Fixe l'ancre directement en nombre de ticks (optionnel) */
  public setAnchorByTick(tick: number) {
    if (Number.isFinite(tick)) this.anchorTick = Math.trunc(tick);
  }

  public getAnchorTick(): number | null { return this.anchorTick; }
public priceToTick(price: number) { return this.toTick(price); }

  private toTick(price: number): number {
    return Math.round(price / this.tickSize);
  }
  private fromTick(tick: number): number {
    return +(tick * this.tickSize).toFixed(8);
  }

  /** Optionnel : parse d'un snapshot depuis une ligne CSV déjà chargée */
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

  /** Optionnel : parse d'un trade depuis une ligne CSV */
  public parseTrade(row: any): Trade | null {
    const p = Number(row.trade_price);
    const s = Number(row.trade_size);
    const aRaw = (row.aggressor ?? "").toString().toUpperCase();
    const a: Side | null = aRaw === "BUY" || aRaw === "B" ? "BUY"
                        : aRaw === "SELL" || aRaw === "S" ? "SELL" : null;
    if (!isFinite(p) || p <= 0 || !isFinite(s) || s <= 0 || !a) return null;
    const ts = row.ts_exch_utc ?? row.ts_utc ?? Date.now();
    
    // Accumuler le volume à ce tick
    const tick = this.toTick(p);
    const currentVol = this.cumulativeVolume.get(tick) || 0;
    this.cumulativeVolume.set(tick, currentVol + s);
    
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

    // 3) fenêtre autour du centre (large, l'UI en affiche 20)
    const HALF = 40;                       // fenêtre ±40 ticks
    const minTick = centerTick - HALF;
    const maxTick = centerTick + HALF;

    const levels: TickLevel[] = [];
    for (let t = maxTick; t >= minTick; t--) {
      const bid = bidByTick.get(t);
      const ask = askByTick.get(t);
      const cumulativeVol = this.cumulativeVolume.get(t) || 0;
      levels.push({
        tick: t,
        price: this.fromTick(t),
        bidSize: bid?.size ?? 0,
        askSize: ask?.size ?? 0,
        bidOrders: bid?.orders ?? 0,
        askOrders: ask?.orders ?? 0,
        sizeWindow: 0,
        volumeCumulative: cumulativeVol,
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

  // Remise à zéro du volume cumulé
  public resetVolume() { 
    this.cumulativeVolume.clear(); 
  }
  
  // Obtenir le volume cumulé pour un tick donné
  public getCumulativeVolume(tick: number): number {
    return this.cumulativeVolume.get(tick) || 0;
  }
}