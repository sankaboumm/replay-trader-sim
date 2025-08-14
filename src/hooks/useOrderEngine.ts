import { useState, useCallback } from 'react';
import { Trade as OrderBookTrade } from '@/lib/orderbook';

// NQ Multiplier: $20 per point
const NQ_MULTIPLIER = 20;

export interface LimitOrder {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  remain: number;
  tickIndex: number;
  queueAhead: number;
  status: 'WORKING' | 'PARTIAL' | 'FILLED' | 'CANCELED';
  timestamp: number;
}

export interface Position {
  contracts: number; // position size (positive = long, negative = short)
  averagePrice: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
}

export interface OrderExecution {
  orderId: string;
  price: number;
  quantity: number;
  timestamp: number;
}

export function useOrderEngine(tickSize: number = 0.25) {
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const [position, setPosition] = useState<Position>({
    contracts: 0,
    averagePrice: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalPnL: 0
  });
  const [executions, setExecutions] = useState<OrderExecution[]>([]);
  const [orderIdCounter, setOrderIdCounter] = useState(0);

  const toTick = useCallback((price: number) => Math.round(price / tickSize), [tickSize]);
  const fromTick = useCallback((tick: number) => tick * tickSize, [tickSize]);

  // Place limit order
  const placeLimitOrder = useCallback((
    side: 'BUY' | 'SELL', 
    price: number, 
    quantity: number,
    currentOrderBook: { bidSizes: Map<number, number>, askSizes: Map<number, number> }
  ) => {
    const tickIndex = toTick(price);
    const adjustedPrice = fromTick(tickIndex);
    
    // Calculate queue ahead at this price level
    let queueAhead = 0;
    if (side === 'BUY') {
      queueAhead = currentOrderBook.bidSizes.get(tickIndex) || 0;
    } else {
      queueAhead = currentOrderBook.askSizes.get(tickIndex) || 0;
    }

    const newOrder: LimitOrder = {
      id: `order_${orderIdCounter + 1}`,
      side,
      price: adjustedPrice,
      quantity,
      remain: quantity,
      tickIndex,
      queueAhead,
      status: 'WORKING',
      timestamp: Date.now()
    };

    setOrders(prev => [...prev, newOrder]);
    setOrderIdCounter(prev => prev + 1);
    
    console.log(`📝 Placed ${side} limit order: ${quantity} @ ${adjustedPrice.toFixed(2)} (queue ahead: ${queueAhead})`);
    return newOrder.id;
  }, [toTick, fromTick, orderIdCounter]);

  // Cancel orders at specific price
  const cancelOrdersAtPrice = useCallback((price: number) => {
    const tickIndex = toTick(price);
    
    setOrders(prev => prev.map(order => {
      if (order.tickIndex === tickIndex && (order.status === 'WORKING' || order.status === 'PARTIAL')) {
        console.log(`❌ Canceled order: ${order.id}`);
        return { ...order, status: 'CANCELED' };
      }
      return order;
    }));
  }, [toTick]);

  // Update position with new fill
  const updatePosition = useCallback((side: 'BUY' | 'SELL', fillPrice: number, fillQuantity: number) => {
    setPosition(prev => {
      let newContracts = prev.contracts;
      let newAveragePrice = prev.averagePrice;
      let additionalRealized = 0;

      if (side === 'BUY') {
        if (prev.contracts >= 0) {
          // Adding to long position or initial long
          if (prev.contracts === 0) {
            newAveragePrice = fillPrice;
          } else {
            newAveragePrice = (prev.averagePrice * prev.contracts + fillPrice * fillQuantity) / (prev.contracts + fillQuantity);
          }
          newContracts = prev.contracts + fillQuantity;
        } else {
          // Covering short position
          const coverQuantity = Math.min(fillQuantity, Math.abs(prev.contracts));
          additionalRealized = (prev.averagePrice - fillPrice) * coverQuantity * NQ_MULTIPLIER;
          newContracts = prev.contracts + fillQuantity;
          
          // If we flip to long after covering short
          if (newContracts > 0 && prev.contracts < 0) {
            newAveragePrice = fillPrice; // New average for the long position
          }
        }
      } else { // SELL
        if (prev.contracts <= 0) {
          // Adding to short position or initial short
          if (prev.contracts === 0) {
            newAveragePrice = fillPrice;
          } else {
            newAveragePrice = (prev.averagePrice * Math.abs(prev.contracts) + fillPrice * fillQuantity) / (Math.abs(prev.contracts) + fillQuantity);
          }
          newContracts = prev.contracts - fillQuantity;
        } else {
          // Covering long position
          const coverQuantity = Math.min(fillQuantity, prev.contracts);
          additionalRealized = (fillPrice - prev.averagePrice) * coverQuantity * NQ_MULTIPLIER;
          newContracts = prev.contracts - fillQuantity;
          
          // If we flip to short after covering long
          if (newContracts < 0 && prev.contracts > 0) {
            newAveragePrice = fillPrice; // New average for the short position
          }
        }
      }

      const newRealizedPnL = prev.realizedPnL + additionalRealized;
      
      console.log(`💰 Position updated: ${newContracts} contracts @ ${newAveragePrice.toFixed(2)}, Realized PnL: +$${additionalRealized.toFixed(2)}`);
      
      return {
        contracts: newContracts,
        averagePrice: newAveragePrice,
        realizedPnL: newRealizedPnL,
        unrealizedPnL: 0, // Will be calculated separately with current market price
        totalPnL: newRealizedPnL
      };
    });
  }, []);

  // Calculate unrealized PnL with current market price
  const updateUnrealizedPnL = useCallback((currentPrice: number) => {
    setPosition(prev => {
      if (prev.contracts === 0) {
        return { ...prev, unrealizedPnL: 0, totalPnL: prev.realizedPnL };
      }
      
      const unrealizedPnL = (currentPrice - prev.averagePrice) * prev.contracts * NQ_MULTIPLIER;
      return {
        ...prev,
        unrealizedPnL,
        totalPnL: prev.realizedPnL + unrealizedPnL
      };
    });
  }, []);

  // Process trades for order execution
  const processTrades = useCallback((
    trades: OrderBookTrade[], 
    previousTimestamp: Date, 
    currentTimestamp: Date
  ) => {
    // Get trades in current window
    const windowTrades = trades.filter(trade => 
      trade.timestamp > previousTimestamp && trade.timestamp <= currentTimestamp
    );

    if (windowTrades.length === 0) return;

    setOrders(prevOrders => {
      const updatedOrders = [...prevOrders];
      const newExecutions: OrderExecution[] = [];

      for (const trade of windowTrades) {
        const tradeTickIndex = toTick(trade.price);
        
        // Find orders that can be filled by this trade
        const fillableOrders = updatedOrders.filter(order => 
          order.tickIndex === tradeTickIndex &&
          (order.status === 'WORKING' || order.status === 'PARTIAL') &&
          ((trade.aggressor === 'BUY' && order.side === 'SELL') || 
           (trade.aggressor === 'SELL' && order.side === 'BUY'))
        );

        let remainingTradeSize = trade.size;

        for (const order of fillableOrders) {
          if (remainingTradeSize <= 0) break;

          // First consume queue ahead
          if (order.queueAhead > 0) {
            const queueConsumption = Math.min(order.queueAhead, remainingTradeSize);
            order.queueAhead -= queueConsumption;
            remainingTradeSize -= queueConsumption;
            console.log(`📊 Queue consumption: ${queueConsumption} at ${order.price.toFixed(2)} (remaining queue: ${order.queueAhead})`);
          }

          // Then fill the order if there's remaining trade size
          if (remainingTradeSize > 0 && order.queueAhead === 0) {
            const fillQuantity = Math.min(order.remain, remainingTradeSize);
            order.remain -= fillQuantity;
            remainingTradeSize -= fillQuantity;

            // Update order status
            if (order.remain === 0) {
              order.status = 'FILLED';
            } else {
              order.status = 'PARTIAL';
            }

            // Record execution
            const execution: OrderExecution = {
              orderId: order.id,
              price: trade.price,
              quantity: fillQuantity,
              timestamp: trade.timestamp.getTime()
            };
            newExecutions.push(execution);

            // Update position
            updatePosition(order.side, trade.price, fillQuantity);
            
            console.log(`✅ Order filled: ${order.id} - ${fillQuantity} @ ${trade.price.toFixed(2)} (${order.status})`);
          }
        }
      }

      if (newExecutions.length > 0) {
        setExecutions(prev => [...prev, ...newExecutions]);
      }

      return updatedOrders;
    });
  }, [toTick, updatePosition]);

  // Get working orders for display
  const getWorkingOrders = useCallback(() => {
    return orders.filter(order => order.status === 'WORKING' || order.status === 'PARTIAL');
  }, [orders]);

  // Reset all states
  const reset = useCallback(() => {
    setOrders([]);
    setPosition({
      contracts: 0,
      averagePrice: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalPnL: 0
    });
    setExecutions([]);
    setOrderIdCounter(0);
  }, []);

  return {
    orders: getWorkingOrders(),
    position,
    executions,
    placeLimitOrder,
    cancelOrdersAtPrice,
    processTrades,
    updateUnrealizedPnL,
    reset,
    toTick,
    fromTick
  };
}