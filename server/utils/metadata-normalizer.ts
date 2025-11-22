import { parse, format, isValid } from "date-fns";

/**
 * Fixes common UTF-8 mojibake (mis-encoding) issues
 * Converts sequences like â€œ to proper curly quotes
 */
export function fixMojibake(text: string | null): string | null {
  if (!text) return null;
  
  let fixed = text;
  
  // Map of common mojibake sequences to their intended characters
  const mojibakeMap: Record<string, string> = {
    'â€œ': '\u201C',  // Left double quote "
    'â€': '\u201D',   // Right double quote "
    'â€˜': '\u2018',  // Left single quote '
    'â€™': '\u2019',  // Right single quote '
    'â€"': '\u2014',  // Em dash — (note: en-dash has similar mojibake, may need special handling)
    'â€¢': '\u2022',  // Bullet •
    'â€¦': '\u2026',  // Ellipsis …
    'Â©': '\u00A9',   // Copyright symbol ©
    'Â®': '\u00AE',   // Registered trademark ®
    'Â°': '\u00B0',   // Degree symbol °
    'Ã©': '\u00E9',   // e with acute é
    'Ã¨': '\u00E8',   // e with grave è
    'Ã ': '\u00E0',   // a with grave à
    'Ã¡': '\u00E1',   // a with acute á
    'Ã³': '\u00F3',   // o with acute ó
    'Ã­': '\u00ED',   // i with acute í
    'Ãº': '\u00FA',   // u with acute ú
    'Ã±': '\u00F1',   // n with tilde ñ
    'Ã¼': '\u00FC',   // u with umlaut ü
    'Ã¶': '\u00F6',   // o with umlaut ö
    'Ã¤': '\u00E4',   // a with umlaut ä
  };
  
  // Replace mojibake sequences - process longer sequences first to avoid partial matches
  const sortedMojibake = Object.entries(mojibakeMap).sort((a, b) => b[0].length - a[0].length);
  
  // Replace mojibake sequences - process in sorted order
  for (const [mojibake, correct] of sortedMojibake) {
    // Escape special regex characters in the mojibake sequence
    const escapedMojibake = mojibake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fixed = fixed.replace(new RegExp(escapedMojibake, 'g'), correct);
  }
  
  // Clean up any remaining â€ fragments
  fixed = fixed.replace(/â€/g, '"');
  
  return fixed;
}

/**
 * Decodes HTML entities like &quot;, &amp;, etc.
 */
export function decodeHTMLEntities(text: string | null): string | null {
  if (!text) return null;
  
  const entityMap: Record<string, string> = {
    '&quot;': '"',
    '&#34;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&amp;': '&',
    '&#38;': '&',
    '&lt;': '<',
    '&#60;': '<',
    '&gt;': '>',
    '&#62;': '>',
    '&nbsp;': ' ',
    '&#160;': ' ',
    '&copy;': '©',
    '&#169;': '©',
    '&reg;': '®',
    '&#174;': '®',
    '&trade;': '™',
    '&#8482;': '™',
    '&euro;': '€',
    '&#8364;': '€',
    '&pound;': '£',
    '&#163;': '£',
    '&mdash;': '—',
    '&#8212;': '—',
    '&ndash;': '–',
    '&#8211;': '–',
    '&hellip;': '\u2026',
    '&#8230;': '\u2026',
    '&lsquo;': '\u2018',
    '&#8216;': '\u2018',
    '&rsquo;': '\u2019',
    '&#8217;': '\u2019',
    '&ldquo;': '\u201C',
    '&#8220;': '\u201C',
    '&rdquo;': '\u201D',
    '&#8221;': '\u201D',
  };
  
  let decoded = text;
  for (const [entity, char] of Object.entries(entityMap)) {
    decoded = decoded.replace(new RegExp(entity, 'g'), char);
  }
  
  // Decode numeric entities
  decoded = decoded.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  return decoded;
}

/**
 * Normalizes and repairs dates, especially fixing truncated years like 0012-08-25 → 2012-08-25
 */
