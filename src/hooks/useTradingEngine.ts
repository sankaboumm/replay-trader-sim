import { useState, useCallback, useRef, useEffect } from 'react';
import Papa from 'papaparse';

interface MarketEvent {
  timestamp: number;
  eventType: 'TRADE' | 'BBO' | 'ORDERBOOK' | 'ORDERBOOK_FULL';
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

interface OrderBookSnapshot {
  bidMap: Map<number, number>; // tickIndex -> size
  askMap: Map<number, number>; // tickIndex -> size
  timestamp: string;
  midPrice: number;
}

interface TradeAggregation {
  tickIndex: number;
  totalSize: number;
}

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
  aggregatedCount?: number;
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  volume?: number; // Volume traded at this price level
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled: number;
  timestamp: number;
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
}

interface PnL {
  unrealized: number;
  realized: number;
  total: number;
}

export function useTradingEngine() {
  const [marketData, setMarketData] = useState<MarketEvent[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [orderBook, setOrderBook] = useState<OrderBookLevel[]>([]);
  const [currentOrderBookData, setCurrentOrderBookData] = useState<{
    book_bid_prices: number[];
    book_ask_prices: number[];
    book_bid_sizes: number[];
    book_ask_sizes: number[];
    book_bid_orders?: number[];
    book_ask_orders?: number[];
  } | null>(null);
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
  const [aggregationBuffer, setAggregationBuffer] = useState<{
    trades: Trade[];
    lastTimestamp: number;
    key: { price: number; aggressor: 'BUY' | 'SELL' };
  } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<Position>({
    symbol: 'DEMO',
    quantity: 0,
    averagePrice: 0,
    marketPrice: 0
  });
  const [pnl, setPnl] = useState<PnL>({
    unrealized: 0,
    realized: 0,
    total: 0
  });
  const [realizedPnLTotal, setRealizedPnLTotal] = useState(0);
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());
  
  // Constants for P&L calculation
  const TICK_SIZE = 0.25;
  const TICK_VALUE = 5.0; // Each tick of 0.25 is worth 5$
  const AGGREGATION_WINDOW_MS = 5;

  // Tick-based indexing helpers
  const toTick = useCallback((price: number): number => {
    return Math.round(price / TICK_SIZE);
  }, []);

  const fromTick = useCallback((tickIndex: number): number => {
    return tickIndex * TICK_SIZE;
  }, []);

  // Orderbook snapshot processing state
  const [orderbookSnapshots, setOrderbookSnapshots] = useState<OrderBookSnapshot[]>([]);
  const [trades, setTrades] = useState<MarketEvent[]>([]);
  const [currentSnapshotIndex, setCurrentSnapshotIndex] = useState(0);
  const [cumulativeVolumeByTick, setCumulativeVolumeByTick] = useState<Map<number, number>>(new Map());

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // Utility functions for CSV parsing
  const parseTimestamp = (row: any): number => {
    // Priority order: ts_exch_utc > ts_exch_madrid > ts_utc/madrid > ssboe+usecs
    const timestampFields = [
      'ts_exch_utc',
      'ts_exch_madrid', 
      'ts_utc',
      'ts_madrid'
    ];
    
    for (const field of timestampFields) {
      if (row[field]) {
        const ts = new Date(row[field]).getTime();
        if (!isNaN(ts)) return ts;
      }
    }
    
    // Fallback: combine ssboe + usecs
    if (row.ssboe && row.usecs) {
      const ssboe = parseInt(row.ssboe);
      const usecs = parseInt(row.usecs);
      if (!isNaN(ssboe) && !isNaN(usecs)) {
        return ssboe * 1000 + Math.floor(usecs / 1000);
      }
    }
    
    // Ultimate fallback
    return Date.now();
  };

  const parseArrayField = (value: string): number[] => {
    if (!value || value === '[]' || value === '') return [];
    
    try {
      // Try JSON first
      if (value.startsWith('[') && value.endsWith(']')) {
        return JSON.parse(value).map((v: any) => parseFloat(v)).filter((v: number) => !isNaN(v));
      }
      
      // Try pipe or semicolon separated
      const separators = ['|', ';', ','];
      for (const sep of separators) {
        if (value.includes(sep)) {
          return value.split(sep)
            .map(v => parseFloat(v.trim()))
            .filter(v => !isNaN(v));
        }
      }
      
      // Single value
      const single = parseFloat(value);
      return isNaN(single) ? [] : [single];
    } catch (e) {
      console.warn('Failed to parse array field:', value, e);
      return [];
    }
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

  const roundToGrid = (price: number): number => {
    // Round to nearest 0.25 (half up)
    return Math.round(price * 4) / 4;
  };

  // Load market data from file
  const loadMarketData = useCallback((file: File) => {
    console.log('🚀 IMPORT STARTED - Loading file:', file.name, 'Type:', file.type, 'Size:', file.size);
    console.log('🚀 File object:', file);
    
    // Reset states
    setMarketData([]);
    setCurrentEventIndex(0);
    setIsPlaying(false);
    
    const reader = new FileReader();
    
    reader.onload = (event) => {
      const text = event.target?.result as string;
      console.log('File loaded, content preview:', text.substring(0, 200));
      console.log('File size in memory:', text.length, 'characters');
      
      // Parse with streaming support for large files
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (results) => {
          try {
            console.log('CSV parsing complete!');
            console.log('Total rows parsed:', results.data.length);
            console.log('Errors during parsing:', results.errors?.length || 0);
            console.log('First row sample:', results.data[0]);
            console.log('Available columns:', Object.keys(results.data[0] || {}));
            console.log('Looking for columns: book_bid_prices, book_ask_prices, book_bid_sizes, book_ask_sizes');
            
            if (results.errors?.length > 0) {
              console.error('CSV parsing errors:', results.errors.slice(0, 5)); // Show first 5 errors
            }
            
            if (!results.data || results.data.length === 0) {
              console.error('❌ No data found in CSV file!');
              return;
            }
            
            console.log('✅ Starting data processing...');
            const rawEvents: Array<MarketEvent & { sortOrder: number }> = [];
            const processedRows = new Set<string>(); // For deduplication
            
            console.log('✅ About to start forEach loop...');
            
            results.data.forEach((row: any, index) => {
              // Progress tracking for large files
              if (index % 1000 === 0) {
                console.log(`Processing row ${index}/${results.data.length} (${Math.round(index/results.data.length*100)}%)`);
              }
              
              // Skip empty rows
              if (!row || Object.keys(row).length === 0) {
                return;
              }
              
              // Deduplication check
              const rowKey = JSON.stringify(row);
              if (processedRows.has(rowKey)) {
                console.log('Skipping duplicate row:', index);
                return;
              }
              processedRows.add(rowKey);
              
              // Log first few rows for debugging
              if (index < 5 || index % 5000 === 0) {
                console.log(`Processing row ${index}:`, row);
              }
              
              // Extract and validate timestamp
              const timestamp = parseTimestamp(row);
              const eventType = normalizeEventType(row.event_type);
              
              console.log(`Row ${index}: event_type="${row.event_type}" -> normalized="${eventType}"`);
              
              // Log unique event types
              if (index < 50) {
                console.log(`Raw event_type: "${row.event_type}", Available columns:`, Object.keys(row).slice(0, 10));
              }
              let sortOrder = 0;
              if (eventType === 'ORDERBOOK') sortOrder = 0;
              else if (eventType === 'BBO') sortOrder = 1;
              else if (eventType === 'TRADE') sortOrder = 2;
              
              // Handle TRADE events
              if (eventType === 'TRADE') {
                const price = parseFloat(row.trade_price);
                const size = parseFloat(row.trade_size);
                const aggressor = normalizeAggressor(row.aggressor);
                
                // Validation: must have valid price, size, and aggressor
                if (isNaN(price) || price <= 0 || isNaN(size) || size <= 0 || !aggressor) {
                  console.log('Skipping invalid TRADE:', { price, size, aggressor });
                  return;
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
              
              // Handle BBO events
              else if (eventType === 'BBO') {
                const bidPrice = parseFloat(row.bid_price);
                const askPrice = parseFloat(row.ask_price);
                const bidSize = parseFloat(row.bid_size);
                const askSize = parseFloat(row.ask_size);
                
                // Validation: must have at least bid or ask
                const hasBid = !isNaN(bidPrice) && bidPrice > 0;
                const hasAsk = !isNaN(askPrice) && askPrice > 0;
                
                if (!hasBid && !hasAsk) {
                  console.log('Skipping incomplete BBO');
                  return;
                }
                
                rawEvents.push({
                  timestamp,
                  sortOrder,
                  eventType: 'BBO',
                  bidPrice: hasBid ? bidPrice : undefined,
                  askPrice: hasAsk ? askPrice : undefined,
                  bidSize: hasBid && !isNaN(bidSize) ? bidSize : undefined,
                  askSize: hasAsk && !isNaN(askSize) ? askSize : undefined
                });
              }
              
              // Handle ORDERBOOK events (including ORDERBOOK_FULL)
              else if (eventType === 'ORDERBOOK' || eventType === 'ORDERBOOK_FULL') {
                console.log(`🔍 Found ${eventType} event at row ${index}`);
                console.log('🔍 Raw book data:', {
                  book_bid_prices: row.book_bid_prices?.substring(0, 50),
                  book_bid_sizes: row.book_bid_sizes?.substring(0, 50),
                  book_ask_prices: row.book_ask_prices?.substring(0, 50),
                  book_ask_sizes: row.book_ask_sizes?.substring(0, 50)
                });
                
                const bidPrices = parseArrayField(row.book_bid_prices);
                const bidSizes = parseArrayField(row.book_bid_sizes);
                const bidOrders = parseArrayField(row.book_bid_orders);
                const askPrices = parseArrayField(row.book_ask_prices);
                const askSizes = parseArrayField(row.book_ask_sizes);
                const askOrders = parseArrayField(row.book_ask_orders);
                
                console.log('🔍 Parsed arrays:', {
                  bidPrices: bidPrices.length,
                  bidSizes: bidSizes.length,
                  askPrices: askPrices.length,
                  askSizes: askSizes.length
                });
                
                // Validation: arrays must have consistent lengths
                const bidValid = bidPrices.length === bidSizes.length && 
                                (bidOrders.length === 0 || bidOrders.length === bidPrices.length);
                const askValid = askPrices.length === askSizes.length && 
                                (askOrders.length === 0 || askOrders.length === askPrices.length);
                
                if (!bidValid || !askValid) {
                  console.log('❌ Skipping ORDERBOOK with inconsistent arrays:', {
                    bidPrices: bidPrices.length,
                    bidSizes: bidSizes.length,
                    bidOrders: bidOrders.length,
                    askPrices: askPrices.length,
                    askSizes: askSizes.length,
                    askOrders: askOrders.length
                  });
                  return;
                }
                
                // Must have at least some data
                if (bidPrices.length === 0 && askPrices.length === 0) {
                  console.log('❌ Skipping empty ORDERBOOK');
                  return;
                }
                
                console.log('✅ Adding ORDERBOOK event with', bidPrices.length, 'bids and', askPrices.length, 'asks');
                
                rawEvents.push({
                  timestamp,
                  sortOrder,
                  eventType: eventType === 'ORDERBOOK_FULL' ? 'ORDERBOOK' : 'ORDERBOOK', // Normalize to ORDERBOOK
                  bookBidPrices: bidPrices,
                  bookAskPrices: askPrices,
                  bookBidSizes: bidSizes,
                  bookAskSizes: askSizes
                });
              }
              
              // Fallback: legacy format with level-based columns
              else if (!eventType && (row.bid_price_L1 || row.ask_price_L1)) {
                const bidPrices: number[] = [];
                const askPrices: number[] = [];
                const bidSizes: number[] = [];
                const askSizes: number[] = [];
                
                // Extract up to 10 levels
                for (let i = 1; i <= 10; i++) {
                  const bidPrice = parseFloat(row[`bid_price_L${i}`]);
                  const askPrice = parseFloat(row[`ask_price_L${i}`]);
                  const bidSize = parseFloat(row[`bid_size_L${i}`]);
                  const askSize = parseFloat(row[`ask_size_L${i}`]);
                  
                  if (!isNaN(bidPrice) && bidPrice > 0) {
                    bidPrices.push(bidPrice);
                    bidSizes.push(isNaN(bidSize) ? 0 : bidSize);
                  }
                  if (!isNaN(askPrice) && askPrice > 0) {
                    askPrices.push(askPrice);
                    askSizes.push(isNaN(askSize) ? 0 : askSize);
                  }
                }
                
                if (bidPrices.length > 0 || askPrices.length > 0) {
                  rawEvents.push({
                    timestamp,
                    sortOrder: 0, // Treat as ORDERBOOK
                    eventType: 'ORDERBOOK',
                    bookBidPrices: bidPrices,
                    bookAskPrices: askPrices,
                    bookBidSizes: bidSizes,
                    bookAskSizes: askSizes
                  });
                }
              }
            });
            
            console.log('✅ forEach loop completed');
            
            // Sort by timestamp, then by sortOrder for intra-timestamp ordering
            rawEvents.sort((a, b) => {
              if (a.timestamp !== b.timestamp) {
                return a.timestamp - b.timestamp;
              }
              return a.sortOrder - b.sortOrder;
            });
            
            console.log('✅ Sorting completed');
            
            // Remove sortOrder property and create final events array
            const events: MarketEvent[] = rawEvents.map(({ sortOrder, ...event }) => event);
            
            console.log('Generated', events.length, 'market events after validation and sorting');
            console.log('Event types:', events.reduce((acc, e) => {
              acc[e.eventType] = (acc[e.eventType] || 0) + 1;
              return acc;
            }, {} as Record<string, number>));
            
            setMarketData(events);
            setCurrentEventIndex(0);
            setTimeAndSales([]);
            
            // Set initial price from first valid price in data
            let initialPrice = 19300; // fallback
            
            // Find first valid trade price
            const firstTrade = events.find(e => e.eventType === 'TRADE' && e.tradePrice && e.tradePrice > 0);
            if (firstTrade && firstTrade.tradePrice) {
              initialPrice = firstTrade.tradePrice;
            } else {
              // Find first valid orderbook or BBO price
              const firstPriceEvent = events.find(e => 
                (e.eventType === 'ORDERBOOK' && 
                 ((e.bookBidPrices && e.bookBidPrices.length > 0) || 
                  (e.bookAskPrices && e.bookAskPrices.length > 0))) ||
                (e.eventType === 'BBO' && (e.bidPrice || e.askPrice))
              );
              
              if (firstPriceEvent) {
                if (firstPriceEvent.eventType === 'ORDERBOOK') {
                  const orderbook = firstPriceEvent;
                  if (orderbook.bookBidPrices && orderbook.bookBidPrices.length > 0) {
                    initialPrice = orderbook.bookBidPrices[0];
                  } else if (orderbook.bookAskPrices && orderbook.bookAskPrices.length > 0) {
                    initialPrice = orderbook.bookAskPrices[0];
                  }
                } else if (firstPriceEvent.eventType === 'BBO') {
                  initialPrice = firstPriceEvent.bidPrice || firstPriceEvent.askPrice || initialPrice;
                }
              }
            }
            
            console.log('Setting initial price to:', initialPrice);
            setCurrentPrice(initialPrice);
            console.log('Setting marketData with', events.length, 'events...');
            setMarketData(events);
            console.log('✅ Import completed successfully! MarketData should now have', events.length, 'events');
            
            // Process data for the new ladder system
            console.log('🚀 About to call processDataForLadder...');
            processDataForLadder(events);
            console.log('🚀 processDataForLadder completed');
            
          } catch (error) {
            console.error('🔥 Error in CSV complete handler:', error);
            console.error('🔥 Error stack:', error.stack);
            throw error;
          }
        }
      });
    };
    
    reader.readAsText(file, 'UTF-8');
  }, []);

  // Process data for ladder according to specifications
  const processDataForLadder = useCallback((events: MarketEvent[]) => {
    console.log('📊 Processing data for ladder system...');
    
    // 3.1 Filter events by type
    const snapshots = events.filter(e => e.eventType === 'ORDERBOOK');
    const tradesData = events.filter(e => e.eventType === 'TRADE');
    
    console.log(`Found ${snapshots.length} snapshots and ${tradesData.length} trades`);
    console.log('First few events:', events.slice(0, 5).map(e => e.eventType));
    console.log('All event types in data:', [...new Set(events.map(e => e.eventType))]);
    
    if (snapshots.length === 0) {
      console.log('❌ No ORDERBOOK events found! Checking for ORDERBOOK_FULL...');
      const orderbookFullEvents = events.filter(e => e.eventType === 'ORDERBOOK_FULL');
      console.log('ORDERBOOK_FULL events:', orderbookFullEvents.length);
    }
    
    // Sort by timestamp
    snapshots.sort((a, b) => a.timestamp - b.timestamp);
    tradesData.sort((a, b) => a.timestamp - b.timestamp);
    
    // Process snapshots into tick-indexed format
    const processedSnapshots: OrderBookSnapshot[] = snapshots.map((snapshot, index) => {
      const bidMap = new Map<number, number>();
      const askMap = new Map<number, number>();
      
      // Process bid side
      if (snapshot.bookBidPrices && snapshot.bookBidSizes) {
        for (let i = 0; i < snapshot.bookBidPrices.length; i++) {
          const price = snapshot.bookBidPrices[i];
          const size = snapshot.bookBidSizes[i];
          if (price > 0 && size > 0) {
            const tickIndex = toTick(price);
            bidMap.set(tickIndex, size);
          }
        }
      }
      
      // Process ask side
      if (snapshot.bookAskPrices && snapshot.bookAskSizes) {
        for (let i = 0; i < snapshot.bookAskPrices.length; i++) {
          const price = snapshot.bookAskPrices[i];
          const size = snapshot.bookAskSizes[i];
          if (price > 0 && size > 0) {
            const tickIndex = toTick(price);
            askMap.set(tickIndex, size);
          }
        }
      }
      
      // Calculate mid price
      let midPrice = 0;
      const bestBid = snapshot.bookBidPrices?.[0] || 0;
      const bestAsk = snapshot.bookAskPrices?.[0] || 0;
      if (bestBid > 0 && bestAsk > 0) {
        midPrice = (bestBid + bestAsk) / 2;
      }
      
      return {
        bidMap,
        askMap,
        timestamp: snapshot.timestamp.toString(),
        midPrice
      };
    });
    
    setOrderbookSnapshots(processedSnapshots);
    setTrades(tradesData);
    
    console.log('✅ Ladder data processing complete');
  }, [toTick]);

  // Process market event
  // Flush aggregation buffer to Time & Sales
  const flushAggregationBuffer = useCallback(() => {
    setAggregationBuffer(prev => {
      if (!prev || prev.trades.length === 0) return null;
      
      const aggregatedTrade: Trade = {
        id: `agg-${Date.now()}-${Math.random()}`,
        timestamp: prev.trades[prev.trades.length - 1].timestamp, // Last trade timestamp
        price: prev.key.price,
        size: prev.trades.reduce((sum, trade) => sum + trade.size, 0),
        aggressor: prev.key.aggressor,
        aggregatedCount: prev.trades.length
      };
      
      setTimeAndSales(prevTAS => [aggregatedTrade, ...prevTAS.slice(0, 99)]);
      return null;
    });
  }, []);

  const processEvent = useCallback((event: MarketEvent) => {
    switch (event.eventType) {
      case 'TRADE':
        if (event.tradePrice && event.tradeSize && event.aggressor) {
          const trade: Trade = {
            id: `trade-${Date.now()}-${Math.random()}`,
            timestamp: event.timestamp,
            price: event.tradePrice,
            size: event.tradeSize,
            aggressor: event.aggressor
          };
          
          // Handle aggregation for Time & Sales
          setAggregationBuffer(prev => {
            const currentKey = { price: event.tradePrice!, aggressor: event.aggressor! };
            
            // Check if we should aggregate
            const shouldAggregate = prev && 
              prev.key.price === currentKey.price &&
              prev.key.aggressor === currentKey.aggressor &&
              (event.timestamp - prev.lastTimestamp) <= AGGREGATION_WINDOW_MS;
            
            if (shouldAggregate) {
              // Add to current buffer
              return {
                trades: [...prev.trades, trade],
                lastTimestamp: event.timestamp,
                key: currentKey
              };
            } else {
              // Flush previous buffer if exists
              if (prev && prev.trades.length > 0) {
                const aggregatedTrade: Trade = {
                  id: `agg-${Date.now()}-${Math.random()}`,
                  timestamp: prev.trades[prev.trades.length - 1].timestamp,
                  price: prev.key.price,
                  size: prev.trades.reduce((sum, t) => sum + t.size, 0),
                  aggressor: prev.key.aggressor,
                  aggregatedCount: prev.trades.length
                };
                
                setTimeAndSales(prevTAS => [aggregatedTrade, ...prevTAS.slice(0, 99)]);
              }
              
              // Start new buffer
              return {
                trades: [trade],
                lastTimestamp: event.timestamp,
                key: currentKey
              };
            }
          });
          
          // Update current price (last)
          setCurrentPrice(event.tradePrice);
          
          // Update volume by price on grid (rounded to 0.25)
          const gridPrice = roundToGrid(event.tradePrice);
          setVolumeByPrice(prev => {
            const newMap = new Map(prev);
            const currentVolume = newMap.get(gridPrice) || 0;
            newMap.set(gridPrice, currentVolume + event.tradeSize);
            return newMap;
          });
          
          // Update orderbook to reflect trade volume
          setOrderBook(prev => {
            return prev.map(level => {
              if (Math.abs(level.price - gridPrice) < 0.125) {
                return {
                  ...level,
                  volume: (level.volume || 0) + event.tradeSize
                };
              }
              return level;
            });
          });
          
          // Check for order fills (existing logic preserved)
          setOrders(prevOrders => {
            return prevOrders.map(order => {
              if (order.filled >= order.quantity) return order;
              
              const shouldFill = (
                (order.side === 'BUY' && event.tradePrice! <= order.price) ||
                (order.side === 'SELL' && event.tradePrice! >= order.price)
              );
              
              if (shouldFill) {
                const fillSize = Math.min(order.quantity - order.filled, event.tradeSize!);
                return { ...order, filled: order.filled + fillSize };
              }
              
              return order;
            });
          });
        }
        break;
        
      case 'BBO':
        // BBO only updates Top of Book - does NOT affect last price or volume
        if (event.bidPrice || event.askPrice) {
          // Generate simulated 20-level orderbook from BBO data
          if (event.bidPrice && event.askPrice) {
            const midPrice = (event.bidPrice + event.askPrice) / 2;
            const bid_prices: number[] = [];
            const ask_prices: number[] = [];
            const bid_sizes: number[] = [];
            const ask_sizes: number[] = [];
            
            // Generate 20 levels around current BBO
            for (let i = 0; i < 20; i++) {
              bid_prices.push(event.bidPrice - (i * TICK_SIZE));
              ask_prices.push(event.askPrice + (i * TICK_SIZE));
              bid_sizes.push(Math.max(1, (event.bidSize || 1) - Math.floor(i / 3)));
              ask_sizes.push(Math.max(1, (event.askSize || 1) - Math.floor(i / 3)));
            }
            
            setCurrentOrderBookData({
              book_bid_prices: bid_prices,
              book_ask_prices: ask_prices,
              book_bid_sizes: bid_sizes,
              book_ask_sizes: ask_sizes
            });
            
            console.log('✅ Generated 20-level orderbook from BBO');
          }
          
          setOrderBook(prev => {
            const newBook = [...prev];
            
            // Update or add bid level
            if (event.bidPrice && event.bidPrice > 0) {
              const gridBidPrice = roundToGrid(event.bidPrice);
              const bidIndex = newBook.findIndex(level => Math.abs(level.price - gridBidPrice) < 0.125);
              
              if (bidIndex >= 0) {
                newBook[bidIndex] = { 
                  ...newBook[bidIndex], 
                  bidSize: event.bidSize || 0 
                };
              } else {
                newBook.push({
                  price: gridBidPrice,
                  bidSize: event.bidSize || 0,
                  askSize: 0,
                  volume: 0
                });
              }
            }
            
            // Update or add ask level
            if (event.askPrice && event.askPrice > 0) {
              const gridAskPrice = roundToGrid(event.askPrice);
              const askIndex = newBook.findIndex(level => Math.abs(level.price - gridAskPrice) < 0.125);
              
              if (askIndex >= 0) {
                newBook[askIndex] = { 
                  ...newBook[askIndex], 
                  askSize: event.askSize || 0 
                };
              } else {
                newBook.push({
                  price: gridAskPrice,
                  bidSize: 0,
                  askSize: event.askSize || 0,
                  volume: 0
                });
              }
            }
            
            // Sort by price (descending for proper display)
            newBook.sort((a, b) => b.price - a.price);
            
            return newBook;
          });
        }
        break;
        
      case 'ORDERBOOK':
        // ORDERBOOK replaces the complete L2 depth (snapshot)
        console.log('Processing ORDERBOOK event:', event);
        if (event.bookBidPrices || event.bookAskPrices) {
          console.log('ORDERBOOK - bookBidPrices:', event.bookBidPrices?.slice(0, 5));
          console.log('ORDERBOOK - bookAskPrices:', event.bookAskPrices?.slice(0, 5));
          console.log('ORDERBOOK - bookBidSizes:', event.bookBidSizes?.slice(0, 5));
          console.log('ORDERBOOK - bookAskSizes:', event.bookAskSizes?.slice(0, 5));
          
          // Test avec des données simulées pour voir si le DOMladder fonctionne
          setCurrentOrderBookData({
            book_bid_prices: [23932, 23931.75, 23931.5, 23931.25, 23931],
            book_ask_prices: [23932.25, 23932.5, 23932.75, 23933, 23933.25],
            book_bid_sizes: [10, 15, 20, 25, 30],
            book_ask_sizes: [12, 18, 22, 28, 32]
          });
          console.log('✅ Simulated orderBookData set for testing');
          
          // Store the complete orderbook data (up to 20 levels)
          setCurrentOrderBookData({
            book_bid_prices: event.bookBidPrices?.slice(0, 20) || [],
            book_ask_prices: event.bookAskPrices?.slice(0, 20) || [],
            book_bid_sizes: event.bookBidSizes?.slice(0, 20) || [],
            book_ask_sizes: event.bookAskSizes?.slice(0, 20) || []
          });

          const newBook: OrderBookLevel[] = [];
          const priceMap = new Map<number, OrderBookLevel>();
          
          // Process bid prices (keep existing 10-level logic for backwards compatibility)
          if (event.bookBidPrices && event.bookBidSizes) {
            for (let i = 0; i < Math.min(event.bookBidPrices.length, 10); i++) {
              const bidPrice = event.bookBidPrices[i];
              const bidSize = event.bookBidSizes[i] || 0;
              
              if (bidPrice > 0 && bidSize > 0) {
                const gridPrice = roundToGrid(bidPrice);
                const existing = priceMap.get(gridPrice);
                
                if (existing) {
                  existing.bidSize = bidSize;
                } else {
                  const level: OrderBookLevel = {
                    price: gridPrice,
                    bidSize: bidSize,
                    askSize: 0,
                    volume: volumeByPrice.get(gridPrice) || 0
                  };
                  priceMap.set(gridPrice, level);
                  newBook.push(level);
                }
              }
            }
          }
          
          // Process ask prices (keep existing 10-level logic for backwards compatibility)
          if (event.bookAskPrices && event.bookAskSizes) {
            for (let i = 0; i < Math.min(event.bookAskPrices.length, 10); i++) {
              const askPrice = event.bookAskPrices[i];
              const askSize = event.bookAskSizes[i] || 0;
              
              if (askPrice > 0 && askSize > 0) {
                const gridPrice = roundToGrid(askPrice);
                const existing = priceMap.get(gridPrice);
                
                if (existing) {
                  existing.askSize = askSize;
                } else {
                  const level: OrderBookLevel = {
                    price: gridPrice,
                    bidSize: 0,
                    askSize: askSize,
                    volume: volumeByPrice.get(gridPrice) || 0
                  };
                  priceMap.set(gridPrice, level);
                  newBook.push(level);
                }
              }
            }
          }
          
          // Sort by price (descending for proper display)
          newBook.sort((a, b) => b.price - a.price);
          
          // Replace the entire orderbook (complete snapshot)
          setOrderBook(newBook);
          
          // Do NOT update current price from ORDERBOOK events
          // Current price (last) only changes from TRADE events
        }
        break;
    }
  }, []);

  // Playback control
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => {
      // If stopping playback, flush aggregation buffer
      if (prev) {
        flushAggregationBuffer();
      }
      return !prev;
    });
  }, [flushAggregationBuffer]);

  // Place limit order
  const placeLimitOrder = useCallback((side: 'BUY' | 'SELL', price: number, quantity: number) => {
    const newOrder: Order = {
      id: `order-${++orderIdCounter.current}`,
      side,
      price,
      quantity,
      filled: 0,
      timestamp: Date.now()
    };
    
    setOrders(prev => [...prev, newOrder]);
  }, []);

  // Place market order
  const placeMarketOrder = useCallback((side: 'BUY' | 'SELL', quantity: number) => {
    // Simulate immediate execution at current price
    const fillPrice = currentPrice;
    
    setPosition(prev => {
      const newQuantity = prev.quantity + (side === 'BUY' ? quantity : -quantity);
      
      // Calculate realized PnL for position changes
      let realizedPnL = 0;
      if (prev.quantity !== 0) {
        if ((prev.quantity > 0 && side === 'SELL') || (prev.quantity < 0 && side === 'BUY')) {
          // Closing or reducing position - calculate realized PnL
          const closeQuantity = Math.min(quantity, Math.abs(prev.quantity));
          if (prev.quantity > 0) {
            // Was long, selling - calculate ticks difference and multiply by tick value
            const tickDifference = (fillPrice - prev.averagePrice) / TICK_SIZE;
            realizedPnL = closeQuantity * tickDifference * TICK_VALUE;
          } else {
            // Was short, buying - calculate ticks difference and multiply by tick value  
            const tickDifference = (prev.averagePrice - fillPrice) / TICK_SIZE;
            realizedPnL = closeQuantity * tickDifference * TICK_VALUE;
          }
        }
      }
      
      // Update total realized PnL
      setRealizedPnLTotal(prevTotal => prevTotal + realizedPnL);
      
      let newAveragePrice = prev.averagePrice;
      if (newQuantity !== 0) {
        const totalCost = (prev.quantity * prev.averagePrice) + (quantity * fillPrice * (side === 'BUY' ? 1 : -1));
        newAveragePrice = Math.abs(totalCost / newQuantity);
      }
      
      return {
        ...prev,
        quantity: newQuantity,
        averagePrice: newAveragePrice,
        marketPrice: fillPrice
      };
    });
    
    // Add to time and sales
    const trade: Trade = {
      id: `my-trade-${Date.now()}`,
      timestamp: Date.now(),
      price: fillPrice,
      size: quantity,
      aggressor: side
    };
    
    setTimeAndSales(prev => [trade, ...prev]);
  }, [currentPrice]);

  // Cancel orders at price
  const cancelOrdersAtPrice = useCallback((price: number) => {
    setOrders(prev => prev.filter(order => Math.abs(order.price - price) >= 0.125));
  }, []);

  // Update PnL using tick value
  useEffect(() => {
    const tickDifference = (currentPrice - position.averagePrice) / TICK_SIZE;
    const unrealized = position.quantity * tickDifference * TICK_VALUE;
    
    setPnl({
      unrealized,
      realized: realizedPnLTotal,
      total: unrealized + realizedPnLTotal
    });
  }, [position, currentPrice, realizedPnLTotal]);

  // Check for limit order execution when price changes
  useEffect(() => {
    if (currentPrice <= 0) return;

    setOrders(prevOrders => {
      const updatedOrders = [...prevOrders];
      const executedOrders: Order[] = [];

      for (let i = updatedOrders.length - 1; i >= 0; i--) {
        const order = updatedOrders[i];
        let shouldExecute = false;

        if (order.side === 'BUY' && currentPrice <= order.price) {
          // Buy limit order executes when price hits or goes below limit price
          shouldExecute = true;
        } else if (order.side === 'SELL' && currentPrice >= order.price) {
          // Sell limit order executes when price hits or goes above limit price
          shouldExecute = true;
        }

        if (shouldExecute) {
          // Execute the order at the limit price
          const fillPrice = order.price;
          const quantity = order.quantity - order.filled;

          // Update position
          setPosition(prev => {
            const newQuantity = prev.quantity + (order.side === 'BUY' ? quantity : -quantity);
            
            // Calculate realized PnL for position changes
            let realizedPnL = 0;
            if (prev.quantity !== 0) {
              if ((prev.quantity > 0 && order.side === 'SELL') || (prev.quantity < 0 && order.side === 'BUY')) {
                // Closing or reducing position - calculate realized PnL
                const closeQuantity = Math.min(quantity, Math.abs(prev.quantity));
                if (prev.quantity > 0) {
                  // Was long, selling - calculate ticks difference and multiply by tick value
                  const tickDifference = (fillPrice - prev.averagePrice) / TICK_SIZE;
                  realizedPnL = closeQuantity * tickDifference * TICK_VALUE;
                } else {
                  // Was short, buying to cover - calculate ticks difference and multiply by tick value
                  const tickDifference = (prev.averagePrice - fillPrice) / TICK_SIZE;
                  realizedPnL = closeQuantity * tickDifference * TICK_VALUE;
                }
                
                // Update total realized PnL
                setRealizedPnLTotal(prevTotal => prevTotal + realizedPnL);
              }
            }
            
            let newAveragePrice = prev.averagePrice;
            
            // If we're closing the entire position, reset average price
            if (newQuantity === 0) {
              newAveragePrice = 0;
            } else if ((prev.quantity > 0 && order.side === 'BUY') || (prev.quantity < 0 && order.side === 'SELL')) {
              // Adding to existing position - update average price
              const totalCost = (prev.quantity * prev.averagePrice) + (quantity * fillPrice * (order.side === 'BUY' ? 1 : -1));
              newAveragePrice = Math.abs(totalCost / newQuantity);
            } else if (newQuantity !== 0 && Math.sign(newQuantity) !== Math.sign(prev.quantity)) {
              // Reversing position - new average price is the fill price
              newAveragePrice = fillPrice;
            }
            
            console.log(`Limit order executed: ${order.side} ${quantity} at ${fillPrice}`);
            console.log(`Position: ${prev.quantity} -> ${newQuantity}, Avg: ${prev.averagePrice} -> ${newAveragePrice}`);
            console.log(`Realized PnL: ${realizedPnL}, Total realized: ${realizedPnLTotal + realizedPnL}`);
            
            return {
              ...prev,
              quantity: newQuantity,
              averagePrice: newAveragePrice,
              marketPrice: fillPrice
            };
          });

          // Add to time and sales
          const trade: Trade = {
            id: `limit-trade-${Date.now()}-${i}`,
            timestamp: Date.now(),
            price: fillPrice,
            size: quantity,
            aggressor: order.side
          };
          
          setTimeAndSales(prev => [trade, ...prev]);

          // Remove the executed order
          executedOrders.push(order);
          updatedOrders.splice(i, 1);
        }
      }

      return updatedOrders;
    });
  }, [currentPrice]);

  // Playback timer
  useEffect(() => {
    if (isPlaying && currentEventIndex < marketData.length) {
      const currentEvent = marketData[currentEventIndex];
      const nextEvent = marketData[currentEventIndex + 1];
      
      if (nextEvent) {
        // Calculate delay between events in milliseconds
        const timeDiff = nextEvent.timestamp - currentEvent.timestamp;
        const baseDelay = Math.min(timeDiff, 5000); // Cap at 5 seconds max
        const adjustedDelay = baseDelay / playbackSpeed;
        
        // For real-time (1x), respect actual delays. For faster speeds, use much smaller minimums
        const minDelay = playbackSpeed === 1 ? 0 : 
                        playbackSpeed === 2 ? 1 : 
                        playbackSpeed === 5 ? 1 : 1; // Minimal delay for fast speeds
        const finalDelay = Math.max(minDelay, adjustedDelay);
        
        console.log('Playback timing:', { timeDiff, baseDelay, adjustedDelay, finalDelay, speed: playbackSpeed });
        
        playbackTimerRef.current = setTimeout(() => {
          processEvent(currentEvent);
          setCurrentEventIndex(prev => prev + 1);
        }, finalDelay);
      } else {
        processEvent(currentEvent);
        flushAggregationBuffer(); // Flush buffer at end of playback
        setIsPlaying(false);
      }
    }
    
    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
      }
    };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent]);

  // Generate ladder data according to specifications
  const generateLadderData = useCallback(() => {
    console.log('🔧 generateLadderData called');
    console.log('🔧 orderbookSnapshots.length:', orderbookSnapshots.length);
    console.log('🔧 currentEventIndex:', currentEventIndex);
    
    if (orderbookSnapshots.length === 0 || currentEventIndex >= orderbookSnapshots.length) {
      console.log('❌ No snapshots or index out of bounds');
      return [];
    }

    const currentSnapshot = orderbookSnapshots[Math.min(currentEventIndex, orderbookSnapshots.length - 1)];
    console.log('🔧 currentSnapshot:', currentSnapshot);
    if (!currentSnapshot) {
      console.log('❌ No current snapshot');
      return [];
    }

    const midTick = toTick(currentSnapshot.midPrice);
    const ladderTicks: number[] = [];
    
    // Generate 41 ticks around mid price (20 above, mid, 20 below)
    for (let i = -20; i <= 20; i++) {
      ladderTicks.push(midTick + i);
    }

    // Calculate size and volume for current frame
    const frameStartTime = currentEventIndex > 0 ? orderbookSnapshots[currentEventIndex - 1]?.timestamp : '0';
    const frameEndTime = currentSnapshot.timestamp;
    
    const tradesInFrame = trades.filter(trade => 
      trade.timestamp.toString() > frameStartTime && 
      trade.timestamp.toString() <= frameEndTime
    );
    
    // Group trades by tick for size calculation
    const sizeByTick = new Map<number, number>();
    tradesInFrame.forEach(trade => {
      if (trade.tradePrice) {
        const tickIndex = toTick(trade.tradePrice);
        const currentSize = sizeByTick.get(tickIndex) || 0;
        sizeByTick.set(tickIndex, currentSize + (trade.tradeSize || 0));
      }
    });

    // Update cumulative volume
    setCumulativeVolumeByTick(prev => {
      const newCumulative = new Map(prev);
      sizeByTick.forEach((size, tick) => {
        const currentVolume = newCumulative.get(tick) || 0;
        newCumulative.set(tick, currentVolume + size);
      });
      return newCumulative;
    });

    // Generate ladder rows
    return ladderTicks.map(tickIndex => {
      const price = fromTick(tickIndex);
      const bidSize = currentSnapshot.bidMap.get(tickIndex) || 0;
      const askSize = currentSnapshot.askMap.get(tickIndex) || 0;
      const size = sizeByTick.get(tickIndex) || 0;
      const volume = cumulativeVolumeByTick.get(tickIndex) || 0;

      return {
        price,
        bidSize,
        askSize,
        size,
        volume,
        tickIndex
      };
    });
  }, [orderbookSnapshots, currentEventIndex, trades, toTick, fromTick, cumulativeVolumeByTick]);

  const ladderData = generateLadderData();

  return {
    marketData,
    position,
    pnl,
    timeAndSales,
    isPlaying,
    playbackSpeed,
    currentPrice,
    orderBook,
    currentOrderBookData,
    orders,
    loadMarketData,
    togglePlayback,
    setPlaybackSpeed,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,
    // New ladder system
    ladderData,
    orderbookSnapshots,
    currentSnapshotIndex
  };
}