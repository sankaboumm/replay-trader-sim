import { useState, useCallback, useRef, useEffect } from 'react';
import Papa from 'papaparse';

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
}

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
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
  const [timeAndSales, setTimeAndSales] = useState<Trade[]>([]);
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

  const playbackTimerRef = useRef<NodeJS.Timeout>();
  const orderIdCounter = useRef(0);

  // Load market data from file
  const loadMarketData = useCallback((file: File) => {
    console.log('Loading file:', file.name, 'Type:', file.type, 'Size:', file.size);
    const reader = new FileReader();
    
    reader.onload = (event) => {
      const text = event.target?.result as string;
      console.log('File loaded, content preview:', text.substring(0, 200));
      
      // For demo purposes, we'll parse CSV and simulate parquet-like data
      Papa.parse(text, {
        header: true,
        complete: (results) => {
          console.log('CSV parsed:', results.data.length, 'rows');
          console.log('First row:', results.data[0]);
          const events: MarketEvent[] = [];
          
          results.data.forEach((row: any, index) => {
            // Skip empty rows
            if (!row || Object.keys(row).length === 0) return;
            
            console.log('Processing row:', row);
            
            // Extract timestamp - convert to milliseconds if needed
            const timestampStr = row.timestamp || Date.now() + index * 1000;
            const timestamp = new Date(timestampStr).getTime();
            
            // Handle different event types from your CSV format
            if (row.event_type === 'trade') {
              // Extract trade data
              const price = parseFloat(row.last_trade_price || row.trade_price || 0);
              const volume = parseFloat(row.last_trade_size || row.trade_size || 1);
              const side = row.last_trade_side === 'B' ? 'BUY' : 'SELL';
              
              if (price > 0) {
                events.push({
                  timestamp: new Date(timestamp).getTime(),
                  eventType: 'TRADE',
                  tradePrice: price,
                  tradeSize: volume,
                  aggressor: side
                });
              }
            }
            
            // Always create orderbook events from the level data
            const bidPrices: number[] = [];
            const askPrices: number[] = [];
            const bidSizes: number[] = [];
            const askSizes: number[] = [];
            
            // Extract up to 10 levels of data
            for (let i = 1; i <= 10; i++) {
              const bidPrice = parseFloat(row[`bid_price_L${i}`] || 0);
              const askPrice = parseFloat(row[`ask_price_L${i}`] || 0);
              const bidSize = parseFloat(row[`bid_size_L${i}`] || 0);
              const askSize = parseFloat(row[`ask_size_L${i}`] || 0);
              
              if (bidPrice > 0) {
                bidPrices.push(bidPrice);
                bidSizes.push(bidSize);
              }
              if (askPrice > 0) {
                askPrices.push(askPrice);
                askSizes.push(askSize);
              }
            }
            
            if (bidPrices.length > 0 || askPrices.length > 0) {
              events.push({
                timestamp: new Date(timestamp).getTime(),
                eventType: 'ORDERBOOK',
                bookBidPrices: bidPrices,
                bookAskPrices: askPrices,
                bookBidSizes: bidSizes,
                bookAskSizes: askSizes
              });
            }
          });
          
          // Sort by timestamp
          events.sort((a, b) => a.timestamp - b.timestamp);
          
          console.log('Generated', events.length, 'market events');
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
            // Find first valid orderbook price
            const firstOrderbook = events.find(e => e.eventType === 'ORDERBOOK' && 
              ((e.bookBidPrices && e.bookBidPrices.length > 0) || 
               (e.bookAskPrices && e.bookAskPrices.length > 0)));
            
            if (firstOrderbook) {
              if (firstOrderbook.bookBidPrices && firstOrderbook.bookBidPrices.length > 0) {
                initialPrice = firstOrderbook.bookBidPrices[0];
              } else if (firstOrderbook.bookAskPrices && firstOrderbook.bookAskPrices.length > 0) {
                initialPrice = firstOrderbook.bookAskPrices[0];
              }
            }
          }
          
          console.log('Setting initial price to:', initialPrice);
          setCurrentPrice(initialPrice);
        }
      });
    };
    
    reader.readAsText(file);
  }, []);

  // Process market event
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
          
          setTimeAndSales(prev => [trade, ...prev.slice(0, 99)]);
          setCurrentPrice(event.tradePrice);
          
          // Check for order fills
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
        if (event.bidPrice && event.askPrice) {
          setOrderBook(prev => {
            const newBook = [...prev];
            // Update top of book
            const bidIndex = newBook.findIndex(level => Math.abs(level.price - event.bidPrice!) < 0.125);
            const askIndex = newBook.findIndex(level => Math.abs(level.price - event.askPrice!) < 0.125);
            
            if (bidIndex >= 0) {
              newBook[bidIndex] = { ...newBook[bidIndex], bidSize: event.bidSize || 0 };
            } else {
              newBook.push({
                price: event.bidPrice!,
                bidSize: event.bidSize || 0,
                askSize: 0
              });
            }
            
            if (askIndex >= 0) {
              newBook[askIndex] = { ...newBook[askIndex], askSize: event.askSize || 0 };
            } else {
              newBook.push({
                price: event.askPrice!,
                bidSize: 0,
                askSize: event.askSize || 0
              });
            }
            
            return newBook;
          });
        }
        break;
        
      case 'ORDERBOOK':
        if (event.bookBidPrices && event.bookAskPrices) {
          const newBook: OrderBookLevel[] = [];
          
          // Create a clean orderbook from the event data
          const maxLevels = Math.min(event.bookBidPrices.length, event.bookAskPrices.length);
          
          for (let i = 0; i < maxLevels; i++) {
            const bidPrice = event.bookBidPrices[i];
            const askPrice = event.bookAskPrices[i];
            const bidSize = event.bookBidSizes?.[i] || 0;
            const askSize = event.bookAskSizes?.[i] || 0;
            
            // Add bid level
            if (bidPrice > 0 && bidSize > 0) {
              newBook.push({
                price: bidPrice,
                bidSize: bidSize,
                askSize: 0
              });
            }
            
            // Add ask level (check if price already exists)
            if (askPrice > 0 && askSize > 0) {
              const existingLevel = newBook.find(level => Math.abs(level.price - askPrice) < 0.125);
              if (existingLevel) {
                existingLevel.askSize = askSize;
              } else {
                newBook.push({
                  price: askPrice,
                  bidSize: 0,
                  askSize: askSize
                });
              }
            }
          }
          
          // Sort by price (descending for proper display)
          newBook.sort((a, b) => b.price - a.price);
          
          // Replace the entire orderbook instead of accumulating
          setOrderBook(newBook);
          
          // Update current price with best bid/ask to avoid gaps
          const bestBid = Math.max(...event.bookBidPrices.filter(p => p > 0));
          const bestAsk = Math.min(...event.bookAskPrices.filter(p => p > 0));
          
          if (bestBid > 0 && bestAsk > 0) {
            const midPrice = (bestBid + bestAsk) / 2;
            setCurrentPrice(midPrice);
          }
        }
        break;
    }
  }, []);

  // Playback control
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => !prev);
  }, []);

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

  // Update PnL
  useEffect(() => {
    const unrealized = position.quantity * (currentPrice - position.averagePrice);
    const realized = 0; // Calculate from filled orders
    
    setPnl({
      unrealized,
      realized,
      total: unrealized + realized
    });
  }, [position, currentPrice]);

  // Playback timer
  useEffect(() => {
    if (isPlaying && currentEventIndex < marketData.length) {
      const currentEvent = marketData[currentEventIndex];
      const nextEvent = marketData[currentEventIndex + 1];
      
      if (nextEvent) {
        // Calculate delay between events in milliseconds
        const timeDiff = nextEvent.timestamp - currentEvent.timestamp;
        const baseDelay = Math.min(timeDiff, 1000); // Cap at 1 second max
        const adjustedDelay = baseDelay / playbackSpeed;
        
        // Set minimum delay based on playback speed to avoid too fast playback
        const minDelay = playbackSpeed >= 10 ? 50 : playbackSpeed >= 5 ? 100 : 200;
        const finalDelay = Math.max(minDelay, adjustedDelay);
        
        console.log('Playback timing:', { timeDiff, baseDelay, adjustedDelay, finalDelay, speed: playbackSpeed });
        
        playbackTimerRef.current = setTimeout(() => {
          processEvent(currentEvent);
          setCurrentEventIndex(prev => prev + 1);
        }, finalDelay);
      } else {
        processEvent(currentEvent);
        setIsPlaying(false);
      }
    }
    
    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
      }
    };
  }, [isPlaying, currentEventIndex, marketData, playbackSpeed, processEvent]);

  return {
    marketData,
    position,
    pnl,
    timeAndSales,
    isPlaying,
    playbackSpeed,
    currentPrice,
    orderBook,
    orders,
    loadMarketData,
    togglePlayback,
    setPlaybackSpeed,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice
  };
}