export function normalizeDateTaken(dateString: string | null): string | null {
  if (!dateString) return null;
  
  let cleaned = dateString.trim();
  
  // Fix legacy year truncation: 0012-08-25 → 2012-08-25
  const truncatedYearMatch = cleaned.match(/^00(\d{2})-(\d{2})-(\d{2})$/);
  if (truncatedYearMatch) {
    const [, year, month, day] = truncatedYearMatch;
    cleaned = `20${year}-${month}-${day}`;
  }
  
  // Try parsing various date formats
  const formats = [
    'yyyy-MM-dd',           // ISO: 2012-08-25
    'dd MMM yyyy',          // 25 Aug 2012
    'dd.MM.yy',             // 25.08.12
    'dd/MM/yyyy',           // 25/08/2012
    'MM/dd/yyyy',           // 08/25/2012
    'yyyy/MM/dd',           // 2012/08/25
    'd MMMM yyyy',          // 25 August 2012
    'MMMM d, yyyy',         // August 25, 2012
  ];
  
  for (const formatStr of formats) {
    try {
      const parsed = parse(cleaned, formatStr, new Date());
      if (isValid(parsed)) {
        // Return in ISO 8601 format
        return format(parsed, 'yyyy-MM-dd');
      }
    } catch {
      // Try next format
    }
  }
  
  // If already in ISO format, validate and return
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    const parsed = new Date(cleaned);
    if (isValid(parsed)) {
      return cleaned;
    }
  }
  
  // Return cleaned string if parsing failed but looks like a date
  if (/\d{4}/.test(cleaned)) {
    return cleaned;
  }
  
  return null;
}

/**
 * Cleans text by removing excess whitespace and punctuation
 */
export function cleanText(text: string | null): string | null {
  if (!text) return null;
  
  let cleaned = text;
  
  // Apply mojibake fixes
  cleaned = fixMojibake(cleaned) || '';
  
  // Decode HTML entities
  cleaned = decodeHTMLEntities(cleaned) || '';
  
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Remove excess punctuation at start/end
  cleaned = cleaned.replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, '');
  
  return cleaned || null;
}

/**
 * Location stopwords that should ONLY be stripped in metadata context
 * These can be part of proper names (Paris Hilton, New York Yankees, Los Angeles Lakers, etc.)
 */
const LOCATION_STOPWORDS = [
  // Cities
  'london',
  'new york',
  'los angeles',
  'paris',
  'hollywood',
  'milan',
  'tokyo',
  'berlin',
  'rome',
  'madrid',
  'barcelona',
  'sydney',
  'toronto',
  'vancouver',
  'chicago',
  'san francisco',
  'miami',
  'las vegas',
  'boston',
  'seattle',
  'washington',
  'dublin',
  'amsterdam',
  'munich',
  'vienna',
  'zurich',
  'brussels',
  'lisbon',
  'athens',
  'beijing',
  'shanghai',
  'hong kong',
  'singapore',
  'dubai',
  'mumbai',
  'new delhi',
  'moscow',
  'sao paulo',
  'rio de janeiro',
  'mexico city',
  'seoul',
  
  // Countries
  'france',
  'uk',
  'united kingdom',
  'usa',
  'united states',
  'us',
  'germany',
  'italy',
  'spain',
  'japan',
  'china',
  'canada',
  'australia',
  'brazil',
  'mexico',
  'india',
  'russia',
  'south korea',
  'netherlands',
  'switzerland',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'belgium',
  'austria',
  'portugal',
  'greece',
  'ireland',
  'scotland',
  'wales',
  'england',
  'poland',
  'czech republic',
  'hungary',
  'romania',
  'thailand',
  'singapore',
  'malaysia',
  'indonesia',
  'philippines',
  'vietnam',
  'argentina',
  'chile',
  'colombia',
  'south africa',
  'egypt',
  'turkey',
  'israel',
  'saudi arabia',
  'uae',
  'new zealand',
  
  // Regions
  'europe',
  'asia',
  'africa',
  'america',
  'north america',
  'south america',
  'latin america',
  'middle east',
  'asia pacific',
  'oceania',
  'scandinavia',
];

