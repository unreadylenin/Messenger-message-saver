// Rules for the photo / video / reel downloader, shared by the background worker and tests.

import { isFbUrl } from './sanitize.js';

const DOWNLOAD_EXT = /\.(mp4|m4a|jpg|jpeg|png|webp|gif)$/i;

/** Only files on Facebook's own servers may be downloaded (a page cannot misuse the downloader). */
export function isDownloadableUrl(url) {
  return isFbUrl(String(url || ''));
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
