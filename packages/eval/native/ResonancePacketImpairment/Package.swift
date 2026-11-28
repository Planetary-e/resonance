// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ResonancePacketImpairment",
  platforms: [.macOS(.v13)],
  products: [.library(name: "PacketShaper", targets: ["PacketShaper"])],
  targets: [
    .target(name: "PacketShaper", path: "Sources/PacketShaper"),
    .testTarget(name: "PacketShaperTests", dependencies: ["PacketShaper"], path: "Tests/PacketShaperTests"),
  ]
)
