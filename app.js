const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const YtDlpWrap = require('yt-dlp-wrap').default;
const ytDlpWrap = new YtDlpWrap();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

const videoUrl = process.argv[2];
if (!videoUrl) {
  console.error('❌ Please provide a video URL as argument.');
  process.exit(1);
}

const OUTPUT_DIR = path.resolve(__dirname);

// Util: save metadata
function saveMetadata(data, filename = 'metadata.json') {
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(data, null, 2));
}

// 1. Try yt-dlp
async function tryYtDlp(url) {
  try {
    console.log('🔍 Fetching metadata...');
    const json = await ytDlpWrap.execPromise(['--dump-json', url]);
    const metadata = JSON.parse(json);
    saveMetadata(metadata);

    console.log('🎥 Title:', metadata.title);
    console.log('🎯 Using yt-dlp to download...');
    await ytDlpWrap.execPromise([
      url,
      '-o',
      path.join(OUTPUT_DIR, '%(title)s.%(ext)s'),
      '--no-playlist',
    ]);
    console.log('✅ yt-dlp download completed!');
    return true;
  } catch (err) {
    console.warn('⚠️ yt-dlp failed:', err.message);
    return false;
  }
}

// 2. Try Puppeteer to find .m3u8
async function tryPuppeteer(url) {
  console.log('🧠 Launching headless browser to extract .m3u8 stream...');
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

  try {
    await page.click('[id*="onetrust-accept"]', { timeout: 3000 });
  } catch {}

  try {
    await page.click('.fs-video-player, #overlayPlay, body');
    console.log('▶️ Clicked play on the video overlay');
  } catch {}

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

  // Download with yt-dlp and headers
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const output = path.join(OUTPUT_DIR, 'fallback_video.%(ext)s');

  await ytDlpWrap.execPromise([
    streamUrl,
    '-o',
    output,
    '--no-playlist',
    '--referer',
    url,
    '--user-agent',
    USER_AGENT,
    '--add-header',
    `Cookie: ${cookieHeader}`,
  ]);
  console.log('✅ Fallback .m3u8 stream downloaded!');
  return true;
}

// 3. Try parsing ld+json <script> for contentUrl
async function tryLdJson(url) {
  console.log('📦 Attempting to extract contentUrl from ld+json...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const result = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      try {
        const json = JSON.parse(script.textContent);
        if (json['@type'] === 'VideoObject' && json.contentUrl) {
          return json;
        }
      } catch {}
    }
    return null;
  });

  await browser.close();

  if (!result?.contentUrl) {
    throw new Error('❌ No contentUrl found in JSON-LD.');
  }

  console.log('🎯 Found direct MP4:', result.contentUrl);
  saveMetadata(result, 'metadata_ldjson.json');

  const output = path.join(OUTPUT_DIR, 'direct_video.mp4');
  await ytDlpWrap.execPromise([
    result.contentUrl,
    '-o',
    output,
    '--referer',
    url,
    '--user-agent',
    USER_AGENT,
  ]);
  console.log('✅ Direct MP4 downloaded!');
  return true;
}

// Master flow
(async () => {
  const ok = await tryYtDlp(videoUrl);
  if (ok) return;

  try {
    const okP = await tryPuppeteer(videoUrl);
    if (okP) return;
  } catch (e) {
    console.warn('⚠️ Puppeteer fallback failed:', e.message);
  }

  try {
    await tryLdJson(videoUrl);
  } catch (e) {
    console.error('❌ Final fallback failed:', e.message);
  }
})();

// link to 3rd video:
// node app.js "https://www.foxsports.com/watch/fmc-5kls1t8t846wq6fu"
