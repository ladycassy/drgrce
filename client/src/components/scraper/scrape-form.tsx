import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { ScrapeConfig } from "@shared/schema";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Play } from "lucide-react";

const formSchema = z.object({
  urls: z.string()
    .min(1, "Please enter at least one URL")
    .refine(
      (urls) => {
        const urlList = urls.split('\n').map(u => u.trim()).filter(Boolean);
        return urlList.every(url => {
          try {
            new URL(url);
            return url.includes("smartframe.com");
          } catch {
            return false;
          }
        });
      },
      "All URLs must be valid smartframe.com URLs"
    ),
});

interface ScrapeFormProps {
  onSubmit: (jobIds: string[]) => void;
  isLoading: boolean;
  config: Omit<ScrapeConfig, "url">;
}

export function ScrapeForm({ onSubmit, isLoading, config }: ScrapeFormProps) {
  const { toast } = useToast();
  
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      urls: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema>) => {
      const urlList = data.urls.split('\n').map(u => u.trim()).filter(Boolean);
      const response = await apiRequest("POST", "/api/scrape/bulk", {
        urls: urlList,
        ...config,
      });
      return response;
    },
    onSuccess: (data: any) => {
      const count = data.jobs?.length || 1;
      const duplicatesRemoved = data.duplicatesRemoved || 0;
      
      const description = duplicatesRemoved > 0
        ? `Started ${count} scraping job${count > 1 ? 's' : ''}. Removed ${duplicatesRemoved} duplicate URL${duplicatesRemoved > 1 ? 's' : ''}.`
        : `Started ${count} scraping job${count > 1 ? 's' : ''}. This may take a few minutes.`;
      
      toast({
        title: "Scrape Started",
        description,
      });
      onSubmit(data.jobs?.map((job: any) => job.jobId) || [data.jobId]);
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to start scraping",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (values: z.infer<typeof formSchema>) => {
    mutation.mutate(values);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="urls"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm font-semibold">SmartFrame URLs</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="https://smartframe.com/search?searchQuery=...&#10;https://smartframe.com/search?searchQuery=..."
                  className="min-h-[120px] font-mono text-sm"
                  data-testid="input-urls"
                  disabled={isLoading || mutation.isPending}
                />
              </FormControl>
              <FormDescription className="text-xs">
                Enter one or more SmartFrame search URLs (one per line)
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button
          type="submit"
          className="w-full h-12 gap-2"
          disabled={isLoading || mutation.isPending}
          data-testid="button-start-scrape"
        >
          {mutation.isPending || isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Scraping...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Start Scraping
            </>
          )}
        </Button>
      </form>
    </Form>
  );
}
