import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import { OrderBookProcessor, ParsedOrderBook, Trade as OrderBookTrade, TickLadder } from '@/lib/orderbook';
import { Order, PositionPnL, initPnl, executeMarket, placeLimit, processTradeWindow, markToMarket } from '@/lib/engine';

interface MarketEvent {
  timestamp: number;
  eventType: 'TRADE' | 'BBO' | 'ORDERBOOK';
  tradePrice?: number;
  tradeSize?: number;
  aggressor?: 'BUY' | 'SELL';
  bidPrice?: number;
  bidSize?: number;
  askPrice?: number;
  askSize?: number;
  bookBidPrices?: number[];
  bookBidSizes?: number[];
  bookAskPrices?: number[];
  bookAskSizes?: number[];
}

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
  aggregatedCount?: number;
}

export function useTradingEngine() {
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  
  // Order execution state
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<PositionPnL>(initPnl());
  const [originTick, setOriginTick] = useState<number>(0);
  
  // Order book processing
  const [orderBookSnapshots, setOrderBookSnapshots] = useState<ParsedOrderBook[]>([]);
  const [trades, setTrades] = useState<OrderBookTrade[]>([]);
  const [currentTickLadder, setCurrentTickLadder] = useState<TickLadder | null>(null);
  const [orderBookProcessor] = useState(() => new OrderBookProcessor(0.25));
  const [currentFrame, setCurrentFrame] = useState(0);

  const playbackTimerRef = useRef<NodeJS.Timeout>();

  // Utility functions for CSV parsing
  const parseTimestamp = (row: any): number => {
    const timestampFields = ['ts_exch_utc', 'ts_exch_madrid', 'ts_utc', 'ts_madrid'];
    
    for (const field of timestampFields) {
      if (row[field]) {
        const ts = new Date(row[field]).getTime();
        if (!isNaN(ts)) return ts;
      }
    }
    
    if (row.ssboe && row.usecs) {
      const ssboe = parseInt(row.ssboe);
      const usecs = parseInt(row.usecs);
      if (!isNaN(ssboe) && !isNaN(usecs)) {
        return ssboe * 1000 + Math.floor(usecs / 1000);
      }
    }
    
    return Date.now();
  };

  const parseArrayField = (value: string): number[] => {
    if (!value || value === '[]' || value === '') return [];
    
    try {
      if (value.startsWith('[') && value.endsWith(']')) {
        const jsonResult = JSON.parse(value);
        if (Array.isArray(jsonResult)) {
          return jsonResult.map(v => parseFloat(v)).filter(v => !isNaN(v));
        }
      }
    } catch (e) {
      // JSON failed, try NumPy format
    }
    
    const cleaned = value.replace(/^\[|\]$/g, '').trim();
    if (!cleaned) return [];
    
    return cleaned
      .split(/[\s,]+/)
      .map(v => v.trim())
      .filter(v => v.length > 0)
      .map(v => parseFloat(v))
      .filter(v => !isNaN(v));
  };

  const normalizeEventType = (eventType: string): string => {
    return eventType?.toString().toUpperCase().trim() || '';
  };

  const normalizeAggressor = (aggressor: string): 'BUY' | 'SELL' | undefined => {
    const normalized = aggressor?.toString().toUpperCase().trim();
    if (normalized === 'BUY' || normalized === 'B') return 'BUY';
    if (normalized === 'SELL' || normalized === 'S') return 'SELL';
    return undefined;
  };

  // Get current price from latest trade or mid price
  const getCurrentPrice = useCallback(() => {
    if (currentPrice > 0) return currentPrice;
    
    if (orderBookSnapshots.length > 0 && currentFrame < orderBookSnapshots.length) {
      const snapshot = orderBookSnapshots[currentFrame];
      const bestBid = snapshot.bidPrices.length > 0 ? Math.max(...snapshot.bidPrices) : 0;
      const bestAsk = snapshot.askPrices.length > 0 ? Math.min(...snapshot.askPrices) : 0;
      
      if (bestBid > 0 && bestAsk > 0) {
        return (bestBid + bestAsk) / 2;
      } else if (bestBid > 0) {
        return bestBid;
      } else if (bestAsk > 0) {
        return bestAsk;
      }
    }
    
    return 19300; // Fallback
  }, [currentPrice, orderBookSnapshots, currentFrame]);

  // Get current ladder data
  const currentLadder = useMemo(() => {
    if (!orderBookSnapshots.length || !trades.length) return null;
    
    const currentIndex = Math.max(0, Math.min(currentFrame, orderBookSnapshots.length - 1));
    const snapshot = orderBookSnapshots[currentIndex];
    
    const previousTimestamp = currentIndex > 0 ? orderBookSnapshots[currentIndex - 1].timestamp : new Date(0);
    
    const ladder = orderBookProcessor.createTickLadder(snapshot, trades, previousTimestamp);
    
    // Set origin tick from first ladder if not set
    if (originTick === 0 && ladder) {
      setOriginTick(ladder.midTick);
    }
    
    return ladder;
  }, [orderBookSnapshots, trades, currentFrame, orderBookProcessor, originTick]);

  // Process new frame for order execution
  useEffect(() => {
    if (!isPlaying || !orderBookSnapshots.length || !trades.length) return;

    const currentIndex = Math.max(0, Math.min(currentFrame, orderBookSnapshots.length - 1));
    const previousTimestamp = currentIndex > 0 ? orderBookSnapshots[currentIndex - 1].timestamp : new Date(0);
    const currentTimestamp = orderBookSnapshots[currentIndex].timestamp;

    // Process trades in current window
    processTradeWindow(
      trades,
      previousTimestamp,
      currentTimestamp,
      0.25, // tick size
      orders.filter(o => o.status === 'WORKING' || o.status === 'PARTIAL'),
      position,
      (price: number) => Math.round(price / 0.25)
    );
    
    // Update unrealized PnL with current price
    const currentPrice = getCurrentPrice();
    if (currentPrice > 0) {
      markToMarket(position, currentPrice);
      setCurrentPrice(currentPrice);
    }
  }, [currentFrame, isPlaying, orderBookSnapshots, trades, orders, position, getCurrentPrice]);

  // Handle limit orders
  const handleLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    if (!orderBookSnapshots.length || !currentLadder) {
      console.warn('No current snapshot for limit order');
      return;
    }

    const currentSnapshot = orderBookSnapshots[Math.min(currentFrame, orderBookSnapshots.length - 1)];
    
    const newOrder = placeLimit(
      side,
      price,
      quantity,
      currentSnapshot,
      0.25,
      (price: number) => Math.round(price / 0.25)
    );
    
    setOrders(prev => [...prev, newOrder]);
    console.log(`📝 Placed ${side} limit order: ${quantity} @ ${price.toFixed(2)}`);
  }, [orderBookSnapshots, currentFrame, currentLadder]);

  // Handle market orders
  const handleMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    if (!orderBookSnapshots.length) {
      console.warn('No current snapshot for market order');
      return;
    }

    const currentSnapshot = orderBookSnapshots[Math.min(currentFrame, orderBookSnapshots.length - 1)];
    executeMarket(side, quantity, currentSnapshot, position);
    console.log(`🎯 Market ${side} order executed: ${quantity} contracts`);
  }, [orderBookSnapshots, currentFrame, position]);

  // Handle order cancellation
  const handleCancelOrders = useCallback((price: number) => {
    const tickIndex = Math.round(price / 0.25);
    setOrders(prev => prev.map(order => {
      if (order.tickIndex === tickIndex && (order.status === 'WORKING' || order.status === 'PARTIAL')) {
        console.log(`❌ Canceled order: ${order.id}`);
        return { ...order, status: 'CANCELED' };
      }
      return order;
    }));
  }, []);

  // Load market data from file
  const loadMarketData = useCallback((file: File) => {
    console.log('🚀 Loading file:', file.name);
    
    // Reset states
    setMarketData([]);
    setCurrentEventIndex(0);
    setCurrentFrame(0);
    setIsPlaying(false);
    setOrderBookSnapshots([]);
    setTrades([]);
    setCurrentTickLadder(null);
    setOrders([]);
    setPosition(initPnl());
    setOriginTick(0);
    orderBookProcessor.resetVolume();
    
    const reader = new FileReader();
    
    reader.onload = (event) => {
      const text = event.target?.result as string;
      
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          console.log('CSV parsing complete, rows:', results.data.length);
          
          if (!results.data || results.data.length === 0) {
            console.error('❌ No data found in CSV file!');
            return;
          }
          
          const rawEvents: Array<MarketEvent & { sortOrder: number }> = [];
          const orderbookSnapshots: ParsedOrderBook[] = [];
          const tradeEvents: OrderBookTrade[] = [];
          
          results.data.forEach((row: any, index) => {
            if (!row || Object.keys(row).length === 0) return;
            
            const timestamp = parseTimestamp(row);
            const eventType = normalizeEventType(row.event_type);
            
            let sortOrder = 0;
            if (eventType === 'ORDERBOOK' || eventType === 'ORDERBOOK_FULL') sortOrder = 0;
            else if (eventType === 'BBO') sortOrder = 1;
            else if (eventType === 'TRADE') sortOrder = 2;
            
            // Handle TRADE events
            if (eventType === 'TRADE') {
              const price = parseFloat(row.trade_price);
              const size = parseFloat(row.trade_size);
              const aggressor = normalizeAggressor(row.aggressor);
              
              if (!isNaN(price) && price > 0 && !isNaN(size) && size > 0 && aggressor) {
                const trade = orderBookProcessor.parseTrade(row);
                if (trade) {
                  tradeEvents.push(trade);
                }
                
                rawEvents.push({
                  timestamp,
                  sortOrder,
                  eventType: 'TRADE',
                  tradePrice: price,
                  tradeSize: size,
                  aggressor
                });
              }
            }
            
            // Handle ORDERBOOK events
            else if (eventType === 'ORDERBOOK' || eventType === 'ORDERBOOK_FULL') {
              const bidPrices = parseArrayField(row.book_bid_prices);
              const bidSizes = parseArrayField(row.book_bid_sizes);
              const askPrices = parseArrayField(row.book_ask_prices);
              const askSizes = parseArrayField(row.book_ask_sizes);
              
              if (bidPrices.length > 0 || askPrices.length > 0) {
                const snapshot = orderBookProcessor.parseOrderBookSnapshot(row);
                if (snapshot) {
                  orderbookSnapshots.push(snapshot);
                }
                
                rawEvents.push({
                  timestamp,
                  sortOrder,
                  eventType: 'ORDERBOOK',
                  bookBidPrices: bidPrices,
                  bookAskPrices: askPrices,
                  bookBidSizes: bidSizes,
                  bookAskSizes: askSizes
                });
              }
            }
          });
          
          // Sort events by timestamp
          rawEvents.sort((a, b) => {
            if (a.timestamp !== b.timestamp) {
              return a.timestamp - b.timestamp;
            }
            return a.sortOrder - b.sortOrder;
          });
          
          const events: MarketEvent[] = rawEvents.map(({ sortOrder, ...event }) => event);
          
          // Sort snapshots and trades by timestamp
          orderbookSnapshots.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          tradeEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          
          console.log('Generated', events.length, 'events,', orderbookSnapshots.length, 'snapshots,', tradeEvents.length, 'trades');
          
          setMarketData(events);
          setOrderBookSnapshots(orderbookSnapshots);
          setTrades(tradeEvents);
          
          // Set initial price
          const firstTrade = tradeEvents[0];
          if (firstTrade) {
            setCurrentPrice(firstTrade.price);
          } else if (orderbookSnapshots.length > 0) {
            const firstSnapshot = orderbookSnapshots[0];
            const bestBid = firstSnapshot.bidPrices[0] || 0;
            const bestAsk = firstSnapshot.askPrices[0] || 0;
            setCurrentPrice(bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 19300));
          }
          
          console.log('✅ Import completed successfully!');
        }
      });
    };
    
    reader.readAsText(file, 'UTF-8');
  }, [orderBookProcessor]);

  // Playback control
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => !prev);
  }, []);

  // Playback timer with frame-based progression
  useEffect(() => {
    if (isPlaying && currentFrame < orderBookSnapshots.length - 1) {
      const delay = 100 / playbackSpeed; // Base delay of 100ms, adjusted by speed
      
      playbackTimerRef.current = setTimeout(() => {
        setCurrentFrame(prev => prev + 1);
      }, delay);
    } else if (isPlaying && currentFrame >= orderBookSnapshots.length - 1) {
      setIsPlaying(false); // Stop at end
    }
    
    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
      }
    };
  }, [isPlaying, currentFrame, orderBookSnapshots.length, playbackSpeed]);

  return {
    // Market data
    marketData,
    currentLadder,
    currentPrice: getCurrentPrice(),
    orders: orders.filter(o => o.status === 'WORKING' || o.status === 'PARTIAL'),
    position,
    originTick,
    
    // Playback
    isPlaying,
    playbackSpeed,
    timeAndSales,
    
    // Actions
    loadMarketData,
    togglePlayback,
    setPlaybackSpeed,
    handleLimitOrder,
    handleMarketOrder,
    handleCancelOrders,
    
    // Legacy compatibility
    orderBook: [],
    currentOrderBookData: null,
    pnl: {
      unrealized: position.unreal,
      realized: position.realized,
      total: position.realized + position.unreal
    },
    placeLimitOrder: handleLimitOrder,
    placeMarketOrder: handleMarketOrder,
    cancelOrdersAtPrice: handleCancelOrders
  };
}