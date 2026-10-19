// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Arch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Arch", path: "Sources/Arch")
    ]
)
