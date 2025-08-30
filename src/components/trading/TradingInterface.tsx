import { useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { FileUpload } from './FileUpload';
import { PlaybackControls } from './PlaybackControls';
import { PositionPanel } from './PositionPanel';
import { DOMInfinite } from './DOMInfinite';
import { TimeAndSales } from './TimeAndSales';
import { useTradingEngine } from '@/hooks/useTradingEngine';

export function TradingInterface() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
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
    currentTickLadder,
    // nouveaux dérivés
    bestBid,
    bestAsk,
    spread,
    spreadTicks,
    setViewAnchorPrice,
    canPlay,
  } = useTradingEngine();

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) loadMarketData(file);
  }, [loadMarketData]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) loadMarketData(file);
  }, [loadMarketData]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  return (
    <div className="h-screen bg-background text-foreground overflow-hidden">
      {/* Header */}
      <div className="h-16 bg-card border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">Trading Simulator</h1>
          <FileUpload onFileSelect={loadMarketData} disabled={isPlaying} />
        </div>

        <div className="flex items-center gap-4">
          <PlaybackControls
            isPlaying={isPlaying}
            speed={playbackSpeed}
            onTogglePlayback={togglePlayback}
            onSpeedChange={setPlaybackSpeed}
            disabled={!canPlay}
          />
        </div>
      </div>

      {/* Main */}
      <div className="h-[calc(100vh-4rem)] flex">
        {/* Left Panel */}
        <div className="w-80 bg-card border-r border-border flex flex-col">
          <PositionPanel
            position={position}
            pnl={pnl}
            currentPrice={currentPrice}
            bestBid={bestBid}
            bestAsk={bestAsk}
            spread={spread}
            spreadTicks={spreadTicks}
          />

          {/* Quick actions */}
          <div className="p-2 flex gap-2">
            <Button
              variant="outline"
              onClick={() => placeMarketOrder('BUY')}
              disabled={!isPlaying && marketData.length === 0}
            >
              Market Buy
            </Button>
            <Button
              variant="outline"
              onClick={() => placeMarketOrder('SELL')}
              disabled={!isPlaying && marketData.length === 0}
            >
              Market Sell
            </Button>
          </div>

          {/* BBO info (rappel visuel) */}
          {bestBid != null && bestAsk != null && (
            <div className="px-2 pb-2 text-sm text-muted-foreground">
              <div className="flex justify-between">
                <span>Bid</span>
                <span className="tabular-nums">{bestBid.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Ask</span>
                <span className="tabular-nums">{bestAsk.toFixed(2)}</span>
              </div>
              {spread != null && (
                <div className="flex justify-between">
                  <span>Spread</span>
                  <span className="tabular-nums">
                    {spread.toFixed(2)}{typeof spreadTicks === 'number' ? ` (${spreadTicks}t)` : ''}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Center - DOM */}
        <div className="w-160 bg-background">
          <DOMInfinite
            tickLadder={currentTickLadder}
            currentPrice={currentPrice}
            trades={timeAndSales}
            orders={orders}
            onLimitOrder={placeLimitOrder}
            onMarketOrder={placeMarketOrder}
            onCancelOrders={cancelOrdersAtPrice}
            disabled={!isPlaying && marketData.length === 0}
            position={position}
          />
        </div>

        {/* Right - Time & Sales */}
        <div className="w-80 bg-card border-l border-border">
          <TimeAndSales trades={timeAndSales} currentPrice={currentPrice} />
        </div>
      </div>

      {/* Hidden input for drag&drop fallback */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".parquet,.csv"
        onChange={handleFileUpload}
        className="hidden"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      />
    </div>
  );
}