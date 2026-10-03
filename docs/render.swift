// Draws the README animation: the real userscript, loaded into docs/mock.html
// in an off-screen web view, as its bar gets narrower.
//
//   swiftc -o "$TMPDIR/hud-bin" docs/render.swift && "$TMPDIR/hud-bin" "$PWD" "$TMPDIR/hud"
//   for t in light dark; do ffmpeg -y -framerate 10/11 -i "$TMPDIR/hud/$t-%02d.png" -filter_complex \
//       "scale=1680:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" -loop 0 docs/hud-$t.gif; done
import AppKit
import WebKit

let repo = URL(fileURLWithPath: CommandLine.arguments[1])
let out = URL(fileURLWithPath: CommandLine.arguments[2])
let widths = [1096, 896, 700, 520, 330, 520, 700, 896]       // of the mock window, in CSS px

@MainActor
func render() async throws {
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 2240, height: 136))
    web.pageZoom = 2
    let window = NSWindow(contentRect: web.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = web
    web.loadFileURL(repo.appendingPathComponent("docs/mock.html"), allowingReadAccessTo: repo)

    for _ in 0..<50 {       // until the script has drawn its bars
        try await Task.sleep(for: .milliseconds(200))
        let ready = try? await web.evaluateJavaScript("String(!!document.querySelector('.cuh .cuh-bar'))") as? String
        if ready == "true" { break }
    }
    for mode in ["light", "dark"] {
        for (i, width) in widths.enumerated() {
            _ = try await web.evaluateJavaScript("setFrame('\(mode)', \(width))")
            try await Task.sleep(for: .milliseconds(700))
            let image = try await web.takeSnapshot(configuration: nil)
            let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
            let name = String(format: "%@-%02d.png", mode, i)
            try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
        }
    }
    print("wrote frames to \(out.path)")
}

_ = NSApplication.shared
Task { @MainActor in
    do { try await render() } catch { print("failed: \(error)") }
    exit(0)
}
RunLoop.main.run()
