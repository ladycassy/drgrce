import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrapeForm } from "@/components/scraper/scrape-form";
import { ConfigPanel } from "@/components/scraper/config-panel";
import { ProgressIndicator } from "@/components/scraper/progress-indicator";
import { ResultsDisplay } from "@/components/scraper/results-display";
import { ExportModal } from "@/components/scraper/export-modal";
import { ScrapeConfig, ScrapeJob } from "@shared/schema";
import { Globe, Download, FileSpreadsheet, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [config, setConfig] = useState<Omit<ScrapeConfig, "url">>({
    maxImages: 0,
    extractDetails: true,
    sortBy: "relevance",
    autoScroll: true,
    scrollDelay: 1000,
    concurrency: 5,
    canvasExtraction: "none",
  });
  const previousJobStatusRef = useRef<string | null>(null);
  const { toast } = useToast();

  const { data: currentJob, refetch } = useQuery<ScrapeJob>({
    queryKey: ["/api/scrape/job", currentJobId],
    enabled: !!currentJobId,
    refetchInterval: (query) => {
      const job = query.state.data;
      return job?.status === "scraping" ? 1000 : false;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const handleStartScrape = useCallback((jobIds: string[]) => {
    if (jobIds.length > 0) {
      setCurrentJobId(jobIds[0]);
      previousJobStatusRef.current = null;
    }
  }, []);

  const hasResults = useMemo(() => 
    currentJob?.images && currentJob.images.length > 0, 
    [currentJob?.images]
  );

  useEffect(() => {
    if (currentJob && previousJobStatusRef.current === "scraping" && currentJob.status === "completed" && hasResults) {
      toast({
        title: "✅ Scraping Complete!",
        description: `Successfully extracted ${currentJob.scrapedImages} image${currentJob.scrapedImages !== 1 ? 's' : ''} with metadata. Click "Export to CSV" in the header to download your data.`,
        duration: 8000,
      });
      
      setShowExport(true);
    }
    previousJobStatusRef.current = currentJob?.status || null;
  }, [currentJob, hasResults, toast]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-card-border shadow-sm">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary rounded-md flex items-center justify-center">
              <Globe className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">SmartFrame Scraper</h1>
              <p className="text-xs text-muted-foreground">Professional Image Metadata Extraction</p>
            </div>
          </div>
          {hasResults && (
            <div className="flex items-center gap-3">
              {currentJob?.status === "completed" && (
                <div className="hidden sm:flex items-center gap-2 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 px-3 py-1.5 rounded-md text-sm font-medium border border-green-200 dark:border-green-800">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{currentJob.scrapedImages} image{currentJob.scrapedImages !== 1 ? 's' : ''} ready</span>
                </div>
              )}
              <Button
                onClick={() => setShowExport(true)}
                variant="default"
                className="gap-2 relative"
                data-testid="button-export"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Export to CSV
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-card rounded-lg border border-card-border p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-card-foreground mb-4">
                Scrape Configuration
              </h2>
              <ScrapeForm
                onSubmit={handleStartScrape}
                isLoading={currentJob?.status === "scraping"}
                config={config}
              />
              
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="mt-4 text-sm text-primary hover:underline"
                data-testid="button-toggle-config"
              >
                {showConfig ? "Hide" : "Show"} Advanced Options
              </button>
              
              {showConfig && (
                <div className="mt-4">
                  <ConfigPanel config={config} onChange={setConfig} />
                </div>
              )}
            </div>

            {currentJob && currentJob.status === "scraping" && (
              <ProgressIndicator job={currentJob} />
            )}
          </div>

          <div className="lg:col-span-2">
            {currentJob ? (
              <ResultsDisplay
                job={currentJob}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
              />
            ) : (
              <div className="bg-card rounded-lg border border-card-border p-12 text-center shadow-sm">
                <div className="max-w-md mx-auto space-y-4">
                  <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto">
                    <Globe className="w-10 h-10 text-muted-foreground" />
                  </div>
                  <h3 className="text-xl font-semibold text-foreground">
                    Ready to Extract Image Data
                  </h3>
                  <p className="text-muted-foreground">
                    Enter one or more SmartFrame search URLs in the form to start scraping image metadata.
                    The tool will automatically handle infinite scrolling and extract detailed information.
                  </p>
                  <div className="pt-4 text-sm text-muted-foreground space-y-1">
                    <p className="font-medium">Example URLs (one per line):</p>
                    <code className="block bg-muted px-4 py-2 rounded-md text-xs break-all whitespace-pre-wrap">
                      https://smartframe.com/search?searchQuery=steps&sortBy=relevance
                    </code>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {showExport && currentJob && (
        <ExportModal
          job={currentJob}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
