import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'fs'

const iconSvg = (size) => {
  const radius = Math.round(size * 0.18)
  const fontSize = Math.round(size * 0.38)
  const dotSize = Math.round(size * 0.14)
  const dotX = size - Math.round(size * 0.22)
  const dotY = Math.round(size * 0.22)
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1d4ed8"/>
      <stop offset="100%" style="stop-color:#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  <text x="${size * 0.47}" y="${size * 0.56}"
        font-family="Arial,Helvetica,sans-serif"
        font-weight="800"
        font-size="${fontSize}"
        fill="white"
        text-anchor="middle"
        dominant-baseline="middle"
        letter-spacing="-0.5">LS</text>
  <circle cx="${dotX}" cy="${dotY}" r="${dotSize}" fill="#34d399"/>
</svg>`
}

mkdirSync('public/icons', { recursive: true })

for (const size of [16, 48, 128]) {
  const svgBuffer = Buffer.from(iconSvg(size))
  const png = await sharp(svgBuffer, { density: 300 })
    .resize(size, size)
    .png()
    .toBuffer()
  writeFileSync(`public/icons/icon${size}.png`, png)
  console.log(`✓ icon${size}.png`)
}

console.log('Icons generated → public/icons/')
