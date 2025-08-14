// Utilities for robust order book parsing and tick-based price management

export interface ParsedOrderBook {
  bidPrices: number[];
  bidSizes: number[];
  bidOrders: number[];
  askPrices: number[];
  askSizes: number[];
  askOrders: number[];
  timestamp: Date;
}

export interface Trade {
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
  timestamp: Date;
}

export interface TickLadder {
  midTick: number;
  levels: TickLevel[];
}

export interface TickLevel {
  tick: number;
  price: number;
  bidSize: number;
  askSize: number;
  sizeWindow: number;
  volumeCumulative: number;
}

export class OrderBookProcessor {
  private tick: number;
  private volumeByTick: Map<number, number> = new Map();
  
  constructor(tickSize: number = 0.25) {
    this.tick = tickSize;
  }

  /**
   * Robust parsing of book_* columns - handles both JSON and NumPy formats
   */
  parseBookArray(value: string | null | undefined): number[] {
    if (!value || value === '[]' || value === '') return [];
    
    try {
      // Try JSON.parse first
      if (value.startsWith('[') && value.endsWith(']')) {
        const jsonResult = JSON.parse(value);
        if (Array.isArray(jsonResult)) {
          return jsonResult.map(v => parseFloat(v)).filter(v => !isNaN(v));
        }
      }
    } catch (e) {
      // JSON failed, try NumPy format
    }
    
    // NumPy format: remove brackets and split on spaces/commas
    const cleaned = value.replace(/^\[|\]$/g, '').trim();
    if (!cleaned) return [];
    
    return cleaned
      .split(/[\s,]+/)
      .map(v => v.trim())
      .filter(v => v.length > 0)
      .map(v => parseFloat(v))
      .filter(v => !isNaN(v));
  }

  /**
   * Parse a full orderbook snapshot from CSV row
   */
  parseOrderBookSnapshot(row: any): ParsedOrderBook | null {
    try {
      const bidPrices = this.parseBookArray(row.book_bid_prices);
      const bidSizes = this.parseBookArray(row.book_bid_sizes);
      const bidOrders = this.parseBookArray(row.book_bid_orders);
      const askPrices = this.parseBookArray(row.book_ask_prices);
      const askSizes = this.parseBookArray(row.book_ask_sizes);
      const askOrders = this.parseBookArray(row.book_ask_orders);
      
      // Validate array lengths
      if (bidPrices.length !== bidSizes.length || askPrices.length !== askSizes.length) {
        console.warn('Mismatched array lengths in orderbook snapshot');
        return null;
      }
      
      // Parse timestamp (priority order)
      let timestamp = new Date();
      if (row.ts_exch_utc) {
        timestamp = new Date(row.ts_exch_utc);
      } else if (row.ts_utc) {
        timestamp = new Date(row.ts_utc);
      }
      
      return {
        bidPrices,
        bidSizes,
        bidOrders,
        askPrices,
        askSizes,
        askOrders,
        timestamp
      };
    } catch (error) {
      console.error('Failed to parse orderbook snapshot:', error);
      return null;
    }
  }

  /**
   * Parse trade from CSV row
   */
  parseTrade(row: any): Trade | null {
    try {
      const price = parseFloat(row.trade_price);
      const size = parseFloat(row.trade_size);
      const aggressor = row.aggressor?.toString().toUpperCase().trim();
      
      if (isNaN(price) || isNaN(size) || !aggressor) return null;
      if (aggressor !== 'BUY' && aggressor !== 'SELL') return null;
      
      let timestamp = new Date();
      if (row.ts_exch_utc) {
        timestamp = new Date(row.ts_exch_utc);
      } else if (row.ts_utc) {
        timestamp = new Date(row.ts_utc);
      }
      
      return {
        price,
        size,
        aggressor: aggressor as 'BUY' | 'SELL',
        timestamp
      };
    } catch (error) {
      console.error('Failed to parse trade:', error);
      return null;
    }
  }

  /**
   * Convert price to tick index (avoids floating point issues)
   */
  toTick(price: number): number {
    return Math.round(price / this.tick);
  }

