// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Fishbowl",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Fishbowl", path: "Sources/Fishbowl")
    ]
)
