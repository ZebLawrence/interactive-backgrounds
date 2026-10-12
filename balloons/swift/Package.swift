// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Balloons",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Balloons", path: "Sources/Balloons")
    ]
)
