import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// usage: hstack out in1 in2 ... : places images side by side
let a = CommandLine.arguments
let imgs = a.dropFirst(2).compactMap { p -> CGImage? in
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(s, 0, nil) }
let w = imgs.reduce(0) { $0 + $1.width + 20 }, h = imgs.map { $0.height }.max() ?? 0
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
var x = 0; for i in imgs { ctx.draw(i, in: CGRect(x: x, y: h - i.height, width: i.width, height: i.height)); x += i.width + 20 }
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, ctx.makeImage()!, nil); CGImageDestinationFinalize(d); print("ok")
