import { useRef, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileUpload } from './FileUpload';
import { PlaybackControls } from './PlaybackControls';
import { PositionPanel } from './PositionPanel';
import { DOMInfinite } from './DOMInfinite';
import { TimeAndSales } from './TimeAndSales';
import { useTradingEngine } from '@/hooks/useTradingEngine';
import { useToast } from '@/hooks/use-toast';
import { Info } from 'lucide-react';

export function TradingInterface() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logsRef = useRef<string[]>([]);
  
  // Capture des logs console
  const originalConsoleLog = console.log;
  console.log = (...args) => {
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    // Garde seulement les logs de trading (avec emojis)
    if (message.includes('📊') || message.includes('🔄') || message.includes('💰') || message.includes('📝') || message.includes('🟡')) {
      logsRef.current.push(`${new Date().toLocaleTimeString()}: ${message}`);
      // Garde seulement les 50 derniers logs
      if (logsRef.current.length > 50) {
        logsRef.current = logsRef.current.slice(-50);
      }
    }
    
    originalConsoleLog(...args);
  };
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
    // nouveaux dérivés
    bestBid,
    bestAsk,
    spread,
    spreadTicks,
    setViewAnchorPrice,
  } = useTradingEngine();
  const { toast } = useToast();

  const showLogs = useCallback(() => {
    const logs = logsRef.current.length > 0 
      ? logsRef.current 
      : [
        "Aucun log de trading disponible.",
        "Effectuez des trades pour voir les logs de debug.",
        "",
        `État actuel:`,
        `Position: qty=${position.quantity}, avg=${position.averagePrice?.toFixed(2) || '0'}`,
        `Prix actuel: ${currentPrice}`,
        `Ordres en attente: ${orders.length}`,
      ];
    
    toast({
      title: "Debug Logs Trading",
      description: (
        <div className="text-xs font-mono whitespace-pre-wrap max-h-96 overflow-y-auto bg-muted p-2 rounded">
          {logs.join('\n')}
        </div>
      ),
      duration: 15000,
    });
  }, [logsRef, position, currentPrice, orders, toast]);

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
          <Button 
            variant="outline" 
            size="sm" 
            onClick={showLogs}
            className="flex items-center gap-2"
          >
            <Info size={16} />
            Debug Logs
          </Button>
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
            disabled={marketData.length === 0}
            position={position}
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