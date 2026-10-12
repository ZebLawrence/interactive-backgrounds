// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Lake",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Lake", path: "Sources/Lake")
    ]
)
