// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ResonancePacketImpairment",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "PacketShaper", targets: ["PacketShaper"]),
    .library(name: "PacketTunnelControl", targets: ["PacketTunnelControl"]),
  ],
  targets: [
    .target(name: "PacketShaper", path: "Sources/PacketShaper"),
    .target(
      name: "PacketTunnelControl",
      dependencies: ["PacketShaper"],
      path: "Sources/TunnelControl"
    ),
    .testTarget(
      name: "PacketShaperTests",
      dependencies: ["PacketShaper", "PacketTunnelControl"],
      path: "Tests/PacketShaperTests"
    ),
  ]
)
