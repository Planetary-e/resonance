import Foundation
import PacketShaper

public enum SharedCounterStoreError: Error, Equatable, LocalizedError {
  case appGroupUnavailable
  case malformedValue
  case persistenceFailed

  public var errorDescription: String? {
    switch self {
    case .appGroupUnavailable: "The signed packet-impairment app group is unavailable"
    case .malformedValue: "The shared packet-shaper counters are malformed"
    case .persistenceFailed: "The app-group packet-shaper counters could not be persisted"
    }
  }
}

/// Uses one app-group defaults value; the provider writes and the containing app reads.
public final class AppGroupCounterStore {
  static let storageKey = "packetShaperCounters"
  private let defaults: UserDefaults

  public init() throws {
    guard let defaults = UserDefaults(suiteName: PacketImpairmentIdentity.appGroupIdentifier) else {
      throw SharedCounterStoreError.appGroupUnavailable
    }
    self.defaults = defaults
  }

  init(defaults: UserDefaults) {
    self.defaults = defaults
  }

  public func load() throws -> ShaperCounters {
    guard let dictionary = defaults.dictionary(forKey: Self.storageKey) else { return ShaperCounters() }
    guard dictionary.count == 6 else { throw SharedCounterStoreError.malformedValue }
    return try ShaperCounters(
      profileDrop: Self.value("profileDrop", dictionary: dictionary),
      overflowDrop: Self.value("overflowDrop", dictionary: dictionary),
      forwarded: Self.value("forwarded", dictionary: dictionary),
      malformed: Self.value("malformed", dictionary: dictionary),
      delayed: Self.value("delayed", dictionary: dictionary),
      cancelled: Self.value("cancelled", dictionary: dictionary)
    )
  }

  public func save(_ counters: ShaperCounters) throws {
    defaults.set([
      "profileDrop": counters.profileDrop,
      "overflowDrop": counters.overflowDrop,
      "forwarded": counters.forwarded,
      "malformed": counters.malformed,
      "delayed": counters.delayed,
      "cancelled": counters.cancelled,
    ], forKey: Self.storageKey)
    guard defaults.dictionary(forKey: Self.storageKey) != nil, try load() == counters else {
      throw SharedCounterStoreError.persistenceFailed
    }
  }

  private static func value(_ key: String, dictionary: [String: Any]) throws -> Int {
    guard let value = dictionary[key] as? Int, value >= 0 else {
      throw SharedCounterStoreError.malformedValue
    }
    return value
  }
}