/**
 * Other metadata stopwords that should be stripped in metadata context
 */
const OTHER_STOPWORDS = [
  'exclusive',
  'mandatory credit',
];

/**
 * Removes diacritics (accents) from text for accent-insensitive matching.
 * Converts "São Paulo" → "Sao Paulo", "Bogotá" → "Bogota", "München" → "Munchen"
 */
function removeDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Strips leading agency prefixes ONLY when they appear in specific patterns:
 * 1. Followed by colon or dash: "WENN: London Fashion..." or "GETTY IMAGES - Event"
 * 2. All-caps multi-word: "GETTY IMAGES London Fashion..."
 * 
 * Does NOT strip partial matches or lowercase variants.
 * 
 * Examples:
 * - "WENN: Paris Hilton arrives" → "Paris Hilton arrives"
 * - "Getty Images - Event" → "Event"
 * - "GETTY IMAGES London Fashion Week" → "London Fashion Week"
 * - "Getty Images London" (mixed case, no separator) → "Getty Images London" (unchanged)
 */
function stripLeadingAgencyPrefixes(subject: string): string {
  let cleaned = subject;
  
  // Pattern 1: Agency name (case-insensitive) followed by colon or dash
  // Matches: "WENN:", "Getty Images -", "Reuters–", etc.
  const agencyWithSeparator = /^(WENN|Getty Images?|WireImage|FilmMagic|Rex Features?|Shutterstock|PA Images?|AFP|EPA|Reuters|Associated Press)\s*[:－–\-]\s*/i;
  cleaned = cleaned.replace(agencyWithSeparator, '');
  
  // Pattern 2: All-caps agency name (multi-word must be all caps)
  // Matches: "WENN ", "GETTY IMAGES ", "ASSOCIATED PRESS "
  // Does NOT match: "Getty Images " (mixed case)
  const allCapsAgency = /^(WENN|GETTY IMAGES?|WIREIMAGE|FILMMAGIC|REX FEATURES?|SHUTTERSTOCK|PA IMAGES?|AFP|EPA|REUTERS|ASSOCIATED PRESS)\s+/;
  cleaned = cleaned.replace(allCapsAgency, '');
  
  return cleaned;
}

/**
 * Strips leading stopwords from a subject string using a conservative, punctuation-based approach.
 * 
 * Iteratively removes MULTIPLE consecutive stopwords when IMMEDIATELY followed by punctuation (: - , ;).
 * This is the most reliable signal that a word is metadata context, not part of a proper name.
 * 
 * Examples:
 *   "Paris, France - Event" → "Event" (remove "Paris", then "France" iteratively)
 *   "London, UK - Fashion Week" → "Fashion Week" (remove "London", then "UK" iteratively)
 *   "New York, USA - Conference" → "Conference" (remove "New York", then "USA" iteratively)
 *   "London: Fashion Week" → "Fashion Week" (remove "London", has colon)
 *   "Paris Hilton attends" → "Paris Hilton attends" (keep "Paris", followed by space + word)
 *   "Los Angeles Lakers" → "Los Angeles Lakers" (keep both, no punctuation)
 *   "Los Angeles-based startup" → "Los Angeles-based startup" (hyphen + letter, keeps)
 */
