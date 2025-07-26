const fs = require('fs');
const path = require('path');
const YtDlpWrap = require('yt-dlp-wrap').default;
const ytDlpWrap = new YtDlpWrap();


ytDlpWrap.execPromise(['--version'])
  .then(output => {
    console.log('✅ yt-dlp version:', output.trim());
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
  });

// Get video URL from user input
const videoUrl = process.argv[2];
if (!videoUrl) {
  console.error('❌ Please provide a video URL as argument.');
  process.exit(1);
}

const OUTPUT_DIR = path.resolve(__dirname);

async function runDownloader(url) {
  try {
    console.log('🔍 Fetching metadata...');
    const rawMetadata = await ytDlpWrap.execPromise(['--dump-json', url]);
    const metadata = JSON.parse(rawMetadata);

    const {title} = metadata;

    console.log('💾 Saving metadata...');
    const metadataPath = path.join(OUTPUT_DIR, `${sanitize(title)}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    console.log('🎬 Downloading video...');
    const outputTemplate = path.join(OUTPUT_DIR, `${sanitize(title)}.%(ext)s`);

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

// Helper to sanitize filenames
function sanitize(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_');
}

runDownloader(videoUrl);



// link to 1st video:
// node app.js "https://edition.cnn.com/2025/07/16/world/video/maynard-gaza-hospitals-nada-bashir-digvid"