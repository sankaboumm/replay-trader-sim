import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { PositionPanel } from './PositionPanel';
import { TimeAndSales } from './TimeAndSales';
import { PlaybackControls } from './PlaybackControls';
import { FileUpload } from './FileUpload';
import { TickLadder } from './TickLadder';
import { useTradingEngine } from '@/hooks/useTradingEngine';

export function TradingInterface() {
  const centerPaneRef = useRef<HTMLDivElement>(null);
  const ladderRef = useRef<{ centerOnPrice: (p: number) => void } | null>(null);

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
  } = useTradingEngine();

  const onSpaceToCenter = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Espace = recentrer le ladder sur le prix courant
    if (e.code === 'Space') {
      e.preventDefault();
      ladderRef.current?.centerOnPrice(currentPrice);
    }
  }, [currentPrice]);

  const onClickCenter = useCallback(() => {
    ladderRef.current?.centerOnPrice(currentPrice);
    // on force le focus pour que la touche Espace marche sans cliquer ailleurs
    centerPaneRef.current?.focus();
  }, [currentPrice]);

  return (
    <div className="h-screen bg-background text-foreground overflow-hidden">
      {/* Header */}
      <div className="h-16 bg-card border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">Trading Simulator</h1>
          <FileUpload onFileSelect={loadMarketData} disabled={isPlaying} />
          <Button variant="outline" size="sm" onClick={onClickCenter}>
            Center Price (Space)
          </Button>
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
            className="flex-shrink-0"
          />
          {!marketData.length && (
            <div className="flex-1 m-4 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center text-muted-foreground">
              <div className="text-center p-8">
                <h3 className="text-lg font-semibold mb-2">Déposez votre fichier CSV</h3>
                <p className="text-sm">Glissez-déposez un fichier d’événements pour démarrer</p>
          </div>
            </div>
          )}
        </div>

        {/* Center Panel — Tick Ladder */}
        <div
          ref={centerPaneRef}
          className="flex-1 bg-background outline-none"
          tabIndex={0}
          onKeyDown={onSpaceToCenter}
        >
          <TickLadder
            ref={ladderRef}
            tickLadder={currentTickLadder}
            currentPrice={currentPrice}
            orders={orders}
            position={position}
            onLimitOrder={placeLimitOrder}
            onMarketOrder={placeMarketOrder}
            onCancelOrders={cancelOrdersAtPrice}
            disabled={!isPlaying && marketData.length === 0}
          />
        </div>

        {/* Right Panel — Time & Sales */}
        <div className="w-80 bg-card border-l border-border">
          <TimeAndSales trades={timeAndSales} currentPrice={currentPrice} />
        </div>
      </div>
    </div>
  );
}