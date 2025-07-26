
// Order: ld+json → yt-dlp → Puppeteer sniffing
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');
const YtDlpWrap = require('yt-dlp-wrap').default;
const ytDlpWrap = new YtDlpWrap();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

const OUTPUT_DIR = path.resolve(__dirname);
const videoUrl = process.argv[2];

if (!videoUrl) {
  console.error('❌ Please provide a video URL as an argument.');
  process.exit(1);
}

function sanitize(name) {
  return name.replace(/[\/:*?"<>|]/g, '_').slice(0, 150);
}

function saveMetadata(data, filename = 'metadata.json') {
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(data, null, 2));
}

function extractDurationFromFile(filePath) {
  try {
    const ffprobeOutput = execSync(
      `ffprobe -v error -show_entries format=duration -of json "${filePath}"`
    );
    const probeJson = JSON.parse(ffprobeOutput.toString());
    const seconds = parseFloat(probeJson.format?.duration);
    return !isNaN(seconds) ? Math.round(seconds) : null;
  } catch (err) {
    console.warn('⚠️ Failed to extract duration via ffprobe:', err.message);
    return null;
  }
}

// --- 1. Try ld+json ---
async function tryLdJson(url) {
  console.log('📦 Trying ld+json contentUrl extraction...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const result = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      try {
        const json = JSON.parse(script.textContent);
        if (json['@type'] === 'VideoObject' && json.contentUrl) return json;
      } catch {}
    }
    return null;
  });

  await browser.close();

  if (!result?.contentUrl) {
    throw new Error('❌ No contentUrl found in JSON-LD.');
  }

  const safeTitle = sanitize(result.name || 'direct_video');
  const outputPath = path.join(OUTPUT_DIR, `${safeTitle}.mp4`);
  saveMetadata(result, `${safeTitle}_ldjson.json`);

  console.log('🎯 Downloading from ld+json:', result.contentUrl);
  await ytDlpWrap.execPromise([
    result.contentUrl,
    '-o',
    outputPath,
    '--referer',
    url,
    '--user-agent',
    USER_AGENT,
  ]);

  if (!result.duration) {
    const duration = extractDurationFromFile(outputPath);
    if (duration) {
      result.duration = duration;
      saveMetadata(result, `${safeTitle}_ldjson.json`); // Update with duration
    }
  }

  console.log('✅ ld+json video downloaded!');
  return true;
}

// --- 2. Try yt-dlp ---
async function tryYtDlp(url) {
  try {
    console.log('🔍 Trying yt-dlp...');
    const json = await ytDlpWrap.execPromise(['--dump-json', url]);
    const metadata = JSON.parse(json);
    const safeTitle = sanitize(metadata.title);
    const outputPath = path.join(OUTPUT_DIR, `${safeTitle}.%(ext)s`);

    saveMetadata(metadata, `${safeTitle}.json`);
    await ytDlpWrap.execPromise([
      url,
      '-o',
      outputPath,
      '--no-playlist',
    ]);

    const downloadedFile = path.join(OUTPUT_DIR, `${safeTitle}.${metadata.ext || 'mp4'}`);
    if (!metadata.duration && fs.existsSync(downloadedFile)) {
      const duration = extractDurationFromFile(downloadedFile);
      if (duration) {
        metadata.duration = duration;
        saveMetadata(metadata, `${safeTitle}.json`);
      }
    }

    console.log('✅ yt-dlp succeeded!');
    return true;
  } catch (err) {
    console.warn('⚠️ yt-dlp failed:', err.message);
    return false;
  }
}

// --- 3. Try Puppeteer sniffing ---
async function tryPuppeteer(url) {
  console.log('🧠 Launching Puppeteer to sniff .m3u8 stream...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  let streamUrl = null;
  page.on('request', req => {
    const reqUrl = req.url();
    if (reqUrl.includes('.m3u8') && !streamUrl) {
      streamUrl = reqUrl;
      console.log('🎯 Detected .m3u8 stream:', streamUrl);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try { await page.click('[id*="onetrust-accept"]', { timeout: 3000 }); } catch {}
  try { await page.click('.fs-video-player, #overlayPlay, body'); } catch {}

  const timeout = 15000;
  const start = Date.now();
  while (!streamUrl && Date.now() - start < timeout) {
    await new Promise(res => setTimeout(res, 500));
  }

  if (!streamUrl) {
    await browser.close();
    throw new Error('❌ No .m3u8 stream found.');
  }

  const cookies = await page.cookies();
  await browser.close();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  let fallbackMeta = {
    contentUrl: streamUrl,
    originalPage: url,
    downloadDate: new Date().toISOString(),
  };
  let safeTitle = 'sniffed_fallback';

  try {
    const rawMeta = await ytDlpWrap.execPromise([
      '--dump-json',
      streamUrl,
      '--no-playlist',
      '--referer', url,
      '--user-agent', USER_AGENT,
      '--add-header', `Cookie: ${cookieHeader}`,
    ]);

    const parsedMeta = JSON.parse(rawMeta);
    fallbackMeta = {
      ...fallbackMeta,
      title: parsedMeta.title || 'Sniffed Stream',
      uploader: parsedMeta.uploader || parsedMeta.channel || null,
      duration: parsedMeta.duration || null,
      uploadDate: parsedMeta.upload_date || null,
      viewCount: parsedMeta.view_count || null,
      categories: parsedMeta.categories || [],
      tags: parsedMeta.tags || [],
      resolution: parsedMeta.format || null,
      ext: parsedMeta.ext || null,
    };
    safeTitle = sanitize(fallbackMeta.title);
  } catch (e) {
    console.warn('⚠️ Failed to extract rich metadata from .m3u8, using fallback only.');
  }

  const outputPath = path.join(OUTPUT_DIR, `${safeTitle}.%(ext)s`);
  await ytDlpWrap.execPromise([
    streamUrl,
    '-o',
    outputPath,
    '--no-playlist',
    '--referer',
    url,
    '--user-agent',
    USER_AGENT,
    '--add-header',
    `Cookie: ${cookieHeader}`,
  ]);

  const sniffedPath = path.join(OUTPUT_DIR, `${safeTitle}.mp4`);
  if (!fallbackMeta.duration && fs.existsSync(sniffedPath)) {
    const duration = extractDurationFromFile(sniffedPath);
    if (duration) fallbackMeta.duration = duration;
  }

  saveMetadata(fallbackMeta, `${safeTitle}.json`);
  console.log('✅ Puppeteer .m3u8 stream downloaded + metadata saved!');
  return true;
}

// --- Master Flow ---
(async () => {
  try {
    if (await tryLdJson(videoUrl)) return;
  } catch (e) {
    console.warn('⚠️ ld+json failed:', e.message);
  }

  try {
    if (await tryYtDlp(videoUrl)) return;
  } catch (e) {
    console.warn('⚠️ yt-dlp failed:', e.message);
  }

  try {
    if (await tryPuppeteer(videoUrl)) return;
  } catch (e) {
    console.error('❌ Puppeteer fallback failed:', e.message);
  }

  console.error('🚫 All extraction methods failed.');
})();




// link to 4th video:
// node app.js "https://www.cbssports.com/watch/nfl/video/is-it-a-surprise-that-micah-parsons-is-being-strung-along-by-cowboys"

