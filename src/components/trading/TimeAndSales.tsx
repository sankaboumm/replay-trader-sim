import React, { memo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface Trade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  aggressor: 'BUY' | 'SELL';
  aggregatedCount?: number;
}

interface TimeAndSalesProps {
  trades: Trade[];
  currentPrice: number;
}

/** Options d’affichage (sans supprimer le code) */
const SHOW_TIME = false;            // mettre true pour ré-afficher la colonne Time
const SHOW_SIDE = false;            // mettre true pour ré-afficher la colonne Side
const BIG_TEXT = 'text-[1.70rem]';  // taille de police demandée pour Price & Size

/** Surlignage plus fort pour les gros prints (size > 10) */
const BUY_HIGHLIGHT_CLASS = 'bg-trading-buy/40';   // avant: /20
const SELL_HIGHLIGHT_CLASS = 'bg-trading-sell/40'; // avant: /20

function pad(n: number, width = 2) {
  return String(n).padStart(width, '0');
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const base = d.toLocaleTimeString('en-GB', { hour12: false });
  return `${base}.${pad(d.getMilliseconds(), 3)}`;
}

function formatPrice(p: number) {
  if (p == null || Number.isNaN(p)) return '--';
  return p.toFixed(2);
}

function TimeAndSalesComponent({ trades, currentPrice }: TimeAndSalesProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll vers le bas à chaque nouveau trade
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [trades]);

  const colClass =
    SHOW_TIME && SHOW_SIDE
      ? 'grid-cols-4'
      : SHOW_TIME || SHOW_SIDE
      ? 'grid-cols-3'
      : 'grid-cols-2';

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border">
      {/* Header */}
      <div className="bg-ladder-header border-b border-border">
        <div className="p-3">
          <h3 className="text-sm font-semibold">Time &amp; Sales</h3>
        </div>

        <div className={cn('grid border-t border-border text-xs font-semibold text-muted-foreground', colClass)}>
          {SHOW_TIME && <div className="border-r border-border p-2 text-center">Time</div>}
          <div className="border-r border-border p-2 text-center">Price</div>
          <div className={cn('p-2 text-center', SHOW_SIDE ? 'border-r border-border' : '')}>Size</div>
          {SHOW_SIDE && <div className="p-2 text-center">Side</div>}
        </div>
      </div>

      {/* Body */}
      <div ref={scrollerRef} className="flex-1 overflow-auto">
        {trades.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No trades yet.</div>
        ) : (
          trades.map((trade) => {
            const rowHighlight =
              trade.size > 10
                ? trade.aggressor === 'BUY'
                  ? BUY_HIGHLIGHT_CLASS
                  : SELL_HIGHLIGHT_CLASS
                : '';

            return (
              <div
                key={trade.id}
                className={cn(
                  'grid items-center border-b border-border/50 py-[2px] font-mono transition-colors hover:bg-ladder-row-hover',
                  colClass,
                  rowHighlight
                )}
              >
                {/* Time */}
                {SHOW_TIME && (
                  <div className="border-r border-border/50 px-2 text-center text-xs">
                    {formatTime(trade.timestamp)}
                  </div>
                )}

                {/* Price */}
                <div
                  className={cn(
                    'border-r border-border/50 px-2 text-center',
                    BIG_TEXT,
                    trade.aggressor === 'BUY' ? 'text-trading-buy' : 'text-trading-sell'
                  )}
                >
                  {formatPrice(trade.price)}
                </div>

                {/* Size */}
                <div className={cn('px-2 text-center', BIG_TEXT)}>{trade.size}</div>

                {/* Side */}
                {SHOW_SIDE && (
                  <div
                    className={cn(
                      'px-2 text-center font-semibold',
                      trade.aggressor === 'BUY' ? 'text-trading-buy' : 'text-trading-sell'
                    )}
                  >
                    {trade.aggressor === 'BUY' ? '▲' : '▼'}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer Stats */}
      <div className="bg-ladder-header border-t border-border p-3">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-muted-foreground">Total Trades</div>
            <div className="font-mono font-semibold">{trades.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Last Price</div>
            <div className="font-mono font-semibold text-yellow-400">
              {currentPrice > 0 ? formatPrice(currentPrice) : '--'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Export nommé + export par défaut pour satisfaire tous les imports */
export const TimeAndSales = memo(TimeAndSalesComponent);
export default TimeAndSales;