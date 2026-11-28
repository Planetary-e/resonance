import Foundation
@preconcurrency import NetworkExtension
import PacketShaper

public enum PacketImpairmentIdentity {
  public static let tunnelBundleIdentifier = "org.planetary.resonance.packetimpairment.controller.tunnel"
  public static let appGroupIdentifier = "RT86W9R3J5.org.planetary.resonance.packetimpairment"
}

public enum ProviderConfigurationError: Error, Equatable, LocalizedError {
  case missingConfiguration
  case unsupportedVersion
  case invalidField(String)
  case invalidRemoteAddress
  case invalidHostAddress(String)
  case disabled
  case emptyTestDestinations
  case emptyLocalAddresses
  case destinationIsLocal(String)
  case missingLocalAddress(String)

  public var errorDescription: String? {
    switch self {
    case .missingConfiguration: "Missing packet-tunnel provider configuration"
    case .unsupportedVersion: "Unsupported packet-tunnel configuration version"
    case .invalidField(let field): "Invalid packet-tunnel configuration field: \(field)"
    case .invalidRemoteAddress: "Tunnel remote address must be a unicast IPv4 or IPv6 address"
    case .invalidHostAddress(let address): "Invalid host address: \(address)"
    case .disabled: "Packet impairment is disabled"
    case .emptyTestDestinations: "At least one explicit test destination is required"
    case .emptyLocalAddresses: "At least one local tunnel address is required"
    case .destinationIsLocal(let address): "Test destination is also a local address: \(address)"
    case .missingLocalAddress(let destination):
      "No local address matches the address family of test destination \(destination)"
    }
  }
}

public struct ProviderConfiguration: Equatable, Sendable {
  public var enabled = false
  public var testDestinations: Set<PacketAddress> = []
  public var localAddresses: Set<PacketAddress> = []
  public var tunnelRemoteAddress = "192.0.2.2"
  public var lossProbability = 0.01
  public var baseDelayNanoseconds: UInt64 = 25_000_000
  public var delayVariationNanoseconds: UInt64 = 5_000_000
  public var queueCapacity = 64
  public var seed: UInt64 = 1

  public init() {}

  public init(providerConfiguration: [String: Any]?) throws {
    guard let providerConfiguration else { throw ProviderConfigurationError.missingConfiguration }
    guard providerConfiguration["version"] as? Int == 1 else {
      throw ProviderConfigurationError.unsupportedVersion
    }
    guard let enabled = providerConfiguration["enabled"] as? Bool else {
      throw ProviderConfigurationError.invalidField("enabled")
    }
    self.enabled = enabled
    testDestinations = try Self.addresses(providerConfiguration, field: "testDestinations")
    localAddresses = try Self.addresses(providerConfiguration, field: "localAddresses")
    tunnelRemoteAddress = try Self.string(providerConfiguration, field: "tunnelRemoteAddress")
    lossProbability = Double(bitPattern: try Self.uint64(providerConfiguration, field: "lossProbabilityBits"))
    baseDelayNanoseconds = try Self.uint64(providerConfiguration, field: "baseDelayNanoseconds")
    delayVariationNanoseconds = try Self.uint64(providerConfiguration, field: "delayVariationNanoseconds")
    guard let queueCapacity = Int(try Self.string(providerConfiguration, field: "queueCapacity")) else {
      throw ProviderConfigurationError.invalidField("queueCapacity")
    }
    self.queueCapacity = queueCapacity
    seed = try Self.uint64(providerConfiguration, field: "seed")
    try validate()
  }

  public var providerConfiguration: [String: Any] {
    [
      "version": 1,
      "enabled": enabled,
      "testDestinations": testDestinations.map(\.description).sorted(),
      "localAddresses": localAddresses.map(\.description).sorted(),
      "tunnelRemoteAddress": tunnelRemoteAddress,
      "lossProbabilityBits": String(lossProbability.bitPattern),
      "baseDelayNanoseconds": String(baseDelayNanoseconds),
      "delayVariationNanoseconds": String(delayVariationNanoseconds),
      "queueCapacity": String(queueCapacity),
      "seed": String(seed),
    ]
  }

