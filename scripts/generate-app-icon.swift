#!/usr/bin/env xcrun swift
//
// Render design/Speakist.svg into Speakist/Resources/Assets.xcassets/AppIcon.appiconset/
// at all 10 sizes macOS expects (16pt–512pt @ 1x/2x).
//
// Run whenever design/Speakist.svg changes:
//   scripts/generate-app-icon.swift
//
// No external deps — uses NSImage + AppKit, which on macOS 14+ rasterizes
// SVG natively. The source must be at its native 1024×1024 viewBox so the
// downsampled targets stay crisp.

import AppKit
import Foundation

// Each entry: (pixel dimension, filename, idiom size, scale)
// Filename ends up in Contents.json. Pixel dimension = size × scale.
struct IconSlot {
    let pixels: Int
    let filename: String
    let size: String   // the "pt" size that goes into Contents.json
    let scale: String  // "1x" or "2x"
}

let slots: [IconSlot] = [
    .init(pixels: 16,   filename: "icon_16.png",       size: "16x16",   scale: "1x"),
    .init(pixels: 32,   filename: "icon_16@2x.png",    size: "16x16",   scale: "2x"),
    .init(pixels: 32,   filename: "icon_32.png",       size: "32x32",   scale: "1x"),
    .init(pixels: 64,   filename: "icon_32@2x.png",    size: "32x32",   scale: "2x"),
    .init(pixels: 128,  filename: "icon_128.png",      size: "128x128", scale: "1x"),
    .init(pixels: 256,  filename: "icon_128@2x.png",   size: "128x128", scale: "2x"),
    .init(pixels: 256,  filename: "icon_256.png",      size: "256x256", scale: "1x"),
    .init(pixels: 512,  filename: "icon_256@2x.png",   size: "256x256", scale: "2x"),
    .init(pixels: 512,  filename: "icon_512.png",      size: "512x512", scale: "1x"),
    .init(pixels: 1024, filename: "icon_512@2x.png",   size: "512x512", scale: "2x"),
]

let fm = FileManager.default
let repoRoot = URL(fileURLWithPath: fm.currentDirectoryPath)
let svgURL = repoRoot.appendingPathComponent("design/Speakist.svg")
let outDir = repoRoot.appendingPathComponent("Speakist/Resources/Assets.xcassets/AppIcon.appiconset")

guard fm.fileExists(atPath: svgURL.path) else {
    FileHandle.standardError.write("SVG not found at \(svgURL.path)\n".data(using: .utf8)!)
    exit(1)
}

guard let source = NSImage(contentsOf: svgURL) else {
    FileHandle.standardError.write("NSImage could not load \(svgURL.path)\n".data(using: .utf8)!)
    exit(1)
}

// Force the NSImage's internal representation to its native viewBox size so
// downstream scaling is 1024-pixel-based, not 72-dpi-point-based.
source.size = NSSize(width: 1024, height: 1024)

func render(to size: Int) -> Data? {
    let dim = CGFloat(size)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )
    rep?.size = NSSize(width: dim, height: dim)
    guard let rep else { return nil }

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    source.draw(
        in: NSRect(x: 0, y: 0, width: dim, height: dim),
        from: NSRect(x: 0, y: 0, width: 1024, height: 1024),
        operation: .copy,
        fraction: 1.0
    )

    return rep.representation(using: .png, properties: [:])
}

try? fm.createDirectory(at: outDir, withIntermediateDirectories: true)

for slot in slots {
    guard let png = render(to: slot.pixels) else {
        FileHandle.standardError.write("Render failed at \(slot.pixels)px\n".data(using: .utf8)!)
        exit(1)
    }
    let dest = outDir.appendingPathComponent(slot.filename)
    try! png.write(to: dest)
    print("  \(slot.pixels.description.padding(toLength: 4, withPad: " ", startingAt: 0))  \(slot.filename)")
}

// Write Contents.json with the filename references.
struct Contents: Encodable {
    struct Image: Encodable {
        let idiom: String
        let size: String
        let scale: String
        let filename: String
    }
    struct Info: Encodable {
        let author: String
        let version: Int
    }
    let images: [Image]
    let info: Info
}

let contents = Contents(
    images: slots.map { s in
        .init(idiom: "mac", size: s.size, scale: s.scale, filename: s.filename)
    },
    info: .init(author: "xcode", version: 1)
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let jsonData = try encoder.encode(contents)
try jsonData.write(to: outDir.appendingPathComponent("Contents.json"))

print("Wrote \(slots.count) PNGs + Contents.json to \(outDir.path)")
