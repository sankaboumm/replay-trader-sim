import { useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { FileUpload } from './FileUpload';
import { PlaybackControls } from './PlaybackControls';
import { PositionPanel } from './PositionPanel';
import { TickLadder } from './TickLadder';
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
    spreadTicks
  ,
    scrollLadderUp,
    scrollLadderDown} = useTradingEngine();

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
            disabled={!marketData.length}
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
            className="flex-shrink-0"
          />

          {/* Drop Zone */}
          {marketData.length === 0 && (
            <div
              className="flex-1 m-4 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center text-muted-foreground"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <div className="text-center p-8">
                <h3 className="text-lg font-semibold mb-2">Déposez votre fichier</h3>
                <p className="text-sm mb-4">Glissez un CSV/Parquet pour démarrer</p>
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  Choisir un fichier
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".parquet,.csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            </div>
          )}
        </div>

        {/* Center - Tick Ladder */}
        <div className="flex-1 bg-background">
          <TickLadder
            tickLadder={currentTickLadder}
            currentPrice={currentPrice}
            orders={orders}
            onLimitOrder={placeLimitOrder}
            onMarketOrder={placeMarketOrder}
            onCancelOrders={cancelOrdersAtPrice}
            disabled={!isPlaying && marketData.length === 0}
            position={position}
            spread={spread}
            spreadTicks={spreadTicks}
            onScrollUp={scrollLadderUp}
            onScrollDown={scrollLadderDown}
          />
        </div>

        {/* Right - Time & Sales */}
        <div className="w-80 bg-card border-l border-border">
          <TimeAndSales trades={timeAndSales} currentPrice={currentPrice} />
        </div>
      </div>
    </div>
  );
}