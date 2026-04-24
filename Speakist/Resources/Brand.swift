import SwiftUI

#if canImport(AppKit)
import AppKit
#endif

#if canImport(UIKit)
import UIKit
#endif

extension Color {
    static let speakistPeach = Color(red: 1.0, green: 0.541, blue: 0.396)    // #FF8A65
    static let speakistPlum = Color(red: 0.290, green: 0.173, blue: 0.353)   // #4A2C5A
    static let speakistCream = Color(red: 1.0, green: 0.965, blue: 0.933)    // #FFF6EE
    static let speakistInk = Color(red: 0.106, green: 0.075, blue: 0.133)    // #1B1322
    static let speakistSage = Color(red: 0.498, green: 0.718, blue: 0.494)   // #7FB77E
    static let speakistMustard = Color(red: 0.894, green: 0.714, blue: 0.227) // #E4B63A
    static let speakistCoral = Color(red: 0.898, green: 0.282, blue: 0.302)  // #E5484D
}

/// `ShapeStyle` mirrors so `.foregroundStyle(.speakistPeach)` /
/// `.tint(.speakistPeach)` resolve via dot-syntax, matching how SwiftUI's
/// built-in styles (`.primary`, `.accentColor`) work. Without these the
/// Color extensions only work behind explicit `Color.` qualification.
extension ShapeStyle where Self == Color {
    static var speakistPeach: Color { .speakistPeach }
    static var speakistPlum: Color { .speakistPlum }
    static var speakistCream: Color { .speakistCream }
    static var speakistInk: Color { .speakistInk }
    static var speakistSage: Color { .speakistSage }
    static var speakistMustard: Color { .speakistMustard }
    static var speakistCoral: Color { .speakistCoral }
}

#if canImport(AppKit)
extension NSColor {
    static let speakistPeach = NSColor(red: 1.0, green: 0.541, blue: 0.396, alpha: 1.0)
    static let speakistPlum = NSColor(red: 0.290, green: 0.173, blue: 0.353, alpha: 1.0)
}
#endif

#if canImport(UIKit)
extension UIColor {
    static let speakistPeach = UIColor(red: 1.0, green: 0.541, blue: 0.396, alpha: 1.0)
    static let speakistPlum = UIColor(red: 0.290, green: 0.173, blue: 0.353, alpha: 1.0)
    static let speakistCream = UIColor(red: 1.0, green: 0.965, blue: 0.933, alpha: 1.0)
    static let speakistInk = UIColor(red: 0.106, green: 0.075, blue: 0.133, alpha: 1.0)
    static let speakistSage = UIColor(red: 0.498, green: 0.718, blue: 0.494, alpha: 1.0)
    static let speakistMustard = UIColor(red: 0.894, green: 0.714, blue: 0.227, alpha: 1.0)
    static let speakistCoral = UIColor(red: 0.898, green: 0.282, blue: 0.302, alpha: 1.0)
}
#endif
