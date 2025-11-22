export interface CaptionData {
  title?: string | null;
  captionRaw?: string | null;
  featuring?: string | null;
  city?: string | null;
  country?: string | null;
  dateTaken?: string | null;
  photographer?: string | null;
  copyright?: string | null;
}

export function generateCaption(data: CaptionData): string {
  const lines: string[] = [];
  
  // Add title/description first
  if (data.title) {
    lines.push(data.title);
  }
  
  if (data.captionRaw) {
    lines.push(data.captionRaw);
  }
  
  // Add structured metadata fields
  if (data.featuring) {
    lines.push(`Featuring: ${data.featuring}`);
  }
  
  if (data.city || data.country) {
    const location = [data.city, data.country].filter(Boolean).join(', ');
    lines.push(`Where: ${location}`);
  }
  
  if (data.dateTaken) {
    lines.push(`When: ${data.dateTaken}`);
  }
  
  const credit = data.copyright || data.photographer;
  if (credit) {
    lines.push(`Credit: ${credit}`);
  }
  
  return lines.join('\n');
}
