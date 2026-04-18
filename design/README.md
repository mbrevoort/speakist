# Speakist brand assets

Drop finished app-icon PNGs into
`Speakist/Resources/Assets.xcassets/AppIcon.appiconset/` at the sizes listed in
`Contents.json` (16, 32, 128, 256, 512 points at 1x and 2x).

The raw brand mark ships as an SVG — `Speakist.svg` in this folder. Quick
conversion recipe:

```sh
# Requires librsvg + iconutil
brew install librsvg

mkdir speakist.iconset
for size in 16 32 64 128 256 512 1024; do
  rsvg-convert -w $size -h $size design/Speakist.svg > speakist.iconset/icon_${size}x${size}.png
done
# rename to match iconutil convention
cp speakist.iconset/icon_32x32.png   speakist.iconset/icon_16x16@2x.png
cp speakist.iconset/icon_64x64.png   speakist.iconset/icon_32x32@2x.png
cp speakist.iconset/icon_256x256.png speakist.iconset/icon_128x128@2x.png
cp speakist.iconset/icon_512x512.png speakist.iconset/icon_256x256@2x.png
cp speakist.iconset/icon_1024x1024.png speakist.iconset/icon_512x512@2x.png
iconutil -c icns speakist.iconset -o speakist.icns
```

Then drag the individual PNGs into the `AppIcon.appiconset` in Xcode's asset
catalog — Xcode will slot each size into the right well.

## Colors

| Role | Token | Hex |
|---|---|---|
| Primary | `speakistPeach` | `#FF8A65` |
| Accent | `speakistPlum` | `#4A2C5A` |
| Surface (light) | `speakistCream` | `#FFF6EE` |
| Surface (dark) | `speakistInk` | `#1B1322` |
| Success | `speakistSage` | `#7FB77E` |
| Warning | `speakistMustard` | `#E4B63A` |
| Error | `speakistCoral` | `#E5484D` |
