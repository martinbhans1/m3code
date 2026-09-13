/**
 * downloadTextFile — hand the user a generated text file.
 *
 * The app has no save-dialog bridge, so an object URL and a synthetic click is
 * the whole mechanism; it behaves the same in the browser and in the desktop
 * shell. Generalized from the plan exporter so a second caller does not have to
 * restate the revoke.
 */
export function downloadTextFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
