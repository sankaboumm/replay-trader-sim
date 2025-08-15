export type Side = "BUY" | "SELL";
export type Status = "WORKING" | "PARTIAL" | "FILLED" | "CANCELED";

export interface Order {
  id: string;
  side: Side;
  price: number;     // prix limite, ignoré pour market
  qty: number;
  remain: number;
  tickIndex: number;
  queueAhead: number; // lots devant toi à la pose
  status: Status;
  timestamp: number;
}

export interface PositionPnL {
  pos: number;       // contrats
  avg: number;       // prix moyen
  realized: number;  // PNL réalisé ($)
  unreal: number;    // PNL latent ($)
  lastPrice: number; // dernier prix (pour unreal)
}

export const MULTIPLIER = 20; // $/pt pour NQ

export const initPnl = (): PositionPnL => ({
  pos: 0, avg: 0, realized: 0, unreal: 0, lastPrice: 0
});

function onBuyFill(state: PositionPnL, px: number, qty: number) {
  if (state.pos >= 0) { // ajouter à une longue
    if (state.pos === 0) {
      state.avg = px;
    } else {
      state.avg = (state.avg * state.pos + px * qty) / (state.pos + qty);
    }
    state.pos += qty;
  } else {              // couvrir short
    const closing = Math.min(qty, -state.pos);
    state.realized += (state.avg - px) * closing * MULTIPLIER;
    state.pos += qty;
    if (state.pos > 0) state.avg = px; // flip → nouvelle longue
  }
}

function onSellFill(state: PositionPnL, px: number, qty: number) {
  if (state.pos <= 0) { // ajouter à un short
    const shortQty = Math.abs(state.pos);
    if (shortQty === 0) {
      state.avg = px;
    } else {
      state.avg = (state.avg * shortQty + px * qty) / (shortQty + qty);
    }
    state.pos -= qty;
  } else {              // déboucler long
    const closing = Math.min(qty, state.pos);
    state.realized += (px - state.avg) * closing * MULTIPLIER;
    state.pos -= qty;
    if (state.pos < 0) state.avg = px; // flip → nouveau short
  }
}

export function markToMarket(state: PositionPnL, mark: number) {
  state.lastPrice = mark;
  state.unreal = (mark - state.avg) * state.pos * MULTIPLIER;
}

// Market orders (sweep du carnet)
export function executeMarket(
  side: Side,
  qty: number,
  snap: { bidPrices: number[]; bidSizes: number[]; askPrices: number[]; askSizes: number[] },
  pnl: PositionPnL
) {
  const prices = side === "BUY" ? snap.askPrices : snap.bidPrices;
  const sizes  = side === "BUY" ? snap.askSizes  : snap.bidSizes;

  let remain = qty;
  for (let i = 0; i < prices.length && remain > 0; i++) {
    const take = Math.min(remain, sizes[i] ?? 0);
    if (take > 0) {
      const px = prices[i];
      if (side === "BUY") onBuyFill(pnl, px, take);
      else                onSellFill(pnl, px, take);
      remain -= take;
    }
  }
  // s'il reste, on exécute au dernier niveau visible (slippage "pessimiste")
  if (remain > 0 && prices.length > 0) {
    const px = prices[prices.length - 1];
    if (side === "BUY") onBuyFill(pnl, px, remain);
    else                onSellFill(pnl, px, remain);
  }
}

// Limit orders avec file d'attente
export function placeLimit(
  side: Side, 
  price: number, 
  qty: number, 
  snap: { bidPrices: number[]; bidSizes: number[]; askPrices: number[]; askSizes: number[] }, 
  tick: number,
  toTick: (price: number) => number
): Order {
  const k = toTick(price);
  const sizeAtLevel =
    side === "BUY"
      ? (snap.bidSizes[snap.bidPrices.findIndex(px => Math.abs(px - price) < tick/2)] ?? 0)
      : (snap.askSizes[snap.askPrices.findIndex(px => Math.abs(px - price) < tick/2)] ?? 0);

  return {
    id: crypto.randomUUID(),
    side, price, qty,
    remain: qty,
    tickIndex: k,
    queueAhead: sizeAtLevel,
    status: "WORKING",
    timestamp: Date.now()
  };
}

// Consommer les TRADE de la fenêtre et remplir les limites
export function processTradeWindow(
  trades: { timestamp: Date; price: number; size: number; aggressor?: string }[],
  t0: Date, 
  t1: Date, 
  tick: number,
  working: Order[], 
  pnl: PositionPnL,
  toTick: (price: number) => number
) {
  const t0n = +t0, t1n = +t1;
  
  for (const tr of trades) {
    const tn = +tr.timestamp;
    if (!(tn > t0n && tn <= t1n)) continue;

    const k = toTick(tr.price);
    const hitSide = tr.aggressor === "BUY" ? "ASK" :
                    tr.aggressor === "SELL" ? "BID" : null;
    if (!hitSide) continue;

    let remainingTrade = tr.size;

    for (const o of working.filter(o => 
      (o.status === "WORKING" || o.status === "PARTIAL") && o.tickIndex === k
    )) {
      // compat côté frappé
      if ((o.side === "BUY"  && hitSide !== "BID") ||
          (o.side === "SELL" && hitSide !== "ASK")) continue;

      // 1) la queue devant toi consomme d'abord
      if (o.queueAhead > 0) {
        const consumed = Math.min(o.queueAhead, remainingTrade);
        o.queueAhead -= consumed;
        remainingTrade -= consumed;
        if (remainingTrade <= 0) continue; // rien pour toi sur ce print
      }

      // 2) puis tes propres fills
      if (o.remain > 0 && remainingTrade > 0) {
        const fillQty = Math.min(o.remain, remainingTrade);
        if (o.side === "BUY") onBuyFill(pnl, tr.price, fillQty);
        else                  onSellFill(pnl, tr.price, fillQty);

        o.remain -= fillQty;
        if (o.remain === 0) o.status = "FILLED";
        else o.status = "PARTIAL";
        remainingTrade -= fillQty;
        
        console.log(`✅ Order filled: ${o.id} - ${fillQty} @ ${tr.price.toFixed(2)} (${o.status})`);
      }
    }
  }
}