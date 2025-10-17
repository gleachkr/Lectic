export function unwrap(xml: string, tag: string): string {
    const openTagPattern = new RegExp(`^<${tag}\\b[^>]*>`)
    const closeTag = `</${tag}>`;
    const openMatch = openTagPattern.exec(xml)
    if (!openMatch || !xml.endsWith(closeTag)) {
        throw new Error(`Invalid serialized ${tag}: ${xml}`);
    }
    return xml.substring(openMatch[0].length, xml.length - closeTag.length);
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
    return `\n${string}`
        .replace(/\n/g, '\n┆')
        .replace(/</g, '<│') + '\n'

}

export function unescapeTags(string : string) {
    return string.slice(0,-1)
        .replace(/\n┆/g, '\n')
        .replace(/^\r?\n/, '')
        .replace(/<│/g, '<')
}
