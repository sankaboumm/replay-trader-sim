type EVT = 'TRADE' | 'BBO' | 'ORDERBOOK' | 'ORDERBOOK_FULL';

type CsvRow = {
  ts_exch_utc: string;
  event_type: EVT | string;
  // BBO:
  bid_price?: number; bid_size?: number;
  ask_price?: number; ask_size?: number;
  // MBP:
  book_bid_prices?: number[] | string;
  book_bid_sizes?: number[] | string;
  book_ask_prices?: number[] | string;
  book_ask_sizes?: number[] | string;
  // TRADES:
  trade_price?: number; trade_size?: number; aggressor?: string;
};

export type Frame = {
  t: number;                          // ms
  ob?: {
    bidPrices: number[]; bidSizes: number[];
    askPrices: number[]; askSizes: number[];
  };
  bbo?: { bidPrice?: number; bidSize?: number; askPrice?: number; askSize?: number; };
  trades: { price: number; size: number; aggressor?: 'BUY'|'SELL' }[];
};

// ---- helpers parse ----
const num = (x: any) => (x == null ? undefined : (Number(x)));

const parseListNumbers = (v: any): number[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  const s = String(v).trim();
  if (!s || s === '[]') return [];
  try { 
    if (s.startsWith('[')) return (JSON.parse(s) as any[]).map(Number).filter(Number.isFinite); 
  }
  catch {}
  return s.replace(/^\[|\]$/g,'').split(/[\s,;]+/).map(Number).filter(Number.isFinite);
};

const parseAgg = (a: any): 'BUY'|'SELL'|undefined => {
  const s = String(a ?? '').toUpperCase();
  if (s.startsWith('B')) return 'BUY';
  if (s.startsWith('S')) return 'SELL';
  return undefined;
};

// ---- BBO dérivé depuis un snapshot MBP ----
function deriveBboFromOb(ob: Frame['ob']): Frame['bbo'] {
  if (!ob) return {};
  const bbp = ob.bidPrices?.[0]; const bbs = ob.bidSizes?.[0];
  const bap = ob.askPrices?.[0]; const bas = ob.askSizes?.[0];
  const bbo: Frame['bbo'] = {};
  if (Number.isFinite(bbp)) bbo.bidPrice = bbp!;
  if (Number.isFinite(bbs)) bbo.bidSize  = bbs!;
  if (Number.isFinite(bap)) bbo.askPrice = bap!;
  if (Number.isFinite(bas)) bbo.askSize  = bas!;
  return bbo;
}

// ---- CONSTRUCTION DES FRAMES SYNCHRONES ----
export function buildFramesSynced(rows: CsvRow[]): Frame[] {
  // 1) normaliser et regrouper par timestamp exact (string)
  const groups = new Map<string, { ob: CsvRow[]; bbo: CsvRow[]; tr: CsvRow[] }>();
  for (const r of rows) {
    if (!r || !r.ts_exch_utc) continue;
    const g = groups.get(r.ts_exch_utc) ?? { ob:[], bbo:[], tr:[] };
    const et = String(r.event_type).toUpperCase();
    if (et === 'ORDERBOOK' || et === 'ORDERBOOK_FULL') g.ob.push(r);
    else if (et === 'BBO') g.bbo.push(r);
    else if (et === 'TRADE') g.tr.push(r);
    groups.set(r.ts_exch_utc, g);
  }

  // 2) produire 1 frame par timestamp (OB dernier, BBO dernier ou dérivé, toutes les trades)
  const keys = Array.from(groups.keys()).sort((a,b) => Date.parse(a) - Date.parse(b));
  const frames: Frame[] = [];
  for (const k of keys) {
    const g = groups.get(k)!;
    const t = Date.parse(k);

    let ob: Frame['ob'] | undefined;
    if (g.ob.length) {
      const last = g.ob[g.ob.length-1];
      ob = {
        bidPrices: parseListNumbers((last as any).book_bid_prices),
        bidSizes:  parseListNumbers((last as any).book_bid_sizes),
        askPrices: parseListNumbers((last as any).book_ask_prices),
        askSizes:  parseListNumbers((last as any).book_ask_sizes),
      };
    }

    let bbo: Frame['bbo'] | undefined;
    if (g.bbo.length) {
      const last = g.bbo[g.bbo.length-1];
      bbo = {
        bidPrice: num((last as any).bid_price),
        bidSize:  num((last as any).bid_size),
        askPrice: num((last as any).ask_price),
        askSize:  num((last as any).ask_size),
      };
    } else if (ob) {
      bbo = deriveBboFromOb(ob); // ✅ pas de "trou" de BBO
    }

    const trades = g.tr.map(r => {
      const a = parseAgg((r as any).aggressor);
      return {
        price: Number((r as any).trade_price),
        size:  Number((r as any).trade_size),
        aggressor: a
      };
    }).filter(x => Number.isFinite(x.price) && Number.isFinite(x.size) && x.size! > 0);

    frames.push({ t, ob, bbo, trades });
  }
  return frames;
}