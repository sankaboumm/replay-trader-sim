import { useState, useRef, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DOMladder } from './DOMladder';
import { TickLadder } from './TickLadder';
import { TimeAndSales } from './TimeAndSales';
import { PlaybackControls } from './PlaybackControls';
import { PositionPanel } from './PositionPanel';
import { FileUpload } from './FileUpload';
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

    // NEW: import & erreurs
    isLoading,
    importError,
    totalTrades,
  } = useTradingEngine();

  // Statut position
  const positionLabel =
    position.quantity === 0 ? 'FLAT' : position.quantity > 0 ? 'LONG' : 'SHORT';

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
          <FileUpload 
            onFileSelect={loadMarketData}
            disabled={isPlaying || isLoading}
          />
        </div>
        
        <div className="flex items-center gap-4">
          <PlaybackControls
            isPlaying={isPlaying}
            speed={playbackSpeed}
            onTogglePlayback={togglePlayback}
            onSpeedChange={setPlaybackSpeed}
            disabled={!marketData.length || isLoading}
          />
        </div>
      </div>

      {/* Overlay Import en cours */}
      {isLoading && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-card border border-border rounded p-4">
            Import en cours…
          </div>
        </div>
      )}
      {/* Toast erreur import */}
      {importError && (
        <div className="fixed bottom-4 right-4 z-50 bg-destructive text-destructive-foreground px-3 py-2 rounded">
          {importError}
        </div>
      )}

      {/* Main Trading Interface */}
      <div className="h-[calc(100vh-4rem)] flex">
        {/* Left Panel - Position & Controls */}
        <div className="w-80 bg-card border-r border-border flex flex-col">
          <PositionPanel
            position={position}
            pnl={pnl}
            currentPrice={currentPrice}
            className="flex-shrink-0"
          />
          
          {/* File Drop Zone when no data */}
          {marketData.length === 0 && !isLoading && (
            <div 
              className="flex-1 m-4 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center text-muted-foreground hover:border-primary/50 transition-colors"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <div className="text-center p-8">
                <h3 className="text-lg font-semibold mb-2">Déposez votre fichier Parquet/CSV</h3>
                <p className="text-sm mb-4">
                  Glissez-déposez un fichier de données de marché pour commencer le trading
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
                  accept=".parquet,.csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            </div>
          )}
        </div>

        {/* Center Panel - Tick Ladder */}
        <div className="flex-1 bg-background">
          <TickLadder
            tickLadder={currentTickLadder}
            currentPrice={currentPrice}
            orders={orders}
            onLimitOrder={placeLimitOrder}
            onMarketOrder={placeMarketOrder}
            onCancelOrders={cancelOrdersAtPrice}
            disabled={!isPlaying && marketData.length === 0}
            getVolumeForPrice={getVolumeForPrice}
          />
        </div>

        {/* Right Panel - Time & Sales */}
        <div className="w-80 bg-card border-l border-border">
          <TimeAndSales 
            trades={timeAndSales}
            currentPrice={currentPrice}
            // (tu peux afficher totalTrades ailleurs si tu veux)
          />
        </div>
      </div>
    </div>
  );
}