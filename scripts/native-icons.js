// Reuse the checked-in DivingHQ mark so the native preview carries the same
// identity as the web app. No generated credentials or store assets required.
const sharp = require('sharp');
const path = require('node:path');
const fs = require('node:fs/promises');

async function main() {
  const source = path.resolve(__dirname, '../public/icon.svg');
  const root = path.resolve(__dirname, '..');
  await sharp(source).resize(1024, 1024).flatten({ background: '#030712' })
    .png().toFile(path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    const dir = path.join(root, `android/app/src/main/res/mipmap-${density}`);
    await fs.mkdir(dir, { recursive: true });
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      await sharp(source).resize(size, size).flatten({ background: '#030712' })
        .png().toFile(path.join(dir, `${name}.png`));
    }
    const canvas = Math.round(size * 108 / 48);
    const mark = await sharp(source).resize(Math.round(canvas * 0.62)).png().toBuffer();
    await sharp({ create: { width: canvas, height: canvas, channels: 4, background: '#030712' } })
      .composite([{ input: mark, gravity: 'centre' }]).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
