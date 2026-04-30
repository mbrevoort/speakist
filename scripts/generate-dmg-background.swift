#!/usr/bin/env xcrun swift
//
// Render the DMG-window background art used by `scripts/release.sh` when
// building the Mac install DMG. Output goes to `design/dmg-background.png`
// (1× logical size 600×400) and `design/dmg-background@2x.png` (1200×800
// for HiDPI Finder rendering).
//
// Run whenever the layout / palette changes:
//   scripts/generate-dmg-background.swift
//
// Why an explicit background: the previous DMG had no chrome — Finder
// drew a dark window with two icons (Speakist.app + an Applications
// alias). On modern macOS the system Applications folder icon doesn't
// always resolve through an alias inside a read-only DMG, so users saw
// a near-invisible dark blob on a dark background and no clue what to
// drag where. A baked-in background gives:
//   * Title + subtitle telling the user what to do
//   * A peach arrow pointing from the app slot to the Applications slot
//   * Dashed outline ghosts where each icon will land, so even if the
//     live alias renders blank the drop target is unmistakable
//
// Window geometry must match the AppleScript in release.sh exactly:
//   bounds  {200, 120, 800, 520}  →  600 × 400 pt window
//   App icon at  (150, 180)
//   Apps alias at (450, 180)
//   Icon size 100 pt
// AppleScript icon positions are CENTERS — so icons span y 130–230 and
// occupy x 100–200 (Speakist) and x 400–500 (Applications).

import AppKit
import Foundation

// MARK: - Layout constants (logical points; 1× pixels)

let windowSize = CGSize(width: 600, height: 400)
let iconSize: CGFloat = 100
let appCenter = CGPoint(x: 150, y: 180)
let applicationsCenter = CGPoint(x: 450, y: 180)

// Brand palette mirrors Speakist/Resources/Brand.swift. Hex literals
// kept inline rather than importing the Mac target (this script is
// standalone, runnable from any clone).
let bgTop      = NSColor(red: 33 / 255.0, green: 26 / 255.0, blue: 41 / 255.0, alpha: 1.0)   // #211A29
let bgBottom   = NSColor(red: 20 / 255.0, green: 16 / 255.0, blue: 26 / 255.0, alpha: 1.0)   // #14101A
let peach      = NSColor(red: 1.0, green: 0.541, blue: 0.396, alpha: 1.0)                   // #FF8A65
let textWhite  = NSColor(white: 1.0, alpha: 0.95)
let textMuted  = NSColor(white: 1.0, alpha: 0.55)
let ghostFill  = peach.withAlphaComponent(0.06)
let ghostStroke = peach.withAlphaComponent(0.45)

// MARK: - Rendering

/// Drawing happens in a flipped coordinate system so y=0 is the TOP
/// edge of the image — matching how AppleScript positions icons inside
/// the Finder window. NSImage's default is bottom-origin, so we flip
/// the underlying CGContext via translate+scale, and ALSO tell AppKit
/// (via NSGraphicsContext(cgContext:flipped:true)) that the context
/// is flipped, so text rendering applies its own internal flip that
/// cancels the CG flip back out — glyphs come out right-side up.
/// Without telling AppKit, NSAttributedString rendered upside-down on
/// top of the flipped CG transform.
func renderBackground(scale: CGFloat) -> NSImage {
    let pixelSize = NSSize(
        width: windowSize.width * scale,
        height: windowSize.height * scale
    )
    let image = NSImage(size: pixelSize)
    image.lockFocus()
    defer { image.unlockFocus() }

    guard let ctx = NSGraphicsContext.current?.cgContext else {
        FileHandle.standardError.write(Data("FATAL: no CG context\n".utf8))
        exit(1)
    }

    // 1) Flip the underlying CG transform to top-origin, then 2) wrap
    //    that context in a flipped NSGraphicsContext so AppKit's text
    //    + gradient rendering knows it's flipped (and cancels the
    //    flip internally for glyphs). Both layers are required.
    ctx.translateBy(x: 0, y: pixelSize.height)
    ctx.scaleBy(x: scale, y: -scale)

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)

    drawBackgroundGradient()
    drawIconGhosts(ctx: ctx)
    drawArrow(ctx: ctx)
    drawTitle()
    drawSubtitle()

    return image
}

func drawBackgroundGradient() {
    let gradient = NSGradient(colors: [bgTop, bgBottom])!
    let rect = NSRect(origin: .zero, size: windowSize)
    gradient.draw(in: rect, angle: 90)
}

