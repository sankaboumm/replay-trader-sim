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

  public setTickSize(size: number) { this.tickSize = size; }
  public inferTickSize(prices: number[]): number {
    // heuristique simple : détecte le plus petit pas non nul
    const sorted = [...new Set(prices.filter(Number.isFinite))].sort((a,b)=>a-b);
    let minStep = Infinity;
    for (let i=1;i<sorted.length;i++) {
      const d = +(sorted[i]-sorted[i-1]).toFixed(8);
      if (d > 0 && d < minStep) minStep = d;
    }
    return Number.isFinite(minStep) && minStep>0 ? minStep : this.tickSize;
  }

  public setAnchorByPrice(price: number) {
    this.anchorTick = this.toTick(price);
  }
  public clearAnchor() { this.anchorTick = null; }

  public priceToTick(price: number) { return this.toTick(price); }

  private toTick(price: number): number {
    // ancrage : arrondi classique ; le côté (bid/ask) est géré au moment de l’agrégation (floor/ceil)
    return Math.round(price / this.tickSize);
  }
  private fromTick(tick: number): number {
    return +(tick * this.tickSize).toFixed(8);
  }

  /** Parse d’un snapshot depuis une ligne CSV déjà chargée */
  public parseOrderBookSnapshot(row: any): ParsedOrderBook | null {
    const arr = (v: any): number[] => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.map(Number).filter(n=>!isNaN(n));
      const s = String(v).trim();
      if (!s) return [];
      try {
        if (s.startsWith('[')) return (JSON.parse(s) as any[]).map(Number).filter(n=>!isNaN(n));
        const cleaned = s.replace(/^\[|\]$/g, '');
        if (!cleaned) return [];
        return cleaned.split(/[\s,]+/).map(Number).filter(n=>!isNaN(n));
      } catch {
        return [];
      }
    };

    const tsStr = row.ts_exch_utc || row.ts_exch_madrid || row.ts_utc || row.ts_madrid;
    const ts = tsStr ? new Date(tsStr) : new Date();
    const snap: ParsedOrderBook = {
      bidPrices: arr(row.book_bid_prices),
      bidSizes:  arr(row.book_bid_sizes),
      bidOrders: arr(row.book_bid_orders),
      askPrices: arr(row.book_ask_prices),
      askSizes:  arr(row.book_ask_sizes),
      askOrders: arr(row.book_ask_orders),
      timestamp: ts
    };
    return snap;
  }

  public parseTrade(row: any): Trade | null {
    const tsStr = row.ts_exch_utc || row.ts_exch_madrid || row.ts_utc || row.ts_madrid;
    const ts = tsStr ? new Date(tsStr) : new Date();
    const p = parseFloat(row.trade_price);
    const s = parseFloat(row.trade_size);
    const a = (row.aggressor?.toString().toUpperCase().startsWith('B') ? 'BUY' :
               row.aggressor?.toString().toUpperCase().startsWith('S') ? 'SELL' : undefined) as Side | undefined;
    if (!Number.isFinite(p) || !Number.isFinite(s) || !a) return null;
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
      const t = Math.floor((snapshot.bidPrices[i] + 1e-9) / this.tickSize); // floor pour BID
      const s = snapshot.bidSizes[i] ?? 0;
      bidByTick.set(t, { size: s, orders: snapshot.bidOrders?.[i] });
    }
    for (let i = 0; i < snapshot.askPrices.length; i++) {
      const t = Math.ceil((snapshot.askPrices[i] - 1e-9) / this.tickSize); // ceil pour ASK
      const s = snapshot.askSizes[i] ?? 0;
      askByTick.set(t, { size: s, orders: snapshot.askOrders?.[i] });
    }

    // 2) centre ancré
    let centerTick = this.anchorTick;
    if (centerTick == null) {
      const lastTrade = trades.length ? trades[trades.length - 1] : undefined;
      if (lastTrade) centerTick = this.toTick(lastTrade.price);
      else {
        // fallback : moyenne des meilleures quotes si dispo
        const bestBidTick = bidByTick.size ? Math.max(...Array.from(bidByTick.keys())) : 0;
        const bestAskTick = askByTick.size ? Math.min(...Array.from(askByTick.keys())) : 0;
        centerTick = Math.round((bestBidTick + bestAskTick) / 2);
      }
    }
    if (centerTick == null) centerTick = 0;

    // fenêtre d’affichage
    // const HALF = 40;
    const HALF = 80;
    const minTick = centerTick - HALF;
    const maxTick = centerTick + HALF;

    // --- Clamp dans le spread : pas de bids au-dessus du best bid, ni d’asks en-dessous du best ask
    const bidTicks = Array.from(bidByTick.keys());
    const askTicks = Array.from(askByTick.keys());
    const bestBidTick = bidTicks.length ? Math.max(...bidTicks) : Number.NEGATIVE_INFINITY;
    const bestAskTick = askTicks.length ? Math.min(...askTicks) : Number.POSITIVE_INFINITY;

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

  public resetVolume() { /* no-op */ }
}