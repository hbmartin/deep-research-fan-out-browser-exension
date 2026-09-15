/** Elapsed-time syntax shared by provider progress and DOM activity checks. */
export const DURATION_PATTERN = String.raw`(?:\d{1,3}:\d{2}(?::\d{2})?|(?:\d+\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\s*){1,3})`;

export const PROGRESS_TRAILING_DURATION = new RegExp(
  String.raw`\s*(?:[·•—-]\s*)?${DURATION_PATTERN}\s*$`, 'i',
);
