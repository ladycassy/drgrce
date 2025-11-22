import { Badge } from "@/components/ui/badge";
import { ScrapeJob } from "@shared/schema";

interface StatusBadgeProps {
  status: ScrapeJob["status"];
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const variants = {
    pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
    scraping: { label: "Scraping", className: "bg-primary text-primary-foreground" },
    completed: { label: "Complete", className: "bg-success text-success-foreground" },
    error: { label: "Error", className: "bg-destructive text-destructive-foreground" },
  };

  const config = variants[status];

  return (
    <Badge className={config.className} data-testid={`badge-status-${status}`}>
      {config.label}
    </Badge>
  );
}
