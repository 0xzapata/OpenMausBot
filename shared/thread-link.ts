const MAX_LENGTH = 2_048;
const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i;
const GITLAB_MR = /^https?:\/\/[^/]+\/.+\/-\/merge_requests\/(\d+)(?:[/?#]|$)/i;
const CHANGE_REQUEST = /https?:\/\/(?:(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+(?::\d+)?\/[\w./-]+?\/-\/merge_requests\/\d+)/gi;

export function threadLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function threadLinkLabel(url: string): string {
  const github = GITHUB.exec(url);
  if (github) return `#${github[1]}`;
  const mergeRequest = GITLAB_MR.exec(url);
  if (mergeRequest) return `!${mergeRequest[1]}`;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

export function lastChangeRequestUrl(text: string): string | null {
  const match = [...text.matchAll(CHANGE_REQUEST)].at(-1)?.[0];
  return match ? threadLinkUrl(match) : null;
}