  public func profileConfiguration() -> ProfileConfiguration {
    var profile = ProfileConfiguration()
    profile.enabled = enabled
    profile.destinationAllowlist = testDestinations.union(localAddresses)
    profile.localAddresses = localAddresses
    profile.lossProbability = lossProbability
    profile.baseDelayNanoseconds = baseDelayNanoseconds
    profile.delayVariationNanoseconds = delayVariationNanoseconds
    profile.queueCapacity = queueCapacity
    profile.seed = seed
    return profile
  }

  public func validate() throws {
    try profileConfiguration().validate()
    let remote: PacketAddress
    do { remote = try PacketAddress(tunnelRemoteAddress) }
    catch { throw ProviderConfigurationError.invalidRemoteAddress }
    try Self.validateHost(remote)
    for address in testDestinations.union(localAddresses) {
      try Self.validateHost(address)
    }
    for destination in testDestinations where localAddresses.contains(destination) {
      throw ProviderConfigurationError.destinationIsLocal(destination.description)
    }
    guard enabled else { return }
    guard !testDestinations.isEmpty else { throw ProviderConfigurationError.emptyTestDestinations }
    guard !localAddresses.isEmpty else { throw ProviderConfigurationError.emptyLocalAddresses }
    let localFamilies = Set(localAddresses.map(\.bytes.count))
    for destination in testDestinations where !localFamilies.contains(destination.bytes.count) {
      throw ProviderConfigurationError.missingLocalAddress(destination.description)
    }
  }

  public func validateForStart() throws {
    try validate()
    guard enabled else { throw ProviderConfigurationError.disabled }
  }

  public func makeNetworkSettings() throws -> NEPacketTunnelNetworkSettings {
    try validateForStart()
    let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: tunnelRemoteAddress)
    settings.mtu = 1500

    let ipv4Destinations = testDestinations.filter { $0.bytes.count == 4 }.map(\.description).sorted()
    if !ipv4Destinations.isEmpty {
      let addresses = localAddresses.filter { $0.bytes.count == 4 }.map(\.description).sorted()
      let ipv4 = NEIPv4Settings(addresses: addresses, subnetMasks: addresses.map { _ in "255.255.255.255" })
      ipv4.includedRoutes = ipv4Destinations.map {
        NEIPv4Route(destinationAddress: $0, subnetMask: "255.255.255.255")
      }
      settings.ipv4Settings = ipv4
    }

    let ipv6Destinations = testDestinations.filter { $0.bytes.count == 16 }.map(\.description).sorted()
    if !ipv6Destinations.isEmpty {
      let addresses = localAddresses.filter { $0.bytes.count == 16 }.map(\.description).sorted()
      let ipv6 = NEIPv6Settings(addresses: addresses, networkPrefixLengths: addresses.map { _ in 128 })
      ipv6.includedRoutes = ipv6Destinations.map {
        NEIPv6Route(destinationAddress: $0, networkPrefixLength: 128)
      }
      settings.ipv6Settings = ipv6
    }
    return settings
  }

  private static func validateHost(_ address: PacketAddress) throws {
    if address.bytes.count == 4 {
      guard address.bytes != [0, 0, 0, 0], address.bytes != [255, 255, 255, 255],
        address.bytes[0] < 224 else {
        throw ProviderConfigurationError.invalidHostAddress(address.description)
      }
    } else {
      guard address.bytes != Array(repeating: 0, count: 16), address.bytes[0] != 0xff else {
        throw ProviderConfigurationError.invalidHostAddress(address.description)
      }
    }
  }

  private static func string(_ dictionary: [String: Any], field: String) throws -> String {
    guard let value = dictionary[field] as? String else {
      throw ProviderConfigurationError.invalidField(field)
    }
    return value
  }

  private static func uint64(_ dictionary: [String: Any], field: String) throws -> UInt64 {
    guard let value = UInt64(try string(dictionary, field: field)) else {
      throw ProviderConfigurationError.invalidField(field)
    }
    return value
  }

  private static func addresses(
    _ dictionary: [String: Any],
    field: String
  ) throws -> Set<PacketAddress> {
    guard let strings = dictionary[field] as? [String] else {
      throw ProviderConfigurationError.invalidField(field)
    }
    var addresses: Set<PacketAddress> = []
    for string in strings {
      do { addresses.insert(try PacketAddress(string)) }
      catch { throw ProviderConfigurationError.invalidField("\(field): \(string)") }
    }
    return addresses
  }
}
