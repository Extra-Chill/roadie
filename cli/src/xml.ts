// Strip XML-style context blocks (`<system-reminder>…</system-reminder>`,
// `<discord-user … />`) from prompt text, keeping the person's own words.

// A tag name starts with a letter, so Discord markup such as `<#123>`, `<@456>`
// and `<t:789:f>`, and comparisons like `a < b`, are text, not tags.
const TAG_BLOCK = /<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>|<[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/>/g

export function extractNonXmlContent(text: string): string {
  return text
    .split(TAG_BLOCK)
    .filter((_, index) => index % 2 === 0)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('\n')
}