function stripLeadingStopwords(subject: string): string {
  let cleaned = subject;
  let changed = true;
  
  // Combine all stopword lists
  const allStopwords = [...LOCATION_STOPWORDS, ...OTHER_STOPWORDS];
  
  // Iterate until no more leading stopwords are found
  while (changed) {
    changed = false;
    const normalizedCleaned = removeDiacritics(cleaned.toLowerCase());
    
    for (const stopword of allStopwords) {
      // Check if the subject starts with the stopword (accent-insensitive)
      if (normalizedCleaned.startsWith(stopword)) {
        const afterStopword = cleaned.substring(stopword.length);
        
        // Check if entire subject is just the stopword - remove it
        if (afterStopword.trim() === '') {
          return '';
        }
        
        // Get the first non-whitespace character after the stopword
        const trimmedAfter = afterStopword.trimStart();
        const nextChar = trimmedAfter[0];
        const charAfterNext = trimmedAfter[1];
        
        // Only remove stopword if immediately followed by punctuation separator
        // AND the punctuation is followed by space or end of string (not a letter)
        const isMetadataContext = 
          (nextChar === ':' || nextChar === '-' || nextChar === '–' || nextChar === '—' || nextChar === '－' || nextChar === ',' || nextChar === ';') &&
          (charAfterNext === ' ' || charAfterNext === undefined);
        
        // Only strip if metadata context is detected
        if (isMetadataContext) {
          cleaned = trimmedAfter;
          // Remove leading punctuation that may remain
          cleaned = cleaned.replace(/^[,:\-–－;]\s*/, '');
          changed = true;
          break;
        }
      }
    }
  }
  
  return cleaned;
}

/**
 * Extracts the primary subject (person, group, event) from title or caption
 * Uses sophisticated anchored regex patterns and multi-pass extraction
 */
export function extractSubject(title: string | null, caption: string | null): string | null {
  const text = title || caption;
  if (!text) return null;
  
  // Clean the text first
  let cleaned = cleanText(text);
  if (!cleaned) return null;
  
  // PASS 0: DISABLED - Retain agency prefixes per user requirement
  // Previously stripped: "WENN: Paris Hilton" → "Paris Hilton"
  // Now preserves: "WENN: Paris Hilton" → "WENN: Paris Hilton" (kept as-is)
  // cleaned = stripLeadingAgencyPrefixes(cleaned);
  
  // PASS 1: Anchored regex for pattern "Subject at/during/outside Event"
  // Matches: "John Smith at the Premier" → "John Smith"
  // Matches: "Taylor Swift & Travis Kelce attending" → "Taylor Swift & Travis Kelce"
  const anchoredPattern = /^([A-Z][\w''.-]*(?:\s+(?:[A-Z][\w''.-]*|&|and|of|the|de|von|van)){0,7})(?=\s+(?:at|outside|during|ahead of|before|after|for|in|on|to|launching|attending|arrives?|seen|spotted|visits?|leaves?|departs?)\b)/i;
  
  const anchoredMatch = cleaned.match(anchoredPattern);
  if (anchoredMatch && anchoredMatch[1]) {
    let subject = anchoredMatch[1].trim();
    
    // Strip leading stopwords after regex capture
    subject = stripLeadingStopwords(subject);
    
    if (subject && subject.length >= 3 && subject.length <= 100) {
      return subject;
    }
  }
  
  // PASS 2: Em-dash and colon splits (common in professional captions)
  // "Subject — Event Description" → "Subject"
  // "Subject: Additional Details" → "Subject"
  const structuralSeparators = [' — ', ' – ', ' - ', ': '];
  for (const sep of structuralSeparators) {
    const parts = cleaned.split(sep);
    if (parts.length >= 2 && parts[0].length > 3 && parts[0].length <= 100) {
      let candidate = parts[0].trim();
      
      // Strip leading stopwords after capture
      candidate = stripLeadingStopwords(candidate);
      
      if (candidate && candidate.length >= 3) {
        return candidate;
      }
    }
  }
  
  // PASS 3: Preposition-based extraction (looser than anchored)
  // Look for common prepositions that separate subject from context
  const prepositions = [' at ', ' outside ', ' attending ', ' during ', ' in ', ' on '];
  for (const prep of prepositions) {
    const idx = cleaned.toLowerCase().indexOf(prep);
    if (idx > 3 && idx < 100) {
      let candidate = cleaned.substring(0, idx).trim();
      
      // Strip leading stopwords after capture
      candidate = stripLeadingStopwords(candidate);
      
      if (candidate && candidate.length >= 3) {
        return candidate;
      }
    }
  }
  
  // PASS 4: First clause extraction (conservative truncation)
  // Extract up to first sentence-ending punctuation
  const firstSentence = cleaned.split(/[.!?;]/)[0];
  if (firstSentence && firstSentence.length >= 3 && firstSentence.length <= 100) {
    let candidate = firstSentence.trim();
    
    // Strip leading stopwords after capture
    candidate = stripLeadingStopwords(candidate);
    
    if (candidate && candidate.length >= 3) {
      return candidate;
    }
  }
  
  // PASS 5: Conservative truncation (last resort)
  // Return first 80 characters if nothing else worked
  if (cleaned.length > 80) {
    return cleaned.substring(0, 80).trim() + '...';
  }
  
  return cleaned;
}

