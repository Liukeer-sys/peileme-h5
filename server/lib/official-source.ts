export const GOVERNMENT_HOST_SUFFIXES = ["gov.cn"] as const;

export const isGovernmentHttpsUrl = (value: string) => {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(value);
  } catch {
    return false;
  }

  if (
    sourceUrl.protocol !== "https:" ||
    sourceUrl.username ||
    sourceUrl.password ||
    (sourceUrl.port && sourceUrl.port !== "443")
  ) {
    return false;
  }

  const hostname = sourceUrl.hostname.toLowerCase().replace(/\.$/, "");
  return GOVERNMENT_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
};

export const assertGovernmentHttpsUrl = (value: string, rowNumber: number) => {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(value);
  } catch {
    throw new Error(`Row ${rowNumber}: source_url is not a valid URL`);
  }

  if (
    sourceUrl.protocol !== "https:" ||
    sourceUrl.username ||
    sourceUrl.password ||
    (sourceUrl.port && sourceUrl.port !== "443")
  ) {
    throw new Error(
      `Row ${rowNumber}: source_url must be an HTTPS government URL`
    );
  }

  const hostname = sourceUrl.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = GOVERNMENT_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
  if (!allowed) {
    throw new Error(
      `Row ${rowNumber}: source_url host is not an approved government host`
    );
  }
};
