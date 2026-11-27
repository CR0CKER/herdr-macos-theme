import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// usage: crop in out x y w h  (pixels, origin top-left)
let a = CommandLine.arguments
guard a.count == 7, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
      let x = Double(a[3]), let y = Double(a[4]), let w = Double(a[5]), let h = Double(a[6]),
      let out = img.cropping(to: CGRect(x: x, y: y, width: w, height: h)),
      let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { print("usage/failed"); exit(1) }
CGImageDestinationAddImage(dst, out, nil); CGImageDestinationFinalize(dst); print("ok")