/**
 * Normalizes tags/keywords - removes duplicates, normalizes casing
 */
export function normalizeTags(tags: string[] | string | null): string | null {
  if (!tags) return null;
  
  // Convert to array if string
  let tagArray: string[];
  if (typeof tags === 'string') {
    // Split by common delimiters
    tagArray = tags.split(/[;,]/).map(t => t.trim()).filter(Boolean);
  } else {
    tagArray = tags;
  }
  
  if (tagArray.length === 0) return null;
  
  // Clean each tag
  const cleanedTags = tagArray
    .map(tag => cleanText(tag))
    .filter((tag): tag is string => tag !== null && tag.length > 0);
  
  // Remove duplicates (case-insensitive)
  const uniqueTags = Array.from(
    new Map(cleanedTags.map(tag => [tag.toLowerCase(), tag])).values()
  );
  
  if (uniqueTags.length === 0) return null;
  
  // Join with semicolons
  return uniqueTags.join('; ');
}

/**
 * Cleans copyright field - removes phone numbers, links, excess noise
 * Preserves copyright symbol and year
 */
export function cleanCopyright(copyright: string | null): string | null {
  if (!copyright) return null;
  
  let cleaned = cleanText(copyright);
  if (!cleaned) return null;
  
  // Remove phone numbers (various formats)
  cleaned = cleaned.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '');
  cleaned = cleaned.replace(/\b\d{10,}\b/g, '');
  
  // Remove URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
  cleaned = cleaned.replace(/www\.[^\s]+/g, '');
  
  // Remove email addresses
  cleaned = cleaned.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '');
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Ensure © symbol is preserved
  if (!cleaned.includes('©') && cleaned.includes('Copyright')) {
    cleaned = cleaned.replace('Copyright', '©');
  }
  
  return cleaned || null;
}

/**
 * Multi-pass text purification for Comments field
 * Removes administrative/legal boilerplate and structural metadata
 * Returns only clean, descriptive narrative content
 */
