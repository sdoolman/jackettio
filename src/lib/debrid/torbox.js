import { createHash } from 'crypto';
import { ERROR } from './const.js';

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlanhmeXRrbm5rb2VndHRldXpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjkxMjgzMzAsImV4cCI6MjA0NDcwNDMzMH0.vIQWcZuN6Nx3DnkmsWLK25J8BM3TTA_8Tb4GoK99MqM';
const SUPABASE_REFRESH_URL = 'https://db.torbox.app/auth/v1/token?grant_type=refresh_token';
const API_BASE = 'https://api.torbox.app/v1/api';

// In-memory token cache: refreshToken -> { accessToken, expiresAt }
const tokenCache = new Map();

export async function getAccessTokenFromRefreshToken(refreshToken) {
  if (!refreshToken) {
    throw new Error('Torbox refresh token is missing. Please re-authenticate on the configure page.');
  }

  const cached = tokenCache.get(refreshToken);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  const res = await fetch(SUPABASE_REFRESH_URL, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({ refresh_token: refreshToken })
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    tokenCache.delete(refreshToken);
    throw new Error(data.msg || data.error_description || 'Torbox session expired. Please re-authenticate on the configure page.');
  }

  // Cache token for (expires_in - 300) seconds (~55 minutes)
  const ttlMs = ((data.expires_in || 3600) - 300) * 1000;
  tokenCache.set(refreshToken, {
    accessToken: data.access_token,
    expiresAt: Date.now() + ttlMs
  });

  return data.access_token;
}

export default class Torbox {
  static id = 'torbox';
  static name = 'Torbox Free Tier (Web Auth)';
  static shortName = 'TB';
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
    this.id = Torbox.id;
    this.name = Torbox.name;
    this.shortName = Torbox.shortName;
  }

  async getUserHash() {
    return createHash('md5').update(this.#refreshToken || this.#email).digest('hex');
  }

  async getTorrentsCached(torrents, isValidCachedFiles) {
    const hashList = torrents.map(t => t.infos?.infoHash).filter(Boolean);
    if (!hashList.length) return [];

    // Query in batches of 50 hashes to avoid URL length issues
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
        console.error(`Torbox: checkcached error:`, err.message);
      }
    }

    return torrents.filter(torrent => {
      const hash = torrent.infos?.infoHash?.toLowerCase();
      const entry = allCached[hash] || (torrent.infos?.infoHash ? allCached[torrent.infos.infoHash] : null);
      if (!entry) return false;

      // Check files array if provided
      if (Array.isArray(entry.files) && entry.files.length > 0) {
        const files = entry.files.map(f => ({ name: f.name, size: f.size }));
        return isValidCachedFiles(files);
      }

      return isValidCachedFiles([]);
    });
  }

  async getProgressTorrents(torrents) {
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
    // 1. Safety check: ensure the torrent is cached to protect the user's free slot
    const check = await this.#request('GET', `/torrents/checkcached?hash=${infoHash}&format=object`);
    const isCached = check?.data && (check.data[infoHash] || check.data[infoHash.toLowerCase()]);
    if (!isCached) {
      throw new Error('Torbox: Torrent not cached. Skipping to prevent consuming uncached download slot.');
    }

    // 2. Check if already in user's mylist
    let torrent = await this.#findTorrentByHash(infoHash);

    // 3. If not in list, add it via createtorrent
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
      ready: torrent.download_finished
    }));
  }

  async getDownload(file) {
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

    // Auto-retry once if token was rejected
    if (res.status === 401) {
      tokenCache.delete(this.#refreshToken);
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
