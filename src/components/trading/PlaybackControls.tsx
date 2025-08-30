import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Play, Pause, Square } from 'lucide-react';

interface PlaybackControlsProps {
  isPlaying: boolean;
  speed: number;
  onTogglePlayback: () => void;
  onSpeedChange: (speed: number) => void;
  disabled?: boolean;
}

const SPEED_OPTIONS = [1, 2, 5, 10];

export const PlaybackControls = memo(function PlaybackControls({
  isPlaying,
  speed,
  onTogglePlayback,
  onSpeedChange,
  disabled = false
}: PlaybackControlsProps) {
  const playDisabled = !!disabled && !isPlaying;

  return (
    <div className="flex items-center gap-2">
      {/* Play/Pause Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={onTogglePlayback}
        disabled={playDisabled}
        className="w-10 h-10 p-0"
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </Button>

      {/* Speed Controls */}
      <div className="flex items-center gap-1 bg-card border rounded-md p-1">
        {SPEED_OPTIONS.map((speedOption) => (
          <Button
            key={speedOption}
            variant={speed === speedOption ? "default" : "ghost"}
            size="sm"
            onClick={() => onSpeedChange(speedOption)}
            disabled={disabled}
            className={cn(
              "h-8 px-3 text-xs",
              speed === speedOption && "bg-primary text-primary-foreground"
            )}
          >
            {speedOption}×
          </Button>
        ))}
      </div>

      {/* Status Indicator */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className={cn(
          "w-2 h-2 rounded-full",
          isPlaying ? "bg-trading-buy animate-pulse" : "bg-muted"
        )} />
        <span>
          {isPlaying ? `Lecture ${speed}×` : 'En pause'}
        </span>
      </div>
    </div>
  );
});