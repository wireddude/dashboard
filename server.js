const express = require('express');
const app = express();
const path = require('path');
const os = require('os');
const checkDiskSpace = require('check-disk-space').default || require('check-disk-space');
const RSSParser = require('rss-parser');
const yahooFinance = require('yahoo-finance2').default;
try { yahooFinance.suppressNotices(['yahooSurvey']); } catch {}

const port = process.env.PORT || 3000;
// behind reverse proxy (for secure cookies, protocol, etc.)
app.set('trust proxy', 1);

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- News: Top 5 business stories ---
const rssParser = new RSSParser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  },
});

const https = require('https');
const http = require('http');

function fetchUrlText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchUrlText(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('Status ' + res.statusCode));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(7000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

function fetchGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'close',
    }, extraHeaders);
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchGet(res.headers.location, extraHeaders));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('Status ' + res.statusCode));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(7000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchFromFeed(url, sourceName) {
  try {
    const feed = await rssParser.parseURL(url);
    const items = (feed.items || []).slice(0, 5).map((i) => ({
      title: i.title,
      link: i.link,
      pubDate: i.pubDate,
      description: i.contentSnippet || i.content || i.summary || '',
      source: sourceName,
    }));
    if (items.length) return items;
  } catch {}
  // Fallback: manual fetch + parse
  try {
    const xml = await fetchUrlText(url);
    const feed = await rssParser.parseString(xml);
    const items = (feed.items || []).slice(0, 5).map((i) => ({
      title: i.title,
      link: i.link,
      pubDate: i.pubDate,
      description: i.contentSnippet || i.content || i.summary || '',
      source: sourceName,
    }));
    return items;
  } catch {
    return [];
  }
}

function buildNewsKeywords(symbols) {
  const upper = (symbols || []).map((s) => String(s).toUpperCase());
  const symbolToNames = {
    SPY: ['S&P 500'],
    QQQ: ['Nasdaq 100', 'Invesco QQQ'],
    DIA: ['Dow Jones', 'Dow 30'],
    IWM: ['Russell 2000'],
    TLT: ['Treasury', 'Treasuries', 'bond market'],
    TSLA: ['Tesla', 'Elon Musk'],
    MSFT: ['Microsoft'],
    GOOGL: ['Alphabet', 'Google'],
    C: ['Citi', 'Citigroup'],
    ABBV: ['AbbVie'],
    NVDA: ['Nvidia', 'NVDA'],
    TSM: ['TSMC', 'Taiwan Semiconductor'],
    WMT: ['Walmart'],
    BSX: ['Boston Scientific'],
    EOG: ['EOG Resources'],
  };
  const general = [
    'stock market', 'stocks', 'equities', 'Wall Street', 'Dow', 'S&P', 'Nasdaq',
    'futures', 'earnings', 'guidance', 'upgrade', 'downgrade', 'rate cut', 'rate hike',
    'inflation', 'CPI', 'PPI', 'jobs report', 'payrolls', 'FOMC', 'Federal Reserve',
  ];
  const names = upper.flatMap((s) => [
    ...(s.length >= 2 ? [s] : []),
    ...(symbolToNames[s] || []),
  ]);
  return Array.from(new Set([...names, ...general])).filter(Boolean);
}

function buildSymbolKeywordMap(symbols) {
  const upper = (symbols || []).map((s) => String(s).toUpperCase());
  const symbolToNames = {
    SPY: ['S&P 500', 'SPDR S&P 500'],
    QQQ: ['Nasdaq 100', 'Invesco QQQ'],
    DIA: ['Dow Jones', 'Dow 30', 'SPDR Dow Jones'],
    IWM: ['Russell 2000', 'iShares Russell 2000'],
    TLT: ['Treasury', 'Treasuries', '20 Year Treasury', 'iShares 20 Year'],
    TSLA: ['Tesla', 'Elon Musk'],
    MSFT: ['Microsoft'],
    GOOGL: ['Alphabet', 'Google'],
    C: ['Citi', 'Citigroup'],
    ABBV: ['AbbVie'],
    NVDA: ['Nvidia', 'NVDA'],
    TSM: ['TSMC', 'Taiwan Semiconductor'],
    WMT: ['Walmart'],
    BSX: ['Boston Scientific'],
    EOG: ['EOG Resources'],
  };
  const map = {};
  for (const s of upper) {
    const names = symbolToNames[s] || [];
    // Avoid single-letter ticker as a keyword (e.g., 'C')
    const includeSymbol = s.length >= 2;
    map[s] = Array.from(new Set([...(includeSymbol ? [s] : []), ...names]));
  }
  return map;
}

async function fetchTopBusinessNewsFiltered(symbols) {
  const feeds = [
    { url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en', source: 'Google News - Business' },
    { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters' },
    { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch' },
    { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', source: 'CNBC' },
    { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ Markets' },
  ];
  const all = [];
  for (const f of feeds) {
    try {
      const items = await fetchFromFeed(f.url, f.source);
      all.push(...items);
    } catch {}
  }
  // Deduplicate by title
  const seen = new Set();
  const unique = [];
  for (const item of all) {
    const key = (item.title || '').trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  const symMap = buildSymbolKeywordMap(symbols);
  const symList = Object.keys(symMap);
  const annotateTickers = (item) => {
    const text = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
    const matched = [];
    for (const sym of symList) {
      const keys = symMap[sym];
      const hit = keys.some((k) => {
        const key = String(k);
        if (/^[A-Z]{2,}$/.test(key)) {
          // Ticker-like token; use word boundary match, case-insensitive
          const re = new RegExp(`\\b${key}\\b`, 'i');
          return re.test(text);
        }
        return text.includes(key.toLowerCase());
      });
      if (hit) matched.push(sym);
    }
    return { ...item, tickers: matched };
  };
  const annotated = unique.map(annotateTickers);
  const prioritized = annotated.filter((i) => (i.tickers || []).length > 0);
  // Build pool that prefers ticker-matched items, but fills with others to reach target
  const pool = prioritized.length
    ? prioritized.concat(annotated.filter((i) => !prioritized.includes(i)))
    : annotated;

  // Select up to 1 article per ticker first, then allow up to 2 per ticker
  const maxPerTicker = 2;
  const targetTotal = Math.min(12, annotated.length);
  const selected = [];
  const selectedKeys = new Set();
  const perCount = Object.fromEntries(Object.keys(symMap).map((s) => [s, 0]));

  function addIfNew(item, assignedSym) {
    const key = (item.link || item.title || '').toLowerCase();
    if (selectedKeys.has(key)) return false;
    selected.push(item);
    selectedKeys.add(key);
    if (assignedSym) perCount[assignedSym] = (perCount[assignedSym] || 0) + 1;
    return true;
  }

  // Pass 1: one per symbol if possible
  for (const sym of symList) {
    if (selected.length >= targetTotal) break;
    const itm = pool.find((i) => (i.tickers || []).includes(sym) && !selectedKeys.has((i.link || i.title || '').toLowerCase()));
    if (itm) addIfNew(itm, sym);
  }

  // Pass 2: fill remaining, but cap at 2 per symbol
  for (const itm of pool) {
    if (selected.length >= targetTotal) break;
    const matched = (itm.tickers || []);
    const assign = matched.find((s) => (perCount[s] || 0) < maxPerTicker);
    if (assign) addIfNew(itm, assign);
  }

  // Pass 3: if still short, fill with remaining items regardless of ticker match
  if (selected.length < targetTotal) {
    for (const itm of annotated) {
      if (selected.length >= targetTotal) break;
      addIfNew(itm);
    }
  }

  // Fallback if nothing selected
  if (selected.length === 0) return pool.slice(0, targetTotal);
  return selected;
}

// --- Stock time series (for small trend chart)
app.get('/api/stocks/series', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const range = String(req.query.range || '1d'); // '1d', '5d'
    // Choose interval based on range
    const interval = range === '5d' ? '15m' : '5m';
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    // Fetch from Yahoo spark API first, then chart API (JSON headers)
    async function fetchSpark(rng, intv) {
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbol)}&range=${encodeURIComponent(rng)}&interval=${encodeURIComponent(intv)}&indicators=close&includeTimestamps=true&includePrePost=false`;
      const json = await fetchGet(url);
      const data = JSON.parse(json);
      const res = data?.spark?.result?.[0] || data?.result?.[0] || data?.[symbol] || data;
      const ts = res?.response?.[0]?.timestamp || res?.timestamp || [];
      const closes = res?.response?.[0]?.indicators?.quote?.[0]?.close || res?.close || [];
      return (ts || []).map((t, i) => ({ t: t * 1000, c: closes[i] })).filter((p) => typeof p.c === 'number');
    }
    async function fetchChart(rng, intv) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(rng)}&interval=${encodeURIComponent(intv)}&includePrePost=false`;
      const json = await fetchGet(url);
      const data = JSON.parse(json);
      const res = data?.chart?.result?.[0];
      const ts = res?.timestamp || [];
      const closes = res?.indicators?.quote?.[0]?.close || [];
      return (ts || []).map((t, i) => ({ t: t * 1000, c: closes[i] })).filter((p) => typeof p.c === 'number');
    }

    let points = await fetchSpark(range, interval);
    if (!points.length) points = await fetchChart(range, interval);
    if (!points.length) points = await fetchSpark('1mo', '1d');
    if (!points.length) points = await fetchChart('1mo', '1d');

    // Ensure ascending by time and limit to ~100 points
    points.sort((a, b) => a.t - b.t);
    if (points.length > 150) points = points.slice(-150);
    res.json({ symbol, range, interval, points });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/news/top', async (req, res) => {
  try {
    const symbols = String(req.query.symbols || 'SPY,QQQ,DIA,IWM,TLT,TSLA,MSFT,GOOGL,C,ABBV,NVDA,TSM,WMT,BSX,EOG')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const news = await fetchTopBusinessNewsFiltered(symbols);
    res.json({ news });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// AI News endpoint (aggregates AI-focused feeds and queries)
async function fetchTopAINews() {
  const feeds = [
    {
      url: 'https://news.google.com/rss/search?q=%28artificial%20intelligence%20OR%20AI%20OR%20machine%20learning%20OR%20genAI%20OR%20LLM%20OR%20OpenAI%20OR%20Anthropic%20OR%20DeepMind%20OR%20Mistral%29&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News - AI',
    },
    { url: 'https://www.technologyreview.com/topic/ai/feed/', source: 'MIT Tech Review - AI' },
    { url: 'https://venturebeat.com/category/ai/feed/', source: 'VentureBeat - AI' },
  ];
  const all = [];
  for (const f of feeds) {
    try {
      const items = await fetchFromFeed(f.url, f.source);
      all.push(...items);
    } catch {}
  }
  // Deduplicate by title and link
  const seen = new Set();
  const unique = [];
  for (const item of all) {
    const key = ((item.title || '') + '|' + (item.link || '')).trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  // Prefer most recent if pubDate exists
  unique.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return unique.slice(0, 12);
}

app.get('/api/news/ai', async (_req, res) => {
  try {
    const news = await fetchTopAINews();
    res.json({ news });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Stocks quotes ---
app.get('/api/stocks', async (req, res) => {
  try {
    const symbols = (req.query.symbols || 'SPY,QQQ,DIA,IWM,TLT,GOOGL').split(',').map((s) => s.trim());
    const quotes = await yahooFinance.quote(symbols);
    const data = (Array.isArray(quotes) ? quotes : [quotes]).map((q) => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent,
      previousClose: q.regularMarketPreviousClose,
      currency: q.currency,
    }));
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Weather (Open-Meteo, no API key) ---
function weatherCodeToDesc(code) {
  const map = {
    0: { d: 'Clear sky', i: '☀️' },
    1: { d: 'Mainly clear', i: '🌤️' },
    2: { d: 'Partly cloudy', i: '⛅' },
    3: { d: 'Overcast', i: '☁️' },
    45: { d: 'Fog', i: '🌫️' },
    48: { d: 'Depositing rime fog', i: '🌫️' },
    51: { d: 'Light drizzle', i: '🌦️' },
    53: { d: 'Drizzle', i: '🌦️' },
    55: { d: 'Dense drizzle', i: '🌧️' },
    61: { d: 'Slight rain', i: '🌦️' },
    63: { d: 'Rain', i: '🌧️' },
    65: { d: 'Heavy rain', i: '🌧️' },
    71: { d: 'Slight snow', i: '🌨️' },
    73: { d: 'Snow', i: '🌨️' },
    75: { d: 'Heavy snow', i: '❄️' },
    80: { d: 'Rain showers', i: '🌦️' },
    81: { d: 'Rain showers', i: '🌦️' },
    82: { d: 'Heavy showers', i: '🌧️' },
    95: { d: 'Thunderstorm', i: '⛈️' },
    96: { d: 'Thunderstorm w/ hail', i: '⛈️' },
    99: { d: 'Thunderstorm w/ hail', i: '⛈️' },
  };
  return map[code] || { d: 'Weather', i: '🌡️' };
}

app.get('/api/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat) || 32.7157; // San Diego
  const lon = parseFloat(req.query.lon) || -117.1611;
  const tz = encodeURIComponent('America/Los_Angeles');

  // Prefer OpenWeather if API key provided, else fall back to Open-Meteo
  const owa = process.env.OPENWEATHER_API_KEY;
  try {
    if (owa) {
      const urlOW = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${owa}`;
      const jsonOW = await fetchUrlText(urlOW);
      const data = JSON.parse(jsonOW);
      const w = (data.weather && data.weather[0]) || {};
      const temp = data.main ? data.main.temp : undefined;
      const desc = w.description ? String(w.description).replace(/\b\w/g, (m) => m.toUpperCase()) : 'Weather';
      const icon = w.icon ? w.icon : null;
      return res.json({
        lat, lon,
        temperatureF: temp,
        apparentF: data.main ? data.main.feels_like : undefined,
        windMph: data.wind ? data.wind.speed : undefined,
        code: w.id,
        description: desc,
        icon: icon, // client can render emoji fallback
        source: 'openweather',
      });
    }
  } catch (e) {
    // fall through to Open-Meteo
  }

  try {
    const urlOM = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${tz}`;
    const json = await fetchUrlText(urlOM);
    const data = JSON.parse(json);
    const c = data.current || {};
    const code = Number(c.weather_code);
    const meta = weatherCodeToDesc(code);
    res.json({
      lat, lon,
      temperatureF: c.temperature_2m,
      apparentF: c.apparent_temperature,
      windMph: c.wind_speed_10m,
      code,
      description: meta.d,
      icon: meta.i,
      source: 'open-meteo',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// In-memory store of metrics to support timeframes
const metricsBuffer = [];
const MAX_BUFFER_MINUTES = 60 * 24; // keep 24h of 1-min samples

function getCpuUsageSample() {
  // Approximate CPU usage over short interval using os.cpus()
  const cpusBefore = os.cpus();
  const beforeTotals = cpusBefore.map((c) => ({
    idle: c.times.idle,
    total: Object.values(c.times).reduce((a, v) => a + v, 0),
  }));
  return new Promise((resolve) => {
    setTimeout(() => {
      const cpusAfter = os.cpus();
      const usagePerCore = cpusAfter.map((c, i) => {
        const afterIdle = c.times.idle;
        const afterTotal = Object.values(c.times).reduce((a, v) => a + v, 0);
        const idle = afterIdle - beforeTotals[i].idle;
        const total = afterTotal - beforeTotals[i].total;
        const usage = total > 0 ? 1 - idle / total : 0;
        return usage;
      });
      const avgUsage = usagePerCore.reduce((a, v) => a + v, 0) / usagePerCore.length;
      resolve({ average: avgUsage, perCore: usagePerCore });
    }, 200); // 200ms sampling interval
  });
}

function getMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usage = total > 0 ? used / total : 0;
  return { total, free, used, usage };
}

async function getDiskSpace() {
  // Use root filesystem on Linux
  const rootPath = process.platform === 'win32' ? 'C:' : '/';
  try {
    const { size, free } = await checkDiskSpace(rootPath);
    const used = size - free;
    const usage = size > 0 ? used / size : 0;
    return { total: size, free, used, usage };
  } catch (err) {
    return { total: 0, free: 0, used: 0, usage: 0, error: String(err) };
  }
}

async function collectMetrics() {
  const timestamp = Date.now();
  const [cpu, memory, disk] = await Promise.all([
    getCpuUsageSample(),
    Promise.resolve(getMemoryUsage()),
    getDiskSpace(),
  ]);
  const sample = { timestamp, cpu, memory, disk };
  metricsBuffer.push(sample);
  // Keep buffer bounded
  const cutoff = Date.now() - MAX_BUFFER_MINUTES * 60 * 1000;
  while (metricsBuffer.length && metricsBuffer[0].timestamp < cutoff) {
    metricsBuffer.shift();
  }
  return sample;
}

// Collect initial sample and then every minute
collectMetrics();
setInterval(collectMetrics, 60 * 1000);

// Realtime endpoint returns latest sample
app.get('/api/metrics/latest', async (req, res) => {
  try {
    const sample = await collectMetrics();
    res.json(sample);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Historical endpoint with timeframe query (?range=15m|1h|6h|24h)
app.get('/api/metrics', (req, res) => {
  const range = String(req.query.range || '1h');
  const now = Date.now();
  const map = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440 };
  const minutes = map[range] || 60;
  const cutoff = now - minutes * 60 * 1000;
  const data = metricsBuffer.filter((s) => s.timestamp >= cutoff);
  res.json({ range, data });
});

// --- Proxy for TradingView mini widget script to comply with strict CSPs ---
app.get('/proxy/tv-mini.js', async (_req, res) => {
  try {
    const url = 'https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js';
    const js = await fetchUrlText(url);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(js);
  } catch (e) {
    res.status(502).send('// Failed to fetch TradingView widget: ' + String(e));
  }
});

// Standalone iframe page to host TradingView mini widget with a permissive CSP
app.get('/widgets/tv-mini', (req, res) => {
  const symbol = String(req.query.symbol || 'NASDAQ:QQQ');
  const dateRange = String(req.query.range || '1M');
  const theme = String(req.query.theme || 'dark');
  const transparent = String(req.query.transparent || 'true') === 'false' ? false : true;
  const locale = String(req.query.locale || 'en');
  const titleHref = String(req.query.titleHref || 'https://www.tradingview.com/');
  const titleText = String(req.query.titleText || `${symbol} chart by TradingView`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Allow this page to be embedded by same-origin parent
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { height: 100%; margin: 0; background: transparent; }
    .tradingview-widget-container, .tradingview-widget-container__widget { height: 100%; }
    .blue-text { color: #60a5fa; font-family: system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial, sans-serif; }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
    <div class="tradingview-widget-copyright"><a href="${titleHref}" rel="noopener nofollow" target="_blank"><span class="blue-text">${titleText}</span></a></div>
    <script type="text/javascript" src="/proxy/tv-mini.js" async>
    ${JSON.stringify({
      symbol,
      chartOnly: false,
      dateRange,
      noTimeScale: false,
      colorTheme: theme,
      isTransparent: transparent,
      locale,
      width: '100%',
      autosize: false,
      height: '100%'
    })}
    </script>
  </div>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`Metrics dashboard at http://localhost:${port}`);
});