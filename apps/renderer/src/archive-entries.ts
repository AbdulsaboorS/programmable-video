export function assertSafeArchiveEntries(listing: string): void {
  for (const entry of listing.split("\n").filter(Boolean)) {
    if (entry === "./") continue;
    const normalized = entry.replace(/^\.\//, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error("Approved artifact archive contains an unsafe path");
    }
  }
}
