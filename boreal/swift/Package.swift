// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Boreal",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Boreal", path: "Sources/Boreal")
    ]
)
