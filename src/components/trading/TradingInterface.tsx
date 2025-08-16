import { useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { FileUpload } from './FileUpload';
import { PlaybackControls } from './PlaybackControls';
import { PositionPanel } from './PositionPanel';
import { TimeAndSales } from './TimeAndSales';
import { TickLadder } from './TickLadder';
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
    orders,
    loadMarketData,
    togglePlayback,
    setPlaybackSpeed,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrdersAtPrice,
    currentTickLadder,
    isLoading, // NEW
  } = useTradingEngine();

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadMarketData(file);
    }
  }, [loadMarketData]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      loadMarketData(file);
    }
  }, [loadMarketData]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  return (
    <div className="h-screen bg-background text-foreground overflow-hidden relative">
      {/* Header */}
      <div className="h-16 bg-card border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">Trading Simulator</h1>
          <FileUpload
            onFileSelect={loadMarketData}
            disabled={isPlaying}
          />
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
        {/* Left Panel - Position */}
        <div className="w-80 bg-card border-r border-border flex flex-col">
          <PositionPanel
            position={position}
            pnl={pnl}
            currentPrice={currentPrice}
            className="flex-shrink-0"
          />

          {/* Drop zone quand pas de data */}
          {marketData.length === 0 && (
            <div
              className="flex-1 m-4 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center text-muted-foreground hover:border-primary/50 transition-colors"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <div className="text-center p-8">
                <h3 className="text-lg font-semibold mb-2">Déposez votre fichier CSV/Parquet</h3>
                <p className="text-sm mb-4">
                  Glissez-déposez un fichier de données de marché pour commencer
                </p>
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choisir un fichier
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.parquet"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            </div>
          )}
        </div>

        {/* Center Panel - Ladder */}
        <div className="flex-1 bg-background">
          <TickLadder
            tickLadder={currentTickLadder}
            currentPrice={currentPrice}
            orders={orders}
            onLimitOrder={placeLimitOrder}
            onMarketOrder={placeMarketOrder}
            onCancelOrders={cancelOrdersAtPrice}
            disabled={!isPlaying && marketData.length === 0}
            position={position}  // pour encadrer le prix moyen
          />
        </div>

        {/* Right Panel - Time & Sales */}
        <div className="w-80 bg-card border-l border-border">
          <TimeAndSales
            trades={timeAndSales}
            currentPrice={currentPrice}
          />
        </div>
      </div>

      {/* POPUP de chargement */}
      {isLoading && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-md px-6 py-4 shadow-lg">
            <div className="text-lg font-semibold mb-2">Import du fichier…</div>
            <div className="text-sm text-muted-foreground">Merci de patienter, parsing en cours.</div>
          </div>
        </div>
      )}
    </div>
  );
}