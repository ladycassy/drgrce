import { ScrapeConfig } from "@shared/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ConfigPanelProps {
  config: Omit<ScrapeConfig, "url">;
  onChange: (config: Omit<ScrapeConfig, "url">) => void;
}

export function ConfigPanel({ config, onChange }: ConfigPanelProps) {
  const updateConfig = (updates: Partial<Omit<ScrapeConfig, "url">>) => {
    onChange({ ...config, ...updates });
  };

  return (
    <div className="space-y-4 pt-4 border-t border-border">
      <div className="space-y-2">
        <Label htmlFor="maxImages" className="text-sm font-medium">
          Maximum Images
        </Label>
        <Input
          id="maxImages"
          type="number"
          min="0"
          max="500"
          value={config.maxImages}
          onChange={(e) => updateConfig({ maxImages: parseInt(e.target.value) || 0 })}
          className="h-10"
          data-testid="input-max-images"
        />
        <p className="text-xs text-muted-foreground">Limit the number of images to scrape (0 for unlimited, max 500)</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sortBy" className="text-sm font-medium">
          Sort By
        </Label>
        <Select
          value={config.sortBy}
          onValueChange={(value: any) => updateConfig({ sortBy: value })}
        >
          <SelectTrigger className="h-10" data-testid="select-sort-by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="relevance">Relevance</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="extractDetails" className="text-sm font-medium">
            Extract Details
          </Label>
          <p className="text-xs text-muted-foreground">
            Fetch photographer, location, and date information
          </p>
        </div>
        <Switch
          id="extractDetails"
          checked={config.extractDetails}
          onCheckedChange={(checked) => updateConfig({ extractDetails: checked })}
          data-testid="switch-extract-details"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="autoScroll" className="text-sm font-medium">
            Auto Scroll
          </Label>
          <p className="text-xs text-muted-foreground">
            Automatically handle infinite scrolling
          </p>
        </div>
        <Switch
          id="autoScroll"
          checked={config.autoScroll}
          onCheckedChange={(checked) => updateConfig({ autoScroll: checked })}
          data-testid="switch-auto-scroll"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="scrollDelay" className="text-sm font-medium">
          Scroll Delay (ms)
        </Label>
        <Input
          id="scrollDelay"
          type="number"
          min="500"
          max="5000"
          step="100"
          value={config.scrollDelay}
          onChange={(e) => updateConfig({ scrollDelay: parseInt(e.target.value) || 500 })}
          className="h-10"
          data-testid="input-scroll-delay"
        />
        <p className="text-xs text-muted-foreground">
          Delay between scroll actions (500-5000ms)
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="concurrency" className="text-sm font-medium">
          Parallel Tabs (Speed)
        </Label>
        <Input
          id="concurrency"
          type="number"
          min="1"
          max="20"
          value={config.concurrency}
          onChange={(e) => updateConfig({ concurrency: parseInt(e.target.value) || 5 })}
          className="h-10"
          data-testid="input-concurrency"
        />
        <p className="text-xs text-muted-foreground">
          Number of concurrent browser tabs for parallel processing (1-20, default: 5)
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="orderedSequential" className="text-sm font-medium">
            Ordered Sequential Mode
          </Label>
          <p className="text-xs text-muted-foreground">
            Process tabs one at a time with active focus for better rendering
          </p>
        </div>
        <Switch
          id="orderedSequential"
          checked={config.orderedSequential || false}
          onCheckedChange={(checked) => updateConfig({ orderedSequential: checked })}
          data-testid="switch-ordered-sequential"
        />
      </div>

      {config.orderedSequential && (
        <div className="space-y-4 pl-4 border-l-2 border-primary/20">
          <div className="space-y-2">
            <Label htmlFor="interTabDelayMin" className="text-sm font-medium">
              Min Tab Delay (ms)
            </Label>
            <Input
              id="interTabDelayMin"
              type="number"
              min="1000"
              max="10000"
              step="500"
              value={config.interTabDelayMin || 3000}
              onChange={(e) => updateConfig({ interTabDelayMin: parseInt(e.target.value) || 3000 })}
              className="h-10"
              data-testid="input-inter-tab-delay-min"
            />
            <p className="text-xs text-muted-foreground">
              Minimum delay between tabs (1000-10000ms)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="interTabDelayMax" className="text-sm font-medium">
              Max Tab Delay (ms)
            </Label>
            <Input
              id="interTabDelayMax"
              type="number"
              min="1000"
              max="10000"
              step="500"
              value={config.interTabDelayMax || 5000}
              onChange={(e) => updateConfig({ interTabDelayMax: parseInt(e.target.value) || 5000 })}
              className="h-10"
              data-testid="input-inter-tab-delay-max"
            />
            <p className="text-xs text-muted-foreground">
              Maximum delay between tabs (1000-10000ms)
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="canvasExtraction" className="text-sm font-medium">
          Canvas Image Extraction
        </Label>
        <Select
          value={config.canvasExtraction}
          onValueChange={(value: any) => updateConfig({ canvasExtraction: value })}
        >
          <SelectTrigger className="h-10" data-testid="select-canvas-extraction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No Canvas Images</SelectItem>
            <SelectItem value="thumbnail">Thumbnail (600x600)</SelectItem>
            <SelectItem value="full">High Resolution (9999x9999)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Extract canvas images from SmartFrame embeds (requires visible browser)
        </p>
      </div>
    </div>
  );
}
