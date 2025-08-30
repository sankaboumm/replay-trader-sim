import { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface OrderBookLevel {
  price: number;
  bidSize: number;
  askSize: number;
  bidOrders?: number;
  askOrders?: number;
  volume?: number;
}

interface OrderBookData {
  book_bid_sizes: number[];
  book_ask_sizes: number[];
  book_bid_prices: number[];
  book_ask_prices: number[];
}

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  filled?: number;
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
}

interface Props {
  currentPrice: number;
  orderBook: OrderBookLevel[];
  orderBookData?: OrderBookData | null;
  priceRange?: { start: number; end: number } | null;
  trades: { price: number; size: number }[];
  orders: Order[];
  onLimitOrder: (side: 'BUY' | 'SELL', price: number, quantity: number) => void;
  onMarketOrder: (side: 'BUY' | 'SELL', quantity: number, at?: 'BID' | 'ASK') => void;
  onCancelOrders: (price: number) => void;
  disabled?: boolean;
  position: Position;
}

const TICK_SIZE = 0.25;
const formatSize = (n: number) => n > 0 ? n.toFixed(0) : '';
const formatPrice = (p: number) => p.toFixed(2);

export const DOMladder = memo(function DOMladder({
  currentPrice,
  orderBook,
  orderBookData,
  priceRange,
  trades,
  orders,
  onLimitOrder,
  onMarketOrder,
  onCancelOrders,
  disabled,
  position
}: Props) {
  const [volumeByPrice, setVolumeByPrice] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    const m = new Map<number, number>();
    for (const t of trades) {
      const p = Math.round(t.price / TICK_SIZE) * TICK_SIZE;
      m.set(p, (m.get(p) ?? 0) + t.size);
    }
    setVolumeByPrice(m);
  }, [trades]);

  const orderBookLevels = useMemo(() => {
    if (orderBook && orderBook.length > 0) {
      const levels = orderBook.map(l => ({
        price: l.price,
        bidSize: l.bidSize || 0,
        askSize: l.askSize || 0,
        bidOrders: orders.filter(o => o.side === 'BUY' && Math.abs(o.price - l.price) < 1e-9).length,
        askOrders: orders.filter(o => o.side === 'SELL' && Math.abs(o.price - l.price) < 1e-9).length,
        volume: l.volume || 0
      }));
      return levels;
    }

    // fallback avec orderBookData + priceRange...
    if (!priceRange) return [];
    const levels: OrderBookLevel[] = [];
    const totalLevels = Math.round((priceRange.end - priceRange.start) / TICK_SIZE);
    for (let i = 0; i <= totalLevels; i++) {
      const price = priceRange.start + (i * TICK_SIZE);
      const bookLevel = orderBook.find(level => Math.abs(level.price - price) < TICK_SIZE / 2);
      levels.push({
        price,
        bidSize: bookLevel?.bidSize || 0,
        askSize: bookLevel?.askSize || 0,
        bidOrders: bookLevel?.bidOrders || 0,
        askOrders: bookLevel?.askOrders || 0,
        volume: bookLevel?.volume || 0
      });
    }
    return levels.sort((a, b) => b.price - a.price);
  }, [priceRange, orderBook, orderBookData, orders]);

  const handleCellClick = useCallback((price: number, side: 'bid' | 'ask') => {
    if (disabled) return;

    const isAboveCurrentPrice = price > currentPrice;
    const isBelowCurrentPrice = price < currentPrice;
    const isAtCurrentPrice = Math.abs(price - currentPrice) < 1e-9;

    if (side === 'bid') {
      if (isAboveCurrentPrice || isAtCurrentPrice) {
        // Market Buy -> best bid
        onMarketOrder('BUY', 1, 'BID');
      } else {
        onLimitOrder('BUY', price, 1);
      }
    } else {
      if (isBelowCurrentPrice || isAtCurrentPrice) {
        // Market Sell -> best ask
        onMarketOrder('SELL', 1, 'ASK');
      } else {
        onLimitOrder('SELL', price, 1);
      }
    }
  }, [currentPrice, disabled, onLimitOrder, onMarketOrder]);

  const handleOrderClick = useCallback((price: number) => {
    if (disabled) return;
    onCancelOrders(price);
  }, [disabled, onCancelOrders]);

  return (
    <div className="h-full flex flex-col bg-card">
      {/* ... header ... */}
      <div className="flex-1 overflow-y-auto trading-scroll">
        {orderBookLevels.map(level => {
          const volume = volumeByPrice.get(level.price) ?? 0;

          return (
            <div key={level.price} className="grid grid-cols-7 border-b border-border/50 text-sm">
              {/* Buy size */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.bidSize > 0 && "bg-ladder-bid text-trading-buy",
                  level.price < currentPrice && "hover:bg-trading-buy/10"
                )}
                onClick={() => handleCellClick(level.price, 'bid')}
              >
                {formatSize(level.bidSize)}
              </div>

              {/* Sell size */}
              <div
                className={cn(
                  "flex items-center justify-center cursor-pointer border-r border-border/50",
                  level.askSize > 0 && "bg-ladder-ask text-trading-sell",
                  level.price > currentPrice && "hover:bg-trading-sell/10"
                )}
                onClick={() => handleCellClick(level.price, 'ask')}
              >
                {formatSize(level.askSize)}
              </div>

              {/* ... reste des colonnes (orders count, price, vol) ... */}
              <div className="flex items-center justify-center border-r border-border/50">{level.bidOrders || ''}</div>

              <div className={cn("flex items-center justify-center font-mono font-medium border-r border-border/50 bg-ladder-price")}>
                {formatPrice(level.price)}
              </div>

              <div className="flex items-center justify-center border-r border-border/50">{level.askOrders || ''}</div>

              <div className="flex items-center justify-center border-r border-border/50 text-muted-foreground">
                {formatSize(volume)}
              </div>

              <div className="flex items-center justify-center text-muted-foreground">{/* volume cumulé éventuel */}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
});