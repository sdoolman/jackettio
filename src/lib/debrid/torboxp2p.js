import { getAccessTokenFromRefreshToken } from './torbox.js';
import { ERROR } from './const.js';

const API_BASE = 'https://api.torbox.app/v1/api';

/**
 * Combined Torbox+P2P provider:
 * - Cached torrents → served via Torbox CDN
 * - Uncached torrents → served as native P2P infoHash streams
 *
 * This protects free-tier Torbox slots: uncached titles never consume a slot.
 */
export default class TorboxP2P {
  static id = 'torboxp2p';
  static name = 'Torbox + P2P Fallback';
  static shortName = 'TB+P2P';
  static cacheCheckAvailable = true;

  static configFields = [
    {
      type: 'text',
      name: 'torboxEmail',
      label: 'Torbox Email',
      required: true
    },
    {
      type: 'password',
      name: 'torboxPassword',
      label: 'Torbox Password (not needed after first install)',
      required: false
    }
  ];

  #refreshToken;
  #email;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.#refreshToken = userConfig.torboxRefreshToken;
    this.#email = userConfig.torboxEmail || '';
    this.userConfig = userConfig;
    this.id = TorboxP2P.id;
    this.name = TorboxP2P.name;
    this.shortName = TorboxP2P.shortName;
  }

  async getUserHash() {
    const { createHash } = await import('crypto');
    return createHash('md5').update(this.#refreshToken || this.#email).digest('hex');
  }

  /**
   * Returns all torrents as "cached" from this provider's perspective —
   * Jackettio will split them into isCached / uncached based on our check below.
   * We mark each torrent with p2pFallback=true if NOT cached on Torbox.
   */
  async getTorrentsCached(torrents, isValidCachedFiles) {
    const hashList = torrents.map(t => t.infos?.infoHash).filter(Boolean);
    if (!hashList.length) return [];

    // Query Torbox cache in batches of 50
    const chunks = [];
    for (let i = 0; i < hashList.length; i += 50) {
      chunks.push(hashList.slice(i, i + 50));
    }

    const allCached = {};
    for (const chunk of chunks) {
      try {
        const res = await this.#request('GET', `/torrents/checkcached?hash=${chunk.join(',')}&format=object&list_files=true`);
        if (res?.data) {
          Object.assign(allCached, res.data);
        }
      } catch (err) {
        console.error(`TorboxP2P: checkcached error:`, err.message);
      }
    }

    // Split: tag cached vs p2p-fallback
    const cachedTorrents = [];
    for (const torrent of torrents) {
      const hash = torrent.infos?.infoHash?.toLowerCase();
      const entry = allCached[hash] || (torrent.infos?.infoHash ? allCached[torrent.infos.infoHash] : null);

      if (entry) {
        let valid = true;
        if (Array.isArray(entry.files) && entry.files.length > 0) {
          const files = entry.files.map(f => ({ name: f.name, size: f.size }));
          valid = isValidCachedFiles(files);
        } else {
          valid = isValidCachedFiles([]);
        }
        if (valid) {
          torrent.p2pFallback = false;
          cachedTorrents.push(torrent);
        }
      }
      // Uncached torrents are NOT added here — Jackettio's getTorrents will
      // keep them in uncachedTorrents and pass through to the stream renderer
      // where we detect p2pFallback is undefined (falsy) for them.
    }

    // Tag all uncached torrents as p2p fallback so the stream renderer knows
    for (const torrent of torrents) {
      if (!cachedTorrents.includes(torrent)) {
        torrent.p2pFallback = true;
      }
    }

    return cachedTorrents;
  }

  async getProgressTorrents(torrents) {
    // Only meaningful for Torbox-cached torrents; P2P ones have no progress
    try {
      const res = await this.#request('GET', '/torrents/mylist');
      return (res?.data || []).reduce((acc, t) => {
        acc[t.hash] = {
          percent: t.progress || (t.download_finished ? 100 : 0),
          speed: t.download_speed || 0
        };
        return acc;
      }, {});
    } catch {
      return {};
    }
  }

  async getFilesFromHash(infoHash) {
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromBuffer(buffer, infoHash) {
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash) {
    // Check cache again at download time to be safe
    const check = await this.#request('GET', `/torrents/checkcached?hash=${infoHash}&format=object`);
    const isCached = check?.data && (check.data[infoHash] || check.data[infoHash.toLowerCase()]);

    if (!isCached) {
      // Return a P2P-style file object — stream renderer will detect this
      return [{ name: infoHash, size: 0, infoHash, url: magnet, link: magnet, p2pFallback: true }];
    }

    // Cached — proceed via Torbox
    let torrent = await this.#findTorrentByHash(infoHash);

    if (!torrent) {
      const body = new FormData();
      body.append('magnet', magnet);
      body.append('seed', '1');
      body.append('allow_zip', 'true');
      await this.#request('POST', '/torrents/createtorrent', { body });
      torrent = await this.#findTorrentByHash(infoHash);
    }

    if (!torrent || !torrent.files) {
      throw new Error(ERROR.NOT_READY);
    }

    return torrent.files.map(file => ({
      name: file.name.split('/').pop(),
      size: file.size,
      id: `${torrent.id}:${file.id}`,
      url: '',
      ready: torrent.download_finished,
      p2pFallback: false
    }));
  }

  async getDownload(file) {
    // P2P fallback files return their magnet/url directly
    if (file.p2pFallback) {
      return file.url || file.link || `magnet:?xt=urn:btih:${file.infoHash}`;
    }

    const [torrentId, fileId] = (file.id || '').split(':');
    if (!torrentId || fileId === undefined) {
      throw new Error(`Invalid file ID: ${file.id}`);
    }

    const token = await this.#getToken();
    const res = await this.#request('GET', `/torrents/requestdl?token=${encodeURIComponent(token)}&torrent_id=${torrentId}&file_id=${fileId}&zip=false`);

    if (!res.success || !res.data) {
      throw new Error(res.detail || ERROR.NOT_READY);
    }

    return res.data;
  }

  async #getToken() {
    return getAccessTokenFromRefreshToken(this.#refreshToken);
  }

  async #request(method, path, options = {}) {
    let token = await this.#getToken();
    let res = await this.#fetchWithToken(method, path, token, options);

    if (res.status === 401) {
      token = await this.#getToken();
      res = await this.#fetchWithToken(method, path, token, options);
    }

    if (!res.ok && res.status !== 404 && res.status !== 400) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Torbox API HTTP ${res.status}: ${errText}`);
    }

    return res.json();
  }

  async #fetchWithToken(method, path, token, options = {}) {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0',
      ...(options.headers || {})
    };
    return fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: options.body
    });
  }

  async #findTorrentByHash(hash) {
    const res = await this.#request('GET', '/torrents/mylist');
    const lower = hash.toLowerCase();
    return (res.data || []).find(t => t.hash && t.hash.toLowerCase() === lower);
  }
}
