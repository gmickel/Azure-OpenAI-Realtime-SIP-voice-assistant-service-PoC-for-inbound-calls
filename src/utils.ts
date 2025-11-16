// Type guard to check if value is a record
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Helper to safely get string from unknown
function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const SIP_PHONE_REGEX = /sip:(\+?\d+)@/;

/**
 * Extracts the caller's phone number from SIP headers
 * @param sipHeaders Array of SIP header objects
 * @returns Phone number string or undefined if not found
 */
export function extractCallerPhone(sipHeaders: unknown[]): string | undefined {
  const fromHeader = sipHeaders.find((h: unknown) => {
    if (!isRecord(h)) {
      return false;
    }
    return getString(h.name)?.toLowerCase() === 'from';
  });

  if (fromHeader && isRecord(fromHeader)) {
    const fromValue = getString(fromHeader.value);
    const phoneMatch = fromValue?.match(SIP_PHONE_REGEX);
    return phoneMatch?.[1];
  }

  return;
}
