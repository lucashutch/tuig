import { spawn } from "node:child_process";

/** Opens a URL outside Tuig. Resolves once the opener starts. */
export type UrlOpener = (url: string) => Promise<void>;

/**
 * Open a web URL in the desktop's default browser with `xdg-open`.
 *
 * The opener runs detached, without a shell, and with its output ignored, so
 * it cannot write into the terminal Tuig draws on or outlive a Tuig crash as
 * a child process. Only http and https URLs are accepted.
 */
export const openUrl: UrlOpener = (url) => {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return Promise.reject(new Error(`Not a valid URL: ${url}`));
  }
  if (protocol !== "https:" && protocol !== "http:")
    return Promise.reject(new Error(`Not a web URL: ${url}`));
  return new Promise((resolve, reject) => {
    const child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
};
