const fs = require('fs');
const path = require('path');
const YtDlpWrap = require('yt-dlp-wrap').default;
const puppeteer = require('puppeteer');


const ytDlpWrap = new YtDlpWrap();
const OUTPUT_DIR = path.resolve(__dirname);

// Confirm yt-dlp works
ytDlpWrap.execPromise(['--version'])
  .then(output => {
    console.log('✅ yt-dlp version:', output.trim());
  })
  .catch(err => {
    console.error('❌ Error checking yt-dlp version:', err.message);
  });

// Get video URL from user input
const videoUrl = process.argv[2];
if (!videoUrl) {
  console.error('❌ Please provide a video URL as argument.');
  process.exit(1);
}

// Run main logic
runDownloader(videoUrl);

// ----------------- Main Downloader Logic -----------------

async function runDownloader(url) {
  try {
    console.log('🔍 Fetching metadata...');

    let rawMetadata;

    // Try direct yt-dlp first
    try {
      rawMetadata = await ytDlpWrap.execPromise(['--dump-json', url]);
    } catch (err) {
      console.warn('⚠️ yt-dlp failed. Trying fallback scraper...');

      const fallbackUrl = await tryGetDirectVideoUrl(url);

      if (!fallbackUrl) throw new Error(`❌ Site not supported and no fallback available for: ${url}`);
      console.log('➡️ Using fallback direct stream URL:', fallbackUrl);

      rawMetadata = await ytDlpWrap.execPromise(['--dump-json', fallbackUrl]);
      url = fallbackUrl;
    }

    const metadata = JSON.parse(rawMetadata);
    const {title } = metadata;

    console.log('💾 Saving metadata...');
    const safeTitle = sanitize(title);
    const metadataPath = path.join(OUTPUT_DIR, `${safeTitle}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    console.log('🎬 Downloading video...');
    const outputTemplate = path.join(OUTPUT_DIR, `${safeTitle}.%(ext)s`);

    await ytDlpWrap.execPromise([
      url,
      '-o', outputTemplate
    ]);

    console.log('✅ Done!');
    console.log('📄 Metadata saved to:', metadataPath);
  } catch (err) {
    console.error('❌ Error:', err.message || err);
  }
}

// ----------------- Fallback Scraper -----------------

async function tryGetDirectVideoUrl(url) {
  if (!url.includes('mako.co.il')) return null;

  console.log('🧠 Launching headless browser to extract .m3u8 stream...');

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  );

  let streamUrl = null;

  page.on('request', req => {
    const reqUrl = req.url();
    if (reqUrl.includes('.m3u8')) {
      streamUrl = reqUrl;
      console.log('🎯 Detected .m3u8 stream:', streamUrl);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Optional: accept cookies if present
  try {
    await page.click('[id*="onetrust-accept"]', { timeout: 3000 });
  } catch {}

  // Try clicking the video container to trigger playback
  try {
    const iframeHandle = await page.$('iframe');
    if (iframeHandle) {
      const frame = await iframeHandle.contentFrame();
      if (frame) {
        await frame.click('body'); // Generic click to start playback
      }
    } else {
      await page.click('body');
    }
  } catch (e) {
    console.log('⚠️ Could not click to start video:', e.message);
  }

  // Wait up to 15s for a request to appear
  const maxWait = 15000;
  const start = Date.now();
  while (!streamUrl && Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 500));
  }

  await browser.close();

  if (!streamUrl) throw new Error('❌ No .m3u8 stream found during browsing.');

  return streamUrl;
}

// ----------------- Filename Sanitizer -----------------

function sanitize(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 150);
}

// link to 2nd video:
// node app.js "https://www.mako.co.il/pzm-soldiers/Article-b1fa03b6e651891027.htm"