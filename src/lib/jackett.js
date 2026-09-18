import crypto from 'crypto';
import {Parser} from "xml2js";
import config from './config.js';
import cache from './cache.js';
import {numberPad, parseWords} from './util.js';

export const CATEGORY = {
  MOVIE: 2000,
  SERIES: 5000
};

export async function searchMovieTorrents({indexer, name, year}){

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:movie:${indexer}:${name}:${year}`;
  let items = await cache.get(cacheKey);

  if(!items){
    const res = await jackettApi(
      `/api/v2.0/indexers/${indexer}/results/torznab/api`,
      {t: 'search', cat: CATEGORY.MOVIE, q: name}
    );
    items = res?.rss?.channel?.item || [];
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }

  return normalizeItems(items);

}

export async function searchSerieTorrents({indexer, name, year}){

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:serie:${indexer}:${name}:${year}`;
  let items = await cache.get(cacheKey);

  if(!items){
    const res = await jackettApi(
      `/api/v2.0/indexers/${indexer}/results/torznab/api`,
      {t: 'search', cat: CATEGORY.SERIES, q: `${name}`}
    );
    items = res?.rss?.channel?.item || [];
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }

  return normalizeItems(items);

}

export async function searchSeasonTorrents({indexer, name, year, season}){

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:season:${indexer}:${name}:${year}:${season}`;
  let items = await cache.get(cacheKey);

  if(!items){
    const res = await jackettApi(
      `/api/v2.0/indexers/${indexer}/results/torznab/api`,
      {t: 'search', cat: CATEGORY.SERIES, q: `${name} S${numberPad(season)}`}
    );
    items = res?.rss?.channel?.item || [];
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }

  return normalizeItems(items);

}

export async function searchEpisodeTorrents({indexer, name, year, season, episode}){

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:episode:${indexer}:${name}:${year}:${season}:${episode}`;
  let items = await cache.get(cacheKey);

  if(!items){
    const res = await jackettApi(
      `/api/v2.0/indexers/${indexer}/results/torznab/api`,
      {t: 'search', cat: CATEGORY.SERIES, q: `${name} S${numberPad(season)}E${numberPad(episode)}`}
    );
    items = res?.rss?.channel?.item || [];
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }

  return normalizeItems(items);

}

export async function getIndexers(){

  // 1. Try Prowlarr native indexer API
  try {
    const pRes = await fetch(`${config.jackettUrl}/api/v1/indexer`, {
      headers: { 'X-Api-Key': config.jackettApiKey, 'Accept': 'application/json' }
    });
    if(pRes.ok){
      const list = await pRes.json();
      return list.filter(i => i.enable).map(i => {
        const cats = (i.capabilities?.categories || []).map(c => c.id);
        return {
          id: i.id,
          configured: true,
          title: i.name,
          language: 'en-US',
          type: 'public',
          categories: cats,
          searching: {
            movie: {
              available: cats.some(c => c >= 2000 && c < 3000) || true,
              supportedParams: ['q']
            },
            series: {
              available: cats.some(c => c >= 5000 && c < 6000) || true,
              supportedParams: ['q', 'season', 'ep']
            }
          }
        };
      });
    }
  }catch{}

  // 2. Fallback to standard Jackett API
  const res = await jackettApi(
    '/api/v2.0/indexers/all/results/torznab/api',
    {t: 'indexers', configured: 'true'}
  );

  return normalizeIndexers(res?.indexers?.indexer || []);

}

async function jackettApi(path, query){

  const params = new URLSearchParams(query || {});
  params.set('apikey', config.jackettApiKey);

  // Map Jackett path to Prowlarr path if needed:
  // /api/v2.0/indexers/${indexer}/results/torznab/api -> /${indexer}/api
  let apiPath = path;
  const torznabMatch = apiPath.match(/\/api\/v2\.0\/indexers\/([^\/]+)\/results\/torznab\/api/);
  if(torznabMatch){
    apiPath = `/${torznabMatch[1]}/api`;
  }

  const url = `${config.jackettUrl}${apiPath}?${params.toString()}`;

  let data;
  const res = await fetch(url, { headers: { 'X-Api-Key': config.jackettApiKey } });
  const contentType = res.headers.get('content-type') || '';
  if(contentType.includes('application/json')){
    data = await res.json();
  }else{
    const text = await res.text();
    if(!text || res.status >= 400){
      throw new Error(`jackettApi HTTP ${res.status}: ${text || 'Empty response'}`);
    }
    const parser = new Parser({explicitArray: false, ignoreAttrs: false});
    data = await parser.parseStringPromise(text);
  }

  if(data.error){
    throw new Error(`jackettApi: ${url.replace(/apikey=[a-z0-9\-]+/, 'apikey=****')} : ${data.error?.$?.description || data.error}`);
  }

  return data;

}

function normalizeItems(items){
  return forceArray(items).map(item => {
    item = mergeDollarKeys(item);
    const rawAttr = item['torznab:attr'] || [];
    const attr = forceArray(rawAttr).reduce((obj, item) => {
      if(item && item.name){
        obj[item.name] = item.value;
      }
      return obj;
    }, {});
    const quality = item.title.match(/(2160|1080|720|480|360)p/);
    const title = parseWords(item.title).join(' ');
    const year = item.title.replace(quality ? quality[1] : '', '').match(/(19|20[\d]{2})/);
    return {
      name: item.title,
      guid: item.guid,
      indexerId: item.jackettindexer?.id || item.prowlarrindexer?.id || item.prowlarrindexer?.$?.id || 0,
      id: crypto.createHash('sha1').update(item.guid || item.title).digest('hex'),
      size: parseInt(item.size || 0),
      link: item.link,
      seeders: parseInt(attr.seeders || 0),
      peers: parseInt(attr.peers || 0),
      infoHash: attr.infohash || '',
      magneturl: attr.magneturl || '', 
      type: item.type,
      quality: quality ? parseInt(quality[1]) : 0,
      year: year ? parseInt(year.pop()) : 0,
      languages: config.languages.filter(lang => title.match(lang.pattern))
    };
  });
}

function normalizeIndexers(items){
  return forceArray(items).map(item => {
    item = mergeDollarKeys(item);
    const searching = item.caps?.searching || {};
    return {
      id: item.id,
      configured: item.configured == 'true',
      title: item.title,
      language: item.language,
      type: item.type,
      categories: forceArray(item.caps?.categories?.category || []).map(category => parseInt(category.id)),
      searching: {
        movie: {
          available: searching['movie-search']?.available == 'yes', 
          supportedParams: (searching['movie-search']?.supportedParams || '').split(',')
        },
        series: {
          available: searching['tv-search']?.available == 'yes', 
          supportedParams: (searching['tv-search']?.supportedParams || '').split(',')
        }
      }
    };
  });
}

function mergeDollarKeys(item){
  if(item.$){
    item = {...item.$, ...item};
    delete item.$;
  }
  for(let key in item){
    if(typeof(item[key]) === 'object'){
      item[key] = mergeDollarKeys(item[key]);
    }
  }
  return item;
}

function forceArray(value){
  return Array.isArray(value) ? value : [value];
}
