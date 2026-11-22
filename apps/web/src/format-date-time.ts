const formatter = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });
export function formatDateTime(timestamp: string): string {
  return formatter.format(new Date(timestamp));
}
