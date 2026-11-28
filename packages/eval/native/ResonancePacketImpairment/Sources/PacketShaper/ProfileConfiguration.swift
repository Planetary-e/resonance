import CryptoKit
import Foundation

public struct ProfileConfiguration: Sendable {
  public var enabled = false
  public var destinationAllowlist: Set<PacketAddress> = []
  public var localAddresses: Set<PacketAddress> = []
  public var lossProbability = 0.01
  public var baseDelayNanoseconds: UInt64 = 25_000_000
  public var delayVariationNanoseconds: UInt64 = 5_000_000
  public var queueCapacity = 64
  public var seed: UInt64 = 1

  public init() {}

  public func validate() throws {
    guard queueCapacity > 0,
      lossProbability >= 0,
      lossProbability <= 1,
      delayVariationNanoseconds <= baseDelayNanoseconds,
      delayVariationNanoseconds <= (UInt64.max - 1) / 2,
      baseDelayNanoseconds <= UInt64.max - delayVariationNanoseconds else {
      throw ConfigurationError.malformedConfiguration
    }
  }

  public var orderingPolicy: String {
    "ascending monotonic due time, then original admission sequence"
  }

  public var configurationHash: String {
    let canonical = [
      "enabled=\(enabled)",
      "seed=\(seed)",
      "lossBits=\(lossProbability.bitPattern)",
      "baseDelayNs=\(baseDelayNanoseconds)",
      "delayVariationNs=\(delayVariationNanoseconds)",
      "queueCapacity=\(queueCapacity)",
      "local=" + localAddresses.map(\.description).sorted().joined(separator: ","),
      "allowlist=" + destinationAllowlist.map(\.description).sorted().joined(separator: ","),
      "ordering=\(orderingPolicy)",
    ].joined(separator: "|")
    return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

public enum ConfigurationError: Error {
  case malformedConfiguration
}