export function cleanComments(
  caption: string | null,
  captionRaw: string | null,
  matchEvent: string | null
): string | null {
  const text = captionRaw || caption || matchEvent;
  if (!text) return null;
  
  // STEP 1: Preserve paragraph breaks BEFORE cleanText destroys them
  // Use a unique sentinel that won't appear in real text
  const PARAGRAPH_SENTINEL = '<<PARAGRAPH>>';
  let textWithSentinel = text.replace(/\n\n+/g, PARAGRAPH_SENTINEL);
  
  // STEP 2: Apply cleanText for mojibake and HTML entity fixes
  // Note: cleanText will normalize whitespace, but won't affect our sentinel
  let cleaned = cleanText(textWithSentinel);
  if (!cleaned) return null;
  
  // PASS 2: Remove structural metadata headers with various punctuation
  // Patterns: "Featuring:", "Where :", "When－", "Credit~", etc.
  const structuralHeaders = [
    /^\s*Featuring\s*[:－–~]\s*/gim,
    /^\s*Where\s*[:－–~]\s*/gim,
    /^\s*When\s*[:－–~]\s*/gim,
    /^\s*Credit\s*[:－–~]\s*/gim,
    /^\s*Photographer\s*[:－–~]\s*/gim,
    /^\s*Photo\s*by\s*[:－–~]?\s*/gim,
    /^\s*Image\s*[:－–~]\s*/gim,
    /^\s*Caption\s*[:－–~]\s*/gim,
  ];
  
  for (const pattern of structuralHeaders) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // PASS 3: Remove location/date stubs at start of lines
  // Pattern: "London, UK 15 Jan 2024" or "New York, 25 August 2012"
  const locationDatePattern = /^[A-Z][a-z]+(?:,\s[A-Za-z ]+)?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*\s+\d{4}\s*[:-]?\s*/gim;
  cleaned = cleaned.replace(locationDatePattern, '');
  
  // PASS 4: CRITICAL - Remove legal boilerplate and agency disclaimers
  // These patterns must be removed for enterprise-grade clean data
  // Updated to capture multi-sentence legal blocks
  
  // WENN indemnification and liability text (multi-sentence)
  const wennPatterns = [
    /WENN\s+(?:does not claim|makes no representations?|assumes? no (?:responsibility|liability))(?:[^.]*\.){1,5}/gi,
    /(?:reproduction|use|publication).*?(?:responsibility|liability|indemnification)(?:[^.]*\.){1,3}/gi,
    /you\s+(?:accept|agree to|assume)\s+(?:all|any)\s+(?:responsibility|liability|risk)(?:[^.]*\.){1,3}/gi,
    /this\s+image\s+(?:remains|is)\s+(?:property|copyright)(?:[^.]*\.){1,5}/gi,
    /all\s+(?:terms|rights)?\s*(?:and\s+conditions)?\s*(?:apply|reserved)(?:[^.]*\.){0,2}/gi,
  ];
  
  for (const pattern of wennPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // Editorial use restrictions (multi-sentence)
  const editorialPatterns = [
    /editorial\s+use\s+only(?:[^.]*\.){1,3}/gi,
    /not\s+for\s+(?:commercial|advertising)\s+use(?:[^.]*\.){1,3}/gi,
    /for\s+editorial\s+purposes?\s+only(?:[^.]*\.){1,3}/gi,
    /mandatory\s+credit(?:[^.]*\.){1,2}/gi,
    /must\s+be\s+credited(?:[^.]*\.){1,2}/gi,
  ];
  
  for (const pattern of editorialPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // Copyright and reproduction restrictions (multi-sentence)
  const copyrightPatterns = [
    /©\s*\d{4}.*?(?:all rights reserved|ltd|inc|limited|photo|images?|wire|getty)(?:[^.]*\.){1,3}/gi,
    /(?:no|not to be)\s+(?:sold|syndicated|archived|reproduced)(?:[^.]*\.){1,3}/gi,
    /(?:unauthorized|improper)\s+(?:use|reproduction|distribution)(?:[^.]*\.){1,3}/gi,
    /(?:permission|license)\s+(?:required|must be obtained)(?:[^.]*\.){1,3}/gi,
    /(?:violators?|infringement)\s+(?:will be|subject to)(?:[^.]*\.){1,3}/gi,
  ];
  
  for (const pattern of copyrightPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // Agency disclaimers and warnings (multi-sentence)
  const disclaimerPatterns = [
    /(?:getty images?|wireimage|wenn|rex features?|shutterstock|pa (?:images?|photos?))\s+(?:makes?|assumes?|claims?)(?:[^.]*\.){1,3}/gi,
    /(?:photo|image)\s+(?:credit|courtesy|supplied by)(?:[^.]*\.){1,2}/gi,
    /contact\s+(?:your|the)\s+(?:account|local)\s+(?:representative|office)(?:[^.]*\.){1,2}/gi,
  ];
  
  for (const pattern of disclaimerPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // PASS 5: Remove photographer/credit lines that survived initial cleanup
  const creditLinePatterns = [
    /(?:photo|image|picture)\s+by\s+[A-Z][a-zA-Z\s.'-]+(?:\/[A-Z][a-zA-Z\s&.'-]+)*/gi,
    /\((?:photo|image|picture)\s*[:－]\s*[^)]+\)/gi,
  ];
  
  for (const pattern of creditLinePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  // PASS 6: Collapse multiple punctuation and whitespace
  // Note: Paragraph preservation is handled by sentinel, not here
  cleaned = cleaned
    .replace(/\s*[.]{2,}\s*/g, ' ') // Remove ellipsis artifacts
    .replace(/\s+/g, ' ')           // Collapse multiple spaces (won't affect sentinel)
    .replace(/[,;]\s*[,;]+/g, ',')  // Remove duplicate punctuation
    .trim();
  
  // PASS 7: Remove leading/trailing punctuation artifacts
  cleaned = cleaned
    .replace(/^[.,;:!?\s-]+/, '')   // Remove leading punctuation
    .replace(/[.,;:!?\s-]+$/, '');  // Remove trailing punctuation
  
  // STEP 4: Restore paragraph breaks at the very end
  cleaned = cleaned.replace(new RegExp(PARAGRAPH_SENTINEL, 'g'), '\n\n');
  
  // Final validation: Return null if cleaned text is too short or only contains noise
  if (!cleaned || cleaned.length < 10) {
    return null;
  }
  
  // Check if result is mostly punctuation/numbers (likely parsing artifact)
  const alphaCount = (cleaned.match(/[a-zA-Z]/g) || []).length;
  if (alphaCount < cleaned.length * 0.5) {
    return null;
  }
  
  return cleaned;
}

/**
 * Transforms raw scraped data into clean metadata with exactly 7 fields
 */
export interface CleanImageMetadata {
  imageId: string;
  hash: string;
  url: string;
  copyLink: string;
  smartframeId: string;
  thumbnailUrl: string | null;
  
  // The 7 clean metadata fields for export
  titleField: string | null;
  subjectField: string | null;
  tags: string | null;
  comments: string | null;
  authors: string | null;
  dateTaken: string | null;
  copyright: string | null;
}

export function transformToCleanMetadata(rawImage: any): CleanImageMetadata {
  const title = cleanText(rawImage.title);
  const extractedSubject = extractSubject(rawImage.title, rawImage.caption);
  const cleanedAuthors = cleanText(rawImage.authors || rawImage.photographer);
  const cleanedDate = normalizeDateTaken(rawImage.dateTaken || rawImage.date);
  const cleanedCopyright = cleanCopyright(rawImage.copyright || rawImage.photographer);
  const cleanedComments = cleanComments(rawImage.caption, rawImage.captionRaw, rawImage.matchEvent);
  
  // Subject Field: Use title if extracted subject is shorter or a substring of title
  let subjectField = extractedSubject;
  if (title && extractedSubject) {
    // If extracted subject is shorter than title or is a substring of title, use title instead
    if (extractedSubject.length < title.length || title.includes(extractedSubject)) {
      subjectField = title;
    }
  } else if (title) {
    // If no subject extracted, use title
    subjectField = title;
  }
  
  // Comments: Combine cleaned comments with comprehensive metadata
  let comprehensiveComments = cleanedComments || '';
  
  // Append additional metadata to comments for comprehensive information
  const metadataLines: string[] = [];
  if (cleanedAuthors) {
    metadataLines.push(`Author: ${cleanedAuthors}`);
  }
  if (cleanedDate) {
    metadataLines.push(`Date: ${cleanedDate}`);
  }
  if (cleanedCopyright) {
    metadataLines.push(`Copyright: ${cleanedCopyright}`);
  }
  
  if (metadataLines.length > 0) {
    if (comprehensiveComments) {
      // Add metadata after the main comments, separated by double newline
      comprehensiveComments = comprehensiveComments + '\n\n' + metadataLines.join('\n');
    } else {
      // If no comments, just use the metadata
      comprehensiveComments = metadataLines.join('\n');
    }
  }
  
  return {
    // Keep technical fields as-is
    imageId: rawImage.imageId,
    hash: rawImage.hash,
    url: rawImage.url,
    copyLink: rawImage.copyLink,
    smartframeId: rawImage.smartframeId,
    thumbnailUrl: rawImage.thumbnailUrl,
    
    // Transform to 7 clean fields
    titleField: title,
    subjectField: subjectField,
    tags: normalizeTags(rawImage.tags),
    comments: comprehensiveComments || null,
    authors: cleanedAuthors,
    dateTaken: cleanedDate,
    copyright: cleanedCopyright,
  };
}
