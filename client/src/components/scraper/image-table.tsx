import { useCallback } from "react";
import { ScrapedImage } from "@shared/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Copy, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ImageTableProps {
  images: ScrapedImage[];
}

export function ImageTable({ images }: ImageTableProps) {
  const { toast } = useToast();

  const handleCopyLink = useCallback(async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast({
        title: "Link Copied",
        description: "The image URL has been copied to your clipboard.",
      });
    } catch (error) {
      toast({
        title: "Copy Failed",
        description: "Could not copy the link to clipboard.",
        variant: "destructive",
      });
    }
  }, [toast]);

  if (images.length === 0) {
    return (
      <div className="bg-card rounded-lg border border-card-border p-12 text-center">
        <p className="text-muted-foreground">No images match your search criteria.</p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-lg border border-card-border overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Preview</TableHead>
              <TableHead>Image ID</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Authors</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Date Taken</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {images.map((image) => (
              <TableRow key={image.imageId} data-testid={`row-image-${image.imageId}`}>
                <TableCell>
                  <div className="w-16 h-16 bg-muted rounded-md flex items-center justify-center overflow-hidden">
                    {image.thumbnailUrl ? (
                      <img
                        src={image.thumbnailUrl}
                        alt={image.smartframeId}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <ImageIcon className="w-6 h-6 text-muted-foreground" />
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm">{image.smartframeId}</TableCell>
                <TableCell className="text-sm">{image.titleField || "—"}</TableCell>
                <TableCell className="text-sm">{image.authors || "—"}</TableCell>
                <TableCell className="text-sm">{image.subjectField || "—"}</TableCell>
                <TableCell className="text-sm">{image.dateTaken || "—"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleCopyLink(image.copyLink)}
                      data-testid={`button-copy-table-${image.imageId}`}
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      asChild
                    >
                      <a
                        href={image.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`button-view-table-${image.imageId}`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
