import { ScrapeJob } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { StatusBadge } from "./status-badge";

interface ProgressIndicatorProps {
  job: ScrapeJob;
}

export function ProgressIndicator({ job }: ProgressIndicatorProps) {
  const Icon = job.status === "scraping" 
    ? Loader2 
    : job.status === "completed" 
    ? CheckCircle2 
    : AlertCircle;

  const iconColor = job.status === "scraping"
    ? "text-primary"
    : job.status === "completed"
    ? "text-success"
    : "text-destructive";

  return (
    <Card className="p-6" data-testid="card-progress">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-card-foreground">
            Scraping Progress
          </h3>
          <StatusBadge status={job.status} />
        </div>

        <Progress value={job.progress} className="h-2" />

        <div className="flex items-center gap-2 text-sm">
          <Icon className={`w-4 h-4 ${iconColor} ${job.status === "scraping" ? "animate-spin" : ""}`} />
          <span className="text-muted-foreground">
            {job.scrapedImages} of {job.totalImages || "?"} images scraped
          </span>
          <span className="text-muted-foreground ml-auto">
            {Math.round(job.progress)}%
          </span>
        </div>

        {job.error && (
          <div className="text-xs text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
            <p className="font-medium">Error:</p>
            <p className="mt-1">{job.error}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
