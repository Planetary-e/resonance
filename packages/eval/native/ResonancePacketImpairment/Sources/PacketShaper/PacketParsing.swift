import Foundation

public enum PacketDirection: String, Hashable, Sendable {
  case inbound
  case outbound
}

public struct PacketAddress: Hashable, Sendable {
  public let bytes: [UInt8]

  public init(bytes: [UInt8]) throws {
    guard bytes.count == 4 || bytes.count == 16 else { throw PacketError.malformedAddress }
    self.bytes = bytes
  }

  public init(_ text: String) throws {
    if text.contains(".") {
      let parts = text.split(separator: ".", omittingEmptySubsequences: false)
      guard parts.count == 4 else { throw PacketError.malformedAddress }
      let octets = try parts.map { part -> UInt8 in
        guard let value = UInt16(part), value <= 255 else { throw PacketError.malformedAddress }
        return UInt8(value)
      }
      try self.init(bytes: octets)
      return
    }
    guard text.contains(":") else { throw PacketError.malformedAddress }
    let halves = text.components(separatedBy: "::")
    guard halves.count <= 2 else { throw PacketError.malformedAddress }
    let left = halves[0].isEmpty ? [] : halves[0].split(separator: ":")
    let right = halves.count == 1 || halves[1].isEmpty ? [] : halves[1].split(separator: ":")
    guard left.count + right.count <= 8, halves.count == 2 || left.count + right.count == 8 else {
      throw PacketError.malformedAddress
    }
    let groups = try left.map { try PacketAddress.hexGroup($0) }
      + Array(repeating: UInt16(0), count: 8 - left.count - right.count)
      + (try right.map { try PacketAddress.hexGroup($0) })
    var bytes: [UInt8] = []
    for group in groups {
      bytes.append(UInt8(group >> 8))
      bytes.append(UInt8(group & 0xff))
    }
    try self.init(bytes: bytes)
  }

  public var description: String {
    if bytes.count == 4 { return bytes.map(String.init).joined(separator: ".") }
    let groups = stride(from: 0, to: 16, by: 2).map { UInt16(bytes[$0]) << 8 | UInt16(bytes[$0 + 1]) }
    var bestStart = -1, bestLength = 0
    var index = 0
    while index < groups.count {
      guard groups[index] == 0 else { index += 1; continue }
      let start = index
      while index < groups.count && groups[index] == 0 { index += 1 }
      if index - start > bestLength && index - start >= 2 {
        bestStart = start
        bestLength = index - start
      }
    }
    let hex = groups.map { String($0, radix: 16) }
    guard bestStart >= 0 else { return hex.joined(separator: ":") }
    let left = hex[..<bestStart].joined(separator: ":")
    let right = hex[(bestStart + bestLength)...].joined(separator: ":")
    return "\(left)::\(right)"
  }

  private static func hexGroup(_ value: Substring) throws -> UInt16 {
    guard !value.isEmpty, value.count <= 4, let group = UInt16(value, radix: 16) else {
      throw PacketError.malformedAddress
    }
    return group
  }
}

public enum PacketError: Error, Equatable {
  case malformedAddress
  case malformedPacket
  case unsupportedVersion
}

public struct ParsedPacket: Sendable {
  public let data: Data
  public let source: PacketAddress
  public let destination: PacketAddress
  public let protocolNumber: UInt8

  public init(data: Data, source: PacketAddress, destination: PacketAddress, protocolNumber: UInt8) {
    self.data = data
    self.source = source
    self.destination = destination
    self.protocolNumber = protocolNumber
  }
}

public func parsePacket(_ data: Data) throws -> ParsedPacket {
  let bytes = [UInt8](data)
  guard let first = bytes.first else { throw PacketError.malformedPacket }
  switch first >> 4 {
  case 4:
    guard bytes.count >= 20 else { throw PacketError.malformedPacket }
    let headerBytes = Int(first & 0x0f) * 4
    guard headerBytes >= 20, headerBytes <= bytes.count else { throw PacketError.malformedPacket }
    let totalBytes = Int(bytes[2]) << 8 | Int(bytes[3])
    guard totalBytes == bytes.count, totalBytes >= headerBytes else { throw PacketError.malformedPacket }
    return ParsedPacket(
      data: data,
      source: try PacketAddress(bytes: Array(bytes[12..<16])),
      destination: try PacketAddress(bytes: Array(bytes[16..<20])),
      protocolNumber: bytes[9]
    )
  case 6:
    guard bytes.count >= 40 else { throw PacketError.malformedPacket }
    let payloadBytes = Int(bytes[4]) << 8 | Int(bytes[5])
    guard payloadBytes == bytes.count - 40 else { throw PacketError.malformedPacket }
    return ParsedPacket(
      data: data,
      source: try PacketAddress(bytes: Array(bytes[8..<24])),
      destination: try PacketAddress(bytes: Array(bytes[24..<40])),
      protocolNumber: bytes[6]
    )
  default:
    throw PacketError.unsupportedVersion
  }
}
