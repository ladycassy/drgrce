import { ScrapedImage } from "@shared/schema";
import { ImageCard } from "./image-card";

interface ImageGridProps {
  images: ScrapedImage[];
}

export function ImageGrid({ images }: ImageGridProps) {
  if (images.length === 0) {
    return (
      <div className="bg-card rounded-lg border border-card-border p-12 text-center">
        <p className="text-muted-foreground">No images match your search criteria.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {images.map((image) => (
        <ImageCard key={image.imageId} image={image} />
      ))}
    </div>
  );
}
