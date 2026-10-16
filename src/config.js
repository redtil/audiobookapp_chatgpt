// Keep this copy independent from the original app on the same Pages origin.
export const APP_NAME = "Kokoro Reader · ChatGPT";
export const LIBRARY_NAME = "audiobook-data_chatgpt";
export const STORAGE_PREFIX = "kokoro-reader-chatgpt";

export function repositoryDefaults({ hostname, pathname }) {
  const owner = hostname.match(/^([\w-]+)\.github\.io$/)?.[1];
  const repo = pathname.split("/").filter(Boolean)[0];
  return {
    appRepo: owner && repo ? `${owner}/${repo}` : "redtil/audiobookapp_chatgpt",
    dataRepo: `${owner || "redtil"}/${LIBRARY_NAME}`,
  };
}
