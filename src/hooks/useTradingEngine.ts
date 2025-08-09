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
            
            // Try to extract real data from CSV
            // Common column names for market data
            const timestamp = row.timestamp || row.time || row.Time || row.TIMESTAMP || Date.now() + index * 1000;
            const price = parseFloat(row.price || row.Price || row.PRICE || row.close || row.Close || row.CLOSE || 0);
            const volume = parseFloat(row.volume || row.Volume || row.VOLUME || row.size || row.Size || row.qty || 1);
            const side = row.side || row.Side || row.SIDE || row.aggressor || (Math.random() > 0.5 ? 'BUY' : 'SELL');
            
            if (price > 0) {
              // TRADE event with real data
              events.push({
                timestamp: typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp,
                eventType: 'TRADE',
                tradePrice: price,
                tradeSize: volume || Math.floor(Math.random() * 20) + 1,
                aggressor: side === 'BUY' || side === 'buy' || side === 1 ? 'BUY' : 'SELL'
              });
              
              // Generate orderbook around the trade price
              if (index % 5 === 0) {
                events.push({
                  timestamp: typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp,
                  eventType: 'ORDERBOOK',
                  bookBidPrices: [price - 0.25, price - 0.5, price - 0.75],
                  bookBidSizes: [10, 15, 8],
                  bookAskPrices: [price + 0.25, price + 0.5, price + 0.75],
                  bookAskSizes: [12, 9, 20]
                });
              }
            }
          });
          
          // Sort by timestamp
          events.sort((a, b) => a.timestamp - b.timestamp);
          
          console.log('Generated', events.length, 'market events');
          setMarketData(events);
          setCurrentEventIndex(0);
          setTimeAndSales([]);
          
          // Set initial price from first trade event
          const firstTrade = events.find(e => e.eventType === 'TRADE' && e.tradePrice);
          const initialPrice = firstTrade?.tradePrice || 15183;
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
          
          // Add bid levels
          event.bookBidPrices.forEach((price, i) => {
            newBook.push({
              price,
              bidSize: event.bookBidSizes?.[i] || 0,
              askSize: 0
            });
          });
          
          // Add ask levels
          event.bookAskPrices.forEach((price, i) => {
            const existingLevel = newBook.find(level => Math.abs(level.price - price) < 0.125);
            if (existingLevel) {
              existingLevel.askSize = event.bookAskSizes?.[i] || 0;
            } else {
              newBook.push({
                price,
                bidSize: 0,
                askSize: event.bookAskSizes?.[i] || 0
              });
            }
          });
          
          setOrderBook(newBook);
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
        const delay = (nextEvent.timestamp - currentEvent.timestamp) / playbackSpeed;
        
        playbackTimerRef.current = setTimeout(() => {
          processEvent(currentEvent);
          setCurrentEventIndex(prev => prev + 1);
        }, Math.max(10, delay)); // Minimum 10ms delay
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