/// Dashed rounded-square outlines under each icon slot. Even if the
/// live Applications alias resolves to a transparent icon (the bug
/// that motivated this whole exercise), the user sees a peach drop
/// target where the icon should be.
func drawIconGhosts(ctx: CGContext) {
    let radius: CGFloat = 22
    for center in [appCenter, applicationsCenter] {
        let frame = CGRect(
            x: center.x - iconSize / 2,
            y: center.y - iconSize / 2,
            width: iconSize,
            height: iconSize
        )
        ctx.saveGState()
        ctx.setFillColor(ghostFill.cgColor)
        ctx.setStrokeColor(ghostStroke.cgColor)
        ctx.setLineWidth(1.5)
        ctx.setLineDash(phase: 0, lengths: [5, 4])
        let path = CGPath(roundedRect: frame, cornerWidth: radius, cornerHeight: radius, transform: nil)
        ctx.addPath(path)
        ctx.fillPath()
        ctx.addPath(path)
        ctx.strokePath()
        ctx.restoreGState()
    }
}

/// Peach arrow from the Speakist icon's right edge to the Applications
/// icon's left edge, at the same y as the icon centers. Tapered
/// shaft + arrowhead — feels Speakist-y rather than generic.
func drawArrow(ctx: CGContext) {
    let startX = appCenter.x + iconSize / 2 + 12          // 12pt gap right of Speakist icon
    let endX = applicationsCenter.x - iconSize / 2 - 12    // 12pt gap left of Apps slot
    let y = appCenter.y                                    // same horizontal as icon centers
    let shaftThickness: CGFloat = 5
    let headLength: CGFloat = 18
    let headWidth: CGFloat = 16

    let path = CGMutablePath()
    // Shaft: a horizontal capsule from startX to (endX - headLength)
    let shaftEnd = endX - headLength
    let shaftRect = CGRect(
        x: startX,
        y: y - shaftThickness / 2,
        width: shaftEnd - startX,
        height: shaftThickness
    )
    path.addRoundedRect(in: shaftRect, cornerWidth: shaftThickness / 2, cornerHeight: shaftThickness / 2)
    // Arrowhead: triangle peak at (endX, y), base at (shaftEnd, y±headWidth/2)
    path.move(to: CGPoint(x: shaftEnd, y: y - headWidth / 2))
    path.addLine(to: CGPoint(x: endX, y: y))
    path.addLine(to: CGPoint(x: shaftEnd, y: y + headWidth / 2))
    path.closeSubpath()

    ctx.saveGState()
    ctx.setFillColor(peach.cgColor)
    // Soft drop-shadow on the arrow so it lifts visibly off the dark
    // bg without looking applied. Offset 0,1 + 4pt blur is enough.
    ctx.setShadow(offset: CGSize(width: 0, height: 1), blur: 4, color: NSColor.black.withAlphaComponent(0.4).cgColor)
    ctx.addPath(path)
    ctx.fillPath()
    ctx.restoreGState()
}

func drawTitle() {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
        .foregroundColor: textWhite,
        .paragraphStyle: style,
        .kern: 0.4
    ]
    let s = NSAttributedString(string: "Install Speakist", attributes: attrs)
    let frame = NSRect(x: 0, y: 56, width: windowSize.width, height: 30)
    s.draw(in: frame)
}

func drawSubtitle() {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        .foregroundColor: textMuted,
        .paragraphStyle: style,
        .kern: 0.2
    ]
    let s = NSAttributedString(
        string: "Drag the app onto the Applications folder to install.",
        attributes: attrs
    )
    let frame = NSRect(x: 0, y: 92, width: windowSize.width, height: 20)
    s.draw(in: frame)
}

// MARK: - PNG export

func writePNG(_ image: NSImage, to url: URL) {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:])
    else {
        FileHandle.standardError.write(Data("FATAL: PNG encode failed for \(url.path)\n".utf8))
        exit(1)
    }
    do {
        try png.write(to: url)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        print("wrote \(url.lastPathComponent) (\(bytes) bytes)")
    } catch {
        FileHandle.standardError.write(Data("FATAL: write failed: \(error)\n".utf8))
        exit(1)
    }
}

// MARK: - main

let fm = FileManager.default
let repoRoot = URL(fileURLWithPath: fm.currentDirectoryPath)
let outDir = repoRoot.appendingPathComponent("design")
try? fm.createDirectory(at: outDir, withIntermediateDirectories: true)

writePNG(renderBackground(scale: 1), to: outDir.appendingPathComponent("dmg-background.png"))
writePNG(renderBackground(scale: 2), to: outDir.appendingPathComponent("dmg-background@2x.png"))
