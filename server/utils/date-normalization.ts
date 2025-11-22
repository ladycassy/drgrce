import { parse, format, isValid } from 'date-fns';

const DATE_FORMATS = [
  'yyyy-MM-dd',
  'dd MMM yyyy',
  'd MMM yyyy',
  'MMMM dd, yyyy',
  'MMMM d, yyyy',
  'MMM dd, yyyy',
  'MMM d, yyyy',
  'dd/MM/yyyy',
  'd/M/yyyy',
  'MM/dd/yyyy',
  'M/d/yyyy',
  'yyyy/MM/dd',
  'dd-MM-yyyy',
  'd-M-yyyy',
  'MM-dd-yyyy',
  'M-d-yyyy',
  'dd.MM.yyyy',
  'd.M.yyyy',
  'dd.MM.yy',
  'd.M.yy',
  'EEEE, MMMM dd, yyyy',
  'EEEE, MMMM d, yyyy',
  'EEEE, dd MMMM yyyy',
  'EEEE, d MMMM yyyy',
];

/**
 * Applies century repair logic to fix truncated years
 * Heuristic: 00YY → 20YY, 0YYY → 20YY (assumes 2000-2099)
 * Iterates until year falls inside [1900, current+1]
 * Preserves genuine 19th-century dates (1800-1899)
 * Examples: 0012 → 2012, 0512 → 2012, 1985 → 1985, 2030 → 1930
 */
function repairCentury(year: number): number {
  const currentYear = new Date().getFullYear();
  let repairedYear = year;
  
  // If year is in format 0-999 (truncated/missing leading digit), add 2000
  if (repairedYear >= 0 && repairedYear < 1000) {
    repairedYear = 2000 + repairedYear;
  }
  
  // Preserve genuine 19th-century dates (1800-1899)
  if (repairedYear >= 1800 && repairedYear < 1900) {
    return repairedYear;
  }
  
  // Iterate: subtract 100 until year falls inside valid range [1900, currentYear+1]
  while (repairedYear > currentYear + 1) {
    repairedYear -= 100;
  }
  
  // Iterate: add 100 if year is too far in the past (shouldn't happen often)
  while (repairedYear < 1800) {
    repairedYear += 100;
  }
  
  return repairedYear;
}

/**
 * Multi-format date parser with bespoke century repair logic
 * Handles truncated years (00XX → 20XX) and validates plausibility
 */
export function normalizeDate(dateString: string | null | undefined): string | null {
  if (!dateString) return null;
  
  // Pre-clean the date string
  let cleanDateString = dateString
    .replace(/\.$/, '')
    .replace(/(\d)(st|nd|rd|th)/g, '$1')
    .trim();

  // Critical Fix: Detect and repair truncated year formats
  // Pattern: 00XX-MM-DD → 20XX-MM-DD
  const truncatedYearMatch = cleanDateString.match(/^00(\d{2})[-/.](\d{2})[-/.](\d{2})$/);
  if (truncatedYearMatch) {
    const [, year, month, day] = truncatedYearMatch;
    cleanDateString = `20${year}-${month}-${day}`;
    console.log(`🔧 Century repair: ${dateString} → ${cleanDateString}`);
  }

  // Pattern: 0XXX-MM-DD → 2XXX-MM-DD (e.g., 0012-08-25 → 2012-08-25)
  const fourDigitTruncMatch = cleanDateString.match(/^0(\d{3})[-/.](\d{2})[-/.](\d{2})$/);
  if (fourDigitTruncMatch) {
    const [, year, month, day] = fourDigitTruncMatch;
    cleanDateString = `2${year}-${month}-${day}`;
    console.log(`🔧 Century repair: ${dateString} → ${cleanDateString}`);
  }

  const referenceDate = new Date();
  
  // Try all supported date formats
  for (const fmt of DATE_FORMATS) {
    try {
      const parsedDate = parse(cleanDateString, fmt, referenceDate);
      
      if (isValid(parsedDate)) {
        const year = parsedDate.getFullYear();
        
        // Apply century repair logic if year is implausible
        if (year < 1900 || year > new Date().getFullYear() + 1) {
          const repairedYear = repairCentury(year);
          if (repairedYear !== year) {
            parsedDate.setFullYear(repairedYear);
            console.log(`🔧 Century repair: ${year} → ${repairedYear} for date ${dateString}`);
          }
        }
        
        return format(parsedDate, 'yyyy-MM-dd');
      }
    } catch (error) {
      // Continue to next format
    }
  }
  
  // Fallback: Try direct parsing
  try {
    const directParse = new Date(cleanDateString);
    if (isValid(directParse) && !isNaN(directParse.getTime())) {
      const year = directParse.getFullYear();
      
      // Apply century repair
      if (year < 1900 || year > new Date().getFullYear() + 1) {
        const repairedYear = repairCentury(year);
        directParse.setFullYear(repairedYear);
        console.log(`🔧 Century repair: ${year} → ${repairedYear} for date ${dateString}`);
      }
      
      return format(directParse, 'yyyy-MM-dd');
    }
  } catch (error) {
    // Continue to error logging
  }
  
  // Log unresolvable dates for investigation
  console.log(`⚠️ Unresolvable date format: "${dateString}"`);
  return null;
}
