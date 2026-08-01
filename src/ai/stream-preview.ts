const escapeValues: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
};

export const extractStreamingSummary = (raw: string) => {
  const match = /"summary"\s*:\s*"/.exec(raw);
  if (!match) return "";
  let result = "";
  for (let index = match.index + match[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') break;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = raw[index + 1];
    if (!escaped) break;
    if (escaped === "u") {
      const code = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(code)) break;
      result += String.fromCharCode(Number.parseInt(code, 16));
      index += 5;
      continue;
    }
    result += escapeValues[escaped] ?? escaped;
    index += 1;
  }
  return result;
};
