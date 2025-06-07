export function unwrap(xml: string, tag: string): string {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    if (!xml.startsWith(openTag) || !xml.endsWith(closeTag)) {
        throw new Error(`Invalid serialized ${tag}: ${xml}`);
    }
    return xml.substring(openTag.length, xml.length - closeTag.length);
}

export function extractElements(xml: string): string[] {
  const elements: string[] = [];
  let depth = 0;
  let startIdx = -1;
  const tagNamePattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagNamePattern.exec(xml)) !== null) {
    if (match[0].startsWith('</')) {
      // Closing tag
      depth--;
      if (depth === 0 && startIdx !== -1) {
        elements.push(xml.substring(startIdx, match.index + match[0].length));
        startIdx = -1;
      } else if (depth < 0) {
        throw new Error(`Unexpected closing tag found: ${match[0]}`);
      }
    } else {
      // Opening tag
      if (depth === 0) startIdx = match.index;
      depth++;
    }
  }

  if (depth !== 0) {
    throw new Error(`Unmatched opening tag`);
  }

  return elements;
}

export function escapeTags(string : string) {
    return string
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/:/g, "&#58;")
    .replace(/`/g, "&#96;")
    .replace(/_/g, "&#95;")
    .replace(/\*/g, "&#42;")
}

export function unescapeTags(string : string) {
    return string
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, "`")
    .replace(/&#95;/g, "_")
    .replace(/&#42;/g, "*")
    .replace(/&#58;/g, ":")
    .replace(/&amp;/g, "&");
}