  /**
   * Convert tick index back to price
   */
  fromTick(tick: number): number {
    return tick * this.tick;
  }

  /**
   * Infer tick size from price data
   */
  inferTickSize(prices: number[]): number {
    if (prices.length < 2) return 0.25; // Default for NQ
    
    const diffs = [];
    for (let i = 1; i < Math.min(prices.length, 100); i++) {
      const diff = Math.abs(prices[i] - prices[i-1]);
      if (diff > 0) diffs.push(diff);
    }
    
    if (diffs.length === 0) return 0.25;
    
    // Find GCD of differences to determine tick
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    let result = diffs[0];
    for (let i = 1; i < diffs.length; i++) {
      result = gcd(result, diffs[i]);
    }
    
    // Round to reasonable precision
    return Math.round(result * 100) / 100 || 0.25;
  }

  /**
   * Create centered price ladder (20 levels up/down from mid)
   */
  createTickLadder(
    orderbook: ParsedOrderBook, 
    trades: Trade[], 
    previousTimestamp?: Date
  ): TickLadder {
    // Calculate mid price
    const bestBid = orderbook.bidPrices.length > 0 ? Math.max(...orderbook.bidPrices) : 0;
    const bestAsk = orderbook.askPrices.length > 0 ? Math.min(...orderbook.askPrices) : 0;
    
    let midPrice = 0;
    if (bestBid > 0 && bestAsk > 0) {
      midPrice = (bestBid + bestAsk) / 2;
    } else if (bestBid > 0) {
      midPrice = bestBid;
    } else if (bestAsk > 0) {
      midPrice = bestAsk;
    } else {
      midPrice = 19300; // Fallback
    }
    
    const midTick = this.toTick(midPrice);
    
    // Create bid and ask maps by tick
    const bidMap = new Map<number, number>();
    const askMap = new Map<number, number>();
    
    // Populate bid map
    for (let i = 0; i < orderbook.bidPrices.length; i++) {
      const tick = this.toTick(orderbook.bidPrices[i]);
      bidMap.set(tick, orderbook.bidSizes[i]);
    }
    
    // Populate ask map
    for (let i = 0; i < orderbook.askPrices.length; i++) {
      const tick = this.toTick(orderbook.askPrices[i]);
      askMap.set(tick, orderbook.askSizes[i]);
    }
    
    // Calculate trade sizes for current window
    const sizeMap = new Map<number, number>();
    if (previousTimestamp) {
      const windowTrades = trades.filter(t => 
        t.timestamp > previousTimestamp && t.timestamp <= orderbook.timestamp
      );
      
      for (const trade of windowTrades) {
        const tick = this.toTick(trade.price);
        sizeMap.set(tick, (sizeMap.get(tick) || 0) + trade.size);
      }
    }
    
    // Update cumulative volume
    for (const trade of trades) {
      if (trade.timestamp <= orderbook.timestamp) {
        const tick = this.toTick(trade.price);
        this.volumeByTick.set(tick, (this.volumeByTick.get(tick) || 0) + trade.size);
      }
    }
    
    // Generate 41 levels (20 up, center, 20 down) - REVERSED ORDER: high prices first
    const levels: TickLevel[] = [];
    for (let i = 20; i >= -20; i--) { // REVERSED: start from +20 down to -20
      const tick = midTick + i;
      const price = this.fromTick(tick);
      
      levels.push({
        tick,
        price,
        bidSize: bidMap.get(tick) || 0,
        askSize: askMap.get(tick) || 0,
        sizeWindow: sizeMap.get(tick) || 0,
        volumeCumulative: this.volumeByTick.get(tick) || 0
      });
    }
    
    return { midTick, levels };
  }

  /**
   * Reset cumulative volume (for new files)
   */
  resetVolume(): void {
    this.volumeByTick.clear();
  }

  /**
   * Get current tick size
   */
  getTickSize(): number {
    return this.tick;
  }

  /**
   * Set tick size
   */
  setTickSize(tickSize: number): void {
    this.tick = tickSize;
    this.resetVolume(); // Reset volume when tick changes
  }
}