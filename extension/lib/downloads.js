// Rules for the photo / video / reel downloader, shared by the background worker and tests.

const DOWNLOAD_URL = /^https:\/\/(?:[a-z0-9-]+\.)*(?:fbcdn\.net|fbsbx\.com|facebook\.com|messenger\.com)(?::443)?\//i;
const DOWNLOAD_EXT = /\.(mp4|m4a|jpg|jpeg|png|webp|gif)$/i;

/** Only files on Facebook's own servers may be downloaded (a page cannot misuse the downloader). */
export function isDownloadableUrl(url) {
  const u = String(url || '');
  return u.length <= 8000 && DOWNLOAD_URL.test(u);
}

/** A safe file name inside Downloads/Facebook, ending in a photo, video or sound extension. */
export function downloadFileName(name, url) {
  let n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+/, '')
    .trim()
    .slice(0, 140)
    .replace(/[\s.]+$/, '');
  if (!DOWNLOAD_EXT.test(n)) {
    const isVideo = /\.mp4$/i.test(String(url || '').split(/[?#]/)[0]);
    n = (n || 'facebook-' + Date.now()).replace(/\.[a-z0-9]{1,5}$/i, '') + (isVideo ? '.mp4' : '.jpg');
  }
  return 'Facebook/' + n;
}
