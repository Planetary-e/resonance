import { app as dr, BrowserWindow as gs, nativeImage as vs, Tray as Es, Menu as Ss } from "electron";
import { createServer as xi } from "node:http";
import Ts, { existsSync as jt, readFileSync as Gt, writeFileSync as ar, mkdirSync as Yr } from "node:fs";
import { join as pt, dirname as Is, resolve as En, extname as Os } from "node:path";
import _i from "events";
import As from "https";
import bi from "http";
import Cs from "net";
import Ns from "tls";
import Vr from "crypto";
import Mr from "stream";
import Ds from "url";
import Ls from "zlib";
import Ms from "buffer";
import Rs, { randomUUID as Kr, randomBytes as Us } from "node:crypto";
import { homedir as Ps } from "node:os";
import ks from "hnswlib-node";
function Rr(l) {
  return l && l.__esModule && Object.prototype.hasOwnProperty.call(l, "default") ? l.default : l;
}
function wi(l) {
  if (Object.prototype.hasOwnProperty.call(l, "__esModule")) return l;
  var n = l.default;
  if (typeof n == "function") {
    var a = function c() {
      var p = !1;
      try {
        p = this instanceof c;
      } catch {
      }
      return p ? Reflect.construct(n, arguments, this.constructor) : n.apply(this, arguments);
    };
    a.prototype = n.prototype;
  } else a = {};
  return Object.defineProperty(a, "__esModule", { value: !0 }), Object.keys(l).forEach(function(c) {
    var p = Object.getOwnPropertyDescriptor(l, c);
    Object.defineProperty(a, c, p.get ? p : {
      enumerable: !0,
      get: function() {
        return l[c];
      }
    });
  }), a;
}
var Cr = { exports: {} }, en, Gn;
function mr() {
  if (Gn) return en;
  Gn = 1;
  const l = ["nodebuffer", "arraybuffer", "fragments"], n = typeof Blob < "u";
  return n && l.push("blob"), en = {
    BINARY_TYPES: l,
    CLOSE_TIMEOUT: 3e4,
    EMPTY_BUFFER: Buffer.alloc(0),
    GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
    hasBlob: n,
    kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
    kListener: /* @__PURE__ */ Symbol("kListener"),
    kStatusCode: /* @__PURE__ */ Symbol("status-code"),
    kWebSocket: /* @__PURE__ */ Symbol("websocket"),
    NOOP: () => {
    }
  }, en;
}
const Bs = {}, Fs = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Bs
}, Symbol.toStringTag, { value: "Module" })), js = /* @__PURE__ */ wi(Fs);
var Yn;
function Xr() {
  if (Yn) return Cr.exports;
  Yn = 1;
  const { EMPTY_BUFFER: l } = mr(), n = Buffer[Symbol.species];
  function a(_, g) {
    if (_.length === 0) return l;
    if (_.length === 1) return _[0];
    const u = Buffer.allocUnsafe(g);
    let O = 0;
    for (let T = 0; T < _.length; T++) {
      const A = _[T];
      u.set(A, O), O += A.length;
    }
    return O < g ? new n(u.buffer, u.byteOffset, O) : u;
  }
  function c(_, g, u, O, T) {
    for (let A = 0; A < T; A++)
      u[O + A] = _[A] ^ g[A & 3];
  }
  function p(_, g) {
    for (let u = 0; u < _.length; u++)
      _[u] ^= g[u & 3];
  }
  function b(_) {
    return _.length === _.buffer.byteLength ? _.buffer : _.buffer.slice(_.byteOffset, _.byteOffset + _.length);
  }
  function m(_) {
    if (m.readOnly = !0, Buffer.isBuffer(_)) return _;
    let g;
    return _ instanceof ArrayBuffer ? g = new n(_) : ArrayBuffer.isView(_) ? g = new n(_.buffer, _.byteOffset, _.byteLength) : (g = Buffer.from(_), m.readOnly = !1), g;
  }
  if (Cr.exports = {
    concat: a,
    mask: c,
    toArrayBuffer: b,
    toBuffer: m,
    unmask: p
  }, !process.env.WS_NO_BUFFER_UTIL)
    try {
      const _ = js;
      Cr.exports.mask = function(g, u, O, T, A) {
        A < 48 ? c(g, u, O, T, A) : _.mask(g, u, O, T, A);
      }, Cr.exports.unmask = function(g, u) {
        g.length < 32 ? p(g, u) : _.unmask(g, u);
      };
    } catch {
    }
  return Cr.exports;
}
var tn, Vn;
function qs() {
  if (Vn) return tn;
  Vn = 1;
  const l = /* @__PURE__ */ Symbol("kDone"), n = /* @__PURE__ */ Symbol("kRun");
  class a {
    /**
     * Creates a new `Limiter`.
     *
     * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
     *     to run concurrently
     */
    constructor(p) {
      this[l] = () => {
        this.pending--, this[n]();
      }, this.concurrency = p || 1 / 0, this.jobs = [], this.pending = 0;
    }
    /**
     * Adds a job to the queue.
     *
     * @param {Function} job The job to run
     * @public
     */
    add(p) {
      this.jobs.push(p), this[n]();
    }
    /**
     * Removes a job from the queue and runs it if possible.
     *
     * @private
     */
    [n]() {
      if (this.pending !== this.concurrency && this.jobs.length) {
        const p = this.jobs.shift();
        this.pending++, p(this[l]);
      }
    }
  }
  return tn = a, tn;
}
var rn, Xn;
function Ur() {
  if (Xn) return rn;
  Xn = 1;
  const l = Ls, n = Xr(), a = qs(), { kStatusCode: c } = mr(), p = Buffer[Symbol.species], b = Buffer.from([0, 0, 255, 255]), m = /* @__PURE__ */ Symbol("permessage-deflate"), _ = /* @__PURE__ */ Symbol("total-length"), g = /* @__PURE__ */ Symbol("callback"), u = /* @__PURE__ */ Symbol("buffers"), O = /* @__PURE__ */ Symbol("error");
  let T;
  class A {
    /**
     * Creates a PerMessageDeflate instance.
     *
     * @param {Object} [options] Configuration options
     * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
     *     for, or request, a custom client window size
     * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
     *     acknowledge disabling of client context takeover
     * @param {Number} [options.concurrencyLimit=10] The number of concurrent
     *     calls to zlib
     * @param {Boolean} [options.isServer=false] Create the instance in either
     *     server or client mode
     * @param {Number} [options.maxPayload=0] The maximum allowed message length
     * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
     *     use of a custom server window size
     * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
     *     disabling of server context takeover
     * @param {Number} [options.threshold=1024] Size (in bytes) below which
     *     messages should not be compressed if context takeover is disabled
     * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
     *     deflate
     * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
     *     inflate
     */
    constructor(q) {
      if (this._options = q || {}, this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024, this._maxPayload = this._options.maxPayload | 0, this._isServer = !!this._options.isServer, this._deflate = null, this._inflate = null, this.params = null, !T) {
        const D = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
        T = new a(D);
      }
    }
    /**
     * @type {String}
     */
    static get extensionName() {
      return "permessage-deflate";
    }
    /**
     * Create an extension negotiation offer.
     *
     * @return {Object} Extension parameters
     * @public
     */
    offer() {
      const q = {};
      return this._options.serverNoContextTakeover && (q.server_no_context_takeover = !0), this._options.clientNoContextTakeover && (q.client_no_context_takeover = !0), this._options.serverMaxWindowBits && (q.server_max_window_bits = this._options.serverMaxWindowBits), this._options.clientMaxWindowBits ? q.client_max_window_bits = this._options.clientMaxWindowBits : this._options.clientMaxWindowBits == null && (q.client_max_window_bits = !0), q;
    }
    /**
     * Accept an extension negotiation offer/response.
     *
     * @param {Array} configurations The extension negotiation offers/reponse
     * @return {Object} Accepted configuration
     * @public
     */
    accept(q) {
      return q = this.normalizeParams(q), this.params = this._isServer ? this.acceptAsServer(q) : this.acceptAsClient(q), this.params;
    }
    /**
     * Releases all resources used by the extension.
     *
     * @public
     */
    cleanup() {
      if (this._inflate && (this._inflate.close(), this._inflate = null), this._deflate) {
        const q = this._deflate[g];
        this._deflate.close(), this._deflate = null, q && q(
          new Error(
            "The deflate stream was closed while data was being processed"
          )
        );
      }
    }
    /**
     *  Accept an extension negotiation offer.
     *
     * @param {Array} offers The extension negotiation offers
     * @return {Object} Accepted configuration
     * @private
     */
    acceptAsServer(q) {
      const D = this._options, X = q.find((V) => !(D.serverNoContextTakeover === !1 && V.server_no_context_takeover || V.server_max_window_bits && (D.serverMaxWindowBits === !1 || typeof D.serverMaxWindowBits == "number" && D.serverMaxWindowBits > V.server_max_window_bits) || typeof D.clientMaxWindowBits == "number" && !V.client_max_window_bits));
      if (!X)
        throw new Error("None of the extension offers can be accepted");
      return D.serverNoContextTakeover && (X.server_no_context_takeover = !0), D.clientNoContextTakeover && (X.client_no_context_takeover = !0), typeof D.serverMaxWindowBits == "number" && (X.server_max_window_bits = D.serverMaxWindowBits), typeof D.clientMaxWindowBits == "number" ? X.client_max_window_bits = D.clientMaxWindowBits : (X.client_max_window_bits === !0 || D.clientMaxWindowBits === !1) && delete X.client_max_window_bits, X;
    }
    /**
     * Accept the extension negotiation response.
     *
     * @param {Array} response The extension negotiation response
     * @return {Object} Accepted configuration
     * @private
     */
    acceptAsClient(q) {
      const D = q[0];
      if (this._options.clientNoContextTakeover === !1 && D.client_no_context_takeover)
        throw new Error('Unexpected parameter "client_no_context_takeover"');
      if (!D.client_max_window_bits)
        typeof this._options.clientMaxWindowBits == "number" && (D.client_max_window_bits = this._options.clientMaxWindowBits);
      else if (this._options.clientMaxWindowBits === !1 || typeof this._options.clientMaxWindowBits == "number" && D.client_max_window_bits > this._options.clientMaxWindowBits)
        throw new Error(
          'Unexpected or invalid parameter "client_max_window_bits"'
        );
      return D;
    }
    /**
     * Normalize parameters.
     *
     * @param {Array} configurations The extension negotiation offers/reponse
     * @return {Array} The offers/response with normalized parameters
     * @private
     */
    normalizeParams(q) {
      return q.forEach((D) => {
        Object.keys(D).forEach((X) => {
          let V = D[X];
          if (V.length > 1)
            throw new Error(`Parameter "${X}" must have only a single value`);
          if (V = V[0], X === "client_max_window_bits") {
            if (V !== !0) {
              const v = +V;
              if (!Number.isInteger(v) || v < 8 || v > 15)
                throw new TypeError(
                  `Invalid value for parameter "${X}": ${V}`
                );
              V = v;
            } else if (!this._isServer)
              throw new TypeError(
                `Invalid value for parameter "${X}": ${V}`
              );
          } else if (X === "server_max_window_bits") {
            const v = +V;
            if (!Number.isInteger(v) || v < 8 || v > 15)
              throw new TypeError(
                `Invalid value for parameter "${X}": ${V}`
              );
            V = v;
          } else if (X === "client_no_context_takeover" || X === "server_no_context_takeover") {
            if (V !== !0)
              throw new TypeError(
                `Invalid value for parameter "${X}": ${V}`
              );
          } else
            throw new Error(`Unknown parameter "${X}"`);
          D[X] = V;
        });
      }), q;
    }
    /**
     * Decompress data. Concurrency limited.
     *
     * @param {Buffer} data Compressed data
     * @param {Boolean} fin Specifies whether or not this is the last fragment
     * @param {Function} callback Callback
     * @public
     */
    decompress(q, D, X) {
      T.add((V) => {
        this._decompress(q, D, (v, x) => {
          V(), X(v, x);
        });
      });
    }
    /**
     * Compress data. Concurrency limited.
     *
     * @param {(Buffer|String)} data Data to compress
     * @param {Boolean} fin Specifies whether or not this is the last fragment
     * @param {Function} callback Callback
     * @public
     */
    compress(q, D, X) {
      T.add((V) => {
        this._compress(q, D, (v, x) => {
          V(), X(v, x);
        });
      });
    }
    /**
     * Decompress data.
     *
     * @param {Buffer} data Compressed data
     * @param {Boolean} fin Specifies whether or not this is the last fragment
     * @param {Function} callback Callback
     * @private
     */
    _decompress(q, D, X) {
      const V = this._isServer ? "client" : "server";
      if (!this._inflate) {
        const v = `${V}_max_window_bits`, x = typeof this.params[v] != "number" ? l.Z_DEFAULT_WINDOWBITS : this.params[v];
        this._inflate = l.createInflateRaw({
          ...this._options.zlibInflateOptions,
          windowBits: x
        }), this._inflate[m] = this, this._inflate[_] = 0, this._inflate[u] = [], this._inflate.on("error", Q), this._inflate.on("data", Y);
      }
      this._inflate[g] = X, this._inflate.write(q), D && this._inflate.write(b), this._inflate.flush(() => {
        const v = this._inflate[O];
        if (v) {
          this._inflate.close(), this._inflate = null, X(v);
          return;
        }
        const x = n.concat(
          this._inflate[u],
          this._inflate[_]
        );
        this._inflate._readableState.endEmitted ? (this._inflate.close(), this._inflate = null) : (this._inflate[_] = 0, this._inflate[u] = [], D && this.params[`${V}_no_context_takeover`] && this._inflate.reset()), X(null, x);
      });
    }
    /**
     * Compress data.
     *
     * @param {(Buffer|String)} data Data to compress
     * @param {Boolean} fin Specifies whether or not this is the last fragment
     * @param {Function} callback Callback
     * @private
     */
    _compress(q, D, X) {
      const V = this._isServer ? "server" : "client";
      if (!this._deflate) {
        const v = `${V}_max_window_bits`, x = typeof this.params[v] != "number" ? l.Z_DEFAULT_WINDOWBITS : this.params[v];
        this._deflate = l.createDeflateRaw({
          ...this._options.zlibDeflateOptions,
          windowBits: x
        }), this._deflate[_] = 0, this._deflate[u] = [], this._deflate.on("data", k);
      }
      this._deflate[g] = X, this._deflate.write(q), this._deflate.flush(l.Z_SYNC_FLUSH, () => {
        if (!this._deflate)
          return;
        let v = n.concat(
          this._deflate[u],
          this._deflate[_]
        );
        D && (v = new p(v.buffer, v.byteOffset, v.length - 4)), this._deflate[g] = null, this._deflate[_] = 0, this._deflate[u] = [], D && this.params[`${V}_no_context_takeover`] && this._deflate.reset(), X(null, v);
      });
    }
  }
  rn = A;
  function k(Z) {
    this[u].push(Z), this[_] += Z.length;
  }
  function Y(Z) {
    if (this[_] += Z.length, this[m]._maxPayload < 1 || this[_] <= this[m]._maxPayload) {
      this[u].push(Z);
      return;
    }
    this[O] = new RangeError("Max payload size exceeded"), this[O].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", this[O][c] = 1009, this.removeListener("data", Y), this.reset();
  }
  function Q(Z) {
    if (this[m]._inflate = null, this[O]) {
      this[g](this[O]);
      return;
    }
    Z[c] = 1007, this[g](Z);
  }
  return rn;
}
var Nr = { exports: {} };
const Ws = {}, $s = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Ws
}, Symbol.toStringTag, { value: "Module" })), zs = /* @__PURE__ */ wi($s);
var Jn;
function Pr() {
  if (Jn) return Nr.exports;
  Jn = 1;
  const { isUtf8: l } = Ms, { hasBlob: n } = mr(), a = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    // 0 - 15
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    // 16 - 31
    0,
    1,
    0,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    1,
    1,
    0,
    1,
    1,
    0,
    // 32 - 47
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    // 48 - 63
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    // 64 - 79
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    1,
    1,
    // 80 - 95
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    // 96 - 111
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    1,
    0,
    1,
    0
    // 112 - 127
  ];
  function c(m) {
    return m >= 1e3 && m <= 1014 && m !== 1004 && m !== 1005 && m !== 1006 || m >= 3e3 && m <= 4999;
  }
  function p(m) {
    const _ = m.length;
    let g = 0;
    for (; g < _; )
      if ((m[g] & 128) === 0)
        g++;
      else if ((m[g] & 224) === 192) {
        if (g + 1 === _ || (m[g + 1] & 192) !== 128 || (m[g] & 254) === 192)
          return !1;
        g += 2;
      } else if ((m[g] & 240) === 224) {
        if (g + 2 >= _ || (m[g + 1] & 192) !== 128 || (m[g + 2] & 192) !== 128 || m[g] === 224 && (m[g + 1] & 224) === 128 || // Overlong
        m[g] === 237 && (m[g + 1] & 224) === 160)
          return !1;
        g += 3;
      } else if ((m[g] & 248) === 240) {
        if (g + 3 >= _ || (m[g + 1] & 192) !== 128 || (m[g + 2] & 192) !== 128 || (m[g + 3] & 192) !== 128 || m[g] === 240 && (m[g + 1] & 240) === 128 || // Overlong
        m[g] === 244 && m[g + 1] > 143 || m[g] > 244)
          return !1;
        g += 4;
      } else
        return !1;
    return !0;
  }
  function b(m) {
    return n && typeof m == "object" && typeof m.arrayBuffer == "function" && typeof m.type == "string" && typeof m.stream == "function" && (m[Symbol.toStringTag] === "Blob" || m[Symbol.toStringTag] === "File");
  }
  if (Nr.exports = {
    isBlob: b,
    isValidStatusCode: c,
    isValidUTF8: p,
    tokenChars: a
  }, l)
    Nr.exports.isValidUTF8 = function(m) {
      return m.length < 24 ? p(m) : l(m);
    };
  else if (!process.env.WS_NO_UTF_8_VALIDATE)
    try {
      const m = zs;
      Nr.exports.isValidUTF8 = function(_) {
        return _.length < 32 ? p(_) : m(_);
      };
    } catch {
    }
  return Nr.exports;
}
var nn, Qn;
function gi() {
  if (Qn) return nn;
  Qn = 1;
  const { Writable: l } = Mr, n = Ur(), {
    BINARY_TYPES: a,
    EMPTY_BUFFER: c,
    kStatusCode: p,
    kWebSocket: b
  } = mr(), { concat: m, toArrayBuffer: _, unmask: g } = Xr(), { isValidStatusCode: u, isValidUTF8: O } = Pr(), T = Buffer[Symbol.species], A = 0, k = 1, Y = 2, Q = 3, Z = 4, q = 5, D = 6;
  class X extends l {
    /**
     * Creates a Receiver instance.
     *
     * @param {Object} [options] Options object
     * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
     *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
     *     multiple times in the same tick
     * @param {String} [options.binaryType=nodebuffer] The type for binary data
     * @param {Object} [options.extensions] An object containing the negotiated
     *     extensions
     * @param {Boolean} [options.isServer=false] Specifies whether to operate in
     *     client or server mode
     * @param {Number} [options.maxPayload=0] The maximum allowed message length
     * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
     *     not to skip UTF-8 validation for text and close messages
     */
    constructor(v = {}) {
      super(), this._allowSynchronousEvents = v.allowSynchronousEvents !== void 0 ? v.allowSynchronousEvents : !0, this._binaryType = v.binaryType || a[0], this._extensions = v.extensions || {}, this._isServer = !!v.isServer, this._maxPayload = v.maxPayload | 0, this._skipUTF8Validation = !!v.skipUTF8Validation, this[b] = void 0, this._bufferedBytes = 0, this._buffers = [], this._compressed = !1, this._payloadLength = 0, this._mask = void 0, this._fragmented = 0, this._masked = !1, this._fin = !1, this._opcode = 0, this._totalPayloadLength = 0, this._messageLength = 0, this._fragments = [], this._errored = !1, this._loop = !1, this._state = A;
    }
    /**
     * Implements `Writable.prototype._write()`.
     *
     * @param {Buffer} chunk The chunk of data to write
     * @param {String} encoding The character encoding of `chunk`
     * @param {Function} cb Callback
     * @private
     */
    _write(v, x, M) {
      if (this._opcode === 8 && this._state == A) return M();
      this._bufferedBytes += v.length, this._buffers.push(v), this.startLoop(M);
    }
    /**
     * Consumes `n` bytes from the buffered data.
     *
     * @param {Number} n The number of bytes to consume
     * @return {Buffer} The consumed bytes
     * @private
     */
    consume(v) {
      if (this._bufferedBytes -= v, v === this._buffers[0].length) return this._buffers.shift();
      if (v < this._buffers[0].length) {
        const M = this._buffers[0];
        return this._buffers[0] = new T(
          M.buffer,
          M.byteOffset + v,
          M.length - v
        ), new T(M.buffer, M.byteOffset, v);
      }
      const x = Buffer.allocUnsafe(v);
      do {
        const M = this._buffers[0], U = x.length - v;
        v >= M.length ? x.set(this._buffers.shift(), U) : (x.set(new Uint8Array(M.buffer, M.byteOffset, v), U), this._buffers[0] = new T(
          M.buffer,
          M.byteOffset + v,
          M.length - v
        )), v -= M.length;
      } while (v > 0);
      return x;
    }
    /**
     * Starts the parsing loop.
     *
     * @param {Function} cb Callback
     * @private
     */
    startLoop(v) {
      this._loop = !0;
      do
        switch (this._state) {
          case A:
            this.getInfo(v);
            break;
          case k:
            this.getPayloadLength16(v);
            break;
          case Y:
            this.getPayloadLength64(v);
            break;
          case Q:
            this.getMask();
            break;
          case Z:
            this.getData(v);
            break;
          case q:
          case D:
            this._loop = !1;
            return;
        }
      while (this._loop);
      this._errored || v();
    }
    /**
     * Reads the first two bytes of a frame.
     *
     * @param {Function} cb Callback
     * @private
     */
    getInfo(v) {
      if (this._bufferedBytes < 2) {
        this._loop = !1;
        return;
      }
      const x = this.consume(2);
      if ((x[0] & 48) !== 0) {
        const U = this.createError(
          RangeError,
          "RSV2 and RSV3 must be clear",
          !0,
          1002,
          "WS_ERR_UNEXPECTED_RSV_2_3"
        );
        v(U);
        return;
      }
      const M = (x[0] & 64) === 64;
      if (M && !this._extensions[n.extensionName]) {
        const U = this.createError(
          RangeError,
          "RSV1 must be clear",
          !0,
          1002,
          "WS_ERR_UNEXPECTED_RSV_1"
        );
        v(U);
        return;
      }
      if (this._fin = (x[0] & 128) === 128, this._opcode = x[0] & 15, this._payloadLength = x[1] & 127, this._opcode === 0) {
        if (M) {
          const U = this.createError(
            RangeError,
            "RSV1 must be clear",
            !0,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          v(U);
          return;
        }
        if (!this._fragmented) {
          const U = this.createError(
            RangeError,
            "invalid opcode 0",
            !0,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          v(U);
          return;
        }
        this._opcode = this._fragmented;
      } else if (this._opcode === 1 || this._opcode === 2) {
        if (this._fragmented) {
          const U = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            !0,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          v(U);
          return;
        }
        this._compressed = M;
      } else if (this._opcode > 7 && this._opcode < 11) {
        if (!this._fin) {
          const U = this.createError(
            RangeError,
            "FIN must be set",
            !0,
            1002,
            "WS_ERR_EXPECTED_FIN"
          );
          v(U);
          return;
        }
        if (M) {
          const U = this.createError(
            RangeError,
            "RSV1 must be clear",
            !0,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          v(U);
          return;
        }
        if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
          const U = this.createError(
            RangeError,
            `invalid payload length ${this._payloadLength}`,
            !0,
            1002,
            "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
          );
          v(U);
          return;
        }
      } else {
        const U = this.createError(
          RangeError,
          `invalid opcode ${this._opcode}`,
          !0,
          1002,
          "WS_ERR_INVALID_OPCODE"
        );
        v(U);
        return;
      }
      if (!this._fin && !this._fragmented && (this._fragmented = this._opcode), this._masked = (x[1] & 128) === 128, this._isServer) {
        if (!this._masked) {
          const U = this.createError(
            RangeError,
            "MASK must be set",
            !0,
            1002,
            "WS_ERR_EXPECTED_MASK"
          );
          v(U);
          return;
        }
      } else if (this._masked) {
        const U = this.createError(
          RangeError,
          "MASK must be clear",
          !0,
          1002,
          "WS_ERR_UNEXPECTED_MASK"
        );
        v(U);
        return;
      }
      this._payloadLength === 126 ? this._state = k : this._payloadLength === 127 ? this._state = Y : this.haveLength(v);
    }
    /**
     * Gets extended payload length (7+16).
     *
     * @param {Function} cb Callback
     * @private
     */
    getPayloadLength16(v) {
      if (this._bufferedBytes < 2) {
        this._loop = !1;
        return;
      }
      this._payloadLength = this.consume(2).readUInt16BE(0), this.haveLength(v);
    }
    /**
     * Gets extended payload length (7+64).
     *
     * @param {Function} cb Callback
     * @private
     */
    getPayloadLength64(v) {
      if (this._bufferedBytes < 8) {
        this._loop = !1;
        return;
      }
      const x = this.consume(8), M = x.readUInt32BE(0);
      if (M > Math.pow(2, 21) - 1) {
        const U = this.createError(
          RangeError,
          "Unsupported WebSocket frame: payload length > 2^53 - 1",
          !1,
          1009,
          "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
        );
        v(U);
        return;
      }
      this._payloadLength = M * Math.pow(2, 32) + x.readUInt32BE(4), this.haveLength(v);
    }
    /**
     * Payload length has been read.
     *
     * @param {Function} cb Callback
     * @private
     */
    haveLength(v) {
      if (this._payloadLength && this._opcode < 8 && (this._totalPayloadLength += this._payloadLength, this._totalPayloadLength > this._maxPayload && this._maxPayload > 0)) {
        const x = this.createError(
          RangeError,
          "Max payload size exceeded",
          !1,
          1009,
          "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
        );
        v(x);
        return;
      }
      this._masked ? this._state = Q : this._state = Z;
    }
    /**
     * Reads mask bytes.
     *
     * @private
     */
    getMask() {
      if (this._bufferedBytes < 4) {
        this._loop = !1;
        return;
      }
      this._mask = this.consume(4), this._state = Z;
    }
    /**
     * Reads data bytes.
     *
     * @param {Function} cb Callback
     * @private
     */
    getData(v) {
      let x = c;
      if (this._payloadLength) {
        if (this._bufferedBytes < this._payloadLength) {
          this._loop = !1;
          return;
        }
        x = this.consume(this._payloadLength), this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0 && g(x, this._mask);
      }
      if (this._opcode > 7) {
        this.controlMessage(x, v);
        return;
      }
      if (this._compressed) {
        this._state = q, this.decompress(x, v);
        return;
      }
      x.length && (this._messageLength = this._totalPayloadLength, this._fragments.push(x)), this.dataMessage(v);
    }
    /**
     * Decompresses data.
     *
     * @param {Buffer} data Compressed data
     * @param {Function} cb Callback
     * @private
     */
    decompress(v, x) {
      this._extensions[n.extensionName].decompress(v, this._fin, (U, te) => {
        if (U) return x(U);
        if (te.length) {
          if (this._messageLength += te.length, this._messageLength > this._maxPayload && this._maxPayload > 0) {
            const H = this.createError(
              RangeError,
              "Max payload size exceeded",
              !1,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            x(H);
            return;
          }
          this._fragments.push(te);
        }
        this.dataMessage(x), this._state === A && this.startLoop(x);
      });
    }
    /**
     * Handles a data message.
     *
     * @param {Function} cb Callback
     * @private
     */
    dataMessage(v) {
      if (!this._fin) {
        this._state = A;
        return;
      }
      const x = this._messageLength, M = this._fragments;
      if (this._totalPayloadLength = 0, this._messageLength = 0, this._fragmented = 0, this._fragments = [], this._opcode === 2) {
        let U;
        this._binaryType === "nodebuffer" ? U = m(M, x) : this._binaryType === "arraybuffer" ? U = _(m(M, x)) : this._binaryType === "blob" ? U = new Blob(M) : U = M, this._allowSynchronousEvents ? (this.emit("message", U, !0), this._state = A) : (this._state = D, setImmediate(() => {
          this.emit("message", U, !0), this._state = A, this.startLoop(v);
        }));
      } else {
        const U = m(M, x);
        if (!this._skipUTF8Validation && !O(U)) {
          const te = this.createError(
            Error,
            "invalid UTF-8 sequence",
            !0,
            1007,
            "WS_ERR_INVALID_UTF8"
          );
          v(te);
          return;
        }
        this._state === q || this._allowSynchronousEvents ? (this.emit("message", U, !1), this._state = A) : (this._state = D, setImmediate(() => {
          this.emit("message", U, !1), this._state = A, this.startLoop(v);
        }));
      }
    }
    /**
     * Handles a control message.
     *
     * @param {Buffer} data Data to handle
     * @return {(Error|RangeError|undefined)} A possible error
     * @private
     */
    controlMessage(v, x) {
      if (this._opcode === 8) {
        if (v.length === 0)
          this._loop = !1, this.emit("conclude", 1005, c), this.end();
        else {
          const M = v.readUInt16BE(0);
          if (!u(M)) {
            const te = this.createError(
              RangeError,
              `invalid status code ${M}`,
              !0,
              1002,
              "WS_ERR_INVALID_CLOSE_CODE"
            );
            x(te);
            return;
          }
          const U = new T(
            v.buffer,
            v.byteOffset + 2,
            v.length - 2
          );
          if (!this._skipUTF8Validation && !O(U)) {
            const te = this.createError(
              Error,
              "invalid UTF-8 sequence",
              !0,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            x(te);
            return;
          }
          this._loop = !1, this.emit("conclude", M, U), this.end();
        }
        this._state = A;
        return;
      }
      this._allowSynchronousEvents ? (this.emit(this._opcode === 9 ? "ping" : "pong", v), this._state = A) : (this._state = D, setImmediate(() => {
        this.emit(this._opcode === 9 ? "ping" : "pong", v), this._state = A, this.startLoop(x);
      }));
    }
    /**
     * Builds an error object.
     *
     * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
     * @param {String} message The error message
     * @param {Boolean} prefix Specifies whether or not to add a default prefix to
     *     `message`
     * @param {Number} statusCode The status code
     * @param {String} errorCode The exposed error code
     * @return {(Error|RangeError)} The error
     * @private
     */
    createError(v, x, M, U, te) {
      this._loop = !1, this._errored = !0;
      const H = new v(
        M ? `Invalid WebSocket frame: ${x}` : x
      );
      return Error.captureStackTrace(H, this.createError), H.code = te, H[p] = U, H;
    }
  }
  return nn = X, nn;
}
var sn, Zn;
function vi() {
  if (Zn) return sn;
  Zn = 1;
  const { Duplex: l } = Mr, { randomFillSync: n } = Vr, a = Ur(), { EMPTY_BUFFER: c, kWebSocket: p, NOOP: b } = mr(), { isBlob: m, isValidStatusCode: _ } = Pr(), { mask: g, toBuffer: u } = Xr(), O = /* @__PURE__ */ Symbol("kByteLength"), T = Buffer.alloc(4), A = 8 * 1024;
  let k, Y = A;
  const Q = 0, Z = 1, q = 2;
  class D {
    /**
     * Creates a Sender instance.
     *
     * @param {Duplex} socket The connection socket
     * @param {Object} [extensions] An object containing the negotiated extensions
     * @param {Function} [generateMask] The function used to generate the masking
     *     key
     */
    constructor(x, M, U) {
      this._extensions = M || {}, U && (this._generateMask = U, this._maskBuffer = Buffer.alloc(4)), this._socket = x, this._firstFragment = !0, this._compress = !1, this._bufferedBytes = 0, this._queue = [], this._state = Q, this.onerror = b, this[p] = void 0;
    }
    /**
     * Frames a piece of data according to the HyBi WebSocket protocol.
     *
     * @param {(Buffer|String)} data The data to frame
     * @param {Object} options Options object
     * @param {Boolean} [options.fin=false] Specifies whether or not to set the
     *     FIN bit
     * @param {Function} [options.generateMask] The function used to generate the
     *     masking key
     * @param {Boolean} [options.mask=false] Specifies whether or not to mask
     *     `data`
     * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
     *     key
     * @param {Number} options.opcode The opcode
     * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
     *     modified
     * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
     *     RSV1 bit
     * @return {(Buffer|String)[]} The framed data
     * @public
     */
    static frame(x, M) {
      let U, te = !1, H = 2, ee = !1;
      M.mask && (U = M.maskBuffer || T, M.generateMask ? M.generateMask(U) : (Y === A && (k === void 0 && (k = Buffer.alloc(A)), n(k, 0, A), Y = 0), U[0] = k[Y++], U[1] = k[Y++], U[2] = k[Y++], U[3] = k[Y++]), ee = (U[0] | U[1] | U[2] | U[3]) === 0, H = 6);
      let Ie;
      typeof x == "string" ? (!M.mask || ee) && M[O] !== void 0 ? Ie = M[O] : (x = Buffer.from(x), Ie = x.length) : (Ie = x.length, te = M.mask && M.readOnly && !ee);
      let Se = Ie;
      Ie >= 65536 ? (H += 8, Se = 127) : Ie > 125 && (H += 2, Se = 126);
      const se = Buffer.allocUnsafe(te ? Ie + H : H);
      return se[0] = M.fin ? M.opcode | 128 : M.opcode, M.rsv1 && (se[0] |= 64), se[1] = Se, Se === 126 ? se.writeUInt16BE(Ie, 2) : Se === 127 && (se[2] = se[3] = 0, se.writeUIntBE(Ie, 4, 6)), M.mask ? (se[1] |= 128, se[H - 4] = U[0], se[H - 3] = U[1], se[H - 2] = U[2], se[H - 1] = U[3], ee ? [se, x] : te ? (g(x, U, se, H, Ie), [se]) : (g(x, U, x, 0, Ie), [se, x])) : [se, x];
    }
    /**
     * Sends a close message to the other peer.
     *
     * @param {Number} [code] The status code component of the body
     * @param {(String|Buffer)} [data] The message component of the body
     * @param {Boolean} [mask=false] Specifies whether or not to mask the message
     * @param {Function} [cb] Callback
     * @public
     */
    close(x, M, U, te) {
      let H;
      if (x === void 0)
        H = c;
      else {
        if (typeof x != "number" || !_(x))
          throw new TypeError("First argument must be a valid error code number");
        if (M === void 0 || !M.length)
          H = Buffer.allocUnsafe(2), H.writeUInt16BE(x, 0);
        else {
          const Ie = Buffer.byteLength(M);
          if (Ie > 123)
            throw new RangeError("The message must not be greater than 123 bytes");
          H = Buffer.allocUnsafe(2 + Ie), H.writeUInt16BE(x, 0), typeof M == "string" ? H.write(M, 2) : H.set(M, 2);
        }
      }
      const ee = {
        [O]: H.length,
        fin: !0,
        generateMask: this._generateMask,
        mask: U,
        maskBuffer: this._maskBuffer,
        opcode: 8,
        readOnly: !1,
        rsv1: !1
      };
      this._state !== Q ? this.enqueue([this.dispatch, H, !1, ee, te]) : this.sendFrame(D.frame(H, ee), te);
    }
    /**
     * Sends a ping message to the other peer.
     *
     * @param {*} data The message to send
     * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
     * @param {Function} [cb] Callback
     * @public
     */
    ping(x, M, U) {
      let te, H;
      if (typeof x == "string" ? (te = Buffer.byteLength(x), H = !1) : m(x) ? (te = x.size, H = !1) : (x = u(x), te = x.length, H = u.readOnly), te > 125)
        throw new RangeError("The data size must not be greater than 125 bytes");
      const ee = {
        [O]: te,
        fin: !0,
        generateMask: this._generateMask,
        mask: M,
        maskBuffer: this._maskBuffer,
        opcode: 9,
        readOnly: H,
        rsv1: !1
      };
      m(x) ? this._state !== Q ? this.enqueue([this.getBlobData, x, !1, ee, U]) : this.getBlobData(x, !1, ee, U) : this._state !== Q ? this.enqueue([this.dispatch, x, !1, ee, U]) : this.sendFrame(D.frame(x, ee), U);
    }
    /**
     * Sends a pong message to the other peer.
     *
     * @param {*} data The message to send
     * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
     * @param {Function} [cb] Callback
     * @public
     */
    pong(x, M, U) {
      let te, H;
      if (typeof x == "string" ? (te = Buffer.byteLength(x), H = !1) : m(x) ? (te = x.size, H = !1) : (x = u(x), te = x.length, H = u.readOnly), te > 125)
        throw new RangeError("The data size must not be greater than 125 bytes");
      const ee = {
        [O]: te,
        fin: !0,
        generateMask: this._generateMask,
        mask: M,
        maskBuffer: this._maskBuffer,
        opcode: 10,
        readOnly: H,
        rsv1: !1
      };
      m(x) ? this._state !== Q ? this.enqueue([this.getBlobData, x, !1, ee, U]) : this.getBlobData(x, !1, ee, U) : this._state !== Q ? this.enqueue([this.dispatch, x, !1, ee, U]) : this.sendFrame(D.frame(x, ee), U);
    }
    /**
     * Sends a data message to the other peer.
     *
     * @param {*} data The message to send
     * @param {Object} options Options object
     * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
     *     or text
     * @param {Boolean} [options.compress=false] Specifies whether or not to
     *     compress `data`
     * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
     *     last one
     * @param {Boolean} [options.mask=false] Specifies whether or not to mask
     *     `data`
     * @param {Function} [cb] Callback
     * @public
     */
    send(x, M, U) {
      const te = this._extensions[a.extensionName];
      let H = M.binary ? 2 : 1, ee = M.compress, Ie, Se;
      typeof x == "string" ? (Ie = Buffer.byteLength(x), Se = !1) : m(x) ? (Ie = x.size, Se = !1) : (x = u(x), Ie = x.length, Se = u.readOnly), this._firstFragment ? (this._firstFragment = !1, ee && te && te.params[te._isServer ? "server_no_context_takeover" : "client_no_context_takeover"] && (ee = Ie >= te._threshold), this._compress = ee) : (ee = !1, H = 0), M.fin && (this._firstFragment = !0);
      const se = {
        [O]: Ie,
        fin: M.fin,
        generateMask: this._generateMask,
        mask: M.mask,
        maskBuffer: this._maskBuffer,
        opcode: H,
        readOnly: Se,
        rsv1: ee
      };
      m(x) ? this._state !== Q ? this.enqueue([this.getBlobData, x, this._compress, se, U]) : this.getBlobData(x, this._compress, se, U) : this._state !== Q ? this.enqueue([this.dispatch, x, this._compress, se, U]) : this.dispatch(x, this._compress, se, U);
    }
    /**
     * Gets the contents of a blob as binary data.
     *
     * @param {Blob} blob The blob
     * @param {Boolean} [compress=false] Specifies whether or not to compress
     *     the data
     * @param {Object} options Options object
     * @param {Boolean} [options.fin=false] Specifies whether or not to set the
     *     FIN bit
     * @param {Function} [options.generateMask] The function used to generate the
     *     masking key
     * @param {Boolean} [options.mask=false] Specifies whether or not to mask
     *     `data`
     * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
     *     key
     * @param {Number} options.opcode The opcode
     * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
     *     modified
     * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
     *     RSV1 bit
     * @param {Function} [cb] Callback
     * @private
     */
    getBlobData(x, M, U, te) {
      this._bufferedBytes += U[O], this._state = q, x.arrayBuffer().then((H) => {
        if (this._socket.destroyed) {
          const Ie = new Error(
            "The socket was closed while the blob was being read"
          );
          process.nextTick(X, this, Ie, te);
          return;
        }
        this._bufferedBytes -= U[O];
        const ee = u(H);
        M ? this.dispatch(ee, M, U, te) : (this._state = Q, this.sendFrame(D.frame(ee, U), te), this.dequeue());
      }).catch((H) => {
        process.nextTick(V, this, H, te);
      });
    }
    /**
     * Dispatches a message.
     *
     * @param {(Buffer|String)} data The message to send
     * @param {Boolean} [compress=false] Specifies whether or not to compress
     *     `data`
     * @param {Object} options Options object
     * @param {Boolean} [options.fin=false] Specifies whether or not to set the
     *     FIN bit
     * @param {Function} [options.generateMask] The function used to generate the
     *     masking key
     * @param {Boolean} [options.mask=false] Specifies whether or not to mask
     *     `data`
     * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
     *     key
     * @param {Number} options.opcode The opcode
     * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
     *     modified
     * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
     *     RSV1 bit
     * @param {Function} [cb] Callback
     * @private
     */
    dispatch(x, M, U, te) {
      if (!M) {
        this.sendFrame(D.frame(x, U), te);
        return;
      }
      const H = this._extensions[a.extensionName];
      this._bufferedBytes += U[O], this._state = Z, H.compress(x, U.fin, (ee, Ie) => {
        if (this._socket.destroyed) {
          const Se = new Error(
            "The socket was closed while data was being compressed"
          );
          X(this, Se, te);
          return;
        }
        this._bufferedBytes -= U[O], this._state = Q, U.readOnly = !1, this.sendFrame(D.frame(Ie, U), te), this.dequeue();
      });
    }
    /**
     * Executes queued send operations.
     *
     * @private
     */
    dequeue() {
      for (; this._state === Q && this._queue.length; ) {
        const x = this._queue.shift();
        this._bufferedBytes -= x[3][O], Reflect.apply(x[0], this, x.slice(1));
      }
    }
    /**
     * Enqueues a send operation.
     *
     * @param {Array} params Send operation parameters.
     * @private
     */
    enqueue(x) {
      this._bufferedBytes += x[3][O], this._queue.push(x);
    }
    /**
     * Sends a frame.
     *
     * @param {(Buffer | String)[]} list The frame to send
     * @param {Function} [cb] Callback
     * @private
     */
    sendFrame(x, M) {
      x.length === 2 ? (this._socket.cork(), this._socket.write(x[0]), this._socket.write(x[1], M), this._socket.uncork()) : this._socket.write(x[0], M);
    }
  }
  sn = D;
  function X(v, x, M) {
    typeof M == "function" && M(x);
    for (let U = 0; U < v._queue.length; U++) {
      const te = v._queue[U], H = te[te.length - 1];
      typeof H == "function" && H(x);
    }
  }
  function V(v, x, M) {
    X(v, x, M), v.onerror(x);
  }
  return sn;
}
var on, ei;
function Hs() {
  if (ei) return on;
  ei = 1;
  const { kForOnEventAttribute: l, kListener: n } = mr(), a = /* @__PURE__ */ Symbol("kCode"), c = /* @__PURE__ */ Symbol("kData"), p = /* @__PURE__ */ Symbol("kError"), b = /* @__PURE__ */ Symbol("kMessage"), m = /* @__PURE__ */ Symbol("kReason"), _ = /* @__PURE__ */ Symbol("kTarget"), g = /* @__PURE__ */ Symbol("kType"), u = /* @__PURE__ */ Symbol("kWasClean");
  class O {
    /**
     * Create a new `Event`.
     *
     * @param {String} type The name of the event
     * @throws {TypeError} If the `type` argument is not specified
     */
    constructor(q) {
      this[_] = null, this[g] = q;
    }
    /**
     * @type {*}
     */
    get target() {
      return this[_];
    }
    /**
     * @type {String}
     */
    get type() {
      return this[g];
    }
  }
  Object.defineProperty(O.prototype, "target", { enumerable: !0 }), Object.defineProperty(O.prototype, "type", { enumerable: !0 });
  class T extends O {
    /**
     * Create a new `CloseEvent`.
     *
     * @param {String} type The name of the event
     * @param {Object} [options] A dictionary object that allows for setting
     *     attributes via object members of the same name
     * @param {Number} [options.code=0] The status code explaining why the
     *     connection was closed
     * @param {String} [options.reason=''] A human-readable string explaining why
     *     the connection was closed
     * @param {Boolean} [options.wasClean=false] Indicates whether or not the
     *     connection was cleanly closed
     */
    constructor(q, D = {}) {
      super(q), this[a] = D.code === void 0 ? 0 : D.code, this[m] = D.reason === void 0 ? "" : D.reason, this[u] = D.wasClean === void 0 ? !1 : D.wasClean;
    }
    /**
     * @type {Number}
     */
    get code() {
      return this[a];
    }
    /**
     * @type {String}
     */
    get reason() {
      return this[m];
    }
    /**
     * @type {Boolean}
     */
    get wasClean() {
      return this[u];
    }
  }
  Object.defineProperty(T.prototype, "code", { enumerable: !0 }), Object.defineProperty(T.prototype, "reason", { enumerable: !0 }), Object.defineProperty(T.prototype, "wasClean", { enumerable: !0 });
  class A extends O {
    /**
     * Create a new `ErrorEvent`.
     *
     * @param {String} type The name of the event
     * @param {Object} [options] A dictionary object that allows for setting
     *     attributes via object members of the same name
     * @param {*} [options.error=null] The error that generated this event
     * @param {String} [options.message=''] The error message
     */
    constructor(q, D = {}) {
      super(q), this[p] = D.error === void 0 ? null : D.error, this[b] = D.message === void 0 ? "" : D.message;
    }
    /**
     * @type {*}
     */
    get error() {
      return this[p];
    }
    /**
     * @type {String}
     */
    get message() {
      return this[b];
    }
  }
  Object.defineProperty(A.prototype, "error", { enumerable: !0 }), Object.defineProperty(A.prototype, "message", { enumerable: !0 });
  class k extends O {
    /**
     * Create a new `MessageEvent`.
     *
     * @param {String} type The name of the event
     * @param {Object} [options] A dictionary object that allows for setting
     *     attributes via object members of the same name
     * @param {*} [options.data=null] The message content
     */
    constructor(q, D = {}) {
      super(q), this[c] = D.data === void 0 ? null : D.data;
    }
    /**
     * @type {*}
     */
    get data() {
      return this[c];
    }
  }
  Object.defineProperty(k.prototype, "data", { enumerable: !0 }), on = {
    CloseEvent: T,
    ErrorEvent: A,
    Event: O,
    EventTarget: {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(Z, q, D = {}) {
        for (const V of this.listeners(Z))
          if (!D[l] && V[n] === q && !V[l])
            return;
        let X;
        if (Z === "message")
          X = function(v, x) {
            const M = new k("message", {
              data: x ? v : v.toString()
            });
            M[_] = this, Q(q, this, M);
          };
        else if (Z === "close")
          X = function(v, x) {
            const M = new T("close", {
              code: v,
              reason: x.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            M[_] = this, Q(q, this, M);
          };
        else if (Z === "error")
          X = function(v) {
            const x = new A("error", {
              error: v,
              message: v.message
            });
            x[_] = this, Q(q, this, x);
          };
        else if (Z === "open")
          X = function() {
            const v = new O("open");
            v[_] = this, Q(q, this, v);
          };
        else
          return;
        X[l] = !!D[l], X[n] = q, D.once ? this.once(Z, X) : this.on(Z, X);
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(Z, q) {
        for (const D of this.listeners(Z))
          if (D[n] === q && !D[l]) {
            this.removeListener(Z, D);
            break;
          }
      }
    },
    MessageEvent: k
  };
  function Q(Z, q, D) {
    typeof Z == "object" && Z.handleEvent ? Z.handleEvent.call(Z, D) : Z.call(q, D);
  }
  return on;
}
var an, ti;
function In() {
  if (ti) return an;
  ti = 1;
  const { tokenChars: l } = Pr();
  function n(p, b, m) {
    p[b] === void 0 ? p[b] = [m] : p[b].push(m);
  }
  function a(p) {
    const b = /* @__PURE__ */ Object.create(null);
    let m = /* @__PURE__ */ Object.create(null), _ = !1, g = !1, u = !1, O, T, A = -1, k = -1, Y = -1, Q = 0;
    for (; Q < p.length; Q++)
      if (k = p.charCodeAt(Q), O === void 0)
        if (Y === -1 && l[k] === 1)
          A === -1 && (A = Q);
        else if (Q !== 0 && (k === 32 || k === 9))
          Y === -1 && A !== -1 && (Y = Q);
        else if (k === 59 || k === 44) {
          if (A === -1)
            throw new SyntaxError(`Unexpected character at index ${Q}`);
          Y === -1 && (Y = Q);
          const q = p.slice(A, Y);
          k === 44 ? (n(b, q, m), m = /* @__PURE__ */ Object.create(null)) : O = q, A = Y = -1;
        } else
          throw new SyntaxError(`Unexpected character at index ${Q}`);
      else if (T === void 0)
        if (Y === -1 && l[k] === 1)
          A === -1 && (A = Q);
        else if (k === 32 || k === 9)
          Y === -1 && A !== -1 && (Y = Q);
        else if (k === 59 || k === 44) {
          if (A === -1)
            throw new SyntaxError(`Unexpected character at index ${Q}`);
          Y === -1 && (Y = Q), n(m, p.slice(A, Y), !0), k === 44 && (n(b, O, m), m = /* @__PURE__ */ Object.create(null), O = void 0), A = Y = -1;
        } else if (k === 61 && A !== -1 && Y === -1)
          T = p.slice(A, Q), A = Y = -1;
        else
          throw new SyntaxError(`Unexpected character at index ${Q}`);
      else if (g) {
        if (l[k] !== 1)
          throw new SyntaxError(`Unexpected character at index ${Q}`);
        A === -1 ? A = Q : _ || (_ = !0), g = !1;
      } else if (u)
        if (l[k] === 1)
          A === -1 && (A = Q);
        else if (k === 34 && A !== -1)
          u = !1, Y = Q;
        else if (k === 92)
          g = !0;
        else
          throw new SyntaxError(`Unexpected character at index ${Q}`);
      else if (k === 34 && p.charCodeAt(Q - 1) === 61)
        u = !0;
      else if (Y === -1 && l[k] === 1)
        A === -1 && (A = Q);
      else if (A !== -1 && (k === 32 || k === 9))
        Y === -1 && (Y = Q);
      else if (k === 59 || k === 44) {
        if (A === -1)
          throw new SyntaxError(`Unexpected character at index ${Q}`);
        Y === -1 && (Y = Q);
        let q = p.slice(A, Y);
        _ && (q = q.replace(/\\/g, ""), _ = !1), n(m, T, q), k === 44 && (n(b, O, m), m = /* @__PURE__ */ Object.create(null), O = void 0), T = void 0, A = Y = -1;
      } else
        throw new SyntaxError(`Unexpected character at index ${Q}`);
    if (A === -1 || u || k === 32 || k === 9)
      throw new SyntaxError("Unexpected end of input");
    Y === -1 && (Y = Q);
    const Z = p.slice(A, Y);
    return O === void 0 ? n(b, Z, m) : (T === void 0 ? n(m, Z, !0) : _ ? n(m, T, Z.replace(/\\/g, "")) : n(m, T, Z), n(b, O, m)), b;
  }
  function c(p) {
    return Object.keys(p).map((b) => {
      let m = p[b];
      return Array.isArray(m) || (m = [m]), m.map((_) => [b].concat(
        Object.keys(_).map((g) => {
          let u = _[g];
          return Array.isArray(u) || (u = [u]), u.map((O) => O === !0 ? g : `${g}=${O}`).join("; ");
        })
      ).join("; ")).join(", ");
    }).join(", ");
  }
  return an = { format: c, parse: a }, an;
}
var fn, ri;
function On() {
  if (ri) return fn;
  ri = 1;
  const l = _i, n = As, a = bi, c = Cs, p = Ns, { randomBytes: b, createHash: m } = Vr, { Duplex: _, Readable: g } = Mr, { URL: u } = Ds, O = Ur(), T = gi(), A = vi(), { isBlob: k } = Pr(), {
    BINARY_TYPES: Y,
    CLOSE_TIMEOUT: Q,
    EMPTY_BUFFER: Z,
    GUID: q,
    kForOnEventAttribute: D,
    kListener: X,
    kStatusCode: V,
    kWebSocket: v,
    NOOP: x
  } = mr(), {
    EventTarget: { addEventListener: M, removeEventListener: U }
  } = Hs(), { format: te, parse: H } = In(), { toBuffer: ee } = Xr(), Ie = /* @__PURE__ */ Symbol("kAborted"), Se = [8, 13], se = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"], Ge = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
  class ae extends l {
    /**
     * Create a new `WebSocket`.
     *
     * @param {(String|URL)} address The URL to which to connect
     * @param {(String|String[])} [protocols] The subprotocols
     * @param {Object} [options] Connection options
     */
    constructor($, fe, be) {
      super(), this._binaryType = Y[0], this._closeCode = 1006, this._closeFrameReceived = !1, this._closeFrameSent = !1, this._closeMessage = Z, this._closeTimer = null, this._errorEmitted = !1, this._extensions = {}, this._paused = !1, this._protocol = "", this._readyState = ae.CONNECTING, this._receiver = null, this._sender = null, this._socket = null, $ !== null ? (this._bufferedAmount = 0, this._isServer = !1, this._redirects = 0, fe === void 0 ? fe = [] : Array.isArray(fe) || (typeof fe == "object" && fe !== null ? (be = fe, fe = []) : fe = [fe]), Ye(this, $, fe, be)) : (this._autoPong = be.autoPong, this._closeTimeout = be.closeTimeout, this._isServer = !0);
    }
    /**
     * For historical reasons, the custom "nodebuffer" type is used by the default
     * instead of "blob".
     *
     * @type {String}
     */
    get binaryType() {
      return this._binaryType;
    }
    set binaryType($) {
      Y.includes($) && (this._binaryType = $, this._receiver && (this._receiver._binaryType = $));
    }
    /**
     * @type {Number}
     */
    get bufferedAmount() {
      return this._socket ? this._socket._writableState.length + this._sender._bufferedBytes : this._bufferedAmount;
    }
    /**
     * @type {String}
     */
    get extensions() {
      return Object.keys(this._extensions).join();
    }
    /**
     * @type {Boolean}
     */
    get isPaused() {
      return this._paused;
    }
    /**
     * @type {Function}
     */
    /* istanbul ignore next */
    get onclose() {
      return null;
    }
    /**
     * @type {Function}
     */
    /* istanbul ignore next */
    get onerror() {
      return null;
    }
    /**
     * @type {Function}
     */
    /* istanbul ignore next */
    get onopen() {
      return null;
    }
    /**
     * @type {Function}
     */
    /* istanbul ignore next */
    get onmessage() {
      return null;
    }
    /**
     * @type {String}
     */
    get protocol() {
      return this._protocol;
    }
    /**
     * @type {Number}
     */
    get readyState() {
      return this._readyState;
    }
    /**
     * @type {String}
     */
    get url() {
      return this._url;
    }
    /**
     * Set up the socket and the internal resources.
     *
     * @param {Duplex} socket The network socket between the server and client
     * @param {Buffer} head The first packet of the upgraded stream
     * @param {Object} options Options object
     * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
     *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
     *     multiple times in the same tick
     * @param {Function} [options.generateMask] The function used to generate the
     *     masking key
     * @param {Number} [options.maxPayload=0] The maximum allowed message size
     * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
     *     not to skip UTF-8 validation for text and close messages
     * @private
     */
    setSocket($, fe, be) {
      const ce = new T({
        allowSynchronousEvents: be.allowSynchronousEvents,
        binaryType: this.binaryType,
        extensions: this._extensions,
        isServer: this._isServer,
        maxPayload: be.maxPayload,
        skipUTF8Validation: be.skipUTF8Validation
      }), $e = new A($, this._extensions, be.generateMask);
      this._receiver = ce, this._sender = $e, this._socket = $, ce[v] = this, $e[v] = this, $[v] = this, ce.on("conclude", It), ce.on("drain", bt), ce.on("error", Ue), ce.on("message", yr), ce.on("ping", Tr), ce.on("pong", At), $e.onerror = Ct, $.setTimeout && $.setTimeout(0), $.setNoDelay && $.setNoDelay(), fe.length > 0 && $.unshift(fe), $.on("close", qt), $.on("data", nr), $.on("end", xr), $.on("error", tt), this._readyState = ae.OPEN, this.emit("open");
    }
    /**
     * Emit the `'close'` event.
     *
     * @private
     */
    emitClose() {
      if (!this._socket) {
        this._readyState = ae.CLOSED, this.emit("close", this._closeCode, this._closeMessage);
        return;
      }
      this._extensions[O.extensionName] && this._extensions[O.extensionName].cleanup(), this._receiver.removeAllListeners(), this._readyState = ae.CLOSED, this.emit("close", this._closeCode, this._closeMessage);
    }
    /**
     * Start a closing handshake.
     *
     *          +----------+   +-----------+   +----------+
     *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
     *    |     +----------+   +-----------+   +----------+     |
     *          +----------+   +-----------+         |
     * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
     *          +----------+   +-----------+   |
     *    |           |                        |   +---+        |
     *                +------------------------+-->|fin| - - - -
     *    |         +---+                      |   +---+
     *     - - - - -|fin|<---------------------+
     *              +---+
     *
     * @param {Number} [code] Status code explaining why the connection is closing
     * @param {(String|Buffer)} [data] The reason why the connection is
     *     closing
     * @public
     */
    close($, fe) {
      if (this.readyState !== ae.CLOSED) {
        if (this.readyState === ae.CONNECTING) {
          lt(this, this._req, "WebSocket was closed before the connection was established");
          return;
        }
        if (this.readyState === ae.CLOSING) {
          this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted) && this._socket.end();
          return;
        }
        this._readyState = ae.CLOSING, this._sender.close($, fe, !this._isServer, (be) => {
          be || (this._closeFrameSent = !0, (this._closeFrameReceived || this._receiver._writableState.errorEmitted) && this._socket.end());
        }), Pt(this);
      }
    }
    /**
     * Pause the socket.
     *
     * @public
     */
    pause() {
      this.readyState === ae.CONNECTING || this.readyState === ae.CLOSED || (this._paused = !0, this._socket.pause());
    }
    /**
     * Send a ping.
     *
     * @param {*} [data] The data to send
     * @param {Boolean} [mask] Indicates whether or not to mask `data`
     * @param {Function} [cb] Callback which is executed when the ping is sent
     * @public
     */
    ping($, fe, be) {
      if (this.readyState === ae.CONNECTING)
        throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
      if (typeof $ == "function" ? (be = $, $ = fe = void 0) : typeof fe == "function" && (be = fe, fe = void 0), typeof $ == "number" && ($ = $.toString()), this.readyState !== ae.OPEN) {
        rr(this, $, be);
        return;
      }
      fe === void 0 && (fe = !this._isServer), this._sender.ping($ || Z, fe, be);
    }
    /**
     * Send a pong.
     *
     * @param {*} [data] The data to send
     * @param {Boolean} [mask] Indicates whether or not to mask `data`
     * @param {Function} [cb] Callback which is executed when the pong is sent
     * @public
     */
    pong($, fe, be) {
      if (this.readyState === ae.CONNECTING)
        throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
      if (typeof $ == "function" ? (be = $, $ = fe = void 0) : typeof fe == "function" && (be = fe, fe = void 0), typeof $ == "number" && ($ = $.toString()), this.readyState !== ae.OPEN) {
        rr(this, $, be);
        return;
      }
      fe === void 0 && (fe = !this._isServer), this._sender.pong($ || Z, fe, be);
    }
    /**
     * Resume the socket.
     *
     * @public
     */
    resume() {
      this.readyState === ae.CONNECTING || this.readyState === ae.CLOSED || (this._paused = !1, this._receiver._writableState.needDrain || this._socket.resume());
    }
    /**
     * Send a data message.
     *
     * @param {*} data The message to send
     * @param {Object} [options] Options object
     * @param {Boolean} [options.binary] Specifies whether `data` is binary or
     *     text
     * @param {Boolean} [options.compress] Specifies whether or not to compress
     *     `data`
     * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
     *     last one
     * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
     * @param {Function} [cb] Callback which is executed when data is written out
     * @public
     */
    send($, fe, be) {
      if (this.readyState === ae.CONNECTING)
        throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
      if (typeof fe == "function" && (be = fe, fe = {}), typeof $ == "number" && ($ = $.toString()), this.readyState !== ae.OPEN) {
        rr(this, $, be);
        return;
      }
      const ce = {
        binary: typeof $ != "string",
        mask: !this._isServer,
        compress: !0,
        fin: !0,
        ...fe
      };
      this._extensions[O.extensionName] || (ce.compress = !1), this._sender.send($ || Z, ce, be);
    }
    /**
     * Forcibly close the connection.
     *
     * @public
     */
    terminate() {
      if (this.readyState !== ae.CLOSED) {
        if (this.readyState === ae.CONNECTING) {
          lt(this, this._req, "WebSocket was closed before the connection was established");
          return;
        }
        this._socket && (this._readyState = ae.CLOSING, this._socket.destroy());
      }
    }
  }
  Object.defineProperty(ae, "CONNECTING", {
    enumerable: !0,
    value: se.indexOf("CONNECTING")
  }), Object.defineProperty(ae.prototype, "CONNECTING", {
    enumerable: !0,
    value: se.indexOf("CONNECTING")
  }), Object.defineProperty(ae, "OPEN", {
    enumerable: !0,
    value: se.indexOf("OPEN")
  }), Object.defineProperty(ae.prototype, "OPEN", {
    enumerable: !0,
    value: se.indexOf("OPEN")
  }), Object.defineProperty(ae, "CLOSING", {
    enumerable: !0,
    value: se.indexOf("CLOSING")
  }), Object.defineProperty(ae.prototype, "CLOSING", {
    enumerable: !0,
    value: se.indexOf("CLOSING")
  }), Object.defineProperty(ae, "CLOSED", {
    enumerable: !0,
    value: se.indexOf("CLOSED")
  }), Object.defineProperty(ae.prototype, "CLOSED", {
    enumerable: !0,
    value: se.indexOf("CLOSED")
  }), [
    "binaryType",
    "bufferedAmount",
    "extensions",
    "isPaused",
    "protocol",
    "readyState",
    "url"
  ].forEach((R) => {
    Object.defineProperty(ae.prototype, R, { enumerable: !0 });
  }), ["open", "error", "close", "message"].forEach((R) => {
    Object.defineProperty(ae.prototype, `on${R}`, {
      enumerable: !0,
      get() {
        for (const $ of this.listeners(R))
          if ($[D]) return $[X];
        return null;
      },
      set($) {
        for (const fe of this.listeners(R))
          if (fe[D]) {
            this.removeListener(R, fe);
            break;
          }
        typeof $ == "function" && this.addEventListener(R, $, {
          [D]: !0
        });
      }
    });
  }), ae.prototype.addEventListener = M, ae.prototype.removeEventListener = U, fn = ae;
  function Ye(R, $, fe, be) {
    const ce = {
      allowSynchronousEvents: !0,
      autoPong: !0,
      closeTimeout: Q,
      protocolVersion: Se[1],
      maxPayload: 104857600,
      skipUTF8Validation: !1,
      perMessageDeflate: !0,
      followRedirects: !1,
      maxRedirects: 10,
      ...be,
      socketPath: void 0,
      hostname: void 0,
      protocol: void 0,
      timeout: void 0,
      method: "GET",
      host: void 0,
      path: void 0,
      port: void 0
    };
    if (R._autoPong = ce.autoPong, R._closeTimeout = ce.closeTimeout, !Se.includes(ce.protocolVersion))
      throw new RangeError(
        `Unsupported protocol version: ${ce.protocolVersion} (supported versions: ${Se.join(", ")})`
      );
    let $e;
    if ($ instanceof u)
      $e = $;
    else
      try {
        $e = new u($);
      } catch {
        throw new SyntaxError(`Invalid URL: ${$}`);
      }
    $e.protocol === "http:" ? $e.protocol = "ws:" : $e.protocol === "https:" && ($e.protocol = "wss:"), R._url = $e.href;
    const kt = $e.protocol === "wss:", Et = $e.protocol === "ws+unix:";
    let Mt;
    if ($e.protocol !== "ws:" && !kt && !Et ? Mt = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"` : Et && !$e.pathname ? Mt = "The URL's pathname is empty" : $e.hash && (Mt = "The URL contains a fragment identifier"), Mt) {
      const ze = new SyntaxError(Mt);
      if (R._redirects === 0)
        throw ze;
      at(R, ze);
      return;
    }
    const Nt = kt ? 443 : 80, wt = b(16).toString("base64"), ir = kt ? n.request : a.request, Wt = /* @__PURE__ */ new Set();
    let sr;
    if (ce.createConnection = ce.createConnection || (kt ? Xt : _t), ce.defaultPort = ce.defaultPort || Nt, ce.port = $e.port || Nt, ce.host = $e.hostname.startsWith("[") ? $e.hostname.slice(1, -1) : $e.hostname, ce.headers = {
      ...ce.headers,
      "Sec-WebSocket-Version": ce.protocolVersion,
      "Sec-WebSocket-Key": wt,
      Connection: "Upgrade",
      Upgrade: "websocket"
    }, ce.path = $e.pathname + $e.search, ce.timeout = ce.handshakeTimeout, ce.perMessageDeflate && (sr = new O({
      ...ce.perMessageDeflate,
      isServer: !1,
      maxPayload: ce.maxPayload
    }), ce.headers["Sec-WebSocket-Extensions"] = te({
      [O.extensionName]: sr.offer()
    })), fe.length) {
      for (const ze of fe) {
        if (typeof ze != "string" || !Ge.test(ze) || Wt.has(ze))
          throw new SyntaxError(
            "An invalid or duplicated subprotocol was specified"
          );
        Wt.add(ze);
      }
      ce.headers["Sec-WebSocket-Protocol"] = fe.join(",");
    }
    if (ce.origin && (ce.protocolVersion < 13 ? ce.headers["Sec-WebSocket-Origin"] = ce.origin : ce.headers.Origin = ce.origin), ($e.username || $e.password) && (ce.auth = `${$e.username}:${$e.password}`), Et) {
      const ze = ce.path.split(":");
      ce.socketPath = ze[0], ce.path = ze[1];
    }
    let it;
    if (ce.followRedirects) {
      if (R._redirects === 0) {
        R._originalIpc = Et, R._originalSecure = kt, R._originalHostOrSocketPath = Et ? ce.socketPath : $e.host;
        const ze = be && be.headers;
        if (be = { ...be, headers: {} }, ze)
          for (const [me, Ot] of Object.entries(ze))
            be.headers[me.toLowerCase()] = Ot;
      } else if (R.listenerCount("redirect") === 0) {
        const ze = Et ? R._originalIpc ? ce.socketPath === R._originalHostOrSocketPath : !1 : R._originalIpc ? !1 : $e.host === R._originalHostOrSocketPath;
        (!ze || R._originalSecure && !kt) && (delete ce.headers.authorization, delete ce.headers.cookie, ze || delete ce.headers.host, ce.auth = void 0);
      }
      ce.auth && !be.headers.authorization && (be.headers.authorization = "Basic " + Buffer.from(ce.auth).toString("base64")), it = R._req = ir(ce), R._redirects && R.emit("redirect", R.url, it);
    } else
      it = R._req = ir(ce);
    ce.timeout && it.on("timeout", () => {
      lt(R, it, "Opening handshake has timed out");
    }), it.on("error", (ze) => {
      it === null || it[Ie] || (it = R._req = null, at(R, ze));
    }), it.on("response", (ze) => {
      const me = ze.headers.location, Ot = ze.statusCode;
      if (me && ce.followRedirects && Ot >= 300 && Ot < 400) {
        if (++R._redirects > ce.maxRedirects) {
          lt(R, it, "Maximum redirects exceeded");
          return;
        }
        it.abort();
        let St;
        try {
          St = new u(me, $);
        } catch {
          const xt = new SyntaxError(`Invalid URL: ${me}`);
          at(R, xt);
          return;
        }
        Ye(R, St, fe, be);
      } else R.emit("unexpected-response", it, ze) || lt(
        R,
        it,
        `Unexpected server response: ${ze.statusCode}`
      );
    }), it.on("upgrade", (ze, me, Ot) => {
      if (R.emit("upgrade", ze), R.readyState !== ae.CONNECTING) return;
      it = R._req = null;
      const St = ze.headers.upgrade;
      if (St === void 0 || St.toLowerCase() !== "websocket") {
        lt(R, me, "Invalid Upgrade header");
        return;
      }
      const $t = m("sha1").update(wt + q).digest("base64");
      if (ze.headers["sec-websocket-accept"] !== $t) {
        lt(R, me, "Invalid Sec-WebSocket-Accept header");
        return;
      }
      const xt = ze.headers["sec-websocket-protocol"];
      let Rt;
      if (xt !== void 0 ? Wt.size ? Wt.has(xt) || (Rt = "Server sent an invalid subprotocol") : Rt = "Server sent a subprotocol but none was requested" : Wt.size && (Rt = "Server sent no subprotocol"), Rt) {
        lt(R, me, Rt);
        return;
      }
      xt && (R._protocol = xt);
      const gt = ze.headers["sec-websocket-extensions"];
      if (gt !== void 0) {
        if (!sr) {
          lt(R, me, "Server sent a Sec-WebSocket-Extensions header but no extension was requested");
          return;
        }
        let Jt;
        try {
          Jt = H(gt);
        } catch {
          lt(R, me, "Invalid Sec-WebSocket-Extensions header");
          return;
        }
        const fr = Object.keys(Jt);
        if (fr.length !== 1 || fr[0] !== O.extensionName) {
          lt(R, me, "Server indicated an extension that was not requested");
          return;
        }
        try {
          sr.accept(Jt[O.extensionName]);
        } catch {
          lt(R, me, "Invalid Sec-WebSocket-Extensions header");
          return;
        }
        R._extensions[O.extensionName] = sr;
      }
      R.setSocket(me, Ot, {
        allowSynchronousEvents: ce.allowSynchronousEvents,
        generateMask: ce.generateMask,
        maxPayload: ce.maxPayload,
        skipUTF8Validation: ce.skipUTF8Validation
      });
    }), ce.finishRequest ? ce.finishRequest(it, R) : it.end();
  }
  function at(R, $) {
    R._readyState = ae.CLOSING, R._errorEmitted = !0, R.emit("error", $), R.emitClose();
  }
  function _t(R) {
    return R.path = R.socketPath, c.connect(R);
  }
  function Xt(R) {
    return R.path = void 0, !R.servername && R.servername !== "" && (R.servername = c.isIP(R.host) ? "" : R.host), p.connect(R);
  }
  function lt(R, $, fe) {
    R._readyState = ae.CLOSING;
    const be = new Error(fe);
    Error.captureStackTrace(be, lt), $.setHeader ? ($[Ie] = !0, $.abort(), $.socket && !$.socket.destroyed && $.socket.destroy(), process.nextTick(at, R, be)) : ($.destroy(be), $.once("error", R.emit.bind(R, "error")), $.once("close", R.emitClose.bind(R)));
  }
  function rr(R, $, fe) {
    if ($) {
      const be = k($) ? $.size : ee($).length;
      R._socket ? R._sender._bufferedBytes += be : R._bufferedAmount += be;
    }
    if (fe) {
      const be = new Error(
        `WebSocket is not open: readyState ${R.readyState} (${se[R.readyState]})`
      );
      process.nextTick(fe, be);
    }
  }
  function It(R, $) {
    const fe = this[v];
    fe._closeFrameReceived = !0, fe._closeMessage = $, fe._closeCode = R, fe._socket[v] !== void 0 && (fe._socket.removeListener("data", nr), process.nextTick(Lt, fe._socket), R === 1005 ? fe.close() : fe.close(R, $));
  }
  function bt() {
    const R = this[v];
    R.isPaused || R._socket.resume();
  }
  function Ue(R) {
    const $ = this[v];
    $._socket[v] !== void 0 && ($._socket.removeListener("data", nr), process.nextTick(Lt, $._socket), $.close(R[V])), $._errorEmitted || ($._errorEmitted = !0, $.emit("error", R));
  }
  function yt() {
    this[v].emitClose();
  }
  function yr(R, $) {
    this[v].emit("message", R, $);
  }
  function Tr(R) {
    const $ = this[v];
    $._autoPong && $.pong(R, !this._isServer, x), $.emit("ping", R);
  }
  function At(R) {
    this[v].emit("pong", R);
  }
  function Lt(R) {
    R.resume();
  }
  function Ct(R) {
    const $ = this[v];
    $.readyState !== ae.CLOSED && ($.readyState === ae.OPEN && ($._readyState = ae.CLOSING, Pt($)), this._socket.end(), $._errorEmitted || ($._errorEmitted = !0, $.emit("error", R)));
  }
  function Pt(R) {
    R._closeTimer = setTimeout(
      R._socket.destroy.bind(R._socket),
      R._closeTimeout
    );
  }
  function qt() {
    const R = this[v];
    if (this.removeListener("close", qt), this.removeListener("data", nr), this.removeListener("end", xr), R._readyState = ae.CLOSING, !this._readableState.endEmitted && !R._closeFrameReceived && !R._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
      const $ = this.read(this._readableState.length);
      R._receiver.write($);
    }
    R._receiver.end(), this[v] = void 0, clearTimeout(R._closeTimer), R._receiver._writableState.finished || R._receiver._writableState.errorEmitted ? R.emitClose() : (R._receiver.on("error", yt), R._receiver.on("finish", yt));
  }
  function nr(R) {
    this[v]._receiver.write(R) || this.pause();
  }
  function xr() {
    const R = this[v];
    R._readyState = ae.CLOSING, R._receiver.end(), this.end();
  }
  function tt() {
    const R = this[v];
    this.removeListener("error", tt), this.on("error", x), R && (R._readyState = ae.CLOSING, this.destroy());
  }
  return fn;
}
var cn, ni;
function Ks() {
  if (ni) return cn;
  ni = 1, On();
  const { Duplex: l } = Mr;
  function n(b) {
    b.emit("close");
  }
  function a() {
    !this.destroyed && this._writableState.finished && this.destroy();
  }
  function c(b) {
    this.removeListener("error", c), this.destroy(), this.listenerCount("error") === 0 && this.emit("error", b);
  }
  function p(b, m) {
    let _ = !0;
    const g = new l({
      ...m,
      autoDestroy: !1,
      emitClose: !1,
      objectMode: !1,
      writableObjectMode: !1
    });
    return b.on("message", function(O, T) {
      const A = !T && g._readableState.objectMode ? O.toString() : O;
      g.push(A) || b.pause();
    }), b.once("error", function(O) {
      g.destroyed || (_ = !1, g.destroy(O));
    }), b.once("close", function() {
      g.destroyed || g.push(null);
    }), g._destroy = function(u, O) {
      if (b.readyState === b.CLOSED) {
        O(u), process.nextTick(n, g);
        return;
      }
      let T = !1;
      b.once("error", function(k) {
        T = !0, O(k);
      }), b.once("close", function() {
        T || O(u), process.nextTick(n, g);
      }), _ && b.terminate();
    }, g._final = function(u) {
      if (b.readyState === b.CONNECTING) {
        b.once("open", function() {
          g._final(u);
        });
        return;
      }
      b._socket !== null && (b._socket._writableState.finished ? (u(), g._readableState.endEmitted && g.destroy()) : (b._socket.once("finish", function() {
        u();
      }), b.close()));
    }, g._read = function() {
      b.isPaused && b.resume();
    }, g._write = function(u, O, T) {
      if (b.readyState === b.CONNECTING) {
        b.once("open", function() {
          g._write(u, O, T);
        });
        return;
      }
      b.send(u, T);
    }, g.on("end", a), g.on("error", c), g;
  }
  return cn = p, cn;
}
Ks();
In();
Ur();
gi();
vi();
var un, ii;
function Ei() {
  if (ii) return un;
  ii = 1;
  const { tokenChars: l } = Pr();
  function n(a) {
    const c = /* @__PURE__ */ new Set();
    let p = -1, b = -1, m = 0;
    for (m; m < a.length; m++) {
      const g = a.charCodeAt(m);
      if (b === -1 && l[g] === 1)
        p === -1 && (p = m);
      else if (m !== 0 && (g === 32 || g === 9))
        b === -1 && p !== -1 && (b = m);
      else if (g === 44) {
        if (p === -1)
          throw new SyntaxError(`Unexpected character at index ${m}`);
        b === -1 && (b = m);
        const u = a.slice(p, b);
        if (c.has(u))
          throw new SyntaxError(`The "${u}" subprotocol is duplicated`);
        c.add(u), p = b = -1;
      } else
        throw new SyntaxError(`Unexpected character at index ${m}`);
    }
    if (p === -1 || b !== -1)
      throw new SyntaxError("Unexpected end of input");
    const _ = a.slice(p, m);
    if (c.has(_))
      throw new SyntaxError(`The "${_}" subprotocol is duplicated`);
    return c.add(_), c;
  }
  return un = { parse: n }, un;
}
Ei();
var Gs = On();
const si = /* @__PURE__ */ Rr(Gs);
var ln, oi;
function Ys() {
  if (oi) return ln;
  oi = 1;
  const l = _i, n = bi, { Duplex: a } = Mr, { createHash: c } = Vr, p = In(), b = Ur(), m = Ei(), _ = On(), { CLOSE_TIMEOUT: g, GUID: u, kWebSocket: O } = mr(), T = /^[+/0-9A-Za-z]{22}==$/, A = 0, k = 1, Y = 2;
  class Q extends l {
    /**
     * Create a `WebSocketServer` instance.
     *
     * @param {Object} options Configuration options
     * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
     *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
     *     multiple times in the same tick
     * @param {Boolean} [options.autoPong=true] Specifies whether or not to
     *     automatically send a pong in response to a ping
     * @param {Number} [options.backlog=511] The maximum length of the queue of
     *     pending connections
     * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
     *     track clients
     * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
     *     wait for the closing handshake to finish after `websocket.close()` is
     *     called
     * @param {Function} [options.handleProtocols] A hook to handle protocols
     * @param {String} [options.host] The hostname where to bind the server
     * @param {Number} [options.maxPayload=104857600] The maximum allowed message
     *     size
     * @param {Boolean} [options.noServer=false] Enable no server mode
     * @param {String} [options.path] Accept only connections matching this path
     * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
     *     permessage-deflate
     * @param {Number} [options.port] The port where to bind the server
     * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
     *     server to use
     * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
     *     not to skip UTF-8 validation for text and close messages
     * @param {Function} [options.verifyClient] A hook to reject connections
     * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
     *     class to use. It must be the `WebSocket` class or class that extends it
     * @param {Function} [callback] A listener for the `listening` event
     */
    constructor(x, M) {
      if (super(), x = {
        allowSynchronousEvents: !0,
        autoPong: !0,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: !1,
        perMessageDeflate: !1,
        handleProtocols: null,
        clientTracking: !0,
        closeTimeout: g,
        verifyClient: null,
        noServer: !1,
        backlog: null,
        // use default (511 as implemented in net.js)
        server: null,
        host: null,
        path: null,
        port: null,
        WebSocket: _,
        ...x
      }, x.port == null && !x.server && !x.noServer || x.port != null && (x.server || x.noServer) || x.server && x.noServer)
        throw new TypeError(
          'One and only one of the "port", "server", or "noServer" options must be specified'
        );
      if (x.port != null ? (this._server = n.createServer((U, te) => {
        const H = n.STATUS_CODES[426];
        te.writeHead(426, {
          "Content-Length": H.length,
          "Content-Type": "text/plain"
        }), te.end(H);
      }), this._server.listen(
        x.port,
        x.host,
        x.backlog,
        M
      )) : x.server && (this._server = x.server), this._server) {
        const U = this.emit.bind(this, "connection");
        this._removeListeners = Z(this._server, {
          listening: this.emit.bind(this, "listening"),
          error: this.emit.bind(this, "error"),
          upgrade: (te, H, ee) => {
            this.handleUpgrade(te, H, ee, U);
          }
        });
      }
      x.perMessageDeflate === !0 && (x.perMessageDeflate = {}), x.clientTracking && (this.clients = /* @__PURE__ */ new Set(), this._shouldEmitClose = !1), this.options = x, this._state = A;
    }
    /**
     * Returns the bound address, the address family name, and port of the server
     * as reported by the operating system if listening on an IP socket.
     * If the server is listening on a pipe or UNIX domain socket, the name is
     * returned as a string.
     *
     * @return {(Object|String|null)} The address of the server
     * @public
     */
    address() {
      if (this.options.noServer)
        throw new Error('The server is operating in "noServer" mode');
      return this._server ? this._server.address() : null;
    }
    /**
     * Stop the server from accepting new connections and emit the `'close'` event
     * when all existing connections are closed.
     *
     * @param {Function} [cb] A one-time listener for the `'close'` event
     * @public
     */
    close(x) {
      if (this._state === Y) {
        x && this.once("close", () => {
          x(new Error("The server is not running"));
        }), process.nextTick(q, this);
        return;
      }
      if (x && this.once("close", x), this._state !== k)
        if (this._state = k, this.options.noServer || this.options.server)
          this._server && (this._removeListeners(), this._removeListeners = this._server = null), this.clients ? this.clients.size ? this._shouldEmitClose = !0 : process.nextTick(q, this) : process.nextTick(q, this);
        else {
          const M = this._server;
          this._removeListeners(), this._removeListeners = this._server = null, M.close(() => {
            q(this);
          });
        }
    }
    /**
     * See if a given request should be handled by this server instance.
     *
     * @param {http.IncomingMessage} req Request object to inspect
     * @return {Boolean} `true` if the request is valid, else `false`
     * @public
     */
    shouldHandle(x) {
      if (this.options.path) {
        const M = x.url.indexOf("?");
        if ((M !== -1 ? x.url.slice(0, M) : x.url) !== this.options.path) return !1;
      }
      return !0;
    }
    /**
     * Handle a HTTP Upgrade request.
     *
     * @param {http.IncomingMessage} req The request object
     * @param {Duplex} socket The network socket between the server and client
     * @param {Buffer} head The first packet of the upgraded stream
     * @param {Function} cb Callback
     * @public
     */
    handleUpgrade(x, M, U, te) {
      M.on("error", D);
      const H = x.headers["sec-websocket-key"], ee = x.headers.upgrade, Ie = +x.headers["sec-websocket-version"];
      if (x.method !== "GET") {
        V(this, x, M, 405, "Invalid HTTP method");
        return;
      }
      if (ee === void 0 || ee.toLowerCase() !== "websocket") {
        V(this, x, M, 400, "Invalid Upgrade header");
        return;
      }
      if (H === void 0 || !T.test(H)) {
        V(this, x, M, 400, "Missing or invalid Sec-WebSocket-Key header");
        return;
      }
      if (Ie !== 13 && Ie !== 8) {
        V(this, x, M, 400, "Missing or invalid Sec-WebSocket-Version header", {
          "Sec-WebSocket-Version": "13, 8"
        });
        return;
      }
      if (!this.shouldHandle(x)) {
        X(M, 400);
        return;
      }
      const Se = x.headers["sec-websocket-protocol"];
      let se = /* @__PURE__ */ new Set();
      if (Se !== void 0)
        try {
          se = m.parse(Se);
        } catch {
          V(this, x, M, 400, "Invalid Sec-WebSocket-Protocol header");
          return;
        }
      const Ge = x.headers["sec-websocket-extensions"], ae = {};
      if (this.options.perMessageDeflate && Ge !== void 0) {
        const Ye = new b({
          ...this.options.perMessageDeflate,
          isServer: !0,
          maxPayload: this.options.maxPayload
        });
        try {
          const at = p.parse(Ge);
          at[b.extensionName] && (Ye.accept(at[b.extensionName]), ae[b.extensionName] = Ye);
        } catch {
          V(this, x, M, 400, "Invalid or unacceptable Sec-WebSocket-Extensions header");
          return;
        }
      }
      if (this.options.verifyClient) {
        const Ye = {
          origin: x.headers[`${Ie === 8 ? "sec-websocket-origin" : "origin"}`],
          secure: !!(x.socket.authorized || x.socket.encrypted),
          req: x
        };
        if (this.options.verifyClient.length === 2) {
          this.options.verifyClient(Ye, (at, _t, Xt, lt) => {
            if (!at)
              return X(M, _t || 401, Xt, lt);
            this.completeUpgrade(
              ae,
              H,
              se,
              x,
              M,
              U,
              te
            );
          });
          return;
        }
        if (!this.options.verifyClient(Ye)) return X(M, 401);
      }
      this.completeUpgrade(ae, H, se, x, M, U, te);
    }
    /**
     * Upgrade the connection to WebSocket.
     *
     * @param {Object} extensions The accepted extensions
     * @param {String} key The value of the `Sec-WebSocket-Key` header
     * @param {Set} protocols The subprotocols
     * @param {http.IncomingMessage} req The request object
     * @param {Duplex} socket The network socket between the server and client
     * @param {Buffer} head The first packet of the upgraded stream
     * @param {Function} cb Callback
     * @throws {Error} If called more than once with the same socket
     * @private
     */
    completeUpgrade(x, M, U, te, H, ee, Ie) {
      if (!H.readable || !H.writable) return H.destroy();
      if (H[O])
        throw new Error(
          "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
        );
      if (this._state > A) return X(H, 503);
      const se = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${c("sha1").update(M + u).digest("base64")}`
      ], Ge = new this.options.WebSocket(null, void 0, this.options);
      if (U.size) {
        const ae = this.options.handleProtocols ? this.options.handleProtocols(U, te) : U.values().next().value;
        ae && (se.push(`Sec-WebSocket-Protocol: ${ae}`), Ge._protocol = ae);
      }
      if (x[b.extensionName]) {
        const ae = x[b.extensionName].params, Ye = p.format({
          [b.extensionName]: [ae]
        });
        se.push(`Sec-WebSocket-Extensions: ${Ye}`), Ge._extensions = x;
      }
      this.emit("headers", se, te), H.write(se.concat(`\r
`).join(`\r
`)), H.removeListener("error", D), Ge.setSocket(H, ee, {
        allowSynchronousEvents: this.options.allowSynchronousEvents,
        maxPayload: this.options.maxPayload,
        skipUTF8Validation: this.options.skipUTF8Validation
      }), this.clients && (this.clients.add(Ge), Ge.on("close", () => {
        this.clients.delete(Ge), this._shouldEmitClose && !this.clients.size && process.nextTick(q, this);
      })), Ie(Ge, te);
    }
  }
  ln = Q;
  function Z(v, x) {
    for (const M of Object.keys(x)) v.on(M, x[M]);
    return function() {
      for (const U of Object.keys(x))
        v.removeListener(U, x[U]);
    };
  }
  function q(v) {
    v._state = Y, v.emit("close");
  }
  function D() {
    this.destroy();
  }
  function X(v, x, M, U) {
    M = M || n.STATUS_CODES[x], U = {
      Connection: "close",
      "Content-Type": "text/html",
      "Content-Length": Buffer.byteLength(M),
      ...U
    }, v.once("finish", v.destroy), v.end(
      `HTTP/1.1 ${x} ${n.STATUS_CODES[x]}\r
` + Object.keys(U).map((te) => `${te}: ${U[te]}`).join(`\r
`) + `\r
\r
` + M
    );
  }
  function V(v, x, M, U, te, H) {
    if (v.listenerCount("wsClientError")) {
      const ee = new Error(te);
      Error.captureStackTrace(ee, V), v.emit("wsClientError", ee, M, x);
    } else
      X(M, U, te, H);
  }
  return ln;
}
var Vs = Ys();
const Si = /* @__PURE__ */ Rr(Vs), Xs = {
  low: 5,
  // More accuracy, less privacy
  medium: 1,
  // Balanced
  high: 0.1
  // More privacy, less accuracy
}, Js = {
  modelId: "nomic-ai/nomic-embed-text-v1"
}, Qs = {
  /** Confirmation threshold — true similarity needed in direct channel.
   *  Lowered from 0.70: empirical avg true need/offer similarity is 0.634,
   *  so 0.70 would reject ~50% of genuine matches. 0.55 filters noise
   *  (unrelated pairs are typically < 0.30) while accepting real matches. */
  confirmThreshold: 0.55
};
function Zs(l, n) {
  if (l.length !== n.length)
    throw new Error(`Vector dimension mismatch: ${l.length} vs ${n.length}`);
  let a = 0;
  for (let c = 0; c < l.length; c++)
    a += l[c] * n[c];
  return a;
}
function eo(l) {
  let n = 0;
  for (let a = 0; a < l.length; a++)
    n += l[a] * l[a];
  return Math.sqrt(n);
}
function to(l) {
  const n = eo(l);
  if (n === 0)
    throw new Error("Cannot normalize zero vector");
  const a = new Float32Array(l.length);
  for (let c = 0; c < l.length; c++)
    a[c] = l[c] / n;
  return a;
}
function ro(l, n) {
  return Zs(l, n);
}
function no(l) {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  const c = (n[0] + 1) / 4294967297 - 0.5;
  return -l * Math.sign(c) * Math.log(1 - 2 * Math.abs(c));
}
const io = 768;
function so(l, n = io) {
  return 0.38 / (l * Math.sqrt(n));
}
function oo(l, n) {
  if (n <= 0)
    throw new Error("Epsilon must be positive");
  const a = so(n), c = new Float32Array(l.length);
  for (let b = 0; b < l.length; b++)
    c[b] = l[b] + no(a);
  return { perturbed: to(c), epsilon: n };
}
function ao(l) {
  return Xs[l];
}
function fo(l, n) {
  return oo(l, ao(n));
}
let hn = null;
async function co() {
  return hn || (hn = (await import("./transformers.node-DdsyhnoL.js")).pipeline), hn;
}
function uo(l, n) {
  if (n === "offer")
    return l;
  let a = l;
  const c = [
    /^I(?:'m| am) (?:looking|searching|seeking) (?:for )?/i,
    /^(?:I )?need(?:ed|ing|s)? (?:to find |to get |to hire )?/i,
    /^Looking (?:for |to find |to hire )?/i,
    /^Searching (?:for )?/i,
    /^Seeking /i,
    /^Want(?:ed|ing|s)? (?:to (?:find|get|hire|learn|join|practice|start|join) )?/i,
    /^We need (?:to find |to hire |to get )?/i
  ];
  for (const b of c) {
    const m = a.match(b);
    if (m) {
      a = a.slice(m[0].length), a = a.charAt(0).toUpperCase() + a.slice(1);
      break;
    }
  }
  return /^(?:a |an |the |my |our |[A-Z][a-z]+ (?:who|that|with|for|in))/i.test(a) && (a = a.replace(/^(?:a |an |the )/i, ""), a = a.charAt(0).toUpperCase() + a.slice(1)), a;
}
class Ti {
  pipe = null;
  modelId;
  constructor(n) {
    this.modelId = n ?? Js.modelId;
  }
  /** Initialize the model pipeline. Downloads model on first run. */
  async initialize() {
    if (this.pipe) return;
    const n = await co();
    this.pipe = await n("feature-extraction", this.modelId, {
      dtype: "fp32"
    });
  }
  /** Check if the engine is ready */
  isInitialized() {
    return this.pipe !== null;
  }
  /**
   * Embed a single text string.
   * @param text - The text to embed
   * @param prefix - 'search_document' for indexed content, 'search_query' for queries
   * @returns Normalized 768-dim Float32Array
   */
  async embed(n, a = "search_document") {
    if (!this.pipe)
      throw new Error("EmbeddingEngine not initialized. Call initialize() first.");
    const c = `${a}: ${n}`, b = (await this.pipe(c, {
      pooling: "mean",
      normalize: !0
    })).data;
    return b instanceof Float32Array ? b : new Float32Array(b);
  }
  /**
   * Embed with complementary matching: rewrite needs before embedding
   * so they match better against offers.
   *
   * @param text - Original text
   * @param itemType - 'need' or 'offer'
   * @param prefix - Embedding prefix
   * @returns Normalized 768-dim Float32Array
   */
  async embedForMatching(n, a, c = "search_document") {
    const p = uo(n, a);
    return this.embed(p, c);
  }
  /**
   * Embed multiple texts in a batch.
   * @param texts - Array of texts to embed
   * @param prefix - 'search_document' for indexed content, 'search_query' for queries
   * @returns Array of normalized 768-dim Float32Arrays
   */
  async embedBatch(n, a = "search_document") {
    if (!this.pipe)
      throw new Error("EmbeddingEngine not initialized. Call initialize() first.");
    const c = [];
    for (const p of n)
      c.push(await this.embed(p, a));
    return c;
  }
}
const An = 9091, Ii = [
  // Add community-operated relays here:
  // 'ws://relay1.planetary.earth:9091',
  // 'ws://relay2.planetary.earth:9091',
];
function lo(l, n, a) {
  let c = a;
  function p() {
    return c ^= c << 13, c ^= c >>> 17, c ^= c << 5, (c >>> 0) / 4294967295 * 2 - 1;
  }
  const b = [];
  for (let m = 0; m < l; m++) {
    const _ = new Float32Array(n);
    for (let u = 0; u < n; u++)
      _[u] = p();
    let g = 0;
    for (let u = 0; u < n; u++) g += _[u] * _[u];
    g = Math.sqrt(g);
    for (let u = 0; u < n; u++) _[u] /= g;
    b.push(_);
  }
  return b;
}
function Oi(l, n) {
  const a = n.length, c = Math.ceil(a / 8), p = new Uint8Array(c);
  for (let b = 0; b < a; b++) {
    let m = 0;
    const _ = n[b];
    for (let g = 0; g < l.length; g++)
      m += l[g] * _[g];
    m >= 0 && (p[b >>> 3] |= 1 << (b & 7));
  }
  return p;
}
const dn = {
  hashBits: 512,
  dimensions: 768,
  seed: 20260326
  // Fixed seed — all nodes use the same projection
};
let pn = null;
function Ai() {
  return pn || (pn = lo(dn.hashBits, dn.dimensions, dn.seed)), pn;
}
function ho(l) {
  throw new Error('Could not dynamically require "' + l + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
}
var mn = { exports: {} }, ai;
function po() {
  return ai || (ai = 1, (function(l) {
    (function(n) {
      var a = function(s) {
        var f, o = new Float64Array(16);
        if (s) for (f = 0; f < s.length; f++) o[f] = s[f];
        return o;
      }, c = function() {
        throw new Error("no PRNG");
      }, p = new Uint8Array(16), b = new Uint8Array(32);
      b[0] = 9;
      var m = a(), _ = a([1]), g = a([56129, 1]), u = a([30883, 4953, 19914, 30187, 55467, 16705, 2637, 112, 59544, 30585, 16505, 36039, 65139, 11119, 27886, 20995]), O = a([61785, 9906, 39828, 60374, 45398, 33411, 5274, 224, 53552, 61171, 33010, 6542, 64743, 22239, 55772, 9222]), T = a([54554, 36645, 11616, 51542, 42930, 38181, 51040, 26924, 56412, 64982, 57905, 49316, 21502, 52590, 14035, 8553]), A = a([26200, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214]), k = a([41136, 18958, 6951, 50414, 58488, 44335, 6150, 12099, 55207, 15867, 153, 11085, 57099, 20417, 9344, 11139]);
      function Y(s, f, o, t) {
        s[f] = o >> 24 & 255, s[f + 1] = o >> 16 & 255, s[f + 2] = o >> 8 & 255, s[f + 3] = o & 255, s[f + 4] = t >> 24 & 255, s[f + 5] = t >> 16 & 255, s[f + 6] = t >> 8 & 255, s[f + 7] = t & 255;
      }
      function Q(s, f, o, t, h) {
        var E, S = 0;
        for (E = 0; E < h; E++) S |= s[f + E] ^ o[t + E];
        return (1 & S - 1 >>> 8) - 1;
      }
      function Z(s, f, o, t) {
        return Q(s, f, o, t, 16);
      }
      function q(s, f, o, t) {
        return Q(s, f, o, t, 32);
      }
      function D(s, f, o, t) {
        for (var h = t[0] & 255 | (t[1] & 255) << 8 | (t[2] & 255) << 16 | (t[3] & 255) << 24, E = o[0] & 255 | (o[1] & 255) << 8 | (o[2] & 255) << 16 | (o[3] & 255) << 24, S = o[4] & 255 | (o[5] & 255) << 8 | (o[6] & 255) << 16 | (o[7] & 255) << 24, j = o[8] & 255 | (o[9] & 255) << 8 | (o[10] & 255) << 16 | (o[11] & 255) << 24, G = o[12] & 255 | (o[13] & 255) << 8 | (o[14] & 255) << 16 | (o[15] & 255) << 24, de = t[4] & 255 | (t[5] & 255) << 8 | (t[6] & 255) << 16 | (t[7] & 255) << 24, ne = f[0] & 255 | (f[1] & 255) << 8 | (f[2] & 255) << 16 | (f[3] & 255) << 24, He = f[4] & 255 | (f[5] & 255) << 8 | (f[6] & 255) << 16 | (f[7] & 255) << 24, re = f[8] & 255 | (f[9] & 255) << 8 | (f[10] & 255) << 16 | (f[11] & 255) << 24, we = f[12] & 255 | (f[13] & 255) << 8 | (f[14] & 255) << 16 | (f[15] & 255) << 24, Ee = t[8] & 255 | (t[9] & 255) << 8 | (t[10] & 255) << 16 | (t[11] & 255) << 24, Ce = o[16] & 255 | (o[17] & 255) << 8 | (o[18] & 255) << 16 | (o[19] & 255) << 24, Oe = o[20] & 255 | (o[21] & 255) << 8 | (o[22] & 255) << 16 | (o[23] & 255) << 24, ge = o[24] & 255 | (o[25] & 255) << 8 | (o[26] & 255) << 16 | (o[27] & 255) << 24, Te = o[28] & 255 | (o[29] & 255) << 8 | (o[30] & 255) << 16 | (o[31] & 255) << 24, ve = t[12] & 255 | (t[13] & 255) << 8 | (t[14] & 255) << 16 | (t[15] & 255) << 24, ue = h, pe = E, oe = S, le = j, he = G, ie = de, L = ne, C = He, P = re, B = we, F = Ee, K = Ce, xe = Oe, Ae = ge, Le = Te, De = ve, y, Re = 0; Re < 20; Re += 2)
          y = ue + xe | 0, he ^= y << 7 | y >>> 25, y = he + ue | 0, P ^= y << 9 | y >>> 23, y = P + he | 0, xe ^= y << 13 | y >>> 19, y = xe + P | 0, ue ^= y << 18 | y >>> 14, y = ie + pe | 0, B ^= y << 7 | y >>> 25, y = B + ie | 0, Ae ^= y << 9 | y >>> 23, y = Ae + B | 0, pe ^= y << 13 | y >>> 19, y = pe + Ae | 0, ie ^= y << 18 | y >>> 14, y = F + L | 0, Le ^= y << 7 | y >>> 25, y = Le + F | 0, oe ^= y << 9 | y >>> 23, y = oe + Le | 0, L ^= y << 13 | y >>> 19, y = L + oe | 0, F ^= y << 18 | y >>> 14, y = De + K | 0, le ^= y << 7 | y >>> 25, y = le + De | 0, C ^= y << 9 | y >>> 23, y = C + le | 0, K ^= y << 13 | y >>> 19, y = K + C | 0, De ^= y << 18 | y >>> 14, y = ue + le | 0, pe ^= y << 7 | y >>> 25, y = pe + ue | 0, oe ^= y << 9 | y >>> 23, y = oe + pe | 0, le ^= y << 13 | y >>> 19, y = le + oe | 0, ue ^= y << 18 | y >>> 14, y = ie + he | 0, L ^= y << 7 | y >>> 25, y = L + ie | 0, C ^= y << 9 | y >>> 23, y = C + L | 0, he ^= y << 13 | y >>> 19, y = he + C | 0, ie ^= y << 18 | y >>> 14, y = F + B | 0, K ^= y << 7 | y >>> 25, y = K + F | 0, P ^= y << 9 | y >>> 23, y = P + K | 0, B ^= y << 13 | y >>> 19, y = B + P | 0, F ^= y << 18 | y >>> 14, y = De + Le | 0, xe ^= y << 7 | y >>> 25, y = xe + De | 0, Ae ^= y << 9 | y >>> 23, y = Ae + xe | 0, Le ^= y << 13 | y >>> 19, y = Le + Ae | 0, De ^= y << 18 | y >>> 14;
        ue = ue + h | 0, pe = pe + E | 0, oe = oe + S | 0, le = le + j | 0, he = he + G | 0, ie = ie + de | 0, L = L + ne | 0, C = C + He | 0, P = P + re | 0, B = B + we | 0, F = F + Ee | 0, K = K + Ce | 0, xe = xe + Oe | 0, Ae = Ae + ge | 0, Le = Le + Te | 0, De = De + ve | 0, s[0] = ue >>> 0 & 255, s[1] = ue >>> 8 & 255, s[2] = ue >>> 16 & 255, s[3] = ue >>> 24 & 255, s[4] = pe >>> 0 & 255, s[5] = pe >>> 8 & 255, s[6] = pe >>> 16 & 255, s[7] = pe >>> 24 & 255, s[8] = oe >>> 0 & 255, s[9] = oe >>> 8 & 255, s[10] = oe >>> 16 & 255, s[11] = oe >>> 24 & 255, s[12] = le >>> 0 & 255, s[13] = le >>> 8 & 255, s[14] = le >>> 16 & 255, s[15] = le >>> 24 & 255, s[16] = he >>> 0 & 255, s[17] = he >>> 8 & 255, s[18] = he >>> 16 & 255, s[19] = he >>> 24 & 255, s[20] = ie >>> 0 & 255, s[21] = ie >>> 8 & 255, s[22] = ie >>> 16 & 255, s[23] = ie >>> 24 & 255, s[24] = L >>> 0 & 255, s[25] = L >>> 8 & 255, s[26] = L >>> 16 & 255, s[27] = L >>> 24 & 255, s[28] = C >>> 0 & 255, s[29] = C >>> 8 & 255, s[30] = C >>> 16 & 255, s[31] = C >>> 24 & 255, s[32] = P >>> 0 & 255, s[33] = P >>> 8 & 255, s[34] = P >>> 16 & 255, s[35] = P >>> 24 & 255, s[36] = B >>> 0 & 255, s[37] = B >>> 8 & 255, s[38] = B >>> 16 & 255, s[39] = B >>> 24 & 255, s[40] = F >>> 0 & 255, s[41] = F >>> 8 & 255, s[42] = F >>> 16 & 255, s[43] = F >>> 24 & 255, s[44] = K >>> 0 & 255, s[45] = K >>> 8 & 255, s[46] = K >>> 16 & 255, s[47] = K >>> 24 & 255, s[48] = xe >>> 0 & 255, s[49] = xe >>> 8 & 255, s[50] = xe >>> 16 & 255, s[51] = xe >>> 24 & 255, s[52] = Ae >>> 0 & 255, s[53] = Ae >>> 8 & 255, s[54] = Ae >>> 16 & 255, s[55] = Ae >>> 24 & 255, s[56] = Le >>> 0 & 255, s[57] = Le >>> 8 & 255, s[58] = Le >>> 16 & 255, s[59] = Le >>> 24 & 255, s[60] = De >>> 0 & 255, s[61] = De >>> 8 & 255, s[62] = De >>> 16 & 255, s[63] = De >>> 24 & 255;
      }
      function X(s, f, o, t) {
        for (var h = t[0] & 255 | (t[1] & 255) << 8 | (t[2] & 255) << 16 | (t[3] & 255) << 24, E = o[0] & 255 | (o[1] & 255) << 8 | (o[2] & 255) << 16 | (o[3] & 255) << 24, S = o[4] & 255 | (o[5] & 255) << 8 | (o[6] & 255) << 16 | (o[7] & 255) << 24, j = o[8] & 255 | (o[9] & 255) << 8 | (o[10] & 255) << 16 | (o[11] & 255) << 24, G = o[12] & 255 | (o[13] & 255) << 8 | (o[14] & 255) << 16 | (o[15] & 255) << 24, de = t[4] & 255 | (t[5] & 255) << 8 | (t[6] & 255) << 16 | (t[7] & 255) << 24, ne = f[0] & 255 | (f[1] & 255) << 8 | (f[2] & 255) << 16 | (f[3] & 255) << 24, He = f[4] & 255 | (f[5] & 255) << 8 | (f[6] & 255) << 16 | (f[7] & 255) << 24, re = f[8] & 255 | (f[9] & 255) << 8 | (f[10] & 255) << 16 | (f[11] & 255) << 24, we = f[12] & 255 | (f[13] & 255) << 8 | (f[14] & 255) << 16 | (f[15] & 255) << 24, Ee = t[8] & 255 | (t[9] & 255) << 8 | (t[10] & 255) << 16 | (t[11] & 255) << 24, Ce = o[16] & 255 | (o[17] & 255) << 8 | (o[18] & 255) << 16 | (o[19] & 255) << 24, Oe = o[20] & 255 | (o[21] & 255) << 8 | (o[22] & 255) << 16 | (o[23] & 255) << 24, ge = o[24] & 255 | (o[25] & 255) << 8 | (o[26] & 255) << 16 | (o[27] & 255) << 24, Te = o[28] & 255 | (o[29] & 255) << 8 | (o[30] & 255) << 16 | (o[31] & 255) << 24, ve = t[12] & 255 | (t[13] & 255) << 8 | (t[14] & 255) << 16 | (t[15] & 255) << 24, ue = h, pe = E, oe = S, le = j, he = G, ie = de, L = ne, C = He, P = re, B = we, F = Ee, K = Ce, xe = Oe, Ae = ge, Le = Te, De = ve, y, Re = 0; Re < 20; Re += 2)
          y = ue + xe | 0, he ^= y << 7 | y >>> 25, y = he + ue | 0, P ^= y << 9 | y >>> 23, y = P + he | 0, xe ^= y << 13 | y >>> 19, y = xe + P | 0, ue ^= y << 18 | y >>> 14, y = ie + pe | 0, B ^= y << 7 | y >>> 25, y = B + ie | 0, Ae ^= y << 9 | y >>> 23, y = Ae + B | 0, pe ^= y << 13 | y >>> 19, y = pe + Ae | 0, ie ^= y << 18 | y >>> 14, y = F + L | 0, Le ^= y << 7 | y >>> 25, y = Le + F | 0, oe ^= y << 9 | y >>> 23, y = oe + Le | 0, L ^= y << 13 | y >>> 19, y = L + oe | 0, F ^= y << 18 | y >>> 14, y = De + K | 0, le ^= y << 7 | y >>> 25, y = le + De | 0, C ^= y << 9 | y >>> 23, y = C + le | 0, K ^= y << 13 | y >>> 19, y = K + C | 0, De ^= y << 18 | y >>> 14, y = ue + le | 0, pe ^= y << 7 | y >>> 25, y = pe + ue | 0, oe ^= y << 9 | y >>> 23, y = oe + pe | 0, le ^= y << 13 | y >>> 19, y = le + oe | 0, ue ^= y << 18 | y >>> 14, y = ie + he | 0, L ^= y << 7 | y >>> 25, y = L + ie | 0, C ^= y << 9 | y >>> 23, y = C + L | 0, he ^= y << 13 | y >>> 19, y = he + C | 0, ie ^= y << 18 | y >>> 14, y = F + B | 0, K ^= y << 7 | y >>> 25, y = K + F | 0, P ^= y << 9 | y >>> 23, y = P + K | 0, B ^= y << 13 | y >>> 19, y = B + P | 0, F ^= y << 18 | y >>> 14, y = De + Le | 0, xe ^= y << 7 | y >>> 25, y = xe + De | 0, Ae ^= y << 9 | y >>> 23, y = Ae + xe | 0, Le ^= y << 13 | y >>> 19, y = Le + Ae | 0, De ^= y << 18 | y >>> 14;
        s[0] = ue >>> 0 & 255, s[1] = ue >>> 8 & 255, s[2] = ue >>> 16 & 255, s[3] = ue >>> 24 & 255, s[4] = ie >>> 0 & 255, s[5] = ie >>> 8 & 255, s[6] = ie >>> 16 & 255, s[7] = ie >>> 24 & 255, s[8] = F >>> 0 & 255, s[9] = F >>> 8 & 255, s[10] = F >>> 16 & 255, s[11] = F >>> 24 & 255, s[12] = De >>> 0 & 255, s[13] = De >>> 8 & 255, s[14] = De >>> 16 & 255, s[15] = De >>> 24 & 255, s[16] = L >>> 0 & 255, s[17] = L >>> 8 & 255, s[18] = L >>> 16 & 255, s[19] = L >>> 24 & 255, s[20] = C >>> 0 & 255, s[21] = C >>> 8 & 255, s[22] = C >>> 16 & 255, s[23] = C >>> 24 & 255, s[24] = P >>> 0 & 255, s[25] = P >>> 8 & 255, s[26] = P >>> 16 & 255, s[27] = P >>> 24 & 255, s[28] = B >>> 0 & 255, s[29] = B >>> 8 & 255, s[30] = B >>> 16 & 255, s[31] = B >>> 24 & 255;
      }
      function V(s, f, o, t) {
        D(s, f, o, t);
      }
      function v(s, f, o, t) {
        X(s, f, o, t);
      }
      var x = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
      function M(s, f, o, t, h, E, S) {
        var j = new Uint8Array(16), G = new Uint8Array(64), de, ne;
        for (ne = 0; ne < 16; ne++) j[ne] = 0;
        for (ne = 0; ne < 8; ne++) j[ne] = E[ne];
        for (; h >= 64; ) {
          for (V(G, j, S, x), ne = 0; ne < 64; ne++) s[f + ne] = o[t + ne] ^ G[ne];
          for (de = 1, ne = 8; ne < 16; ne++)
            de = de + (j[ne] & 255) | 0, j[ne] = de & 255, de >>>= 8;
          h -= 64, f += 64, t += 64;
        }
        if (h > 0)
          for (V(G, j, S, x), ne = 0; ne < h; ne++) s[f + ne] = o[t + ne] ^ G[ne];
        return 0;
      }
      function U(s, f, o, t, h) {
        var E = new Uint8Array(16), S = new Uint8Array(64), j, G;
        for (G = 0; G < 16; G++) E[G] = 0;
        for (G = 0; G < 8; G++) E[G] = t[G];
        for (; o >= 64; ) {
          for (V(S, E, h, x), G = 0; G < 64; G++) s[f + G] = S[G];
          for (j = 1, G = 8; G < 16; G++)
            j = j + (E[G] & 255) | 0, E[G] = j & 255, j >>>= 8;
          o -= 64, f += 64;
        }
        if (o > 0)
          for (V(S, E, h, x), G = 0; G < o; G++) s[f + G] = S[G];
        return 0;
      }
      function te(s, f, o, t, h) {
        var E = new Uint8Array(32);
        v(E, t, h, x);
        for (var S = new Uint8Array(8), j = 0; j < 8; j++) S[j] = t[j + 16];
        return U(s, f, o, S, E);
      }
      function H(s, f, o, t, h, E, S) {
        var j = new Uint8Array(32);
        v(j, E, S, x);
        for (var G = new Uint8Array(8), de = 0; de < 8; de++) G[de] = E[de + 16];
        return M(s, f, o, t, h, G, j);
      }
      var ee = function(s) {
        this.buffer = new Uint8Array(16), this.r = new Uint16Array(10), this.h = new Uint16Array(10), this.pad = new Uint16Array(8), this.leftover = 0, this.fin = 0;
        var f, o, t, h, E, S, j, G;
        f = s[0] & 255 | (s[1] & 255) << 8, this.r[0] = f & 8191, o = s[2] & 255 | (s[3] & 255) << 8, this.r[1] = (f >>> 13 | o << 3) & 8191, t = s[4] & 255 | (s[5] & 255) << 8, this.r[2] = (o >>> 10 | t << 6) & 7939, h = s[6] & 255 | (s[7] & 255) << 8, this.r[3] = (t >>> 7 | h << 9) & 8191, E = s[8] & 255 | (s[9] & 255) << 8, this.r[4] = (h >>> 4 | E << 12) & 255, this.r[5] = E >>> 1 & 8190, S = s[10] & 255 | (s[11] & 255) << 8, this.r[6] = (E >>> 14 | S << 2) & 8191, j = s[12] & 255 | (s[13] & 255) << 8, this.r[7] = (S >>> 11 | j << 5) & 8065, G = s[14] & 255 | (s[15] & 255) << 8, this.r[8] = (j >>> 8 | G << 8) & 8191, this.r[9] = G >>> 5 & 127, this.pad[0] = s[16] & 255 | (s[17] & 255) << 8, this.pad[1] = s[18] & 255 | (s[19] & 255) << 8, this.pad[2] = s[20] & 255 | (s[21] & 255) << 8, this.pad[3] = s[22] & 255 | (s[23] & 255) << 8, this.pad[4] = s[24] & 255 | (s[25] & 255) << 8, this.pad[5] = s[26] & 255 | (s[27] & 255) << 8, this.pad[6] = s[28] & 255 | (s[29] & 255) << 8, this.pad[7] = s[30] & 255 | (s[31] & 255) << 8;
      };
      ee.prototype.blocks = function(s, f, o) {
        for (var t = this.fin ? 0 : 2048, h, E, S, j, G, de, ne, He, re, we, Ee, Ce, Oe, ge, Te, ve, ue, pe, oe, le = this.h[0], he = this.h[1], ie = this.h[2], L = this.h[3], C = this.h[4], P = this.h[5], B = this.h[6], F = this.h[7], K = this.h[8], xe = this.h[9], Ae = this.r[0], Le = this.r[1], De = this.r[2], y = this.r[3], Re = this.r[4], Ke = this.r[5], Fe = this.r[6], Me = this.r[7], Be = this.r[8], We = this.r[9]; o >= 16; )
          h = s[f + 0] & 255 | (s[f + 1] & 255) << 8, le += h & 8191, E = s[f + 2] & 255 | (s[f + 3] & 255) << 8, he += (h >>> 13 | E << 3) & 8191, S = s[f + 4] & 255 | (s[f + 5] & 255) << 8, ie += (E >>> 10 | S << 6) & 8191, j = s[f + 6] & 255 | (s[f + 7] & 255) << 8, L += (S >>> 7 | j << 9) & 8191, G = s[f + 8] & 255 | (s[f + 9] & 255) << 8, C += (j >>> 4 | G << 12) & 8191, P += G >>> 1 & 8191, de = s[f + 10] & 255 | (s[f + 11] & 255) << 8, B += (G >>> 14 | de << 2) & 8191, ne = s[f + 12] & 255 | (s[f + 13] & 255) << 8, F += (de >>> 11 | ne << 5) & 8191, He = s[f + 14] & 255 | (s[f + 15] & 255) << 8, K += (ne >>> 8 | He << 8) & 8191, xe += He >>> 5 | t, re = 0, we = re, we += le * Ae, we += he * (5 * We), we += ie * (5 * Be), we += L * (5 * Me), we += C * (5 * Fe), re = we >>> 13, we &= 8191, we += P * (5 * Ke), we += B * (5 * Re), we += F * (5 * y), we += K * (5 * De), we += xe * (5 * Le), re += we >>> 13, we &= 8191, Ee = re, Ee += le * Le, Ee += he * Ae, Ee += ie * (5 * We), Ee += L * (5 * Be), Ee += C * (5 * Me), re = Ee >>> 13, Ee &= 8191, Ee += P * (5 * Fe), Ee += B * (5 * Ke), Ee += F * (5 * Re), Ee += K * (5 * y), Ee += xe * (5 * De), re += Ee >>> 13, Ee &= 8191, Ce = re, Ce += le * De, Ce += he * Le, Ce += ie * Ae, Ce += L * (5 * We), Ce += C * (5 * Be), re = Ce >>> 13, Ce &= 8191, Ce += P * (5 * Me), Ce += B * (5 * Fe), Ce += F * (5 * Ke), Ce += K * (5 * Re), Ce += xe * (5 * y), re += Ce >>> 13, Ce &= 8191, Oe = re, Oe += le * y, Oe += he * De, Oe += ie * Le, Oe += L * Ae, Oe += C * (5 * We), re = Oe >>> 13, Oe &= 8191, Oe += P * (5 * Be), Oe += B * (5 * Me), Oe += F * (5 * Fe), Oe += K * (5 * Ke), Oe += xe * (5 * Re), re += Oe >>> 13, Oe &= 8191, ge = re, ge += le * Re, ge += he * y, ge += ie * De, ge += L * Le, ge += C * Ae, re = ge >>> 13, ge &= 8191, ge += P * (5 * We), ge += B * (5 * Be), ge += F * (5 * Me), ge += K * (5 * Fe), ge += xe * (5 * Ke), re += ge >>> 13, ge &= 8191, Te = re, Te += le * Ke, Te += he * Re, Te += ie * y, Te += L * De, Te += C * Le, re = Te >>> 13, Te &= 8191, Te += P * Ae, Te += B * (5 * We), Te += F * (5 * Be), Te += K * (5 * Me), Te += xe * (5 * Fe), re += Te >>> 13, Te &= 8191, ve = re, ve += le * Fe, ve += he * Ke, ve += ie * Re, ve += L * y, ve += C * De, re = ve >>> 13, ve &= 8191, ve += P * Le, ve += B * Ae, ve += F * (5 * We), ve += K * (5 * Be), ve += xe * (5 * Me), re += ve >>> 13, ve &= 8191, ue = re, ue += le * Me, ue += he * Fe, ue += ie * Ke, ue += L * Re, ue += C * y, re = ue >>> 13, ue &= 8191, ue += P * De, ue += B * Le, ue += F * Ae, ue += K * (5 * We), ue += xe * (5 * Be), re += ue >>> 13, ue &= 8191, pe = re, pe += le * Be, pe += he * Me, pe += ie * Fe, pe += L * Ke, pe += C * Re, re = pe >>> 13, pe &= 8191, pe += P * y, pe += B * De, pe += F * Le, pe += K * Ae, pe += xe * (5 * We), re += pe >>> 13, pe &= 8191, oe = re, oe += le * We, oe += he * Be, oe += ie * Me, oe += L * Fe, oe += C * Ke, re = oe >>> 13, oe &= 8191, oe += P * Re, oe += B * y, oe += F * De, oe += K * Le, oe += xe * Ae, re += oe >>> 13, oe &= 8191, re = (re << 2) + re | 0, re = re + we | 0, we = re & 8191, re = re >>> 13, Ee += re, le = we, he = Ee, ie = Ce, L = Oe, C = ge, P = Te, B = ve, F = ue, K = pe, xe = oe, f += 16, o -= 16;
        this.h[0] = le, this.h[1] = he, this.h[2] = ie, this.h[3] = L, this.h[4] = C, this.h[5] = P, this.h[6] = B, this.h[7] = F, this.h[8] = K, this.h[9] = xe;
      }, ee.prototype.finish = function(s, f) {
        var o = new Uint16Array(10), t, h, E, S;
        if (this.leftover) {
          for (S = this.leftover, this.buffer[S++] = 1; S < 16; S++) this.buffer[S] = 0;
          this.fin = 1, this.blocks(this.buffer, 0, 16);
        }
        for (t = this.h[1] >>> 13, this.h[1] &= 8191, S = 2; S < 10; S++)
          this.h[S] += t, t = this.h[S] >>> 13, this.h[S] &= 8191;
        for (this.h[0] += t * 5, t = this.h[0] >>> 13, this.h[0] &= 8191, this.h[1] += t, t = this.h[1] >>> 13, this.h[1] &= 8191, this.h[2] += t, o[0] = this.h[0] + 5, t = o[0] >>> 13, o[0] &= 8191, S = 1; S < 10; S++)
          o[S] = this.h[S] + t, t = o[S] >>> 13, o[S] &= 8191;
        for (o[9] -= 8192, h = (t ^ 1) - 1, S = 0; S < 10; S++) o[S] &= h;
        for (h = ~h, S = 0; S < 10; S++) this.h[S] = this.h[S] & h | o[S];
        for (this.h[0] = (this.h[0] | this.h[1] << 13) & 65535, this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535, this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535, this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535, this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535, this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535, this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535, this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535, E = this.h[0] + this.pad[0], this.h[0] = E & 65535, S = 1; S < 8; S++)
          E = (this.h[S] + this.pad[S] | 0) + (E >>> 16) | 0, this.h[S] = E & 65535;
        s[f + 0] = this.h[0] >>> 0 & 255, s[f + 1] = this.h[0] >>> 8 & 255, s[f + 2] = this.h[1] >>> 0 & 255, s[f + 3] = this.h[1] >>> 8 & 255, s[f + 4] = this.h[2] >>> 0 & 255, s[f + 5] = this.h[2] >>> 8 & 255, s[f + 6] = this.h[3] >>> 0 & 255, s[f + 7] = this.h[3] >>> 8 & 255, s[f + 8] = this.h[4] >>> 0 & 255, s[f + 9] = this.h[4] >>> 8 & 255, s[f + 10] = this.h[5] >>> 0 & 255, s[f + 11] = this.h[5] >>> 8 & 255, s[f + 12] = this.h[6] >>> 0 & 255, s[f + 13] = this.h[6] >>> 8 & 255, s[f + 14] = this.h[7] >>> 0 & 255, s[f + 15] = this.h[7] >>> 8 & 255;
      }, ee.prototype.update = function(s, f, o) {
        var t, h;
        if (this.leftover) {
          for (h = 16 - this.leftover, h > o && (h = o), t = 0; t < h; t++)
            this.buffer[this.leftover + t] = s[f + t];
          if (o -= h, f += h, this.leftover += h, this.leftover < 16)
            return;
          this.blocks(this.buffer, 0, 16), this.leftover = 0;
        }
        if (o >= 16 && (h = o - o % 16, this.blocks(s, f, h), f += h, o -= h), o) {
          for (t = 0; t < o; t++)
            this.buffer[this.leftover + t] = s[f + t];
          this.leftover += o;
        }
      };
      function Ie(s, f, o, t, h, E) {
        var S = new ee(E);
        return S.update(o, t, h), S.finish(s, f), 0;
      }
      function Se(s, f, o, t, h, E) {
        var S = new Uint8Array(16);
        return Ie(S, 0, o, t, h, E), Z(s, f, S, 0);
      }
      function se(s, f, o, t, h) {
        var E;
        if (o < 32) return -1;
        for (H(s, 0, f, 0, o, t, h), Ie(s, 16, s, 32, o - 32, s), E = 0; E < 16; E++) s[E] = 0;
        return 0;
      }
      function Ge(s, f, o, t, h) {
        var E, S = new Uint8Array(32);
        if (o < 32 || (te(S, 0, 32, t, h), Se(f, 16, f, 32, o - 32, S) !== 0)) return -1;
        for (H(s, 0, f, 0, o, t, h), E = 0; E < 32; E++) s[E] = 0;
        return 0;
      }
      function ae(s, f) {
        var o;
        for (o = 0; o < 16; o++) s[o] = f[o] | 0;
      }
      function Ye(s) {
        var f, o, t = 1;
        for (f = 0; f < 16; f++)
          o = s[f] + t + 65535, t = Math.floor(o / 65536), s[f] = o - t * 65536;
        s[0] += t - 1 + 37 * (t - 1);
      }
      function at(s, f, o) {
        for (var t, h = ~(o - 1), E = 0; E < 16; E++)
          t = h & (s[E] ^ f[E]), s[E] ^= t, f[E] ^= t;
      }
      function _t(s, f) {
        var o, t, h, E = a(), S = a();
        for (o = 0; o < 16; o++) S[o] = f[o];
        for (Ye(S), Ye(S), Ye(S), t = 0; t < 2; t++) {
          for (E[0] = S[0] - 65517, o = 1; o < 15; o++)
            E[o] = S[o] - 65535 - (E[o - 1] >> 16 & 1), E[o - 1] &= 65535;
          E[15] = S[15] - 32767 - (E[14] >> 16 & 1), h = E[15] >> 16 & 1, E[14] &= 65535, at(S, E, 1 - h);
        }
        for (o = 0; o < 16; o++)
          s[2 * o] = S[o] & 255, s[2 * o + 1] = S[o] >> 8;
      }
      function Xt(s, f) {
        var o = new Uint8Array(32), t = new Uint8Array(32);
        return _t(o, s), _t(t, f), q(o, 0, t, 0);
      }
      function lt(s) {
        var f = new Uint8Array(32);
        return _t(f, s), f[0] & 1;
      }
      function rr(s, f) {
        var o;
        for (o = 0; o < 16; o++) s[o] = f[2 * o] + (f[2 * o + 1] << 8);
        s[15] &= 32767;
      }
      function It(s, f, o) {
        for (var t = 0; t < 16; t++) s[t] = f[t] + o[t];
      }
      function bt(s, f, o) {
        for (var t = 0; t < 16; t++) s[t] = f[t] - o[t];
      }
      function Ue(s, f, o) {
        var t, h, E = 0, S = 0, j = 0, G = 0, de = 0, ne = 0, He = 0, re = 0, we = 0, Ee = 0, Ce = 0, Oe = 0, ge = 0, Te = 0, ve = 0, ue = 0, pe = 0, oe = 0, le = 0, he = 0, ie = 0, L = 0, C = 0, P = 0, B = 0, F = 0, K = 0, xe = 0, Ae = 0, Le = 0, De = 0, y = o[0], Re = o[1], Ke = o[2], Fe = o[3], Me = o[4], Be = o[5], We = o[6], Ze = o[7], je = o[8], et = o[9], Ve = o[10], rt = o[11], ft = o[12], mt = o[13], st = o[14], ct = o[15];
        t = f[0], E += t * y, S += t * Re, j += t * Ke, G += t * Fe, de += t * Me, ne += t * Be, He += t * We, re += t * Ze, we += t * je, Ee += t * et, Ce += t * Ve, Oe += t * rt, ge += t * ft, Te += t * mt, ve += t * st, ue += t * ct, t = f[1], S += t * y, j += t * Re, G += t * Ke, de += t * Fe, ne += t * Me, He += t * Be, re += t * We, we += t * Ze, Ee += t * je, Ce += t * et, Oe += t * Ve, ge += t * rt, Te += t * ft, ve += t * mt, ue += t * st, pe += t * ct, t = f[2], j += t * y, G += t * Re, de += t * Ke, ne += t * Fe, He += t * Me, re += t * Be, we += t * We, Ee += t * Ze, Ce += t * je, Oe += t * et, ge += t * Ve, Te += t * rt, ve += t * ft, ue += t * mt, pe += t * st, oe += t * ct, t = f[3], G += t * y, de += t * Re, ne += t * Ke, He += t * Fe, re += t * Me, we += t * Be, Ee += t * We, Ce += t * Ze, Oe += t * je, ge += t * et, Te += t * Ve, ve += t * rt, ue += t * ft, pe += t * mt, oe += t * st, le += t * ct, t = f[4], de += t * y, ne += t * Re, He += t * Ke, re += t * Fe, we += t * Me, Ee += t * Be, Ce += t * We, Oe += t * Ze, ge += t * je, Te += t * et, ve += t * Ve, ue += t * rt, pe += t * ft, oe += t * mt, le += t * st, he += t * ct, t = f[5], ne += t * y, He += t * Re, re += t * Ke, we += t * Fe, Ee += t * Me, Ce += t * Be, Oe += t * We, ge += t * Ze, Te += t * je, ve += t * et, ue += t * Ve, pe += t * rt, oe += t * ft, le += t * mt, he += t * st, ie += t * ct, t = f[6], He += t * y, re += t * Re, we += t * Ke, Ee += t * Fe, Ce += t * Me, Oe += t * Be, ge += t * We, Te += t * Ze, ve += t * je, ue += t * et, pe += t * Ve, oe += t * rt, le += t * ft, he += t * mt, ie += t * st, L += t * ct, t = f[7], re += t * y, we += t * Re, Ee += t * Ke, Ce += t * Fe, Oe += t * Me, ge += t * Be, Te += t * We, ve += t * Ze, ue += t * je, pe += t * et, oe += t * Ve, le += t * rt, he += t * ft, ie += t * mt, L += t * st, C += t * ct, t = f[8], we += t * y, Ee += t * Re, Ce += t * Ke, Oe += t * Fe, ge += t * Me, Te += t * Be, ve += t * We, ue += t * Ze, pe += t * je, oe += t * et, le += t * Ve, he += t * rt, ie += t * ft, L += t * mt, C += t * st, P += t * ct, t = f[9], Ee += t * y, Ce += t * Re, Oe += t * Ke, ge += t * Fe, Te += t * Me, ve += t * Be, ue += t * We, pe += t * Ze, oe += t * je, le += t * et, he += t * Ve, ie += t * rt, L += t * ft, C += t * mt, P += t * st, B += t * ct, t = f[10], Ce += t * y, Oe += t * Re, ge += t * Ke, Te += t * Fe, ve += t * Me, ue += t * Be, pe += t * We, oe += t * Ze, le += t * je, he += t * et, ie += t * Ve, L += t * rt, C += t * ft, P += t * mt, B += t * st, F += t * ct, t = f[11], Oe += t * y, ge += t * Re, Te += t * Ke, ve += t * Fe, ue += t * Me, pe += t * Be, oe += t * We, le += t * Ze, he += t * je, ie += t * et, L += t * Ve, C += t * rt, P += t * ft, B += t * mt, F += t * st, K += t * ct, t = f[12], ge += t * y, Te += t * Re, ve += t * Ke, ue += t * Fe, pe += t * Me, oe += t * Be, le += t * We, he += t * Ze, ie += t * je, L += t * et, C += t * Ve, P += t * rt, B += t * ft, F += t * mt, K += t * st, xe += t * ct, t = f[13], Te += t * y, ve += t * Re, ue += t * Ke, pe += t * Fe, oe += t * Me, le += t * Be, he += t * We, ie += t * Ze, L += t * je, C += t * et, P += t * Ve, B += t * rt, F += t * ft, K += t * mt, xe += t * st, Ae += t * ct, t = f[14], ve += t * y, ue += t * Re, pe += t * Ke, oe += t * Fe, le += t * Me, he += t * Be, ie += t * We, L += t * Ze, C += t * je, P += t * et, B += t * Ve, F += t * rt, K += t * ft, xe += t * mt, Ae += t * st, Le += t * ct, t = f[15], ue += t * y, pe += t * Re, oe += t * Ke, le += t * Fe, he += t * Me, ie += t * Be, L += t * We, C += t * Ze, P += t * je, B += t * et, F += t * Ve, K += t * rt, xe += t * ft, Ae += t * mt, Le += t * st, De += t * ct, E += 38 * pe, S += 38 * oe, j += 38 * le, G += 38 * he, de += 38 * ie, ne += 38 * L, He += 38 * C, re += 38 * P, we += 38 * B, Ee += 38 * F, Ce += 38 * K, Oe += 38 * xe, ge += 38 * Ae, Te += 38 * Le, ve += 38 * De, h = 1, t = E + h + 65535, h = Math.floor(t / 65536), E = t - h * 65536, t = S + h + 65535, h = Math.floor(t / 65536), S = t - h * 65536, t = j + h + 65535, h = Math.floor(t / 65536), j = t - h * 65536, t = G + h + 65535, h = Math.floor(t / 65536), G = t - h * 65536, t = de + h + 65535, h = Math.floor(t / 65536), de = t - h * 65536, t = ne + h + 65535, h = Math.floor(t / 65536), ne = t - h * 65536, t = He + h + 65535, h = Math.floor(t / 65536), He = t - h * 65536, t = re + h + 65535, h = Math.floor(t / 65536), re = t - h * 65536, t = we + h + 65535, h = Math.floor(t / 65536), we = t - h * 65536, t = Ee + h + 65535, h = Math.floor(t / 65536), Ee = t - h * 65536, t = Ce + h + 65535, h = Math.floor(t / 65536), Ce = t - h * 65536, t = Oe + h + 65535, h = Math.floor(t / 65536), Oe = t - h * 65536, t = ge + h + 65535, h = Math.floor(t / 65536), ge = t - h * 65536, t = Te + h + 65535, h = Math.floor(t / 65536), Te = t - h * 65536, t = ve + h + 65535, h = Math.floor(t / 65536), ve = t - h * 65536, t = ue + h + 65535, h = Math.floor(t / 65536), ue = t - h * 65536, E += h - 1 + 37 * (h - 1), h = 1, t = E + h + 65535, h = Math.floor(t / 65536), E = t - h * 65536, t = S + h + 65535, h = Math.floor(t / 65536), S = t - h * 65536, t = j + h + 65535, h = Math.floor(t / 65536), j = t - h * 65536, t = G + h + 65535, h = Math.floor(t / 65536), G = t - h * 65536, t = de + h + 65535, h = Math.floor(t / 65536), de = t - h * 65536, t = ne + h + 65535, h = Math.floor(t / 65536), ne = t - h * 65536, t = He + h + 65535, h = Math.floor(t / 65536), He = t - h * 65536, t = re + h + 65535, h = Math.floor(t / 65536), re = t - h * 65536, t = we + h + 65535, h = Math.floor(t / 65536), we = t - h * 65536, t = Ee + h + 65535, h = Math.floor(t / 65536), Ee = t - h * 65536, t = Ce + h + 65535, h = Math.floor(t / 65536), Ce = t - h * 65536, t = Oe + h + 65535, h = Math.floor(t / 65536), Oe = t - h * 65536, t = ge + h + 65535, h = Math.floor(t / 65536), ge = t - h * 65536, t = Te + h + 65535, h = Math.floor(t / 65536), Te = t - h * 65536, t = ve + h + 65535, h = Math.floor(t / 65536), ve = t - h * 65536, t = ue + h + 65535, h = Math.floor(t / 65536), ue = t - h * 65536, E += h - 1 + 37 * (h - 1), s[0] = E, s[1] = S, s[2] = j, s[3] = G, s[4] = de, s[5] = ne, s[6] = He, s[7] = re, s[8] = we, s[9] = Ee, s[10] = Ce, s[11] = Oe, s[12] = ge, s[13] = Te, s[14] = ve, s[15] = ue;
      }
      function yt(s, f) {
        Ue(s, f, f);
      }
      function yr(s, f) {
        var o = a(), t;
        for (t = 0; t < 16; t++) o[t] = f[t];
        for (t = 253; t >= 0; t--)
          yt(o, o), t !== 2 && t !== 4 && Ue(o, o, f);
        for (t = 0; t < 16; t++) s[t] = o[t];
      }
      function Tr(s, f) {
        var o = a(), t;
        for (t = 0; t < 16; t++) o[t] = f[t];
        for (t = 250; t >= 0; t--)
          yt(o, o), t !== 1 && Ue(o, o, f);
        for (t = 0; t < 16; t++) s[t] = o[t];
      }
      function At(s, f, o) {
        var t = new Uint8Array(32), h = new Float64Array(80), E, S, j = a(), G = a(), de = a(), ne = a(), He = a(), re = a();
        for (S = 0; S < 31; S++) t[S] = f[S];
        for (t[31] = f[31] & 127 | 64, t[0] &= 248, rr(h, o), S = 0; S < 16; S++)
          G[S] = h[S], ne[S] = j[S] = de[S] = 0;
        for (j[0] = ne[0] = 1, S = 254; S >= 0; --S)
          E = t[S >>> 3] >>> (S & 7) & 1, at(j, G, E), at(de, ne, E), It(He, j, de), bt(j, j, de), It(de, G, ne), bt(G, G, ne), yt(ne, He), yt(re, j), Ue(j, de, j), Ue(de, G, He), It(He, j, de), bt(j, j, de), yt(G, j), bt(de, ne, re), Ue(j, de, g), It(j, j, ne), Ue(de, de, j), Ue(j, ne, re), Ue(ne, G, h), yt(G, He), at(j, G, E), at(de, ne, E);
        for (S = 0; S < 16; S++)
          h[S + 16] = j[S], h[S + 32] = de[S], h[S + 48] = G[S], h[S + 64] = ne[S];
        var we = h.subarray(32), Ee = h.subarray(16);
        return yr(we, we), Ue(Ee, Ee, we), _t(s, Ee), 0;
      }
      function Lt(s, f) {
        return At(s, f, b);
      }
      function Ct(s, f) {
        return c(f, 32), Lt(s, f);
      }
      function Pt(s, f, o) {
        var t = new Uint8Array(32);
        return At(t, o, f), v(s, p, t, x);
      }
      var qt = se, nr = Ge;
      function xr(s, f, o, t, h, E) {
        var S = new Uint8Array(32);
        return Pt(S, h, E), qt(s, f, o, t, S);
      }
      function tt(s, f, o, t, h, E) {
        var S = new Uint8Array(32);
        return Pt(S, h, E), nr(s, f, o, t, S);
      }
      var R = [
        1116352408,
        3609767458,
        1899447441,
        602891725,
        3049323471,
        3964484399,
        3921009573,
        2173295548,
        961987163,
        4081628472,
        1508970993,
        3053834265,
        2453635748,
        2937671579,
        2870763221,
        3664609560,
        3624381080,
        2734883394,
        310598401,
        1164996542,
        607225278,
        1323610764,
        1426881987,
        3590304994,
        1925078388,
        4068182383,
        2162078206,
        991336113,
        2614888103,
        633803317,
        3248222580,
        3479774868,
        3835390401,
        2666613458,
        4022224774,
        944711139,
        264347078,
        2341262773,
        604807628,
        2007800933,
        770255983,
        1495990901,
        1249150122,
        1856431235,
        1555081692,
        3175218132,
        1996064986,
        2198950837,
        2554220882,
        3999719339,
        2821834349,
        766784016,
        2952996808,
        2566594879,
        3210313671,
        3203337956,
        3336571891,
        1034457026,
        3584528711,
        2466948901,
        113926993,
        3758326383,
        338241895,
        168717936,
        666307205,
        1188179964,
        773529912,
        1546045734,
        1294757372,
        1522805485,
        1396182291,
        2643833823,
        1695183700,
        2343527390,
        1986661051,
        1014477480,
        2177026350,
        1206759142,
        2456956037,
        344077627,
        2730485921,
        1290863460,
        2820302411,
        3158454273,
        3259730800,
        3505952657,
        3345764771,
        106217008,
        3516065817,
        3606008344,
        3600352804,
        1432725776,
        4094571909,
        1467031594,
        275423344,
        851169720,
        430227734,
        3100823752,
        506948616,
        1363258195,
        659060556,
        3750685593,
        883997877,
        3785050280,
        958139571,
        3318307427,
        1322822218,
        3812723403,
        1537002063,
        2003034995,
        1747873779,
        3602036899,
        1955562222,
        1575990012,
        2024104815,
        1125592928,
        2227730452,
        2716904306,
        2361852424,
        442776044,
        2428436474,
        593698344,
        2756734187,
        3733110249,
        3204031479,
        2999351573,
        3329325298,
        3815920427,
        3391569614,
        3928383900,
        3515267271,
        566280711,
        3940187606,
        3454069534,
        4118630271,
        4000239992,
        116418474,
        1914138554,
        174292421,
        2731055270,
        289380356,
        3203993006,
        460393269,
        320620315,
        685471733,
        587496836,
        852142971,
        1086792851,
        1017036298,
        365543100,
        1126000580,
        2618297676,
        1288033470,
        3409855158,
        1501505948,
        4234509866,
        1607167915,
        987167468,
        1816402316,
        1246189591
      ];
      function $(s, f, o, t) {
        for (var h = new Int32Array(16), E = new Int32Array(16), S, j, G, de, ne, He, re, we, Ee, Ce, Oe, ge, Te, ve, ue, pe, oe, le, he, ie, L, C, P, B, F, K, xe = s[0], Ae = s[1], Le = s[2], De = s[3], y = s[4], Re = s[5], Ke = s[6], Fe = s[7], Me = f[0], Be = f[1], We = f[2], Ze = f[3], je = f[4], et = f[5], Ve = f[6], rt = f[7], ft = 0; t >= 128; ) {
          for (he = 0; he < 16; he++)
            ie = 8 * he + ft, h[he] = o[ie + 0] << 24 | o[ie + 1] << 16 | o[ie + 2] << 8 | o[ie + 3], E[he] = o[ie + 4] << 24 | o[ie + 5] << 16 | o[ie + 6] << 8 | o[ie + 7];
          for (he = 0; he < 80; he++)
            if (S = xe, j = Ae, G = Le, de = De, ne = y, He = Re, re = Ke, we = Fe, Ee = Me, Ce = Be, Oe = We, ge = Ze, Te = je, ve = et, ue = Ve, pe = rt, L = Fe, C = rt, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = (y >>> 14 | je << 18) ^ (y >>> 18 | je << 14) ^ (je >>> 9 | y << 23), C = (je >>> 14 | y << 18) ^ (je >>> 18 | y << 14) ^ (y >>> 9 | je << 23), P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, L = y & Re ^ ~y & Ke, C = je & et ^ ~je & Ve, P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, L = R[he * 2], C = R[he * 2 + 1], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, L = h[he % 16], C = E[he % 16], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, oe = F & 65535 | K << 16, le = P & 65535 | B << 16, L = oe, C = le, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = (xe >>> 28 | Me << 4) ^ (Me >>> 2 | xe << 30) ^ (Me >>> 7 | xe << 25), C = (Me >>> 28 | xe << 4) ^ (xe >>> 2 | Me << 30) ^ (xe >>> 7 | Me << 25), P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, L = xe & Ae ^ xe & Le ^ Ae & Le, C = Me & Be ^ Me & We ^ Be & We, P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, we = F & 65535 | K << 16, pe = P & 65535 | B << 16, L = de, C = ge, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = oe, C = le, P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, de = F & 65535 | K << 16, ge = P & 65535 | B << 16, Ae = S, Le = j, De = G, y = de, Re = ne, Ke = He, Fe = re, xe = we, Be = Ee, We = Ce, Ze = Oe, je = ge, et = Te, Ve = ve, rt = ue, Me = pe, he % 16 === 15)
              for (ie = 0; ie < 16; ie++)
                L = h[ie], C = E[ie], P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = h[(ie + 9) % 16], C = E[(ie + 9) % 16], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, oe = h[(ie + 1) % 16], le = E[(ie + 1) % 16], L = (oe >>> 1 | le << 31) ^ (oe >>> 8 | le << 24) ^ oe >>> 7, C = (le >>> 1 | oe << 31) ^ (le >>> 8 | oe << 24) ^ (le >>> 7 | oe << 25), P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, oe = h[(ie + 14) % 16], le = E[(ie + 14) % 16], L = (oe >>> 19 | le << 13) ^ (le >>> 29 | oe << 3) ^ oe >>> 6, C = (le >>> 19 | oe << 13) ^ (oe >>> 29 | le << 3) ^ (le >>> 6 | oe << 26), P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, h[ie] = F & 65535 | K << 16, E[ie] = P & 65535 | B << 16;
          L = xe, C = Me, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[0], C = f[0], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[0] = xe = F & 65535 | K << 16, f[0] = Me = P & 65535 | B << 16, L = Ae, C = Be, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[1], C = f[1], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[1] = Ae = F & 65535 | K << 16, f[1] = Be = P & 65535 | B << 16, L = Le, C = We, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[2], C = f[2], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[2] = Le = F & 65535 | K << 16, f[2] = We = P & 65535 | B << 16, L = De, C = Ze, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[3], C = f[3], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[3] = De = F & 65535 | K << 16, f[3] = Ze = P & 65535 | B << 16, L = y, C = je, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[4], C = f[4], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[4] = y = F & 65535 | K << 16, f[4] = je = P & 65535 | B << 16, L = Re, C = et, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[5], C = f[5], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[5] = Re = F & 65535 | K << 16, f[5] = et = P & 65535 | B << 16, L = Ke, C = Ve, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[6], C = f[6], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[6] = Ke = F & 65535 | K << 16, f[6] = Ve = P & 65535 | B << 16, L = Fe, C = rt, P = C & 65535, B = C >>> 16, F = L & 65535, K = L >>> 16, L = s[7], C = f[7], P += C & 65535, B += C >>> 16, F += L & 65535, K += L >>> 16, B += P >>> 16, F += B >>> 16, K += F >>> 16, s[7] = Fe = F & 65535 | K << 16, f[7] = rt = P & 65535 | B << 16, ft += 128, t -= 128;
        }
        return t;
      }
      function fe(s, f, o) {
        var t = new Int32Array(8), h = new Int32Array(8), E = new Uint8Array(256), S, j = o;
        for (t[0] = 1779033703, t[1] = 3144134277, t[2] = 1013904242, t[3] = 2773480762, t[4] = 1359893119, t[5] = 2600822924, t[6] = 528734635, t[7] = 1541459225, h[0] = 4089235720, h[1] = 2227873595, h[2] = 4271175723, h[3] = 1595750129, h[4] = 2917565137, h[5] = 725511199, h[6] = 4215389547, h[7] = 327033209, $(t, h, f, o), o %= 128, S = 0; S < o; S++) E[S] = f[j - o + S];
        for (E[o] = 128, o = 256 - 128 * (o < 112 ? 1 : 0), E[o - 9] = 0, Y(E, o - 8, j / 536870912 | 0, j << 3), $(t, h, E, o), S = 0; S < 8; S++) Y(s, 8 * S, t[S], h[S]);
        return 0;
      }
      function be(s, f) {
        var o = a(), t = a(), h = a(), E = a(), S = a(), j = a(), G = a(), de = a(), ne = a();
        bt(o, s[1], s[0]), bt(ne, f[1], f[0]), Ue(o, o, ne), It(t, s[0], s[1]), It(ne, f[0], f[1]), Ue(t, t, ne), Ue(h, s[3], f[3]), Ue(h, h, O), Ue(E, s[2], f[2]), It(E, E, E), bt(S, t, o), bt(j, E, h), It(G, E, h), It(de, t, o), Ue(s[0], S, j), Ue(s[1], de, G), Ue(s[2], G, j), Ue(s[3], S, de);
      }
      function ce(s, f, o) {
        var t;
        for (t = 0; t < 4; t++)
          at(s[t], f[t], o);
      }
      function $e(s, f) {
        var o = a(), t = a(), h = a();
        yr(h, f[2]), Ue(o, f[0], h), Ue(t, f[1], h), _t(s, t), s[31] ^= lt(o) << 7;
      }
      function kt(s, f, o) {
        var t, h;
        for (ae(s[0], m), ae(s[1], _), ae(s[2], _), ae(s[3], m), h = 255; h >= 0; --h)
          t = o[h / 8 | 0] >> (h & 7) & 1, ce(s, f, t), be(f, s), be(s, s), ce(s, f, t);
      }
      function Et(s, f) {
        var o = [a(), a(), a(), a()];
        ae(o[0], T), ae(o[1], A), ae(o[2], _), Ue(o[3], T, A), kt(s, o, f);
      }
      function Mt(s, f, o) {
        var t = new Uint8Array(64), h = [a(), a(), a(), a()], E;
        for (o || c(f, 32), fe(t, f, 32), t[0] &= 248, t[31] &= 127, t[31] |= 64, Et(h, t), $e(s, h), E = 0; E < 32; E++) f[E + 32] = s[E];
        return 0;
      }
      var Nt = new Float64Array([237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
      function wt(s, f) {
        var o, t, h, E;
        for (t = 63; t >= 32; --t) {
          for (o = 0, h = t - 32, E = t - 12; h < E; ++h)
            f[h] += o - 16 * f[t] * Nt[h - (t - 32)], o = Math.floor((f[h] + 128) / 256), f[h] -= o * 256;
          f[h] += o, f[t] = 0;
        }
        for (o = 0, h = 0; h < 32; h++)
          f[h] += o - (f[31] >> 4) * Nt[h], o = f[h] >> 8, f[h] &= 255;
        for (h = 0; h < 32; h++) f[h] -= o * Nt[h];
        for (t = 0; t < 32; t++)
          f[t + 1] += f[t] >> 8, s[t] = f[t] & 255;
      }
      function ir(s) {
        var f = new Float64Array(64), o;
        for (o = 0; o < 64; o++) f[o] = s[o];
        for (o = 0; o < 64; o++) s[o] = 0;
        wt(s, f);
      }
      function Wt(s, f, o, t) {
        var h = new Uint8Array(64), E = new Uint8Array(64), S = new Uint8Array(64), j, G, de = new Float64Array(64), ne = [a(), a(), a(), a()];
        fe(h, t, 32), h[0] &= 248, h[31] &= 127, h[31] |= 64;
        var He = o + 64;
        for (j = 0; j < o; j++) s[64 + j] = f[j];
        for (j = 0; j < 32; j++) s[32 + j] = h[32 + j];
        for (fe(S, s.subarray(32), o + 32), ir(S), Et(ne, S), $e(s, ne), j = 32; j < 64; j++) s[j] = t[j];
        for (fe(E, s, o + 64), ir(E), j = 0; j < 64; j++) de[j] = 0;
        for (j = 0; j < 32; j++) de[j] = S[j];
        for (j = 0; j < 32; j++)
          for (G = 0; G < 32; G++)
            de[j + G] += E[j] * h[G];
        return wt(s.subarray(32), de), He;
      }
      function sr(s, f) {
        var o = a(), t = a(), h = a(), E = a(), S = a(), j = a(), G = a();
        return ae(s[2], _), rr(s[1], f), yt(h, s[1]), Ue(E, h, u), bt(h, h, s[2]), It(E, s[2], E), yt(S, E), yt(j, S), Ue(G, j, S), Ue(o, G, h), Ue(o, o, E), Tr(o, o), Ue(o, o, h), Ue(o, o, E), Ue(o, o, E), Ue(s[0], o, E), yt(t, s[0]), Ue(t, t, E), Xt(t, h) && Ue(s[0], s[0], k), yt(t, s[0]), Ue(t, t, E), Xt(t, h) ? -1 : (lt(s[0]) === f[31] >> 7 && bt(s[0], m, s[0]), Ue(s[3], s[0], s[1]), 0);
      }
      function it(s, f, o, t) {
        var h, E = new Uint8Array(32), S = new Uint8Array(64), j = [a(), a(), a(), a()], G = [a(), a(), a(), a()];
        if (o < 64 || sr(G, t)) return -1;
        for (h = 0; h < o; h++) s[h] = f[h];
        for (h = 0; h < 32; h++) s[h + 32] = t[h];
        if (fe(S, s, o), ir(S), kt(j, G, S), Et(G, f.subarray(32)), be(j, G), $e(E, j), o -= 64, q(f, 0, E, 0)) {
          for (h = 0; h < o; h++) s[h] = 0;
          return -1;
        }
        for (h = 0; h < o; h++) s[h] = f[h + 64];
        return o;
      }
      var ze = 32, me = 24, Ot = 32, St = 16, $t = 32, xt = 32, Rt = 32, gt = 32, Jt = 32, fr = me, J = Ot, Or = St, zt = 64, ht = 32, Qt = 64, _r = 32, br = 64;
      n.lowlevel = {
        crypto_core_hsalsa20: v,
        crypto_stream_xor: H,
        crypto_stream: te,
        crypto_stream_salsa20_xor: M,
        crypto_stream_salsa20: U,
        crypto_onetimeauth: Ie,
        crypto_onetimeauth_verify: Se,
        crypto_verify_16: Z,
        crypto_verify_32: q,
        crypto_secretbox: se,
        crypto_secretbox_open: Ge,
        crypto_scalarmult: At,
        crypto_scalarmult_base: Lt,
        crypto_box_beforenm: Pt,
        crypto_box_afternm: qt,
        crypto_box: xr,
        crypto_box_open: tt,
        crypto_box_keypair: Ct,
        crypto_hash: fe,
        crypto_sign: Wt,
        crypto_sign_keypair: Mt,
        crypto_sign_open: it,
        crypto_secretbox_KEYBYTES: ze,
        crypto_secretbox_NONCEBYTES: me,
        crypto_secretbox_ZEROBYTES: Ot,
        crypto_secretbox_BOXZEROBYTES: St,
        crypto_scalarmult_BYTES: $t,
        crypto_scalarmult_SCALARBYTES: xt,
        crypto_box_PUBLICKEYBYTES: Rt,
        crypto_box_SECRETKEYBYTES: gt,
        crypto_box_BEFORENMBYTES: Jt,
        crypto_box_NONCEBYTES: fr,
        crypto_box_ZEROBYTES: J,
        crypto_box_BOXZEROBYTES: Or,
        crypto_sign_BYTES: zt,
        crypto_sign_PUBLICKEYBYTES: ht,
        crypto_sign_SECRETKEYBYTES: Qt,
        crypto_sign_SEEDBYTES: _r,
        crypto_hash_BYTES: br,
        gf: a,
        D: u,
        L: Nt,
        pack25519: _t,
        unpack25519: rr,
        M: Ue,
        A: It,
        S: yt,
        Z: bt,
        pow2523: Tr,
        add: be,
        set25519: ae,
        modL: wt,
        scalarmult: kt,
        scalarbase: Et
      };
      function Zt(s, f) {
        if (s.length !== ze) throw new Error("bad key size");
        if (f.length !== me) throw new Error("bad nonce size");
      }
      function Br(s, f) {
        if (s.length !== Rt) throw new Error("bad public key size");
        if (f.length !== gt) throw new Error("bad secret key size");
      }
      function Qe() {
        for (var s = 0; s < arguments.length; s++)
          if (!(arguments[s] instanceof Uint8Array))
            throw new TypeError("unexpected type, use Uint8Array");
      }
      function or(s) {
        for (var f = 0; f < s.length; f++) s[f] = 0;
      }
      n.randomBytes = function(s) {
        var f = new Uint8Array(s);
        return c(f, s), f;
      }, n.secretbox = function(s, f, o) {
        Qe(s, f, o), Zt(o, f);
        for (var t = new Uint8Array(Ot + s.length), h = new Uint8Array(t.length), E = 0; E < s.length; E++) t[E + Ot] = s[E];
        return se(h, t, t.length, f, o), h.subarray(St);
      }, n.secretbox.open = function(s, f, o) {
        Qe(s, f, o), Zt(o, f);
        for (var t = new Uint8Array(St + s.length), h = new Uint8Array(t.length), E = 0; E < s.length; E++) t[E + St] = s[E];
        return t.length < 32 || Ge(h, t, t.length, f, o) !== 0 ? null : h.subarray(Ot);
      }, n.secretbox.keyLength = ze, n.secretbox.nonceLength = me, n.secretbox.overheadLength = St, n.scalarMult = function(s, f) {
        if (Qe(s, f), s.length !== xt) throw new Error("bad n size");
        if (f.length !== $t) throw new Error("bad p size");
        var o = new Uint8Array($t);
        return At(o, s, f), o;
      }, n.scalarMult.base = function(s) {
        if (Qe(s), s.length !== xt) throw new Error("bad n size");
        var f = new Uint8Array($t);
        return Lt(f, s), f;
      }, n.scalarMult.scalarLength = xt, n.scalarMult.groupElementLength = $t, n.box = function(s, f, o, t) {
        var h = n.box.before(o, t);
        return n.secretbox(s, f, h);
      }, n.box.before = function(s, f) {
        Qe(s, f), Br(s, f);
        var o = new Uint8Array(Jt);
        return Pt(o, s, f), o;
      }, n.box.after = n.secretbox, n.box.open = function(s, f, o, t) {
        var h = n.box.before(o, t);
        return n.secretbox.open(s, f, h);
      }, n.box.open.after = n.secretbox.open, n.box.keyPair = function() {
        var s = new Uint8Array(Rt), f = new Uint8Array(gt);
        return Ct(s, f), { publicKey: s, secretKey: f };
      }, n.box.keyPair.fromSecretKey = function(s) {
        if (Qe(s), s.length !== gt)
          throw new Error("bad secret key size");
        var f = new Uint8Array(Rt);
        return Lt(f, s), { publicKey: f, secretKey: new Uint8Array(s) };
      }, n.box.publicKeyLength = Rt, n.box.secretKeyLength = gt, n.box.sharedKeyLength = Jt, n.box.nonceLength = fr, n.box.overheadLength = n.secretbox.overheadLength, n.sign = function(s, f) {
        if (Qe(s, f), f.length !== Qt)
          throw new Error("bad secret key size");
        var o = new Uint8Array(zt + s.length);
        return Wt(o, s, s.length, f), o;
      }, n.sign.open = function(s, f) {
        if (Qe(s, f), f.length !== ht)
          throw new Error("bad public key size");
        var o = new Uint8Array(s.length), t = it(o, s, s.length, f);
        if (t < 0) return null;
        for (var h = new Uint8Array(t), E = 0; E < h.length; E++) h[E] = o[E];
        return h;
      }, n.sign.detached = function(s, f) {
        for (var o = n.sign(s, f), t = new Uint8Array(zt), h = 0; h < t.length; h++) t[h] = o[h];
        return t;
      }, n.sign.detached.verify = function(s, f, o) {
        if (Qe(s, f, o), f.length !== zt)
          throw new Error("bad signature size");
        if (o.length !== ht)
          throw new Error("bad public key size");
        var t = new Uint8Array(zt + s.length), h = new Uint8Array(zt + s.length), E;
        for (E = 0; E < zt; E++) t[E] = f[E];
        for (E = 0; E < s.length; E++) t[E + zt] = s[E];
        return it(h, t, t.length, o) >= 0;
      }, n.sign.keyPair = function() {
        var s = new Uint8Array(ht), f = new Uint8Array(Qt);
        return Mt(s, f), { publicKey: s, secretKey: f };
      }, n.sign.keyPair.fromSecretKey = function(s) {
        if (Qe(s), s.length !== Qt)
          throw new Error("bad secret key size");
        for (var f = new Uint8Array(ht), o = 0; o < f.length; o++) f[o] = s[32 + o];
        return { publicKey: f, secretKey: new Uint8Array(s) };
      }, n.sign.keyPair.fromSeed = function(s) {
        if (Qe(s), s.length !== _r)
          throw new Error("bad seed size");
        for (var f = new Uint8Array(ht), o = new Uint8Array(Qt), t = 0; t < 32; t++) o[t] = s[t];
        return Mt(f, o, !0), { publicKey: f, secretKey: o };
      }, n.sign.publicKeyLength = ht, n.sign.secretKeyLength = Qt, n.sign.seedLength = _r, n.sign.signatureLength = zt, n.hash = function(s) {
        Qe(s);
        var f = new Uint8Array(br);
        return fe(f, s, s.length), f;
      }, n.hash.hashLength = br, n.verify = function(s, f) {
        return Qe(s, f), s.length === 0 || f.length === 0 || s.length !== f.length ? !1 : Q(s, 0, f, 0, s.length) === 0;
      }, n.setPRNG = function(s) {
        c = s;
      }, (function() {
        var s = typeof self < "u" ? self.crypto || self.msCrypto : null;
        if (s && s.getRandomValues) {
          var f = 65536;
          n.setPRNG(function(o, t) {
            var h, E = new Uint8Array(t);
            for (h = 0; h < t; h += f)
              s.getRandomValues(E.subarray(h, h + Math.min(t - h, f)));
            for (h = 0; h < t; h++) o[h] = E[h];
            or(E);
          });
        } else typeof ho < "u" && (s = Vr, s && s.randomBytes && n.setPRNG(function(o, t) {
          var h, E = s.randomBytes(t);
          for (h = 0; h < t; h++) o[h] = E[h];
          or(E);
        }));
      })();
    })(l.exports ? l.exports : self.nacl = self.nacl || {});
  })(mn)), mn.exports;
}
var mo = po();
const Dt = /* @__PURE__ */ Rr(mo);
var Hr = { exports: {} }, yo = Hr.exports, fi;
function xo() {
  return fi || (fi = 1, (function(l) {
    (function(n, a) {
      l.exports ? l.exports = a() : (n.nacl || (n.nacl = {}), n.nacl.util = a());
    })(yo, function() {
      var n = {};
      function a(c) {
        if (!/^(?:[A-Za-z0-9+\/]{2}[A-Za-z0-9+\/]{2})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(c))
          throw new TypeError("invalid encoding");
      }
      return n.decodeUTF8 = function(c) {
        if (typeof c != "string") throw new TypeError("expected string");
        var p, b = unescape(encodeURIComponent(c)), m = new Uint8Array(b.length);
        for (p = 0; p < b.length; p++) m[p] = b.charCodeAt(p);
        return m;
      }, n.encodeUTF8 = function(c) {
        var p, b = [];
        for (p = 0; p < c.length; p++) b.push(String.fromCharCode(c[p]));
        return decodeURIComponent(escape(b.join("")));
      }, typeof atob > "u" ? typeof Buffer.from < "u" ? (n.encodeBase64 = function(c) {
        return Buffer.from(c).toString("base64");
      }, n.decodeBase64 = function(c) {
        return a(c), new Uint8Array(Array.prototype.slice.call(Buffer.from(c, "base64"), 0));
      }) : (n.encodeBase64 = function(c) {
        return new Buffer(c).toString("base64");
      }, n.decodeBase64 = function(c) {
        return a(c), new Uint8Array(Array.prototype.slice.call(new Buffer(c, "base64"), 0));
      }) : (n.encodeBase64 = function(c) {
        var p, b = [], m = c.length;
        for (p = 0; p < m; p++) b.push(String.fromCharCode(c[p]));
        return btoa(b.join(""));
      }, n.decodeBase64 = function(c) {
        a(c);
        var p, b = atob(c), m = new Uint8Array(b.length);
        for (p = 0; p < b.length; p++) m[p] = b.charCodeAt(p);
        return m;
      }), n;
    });
  })(Hr)), Hr.exports;
}
var _o = xo();
const bo = /* @__PURE__ */ Rr(_o), { encodeBase64: Ft, decodeBase64: tr, encodeUTF8: Cn, decodeUTF8: Sr } = bo, Ci = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function wo(l) {
  const n = [0];
  for (const c of l) {
    let p = c;
    for (let b = 0; b < n.length; b++)
      p += n[b] << 8, n[b] = p % 58, p = p / 58 | 0;
    for (; p > 0; )
      n.push(p % 58), p = p / 58 | 0;
  }
  let a = "";
  for (const c of l) {
    if (c !== 0) break;
    a += "1";
  }
  for (let c = n.length - 1; c >= 0; c--)
    a += Ci[n[c]];
  return a;
}
function go(l) {
  const n = [0];
  for (const a of l) {
    const c = Ci.indexOf(a);
    if (c < 0) throw new Error(`Invalid base58 character: ${a}`);
    let p = c;
    for (let b = 0; b < n.length; b++)
      p += n[b] * 58, n[b] = p & 255, p >>= 8;
    for (; p > 0; )
      n.push(p & 255), p >>= 8;
  }
  for (const a of l) {
    if (a !== "1") break;
    n.push(0);
  }
  return new Uint8Array(n.reverse());
}
const yn = new Uint8Array([237, 1]);
function Ni() {
  const l = Dt.sign.keyPair(), n = vo(l.publicKey);
  return {
    publicKey: l.publicKey,
    secretKey: l.secretKey,
    did: n
  };
}
function vo(l) {
  const n = new Uint8Array(yn.length + l.length);
  return n.set(yn), n.set(l, yn.length), `did:key:z${wo(n)}`;
}
function Di(l) {
  if (!l.startsWith("did:key:z"))
    throw new Error(`Invalid did:key format: ${l}`);
  const n = go(l.slice(9));
  if (n[0] !== 237 || n[1] !== 1)
    throw new Error("Invalid multicodec prefix for ed25519");
  return n.slice(2);
}
function Li(l, n) {
  return Dt.sign.detached(l, n);
}
function Mi(l, n, a) {
  return Dt.sign.detached.verify(l, n, a);
}
function ci() {
  return Dt.box.keyPair();
}
function ui(l, n) {
  return Dt.box.before(n, l);
}
function Nn(l, n) {
  const a = Dt.randomBytes(Dt.secretbox.nonceLength), c = Dt.secretbox(l, a, n);
  if (!c) throw new Error("Encryption failed");
  return { nonce: a, ciphertext: c };
}
function Dn(l, n, a) {
  return Dt.secretbox.open(l, n, a);
}
async function Ri(l, n) {
  const { argon2id: a } = await import("./index.esm-BHvTnaWc.js"), c = await a({
    password: l,
    salt: n,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    // 64 MiB
    hashLength: 32,
    outputType: "binary"
  });
  return new Uint8Array(c);
}
function Eo(l) {
  return Dt.hash(Sr(l)).slice(0, Dt.secretbox.keyLength);
}
async function So(l, n) {
  const a = Dt.randomBytes(16), c = await Ri(n, a), p = Sr(JSON.stringify({
    publicKey: Ft(l.publicKey),
    secretKey: Ft(l.secretKey),
    did: l.did
  })), { nonce: b, ciphertext: m } = Nn(p, c);
  return JSON.stringify({
    version: 2,
    salt: Ft(a),
    nonce: Ft(b),
    ciphertext: Ft(m)
  });
}
async function To(l, n) {
  const a = JSON.parse(l);
  let c;
  a.version === 2 ? c = await Ri(n, tr(a.salt)) : c = Eo(n);
  const p = Dn(tr(a.ciphertext), tr(a.nonce), c);
  if (!p) throw new Error("Decryption failed — wrong password?");
  const b = JSON.parse(Cn(p));
  return {
    publicKey: tr(b.publicKey),
    secretKey: tr(b.secretKey),
    did: b.did
  };
}
const ke = {
  // Authentication
  AUTH: "auth",
  // Node → Relay
  PUBLISH: "publish",
  SEARCH: "search",
  CONSENT: "consent",
  WITHDRAW: "withdraw",
  // Relay → Node
  MATCH: "match",
  SEARCH_RESULTS: "search_results",
  CONSENT_FORWARD: "consent_forward",
  ACK: "ack",
  // Direct Channel
  CONFIRM_EMBEDDING: "confirm_embedding",
  CONFIRM_RESULT: "confirm_result",
  DISCLOSURE: "disclosure",
  ACCEPT: "accept",
  REJECT: "reject",
  CLOSE: "close",
  // Channel bridge (via relay)
  CHANNEL_MESSAGE: "channel_message",
  CHANNEL_FORWARD: "channel_forward"
};
function Ui(l, n, a, c) {
  const p = JSON.stringify({ type: l, from: n, timestamp: a, payload: c });
  return Sr(p);
}
function Yt(l, n, a) {
  const c = Date.now(), p = Ui(l, a.did, c, n), b = Li(p, a.secretKey);
  return {
    type: l,
    from: a.did,
    timestamp: c,
    signature: Ft(b),
    payload: n
  };
}
function Io(l, n) {
  const a = Di(l.from), c = Ui(l.type, l.from, l.timestamp, l.payload), p = tr(l.signature);
  return Mi(c, p, a);
}
function Sn(l) {
  const n = JSON.parse(l);
  if (typeof n.type != "string") throw new Error('Missing or invalid "type" field');
  if (typeof n.from != "string") throw new Error('Missing or invalid "from" field');
  if (typeof n.timestamp != "number") throw new Error('Missing or invalid "timestamp" field');
  if (typeof n.signature != "string") throw new Error('Missing or invalid "signature" field');
  if (n.payload === void 0) throw new Error('Missing "payload" field');
  return n;
}
function Er(l) {
  return JSON.stringify(l);
}
var xn = { exports: {} }, li;
function Oo() {
  return li || (li = 1, (function(l, n) {
    var a = void 0, c = function(p) {
      return a || (a = new Promise(function(b, m) {
        var _ = typeof p < "u" ? p : {}, g = _.onAbort;
        _.onAbort = function(e) {
          m(new Error(e)), g && g(e);
        }, _.postRun = _.postRun || [], _.postRun.push(function() {
          b(_);
        }), l = void 0;
        var u;
        u ||= typeof _ < "u" ? _ : {};
        var O = !!globalThis.window, T = !!globalThis.WorkerGlobalScope, A = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";
        u.onRuntimeInitialized = function() {
          function e(I, z) {
            switch (typeof z) {
              case "boolean":
                bs(I, z ? 1 : 0);
                break;
              case "number":
                ys(I, z);
                break;
              case "string":
                xs(I, z, -1, -1);
                break;
              case "object":
                if (z === null) $n(I);
                else if (z.length != null) {
                  var ye = ct(z.length);
                  H.set(z, ye), _s(I, ye, z.length, -1), Ar(ye);
                } else Wr(I, "Wrong API use : tried to return a value of an unknown type (" + z + ").", -1);
                break;
              default:
                $n(I);
            }
          }
          function r(I, z) {
            for (var ye = [], _e = 0; _e < I; _e += 1) {
              var qe = Ct(z + 4 * _e, "i32"), Je = ls(qe);
              if (Je === 1 || Je === 2) qe = ms(qe);
              else if (Je === 3) qe = ds(qe);
              else if (Je === 4) {
                Je = qe, qe = hs(Je), Je = ps(Je);
                for (var Ht = new Uint8Array(qe), Bt = 0; Bt < qe; Bt += 1) Ht[Bt] = H[Je + Bt];
                qe = Ht;
              } else qe = null;
              ye.push(qe);
            }
            return ye;
          }
          function i(I, z) {
            this.Qa = I, this.db = z, this.Oa = 1, this.mb = [];
          }
          function d(I, z) {
            if (this.db = z, this.fb = Ze(I), this.fb === null) throw Error("Unable to allocate memory for the SQL string");
            this.lb = this.fb, this.$a = this.sb = null;
          }
          function w(I) {
            if (this.filename = "dbfile_" + (4294967295 * Math.random() >>> 0), I != null) {
              var z = this.filename, ye = "/", _e = z;
              if (ye && (ye = typeof ye == "string" ? ye : Qt(ye), _e = z ? $(ye + "/" + z) : ye), z = Ot(!0, !0), _e = He(
                _e,
                z
              ), I) {
                if (typeof I == "string") {
                  ye = Array(I.length);
                  for (var qe = 0, Je = I.length; qe < Je; ++qe) ye[qe] = I.charCodeAt(qe);
                  I = ye;
                }
                ve(_e, z | 146), ye = pe(_e, 577), ie(ye, I, 0, I.length, 0), oe(ye), ve(_e, z);
              }
            }
            this.handleError(Ne(this.filename, N)), this.db = Ct(N, "i32"), Hn(this.db), this.gb = {}, this.Sa = {};
          }
          var N = wr(4), W = u.cwrap, Ne = W("sqlite3_open", "number", ["string", "number"]), Xe = W("sqlite3_close_v2", "number", ["number"]), Pe = W("sqlite3_exec", "number", ["number", "string", "number", "number", "number"]), nt = W("sqlite3_changes", "number", ["number"]), vt = W(
            "sqlite3_prepare_v2",
            "number",
            ["number", "string", "number", "number", "number"]
          ), Bn = W("sqlite3_sql", "string", ["number"]), Yi = W("sqlite3_normalized_sql", "string", ["number"]), Fn = W("sqlite3_prepare_v2", "number", ["number", "number", "number", "number", "number"]), Vi = W("sqlite3_bind_text", "number", ["number", "number", "number", "number", "number"]), jn = W("sqlite3_bind_blob", "number", ["number", "number", "number", "number", "number"]), Xi = W("sqlite3_bind_double", "number", ["number", "number", "number"]), Ji = W("sqlite3_bind_int", "number", [
            "number",
            "number",
            "number"
          ]), Qi = W("sqlite3_bind_parameter_index", "number", ["number", "string"]), Zi = W("sqlite3_step", "number", ["number"]), es = W("sqlite3_errmsg", "string", ["number"]), ts = W("sqlite3_column_count", "number", ["number"]), rs = W("sqlite3_data_count", "number", ["number"]), ns = W("sqlite3_column_double", "number", ["number", "number"]), qn = W("sqlite3_column_text", "string", ["number", "number"]), is = W("sqlite3_column_blob", "number", ["number", "number"]), ss = W("sqlite3_column_bytes", "number", ["number", "number"]), os = W(
            "sqlite3_column_type",
            "number",
            ["number", "number"]
          ), as = W("sqlite3_column_name", "string", ["number", "number"]), fs = W("sqlite3_reset", "number", ["number"]), cs = W("sqlite3_clear_bindings", "number", ["number"]), us = W("sqlite3_finalize", "number", ["number"]), Wn = W("sqlite3_create_function_v2", "number", "number string number number number number number number number".split(" ")), ls = W("sqlite3_value_type", "number", ["number"]), hs = W("sqlite3_value_bytes", "number", ["number"]), ds = W("sqlite3_value_text", "string", ["number"]), ps = W(
            "sqlite3_value_blob",
            "number",
            ["number"]
          ), ms = W("sqlite3_value_double", "number", ["number"]), ys = W("sqlite3_result_double", "", ["number", "number"]), $n = W("sqlite3_result_null", "", ["number"]), xs = W("sqlite3_result_text", "", ["number", "string", "number", "number"]), _s = W("sqlite3_result_blob", "", ["number", "number", "number", "number"]), bs = W("sqlite3_result_int", "", ["number", "number"]), Wr = W("sqlite3_result_error", "", ["number", "string", "number"]), zn = W("sqlite3_aggregate_context", "number", ["number", "number"]), Hn = W(
            "RegisterExtensionFunctions",
            "number",
            ["number"]
          ), Kn = W("sqlite3_update_hook", "number", ["number", "number", "number"]);
          i.prototype.bind = function(I) {
            if (!this.Qa) throw "Statement closed";
            return this.reset(), Array.isArray(I) ? this.Gb(I) : I != null && typeof I == "object" ? this.Hb(I) : !0;
          }, i.prototype.step = function() {
            if (!this.Qa) throw "Statement closed";
            this.Oa = 1;
            var I = Zi(this.Qa);
            switch (I) {
              case 100:
                return !0;
              case 101:
                return !1;
              default:
                throw this.db.handleError(I);
            }
          }, i.prototype.Ab = function(I) {
            return I == null && (I = this.Oa, this.Oa += 1), ns(this.Qa, I);
          }, i.prototype.Ob = function(I) {
            if (I == null && (I = this.Oa, this.Oa += 1), I = qn(this.Qa, I), typeof BigInt != "function") throw Error("BigInt is not supported");
            return BigInt(I);
          }, i.prototype.Tb = function(I) {
            return I == null && (I = this.Oa, this.Oa += 1), qn(this.Qa, I);
          }, i.prototype.getBlob = function(I) {
            I == null && (I = this.Oa, this.Oa += 1);
            var z = ss(this.Qa, I);
            I = is(this.Qa, I);
            for (var ye = new Uint8Array(z), _e = 0; _e < z; _e += 1) ye[_e] = H[I + _e];
            return ye;
          }, i.prototype.get = function(I, z) {
            z = z || {}, I != null && this.bind(I) && this.step(), I = [];
            for (var ye = rs(this.Qa), _e = 0; _e < ye; _e += 1) switch (os(this.Qa, _e)) {
              case 1:
                var qe = z.useBigInt ? this.Ob(_e) : this.Ab(_e);
                I.push(qe);
                break;
              case 2:
                I.push(this.Ab(_e));
                break;
              case 3:
                I.push(this.Tb(_e));
                break;
              case 4:
                I.push(this.getBlob(_e));
                break;
              default:
                I.push(null);
            }
            return I;
          }, i.prototype.qb = function() {
            for (var I = [], z = ts(this.Qa), ye = 0; ye < z; ye += 1) I.push(as(this.Qa, ye));
            return I;
          }, i.prototype.zb = function(I, z) {
            I = this.get(I, z), z = this.qb();
            for (var ye = {}, _e = 0; _e < z.length; _e += 1) ye[z[_e]] = I[_e];
            return ye;
          }, i.prototype.Sb = function() {
            return Bn(this.Qa);
          }, i.prototype.Pb = function() {
            return Yi(this.Qa);
          }, i.prototype.run = function(I) {
            return I != null && this.bind(I), this.step(), this.reset();
          }, i.prototype.wb = function(I, z) {
            z == null && (z = this.Oa, this.Oa += 1), I = Ze(I), this.mb.push(I), this.db.handleError(Vi(this.Qa, z, I, -1, 0));
          }, i.prototype.Fb = function(I, z) {
            z == null && (z = this.Oa, this.Oa += 1);
            var ye = ct(I.length);
            H.set(I, ye), this.mb.push(ye), this.db.handleError(jn(this.Qa, z, ye, I.length, 0));
          }, i.prototype.vb = function(I, z) {
            z == null && (z = this.Oa, this.Oa += 1), this.db.handleError((I === (I | 0) ? Ji : Xi)(
              this.Qa,
              z,
              I
            ));
          }, i.prototype.Ib = function(I) {
            I == null && (I = this.Oa, this.Oa += 1), jn(this.Qa, I, 0, 0, 0);
          }, i.prototype.xb = function(I, z) {
            switch (z == null && (z = this.Oa, this.Oa += 1), typeof I) {
              case "string":
                this.wb(I, z);
                return;
              case "number":
                this.vb(I, z);
                return;
              case "bigint":
                this.wb(I.toString(), z);
                return;
              case "boolean":
                this.vb(I + 0, z);
                return;
              case "object":
                if (I === null) {
                  this.Ib(z);
                  return;
                }
                if (I.length != null) {
                  this.Fb(I, z);
                  return;
                }
            }
            throw "Wrong API use : tried to bind a value of an unknown type (" + I + ").";
          }, i.prototype.Hb = function(I) {
            var z = this;
            return Object.keys(I).forEach(function(ye) {
              var _e = Qi(z.Qa, ye);
              _e !== 0 && z.xb(I[ye], _e);
            }), !0;
          }, i.prototype.Gb = function(I) {
            for (var z = 0; z < I.length; z += 1) this.xb(I[z], z + 1);
            return !0;
          }, i.prototype.reset = function() {
            return this.freemem(), cs(this.Qa) === 0 && fs(this.Qa) === 0;
          }, i.prototype.freemem = function() {
            for (var I; (I = this.mb.pop()) !== void 0; ) Ar(I);
          }, i.prototype.Ya = function() {
            this.freemem();
            var I = us(this.Qa) === 0;
            return delete this.db.gb[this.Qa], this.Qa = 0, I;
          }, d.prototype.next = function() {
            if (this.fb === null) return { done: !0 };
            if (this.$a !== null && (this.$a.Ya(), this.$a = null), !this.db.db) throw this.ob(), Error("Database closed");
            var I = jr(), z = wr(4);
            qt(N), qt(z);
            try {
              this.db.handleError(Fn(this.db.db, this.lb, -1, N, z)), this.lb = Ct(z, "i32");
              var ye = Ct(N, "i32");
              return ye === 0 ? (this.ob(), { done: !0 }) : (this.$a = new i(ye, this.db), this.db.gb[ye] = this.$a, { value: this.$a, done: !1 });
            } catch (_e) {
              throw this.sb = tt(this.lb), this.ob(), _e;
            } finally {
              Fr(I);
            }
          }, d.prototype.ob = function() {
            Ar(this.fb), this.fb = null;
          }, d.prototype.Qb = function() {
            return this.sb !== null ? this.sb : tt(this.lb);
          }, typeof Symbol == "function" && typeof Symbol.iterator == "symbol" && (d.prototype[Symbol.iterator] = function() {
            return this;
          }), w.prototype.run = function(I, z) {
            if (!this.db) throw "Database closed";
            if (z) {
              I = this.tb(I, z);
              try {
                I.step();
              } finally {
                I.Ya();
              }
            } else this.handleError(Pe(this.db, I, 0, 0, N));
            return this;
          }, w.prototype.exec = function(I, z, ye) {
            if (!this.db) throw "Database closed";
            var _e = null, qe = null, Je = null;
            try {
              Je = qe = Ze(I);
              var Ht = wr(4);
              for (I = []; Ct(Je, "i8") !== 0; ) {
                qt(N), qt(Ht), this.handleError(Fn(this.db, Je, -1, N, Ht));
                var Bt = Ct(
                  N,
                  "i32"
                );
                if (Je = Ct(Ht, "i32"), Bt !== 0) {
                  var Ut = null;
                  for (_e = new i(Bt, this), z != null && _e.bind(z); _e.step(); ) Ut === null && (Ut = { columns: _e.qb(), values: [] }, I.push(Ut)), Ut.values.push(_e.get(null, ye));
                  _e.Ya();
                }
              }
              return I;
            } catch (Kt) {
              throw _e && _e.Ya(), Kt;
            } finally {
              qe && Ar(qe);
            }
          }, w.prototype.Mb = function(I, z, ye, _e, qe) {
            typeof z == "function" && (_e = ye, ye = z, z = void 0), I = this.tb(I, z);
            try {
              for (; I.step(); ) ye(I.zb(null, qe));
            } finally {
              I.Ya();
            }
            if (typeof _e == "function") return _e();
          }, w.prototype.tb = function(I, z) {
            if (qt(N), this.handleError(vt(this.db, I, -1, N, 0)), I = Ct(N, "i32"), I === 0) throw "Nothing to prepare";
            var ye = new i(I, this);
            return z != null && ye.bind(z), this.gb[I] = ye;
          }, w.prototype.Ub = function(I) {
            return new d(I, this);
          }, w.prototype.Nb = function() {
            Object.values(this.gb).forEach(function(z) {
              z.Ya();
            }), Object.values(this.Sa).forEach(Ve), this.Sa = {}, this.handleError(Xe(this.db));
            var I = L(this.filename);
            return this.handleError(Ne(this.filename, N)), this.db = Ct(N, "i32"), Hn(this.db), I;
          }, w.prototype.close = function() {
            this.db !== null && (Object.values(this.gb).forEach(function(I) {
              I.Ya();
            }), Object.values(this.Sa).forEach(Ve), this.Sa = {}, this.Za && (Ve(this.Za), this.Za = void 0), this.handleError(Xe(this.db)), Oe("/" + this.filename), this.db = null);
          }, w.prototype.handleError = function(I) {
            if (I === 0) return null;
            throw I = es(this.db), Error(I);
          }, w.prototype.Rb = function() {
            return nt(this.db);
          }, w.prototype.Kb = function(I, z) {
            Object.prototype.hasOwnProperty.call(this.Sa, I) && (Ve(this.Sa[I]), delete this.Sa[I]);
            var ye = st(function(_e, qe, Je) {
              qe = r(qe, Je);
              try {
                var Ht = z.apply(null, qe);
              } catch (Bt) {
                Wr(_e, Bt, -1);
                return;
              }
              e(_e, Ht);
            }, "viii");
            return this.Sa[I] = ye, this.handleError(Wn(
              this.db,
              I,
              z.length,
              1,
              0,
              ye,
              0,
              0,
              0
            )), this;
          }, w.prototype.Jb = function(I, z) {
            var ye = z.init || function() {
              return null;
            }, _e = z.finalize || function(Ut) {
              return Ut;
            }, qe = z.step;
            if (!qe) throw "An aggregate function must have a step function in " + I;
            var Je = {};
            Object.hasOwnProperty.call(this.Sa, I) && (Ve(this.Sa[I]), delete this.Sa[I]), z = I + "__finalize", Object.hasOwnProperty.call(this.Sa, z) && (Ve(this.Sa[z]), delete this.Sa[z]);
            var Ht = st(function(Ut, Kt, Zr) {
              var gr = zn(Ut, 1);
              Object.hasOwnProperty.call(Je, gr) || (Je[gr] = ye()), Kt = r(Kt, Zr), Kt = [Je[gr]].concat(Kt);
              try {
                Je[gr] = qe.apply(null, Kt);
              } catch (ws) {
                delete Je[gr], Wr(Ut, ws, -1);
              }
            }, "viii"), Bt = st(function(Ut) {
              var Kt = zn(Ut, 1);
              try {
                var Zr = _e(Je[Kt]);
              } catch (gr) {
                delete Je[Kt], Wr(Ut, gr, -1);
                return;
              }
              e(Ut, Zr), delete Je[Kt];
            }, "vi");
            return this.Sa[I] = Ht, this.Sa[z] = Bt, this.handleError(Wn(this.db, I, qe.length - 1, 1, 0, 0, Ht, Bt, 0)), this;
          }, w.prototype.Zb = function(I) {
            return this.Za && (Kn(this.db, 0, 0), Ve(this.Za), this.Za = void 0), I ? (this.Za = st(function(z, ye, _e, qe, Je) {
              switch (ye) {
                case 18:
                  z = "insert";
                  break;
                case 23:
                  z = "update";
                  break;
                case 9:
                  z = "delete";
                  break;
                default:
                  throw "unknown operationCode in updateHook callback: " + ye;
              }
              if (_e = tt(_e), qe = tt(qe), Je > Number.MAX_SAFE_INTEGER) throw "rowId too big to fit inside a Number";
              I(z, _e, qe, Number(Je));
            }, "viiiij"), Kn(this.db, this.Za, 0), this) : this;
          }, i.prototype.bind = i.prototype.bind, i.prototype.step = i.prototype.step, i.prototype.get = i.prototype.get, i.prototype.getColumnNames = i.prototype.qb, i.prototype.getAsObject = i.prototype.zb, i.prototype.getSQL = i.prototype.Sb, i.prototype.getNormalizedSQL = i.prototype.Pb, i.prototype.run = i.prototype.run, i.prototype.reset = i.prototype.reset, i.prototype.freemem = i.prototype.freemem, i.prototype.free = i.prototype.Ya, d.prototype.next = d.prototype.next, d.prototype.getRemainingSQL = d.prototype.Qb, w.prototype.run = w.prototype.run, w.prototype.exec = w.prototype.exec, w.prototype.each = w.prototype.Mb, w.prototype.prepare = w.prototype.tb, w.prototype.iterateStatements = w.prototype.Ub, w.prototype.export = w.prototype.Nb, w.prototype.close = w.prototype.close, w.prototype.handleError = w.prototype.handleError, w.prototype.getRowsModified = w.prototype.Rb, w.prototype.create_function = w.prototype.Kb, w.prototype.create_aggregate = w.prototype.Jb, w.prototype.updateHook = w.prototype.Zb, u.Database = w;
        };
        var k = "./this.program", Y = (e, r) => {
          throw r;
        }, Q = globalThis.document?.currentScript?.src;
        typeof __filename < "u" ? Q = __filename : T && (Q = self.location.href);
        var Z = "", q, D;
        if (A) {
          var X = Ts;
          Z = __dirname + "/", D = (e) => (e = te(e) ? new URL(e) : e, X.readFileSync(e)), q = async (e) => (e = te(e) ? new URL(e) : e, X.readFileSync(e, void 0)), 1 < process.argv.length && (k = process.argv[1].replace(/\\/g, "/")), process.argv.slice(2), l.exports = u, Y = (e, r) => {
            throw process.exitCode = e, r;
          };
        } else if (O || T) {
          try {
            Z = new URL(".", Q).href;
          } catch {
          }
          T && (D = (e) => {
            var r = new XMLHttpRequest();
            return r.open("GET", e, !1), r.responseType = "arraybuffer", r.send(null), new Uint8Array(r.response);
          }), q = async (e) => {
            if (te(e)) return new Promise((i, d) => {
              var w = new XMLHttpRequest();
              w.open("GET", e, !0), w.responseType = "arraybuffer", w.onload = () => {
                w.status == 200 || w.status == 0 && w.response ? i(w.response) : d(w.status);
              }, w.onerror = d, w.send(null);
            });
            var r = await fetch(e, { credentials: "same-origin" });
            if (r.ok) return r.arrayBuffer();
            throw Error(r.status + " : " + r.url);
          };
        }
        var V = console.log.bind(console), v = console.error.bind(console), x, M = !1, U, te = (e) => e.startsWith("file://"), H, ee, Ie, Se, se, Ge, ae, Ye;
        function at() {
          var e = qr.buffer;
          H = new Int8Array(e), Ie = new Int16Array(e), ee = new Uint8Array(e), Se = new Int32Array(e), se = new Uint32Array(e), Ge = new Float32Array(e), ae = new Float64Array(e), Ye = new BigInt64Array(e), new BigUint64Array(e);
        }
        function _t(e) {
          throw u.onAbort?.(e), e = "Aborted(" + e + ")", v(e), M = !0, new WebAssembly.RuntimeError(e + ". Build with -sASSERTIONS for more info.");
        }
        var Xt;
        async function lt(e) {
          if (!x) try {
            var r = await q(e);
            return new Uint8Array(r);
          } catch {
          }
          if (e == Xt && x) e = new Uint8Array(x);
          else if (D) e = D(e);
          else throw "both async and sync fetching of the wasm failed";
          return e;
        }
        async function rr(e, r) {
          try {
            var i = await lt(e);
            return await WebAssembly.instantiate(i, r);
          } catch (d) {
            v(`failed to asynchronously prepare wasm: ${d}`), _t(d);
          }
        }
        async function It(e) {
          var r = Xt;
          if (!x && !te(r) && !A) try {
            var i = fetch(r, { credentials: "same-origin" });
            return await WebAssembly.instantiateStreaming(i, e);
          } catch (d) {
            v(`wasm streaming compile failed: ${d}`), v("falling back to ArrayBuffer instantiation");
          }
          return rr(r, e);
        }
        class bt {
          name = "ExitStatus";
          constructor(r) {
            this.message = `Program terminated with exit(${r})`, this.status = r;
          }
        }
        var Ue = (e) => {
          for (; 0 < e.length; ) e.shift()(u);
        }, yt = [], yr = [], Tr = () => {
          var e = u.preRun.shift();
          yr.push(e);
        }, At = 0, Lt = null;
        function Ct(e, r = "i8") {
          switch (r.endsWith("*") && (r = "*"), r) {
            case "i1":
              return H[e];
            case "i8":
              return H[e];
            case "i16":
              return Ie[e >> 1];
            case "i32":
              return Se[e >> 2];
            case "i64":
              return Ye[e >> 3];
            case "float":
              return Ge[e >> 2];
            case "double":
              return ae[e >> 3];
            case "*":
              return se[e >> 2];
            default:
              _t(`invalid type for getValue: ${r}`);
          }
        }
        var Pt = !0;
        function qt(e) {
          var r = "i32";
          switch (r.endsWith("*") && (r = "*"), r) {
            case "i1":
              H[e] = 0;
              break;
            case "i8":
              H[e] = 0;
              break;
            case "i16":
              Ie[e >> 1] = 0;
              break;
            case "i32":
              Se[e >> 2] = 0;
              break;
            case "i64":
              Ye[e >> 3] = BigInt(0);
              break;
            case "float":
              Ge[e >> 2] = 0;
              break;
            case "double":
              ae[e >> 3] = 0;
              break;
            case "*":
              se[e >> 2] = 0;
              break;
            default:
              _t(`invalid type for setValue: ${r}`);
          }
        }
        var nr = new TextDecoder(), xr = (e, r, i, d) => {
          if (i = r + i, d) return i;
          for (; e[r] && !(r >= i); ) ++r;
          return r;
        }, tt = (e, r, i) => e ? nr.decode(ee.subarray(e, xr(ee, e, r, i))) : "", R = (e, r) => {
          for (var i = 0, d = e.length - 1; 0 <= d; d--) {
            var w = e[d];
            w === "." ? e.splice(d, 1) : w === ".." ? (e.splice(d, 1), i++) : i && (e.splice(d, 1), i--);
          }
          if (r) for (; i; i--) e.unshift("..");
          return e;
        }, $ = (e) => {
          var r = e.charAt(0) === "/", i = e.slice(-1) === "/";
          return (e = R(e.split("/").filter((d) => !!d), !r).join("/")) || r || (e = "."), e && i && (e += "/"), (r ? "/" : "") + e;
        }, fe = (e) => {
          var r = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec(e).slice(1);
          return e = r[0], r = r[1], !e && !r ? "." : (r &&= r.slice(0, -1), e + r);
        }, be = (e) => e && e.match(/([^\/]+|\/)\/*$/)[1], ce = () => {
          if (A) {
            var e = Rs;
            return (r) => e.randomFillSync(r);
          }
          return (r) => crypto.getRandomValues(r);
        }, $e = (e) => {
          ($e = ce())(e);
        }, kt = (...e) => {
          for (var r = "", i = !1, d = e.length - 1; -1 <= d && !i; d--) {
            if (i = 0 <= d ? e[d] : "/", typeof i != "string") throw new TypeError("Arguments to path.resolve must be strings");
            if (!i) return "";
            r = i + "/" + r, i = i.charAt(0) === "/";
          }
          return r = R(r.split("/").filter((w) => !!w), !i).join("/"), (i ? "/" : "") + r || ".";
        }, Et = (e) => {
          var r = xr(e, 0);
          return nr.decode(e.buffer ? e.subarray(0, r) : new Uint8Array(e.slice(0, r)));
        }, Mt = [], Nt = (e) => {
          for (var r = 0, i = 0; i < e.length; ++i) {
            var d = e.charCodeAt(i);
            127 >= d ? r++ : 2047 >= d ? r += 2 : 55296 <= d && 57343 >= d ? (r += 4, ++i) : r += 3;
          }
          return r;
        }, wt = (e, r, i, d) => {
          if (!(0 < d)) return 0;
          var w = i;
          d = i + d - 1;
          for (var N = 0; N < e.length; ++N) {
            var W = e.codePointAt(N);
            if (127 >= W) {
              if (i >= d) break;
              r[i++] = W;
            } else if (2047 >= W) {
              if (i + 1 >= d) break;
              r[i++] = 192 | W >> 6, r[i++] = 128 | W & 63;
            } else if (65535 >= W) {
              if (i + 2 >= d) break;
              r[i++] = 224 | W >> 12, r[i++] = 128 | W >> 6 & 63, r[i++] = 128 | W & 63;
            } else {
              if (i + 3 >= d) break;
              r[i++] = 240 | W >> 18, r[i++] = 128 | W >> 12 & 63, r[i++] = 128 | W >> 6 & 63, r[i++] = 128 | W & 63, N++;
            }
          }
          return r[i] = 0, i - w;
        }, ir = [];
        function Wt(e, r) {
          ir[e] = { input: [], output: [], eb: r }, G(e, sr);
        }
        var sr = { open(e) {
          var r = ir[e.node.rdev];
          if (!r) throw new J(43);
          e.tty = r, e.seekable = !1;
        }, close(e) {
          e.tty.eb.fsync(e.tty);
        }, fsync(e) {
          e.tty.eb.fsync(e.tty);
        }, read(e, r, i, d) {
          if (!e.tty || !e.tty.eb.Bb) throw new J(60);
          for (var w = 0, N = 0; N < d; N++) {
            try {
              var W = e.tty.eb.Bb(e.tty);
            } catch {
              throw new J(29);
            }
            if (W === void 0 && w === 0) throw new J(6);
            if (W == null) break;
            w++, r[i + N] = W;
          }
          return w && (e.node.atime = Date.now()), w;
        }, write(e, r, i, d) {
          if (!e.tty || !e.tty.eb.ub) throw new J(60);
          try {
            for (var w = 0; w < d; w++) e.tty.eb.ub(e.tty, r[i + w]);
          } catch {
            throw new J(29);
          }
          return d && (e.node.mtime = e.node.ctime = Date.now()), w;
        } }, it = { Bb() {
          e: {
            if (!Mt.length) {
              var e = null;
              if (A) {
                var r = Buffer.alloc(256), i = 0, d = process.stdin.fd;
                try {
                  i = X.readSync(d, r, 0, 256);
                } catch (w) {
                  if (w.toString().includes("EOF")) i = 0;
                  else throw w;
                }
                0 < i && (e = r.slice(0, i).toString("utf-8"));
              } else globalThis.window?.prompt && (e = window.prompt("Input: "), e !== null && (e += `
`));
              if (!e) {
                e = null;
                break e;
              }
              r = Array(Nt(e) + 1), e = wt(e, r, 0, r.length), r.length = e, Mt = r;
            }
            e = Mt.shift();
          }
          return e;
        }, ub(e, r) {
          r === null || r === 10 ? (V(Et(e.output)), e.output = []) : r != 0 && e.output.push(r);
        }, fsync(e) {
          0 < e.output?.length && (V(Et(e.output)), e.output = []);
        }, hc() {
          return { bc: 25856, dc: 5, ac: 191, cc: 35387, $b: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
        }, ic() {
          return 0;
        }, jc() {
          return [24, 80];
        } }, ze = { ub(e, r) {
          r === null || r === 10 ? (v(Et(e.output)), e.output = []) : r != 0 && e.output.push(r);
        }, fsync(e) {
          0 < e.output?.length && (v(Et(e.output)), e.output = []);
        } }, me = { Wa: null, Xa() {
          return me.createNode(null, "/", 16895, 0);
        }, createNode(e, r, i, d) {
          if ((i & 61440) === 24576 || (i & 61440) === 4096) throw new J(63);
          return me.Wa || (me.Wa = { dir: { node: { Ta: me.La.Ta, Ua: me.La.Ua, lookup: me.La.lookup, ib: me.La.ib, rename: me.La.rename, unlink: me.La.unlink, rmdir: me.La.rmdir, readdir: me.La.readdir, symlink: me.La.symlink }, stream: { Va: me.Ma.Va } }, file: { node: { Ta: me.La.Ta, Ua: me.La.Ua }, stream: { Va: me.Ma.Va, read: me.Ma.read, write: me.Ma.write, jb: me.Ma.jb, kb: me.Ma.kb } }, link: { node: { Ta: me.La.Ta, Ua: me.La.Ua, readlink: me.La.readlink }, stream: {} }, yb: { node: { Ta: me.La.Ta, Ua: me.La.Ua }, stream: j } }), i = Br(e, r, i, d), Qe(i.mode) ? (i.La = me.Wa.dir.node, i.Ma = me.Wa.dir.stream, i.Na = {}) : (i.mode & 61440) === 32768 ? (i.La = me.Wa.file.node, i.Ma = me.Wa.file.stream, i.Ra = 0, i.Na = null) : (i.mode & 61440) === 40960 ? (i.La = me.Wa.link.node, i.Ma = me.Wa.link.stream) : (i.mode & 61440) === 8192 && (i.La = me.Wa.yb.node, i.Ma = me.Wa.yb.stream), i.atime = i.mtime = i.ctime = Date.now(), e && (e.Na[r] = i, e.atime = e.mtime = e.ctime = i.atime), i;
        }, fc(e) {
          return e.Na ? e.Na.subarray ? e.Na.subarray(0, e.Ra) : new Uint8Array(e.Na) : new Uint8Array(0);
        }, La: {
          Ta(e) {
            var r = {};
            return r.dev = (e.mode & 61440) === 8192 ? e.id : 1, r.ino = e.id, r.mode = e.mode, r.nlink = 1, r.uid = 0, r.gid = 0, r.rdev = e.rdev, Qe(e.mode) ? r.size = 4096 : (e.mode & 61440) === 32768 ? r.size = e.Ra : (e.mode & 61440) === 40960 ? r.size = e.link.length : r.size = 0, r.atime = new Date(e.atime), r.mtime = new Date(e.mtime), r.ctime = new Date(e.ctime), r.blksize = 4096, r.blocks = Math.ceil(r.size / r.blksize), r;
          },
          Ua(e, r) {
            for (var i of ["mode", "atime", "mtime", "ctime"]) r[i] != null && (e[i] = r[i]);
            r.size !== void 0 && (r = r.size, e.Ra != r && (r == 0 ? (e.Na = null, e.Ra = 0) : (i = e.Na, e.Na = new Uint8Array(r), i && e.Na.set(i.subarray(0, Math.min(r, e.Ra))), e.Ra = r)));
          },
          lookup() {
            throw me.nb || (me.nb = new J(44), me.nb.stack = "<generic error, no stack>"), me.nb;
          },
          ib(e, r, i, d) {
            return me.createNode(e, r, i, d);
          },
          rename(e, r, i) {
            try {
              var d = Zt(r, i);
            } catch {
            }
            if (d) {
              if (Qe(e.mode)) for (var w in d.Na) throw new J(55);
              br(d);
            }
            delete e.parent.Na[e.name], r.Na[i] = e, e.name = i, r.ctime = r.mtime = e.parent.ctime = e.parent.mtime = Date.now();
          },
          unlink(e, r) {
            delete e.Na[r], e.ctime = e.mtime = Date.now();
          },
          rmdir(e, r) {
            var i = Zt(e, r), d;
            for (d in i.Na) throw new J(55);
            delete e.Na[r], e.ctime = e.mtime = Date.now();
          },
          readdir(e) {
            return [".", "..", ...Object.keys(e.Na)];
          },
          symlink(e, r, i) {
            return e = me.createNode(e, r, 41471, 0), e.link = i, e;
          },
          readlink(e) {
            if ((e.mode & 61440) !== 40960) throw new J(28);
            return e.link;
          }
        }, Ma: { read(e, r, i, d, w) {
          var N = e.node.Na;
          if (w >= e.node.Ra) return 0;
          if (e = Math.min(e.node.Ra - w, d), 8 < e && N.subarray) r.set(N.subarray(w, w + e), i);
          else for (d = 0; d < e; d++) r[i + d] = N[w + d];
          return e;
        }, write(e, r, i, d, w, N) {
          if (r.buffer === H.buffer && (N = !1), !d) return 0;
          if (e = e.node, e.mtime = e.ctime = Date.now(), r.subarray && (!e.Na || e.Na.subarray)) {
            if (N) return e.Na = r.subarray(i, i + d), e.Ra = d;
            if (e.Ra === 0 && w === 0) return e.Na = r.slice(i, i + d), e.Ra = d;
            if (w + d <= e.Ra) return e.Na.set(r.subarray(i, i + d), w), d;
          }
          N = w + d;
          var W = e.Na ? e.Na.length : 0;
          if (W >= N || (N = Math.max(N, W * (1048576 > W ? 2 : 1.125) >>> 0), W != 0 && (N = Math.max(N, 256)), W = e.Na, e.Na = new Uint8Array(N), 0 < e.Ra && e.Na.set(W.subarray(0, e.Ra), 0)), e.Na.subarray && r.subarray) e.Na.set(r.subarray(i, i + d), w);
          else for (N = 0; N < d; N++) e.Na[w + N] = r[i + N];
          return e.Ra = Math.max(e.Ra, w + d), d;
        }, Va(e, r, i) {
          if (i === 1 ? r += e.position : i === 2 && (e.node.mode & 61440) === 32768 && (r += e.node.Ra), 0 > r) throw new J(28);
          return r;
        }, jb(e, r, i, d, w) {
          if ((e.node.mode & 61440) !== 32768) throw new J(43);
          if (e = e.node.Na, w & 2 || !e || e.buffer !== H.buffer) {
            w = !0, d = 65536 * Math.ceil(r / 65536);
            var N = Pn(65536, d);
            if (N && ee.fill(0, N, N + d), d = N, !d) throw new J(48);
            e && ((0 < i || i + r < e.length) && (e.subarray ? e = e.subarray(i, i + r) : e = Array.prototype.slice.call(e, i, i + r)), H.set(e, d));
          } else w = !1, d = e.byteOffset;
          return { Xb: d, Eb: w };
        }, kb(e, r, i, d) {
          return me.Ma.write(e, r, 0, d, i, !1), 0;
        } } }, Ot = (e, r) => {
          var i = 0;
          return e && (i |= 365), r && (i |= 146), i;
        }, St = null, $t = {}, xt = [], Rt = 1, gt = null, Jt = !1, fr = !0, J = class {
          name = "ErrnoError";
          constructor(e) {
            this.Pa = e;
          }
        }, Or = class {
          hb = {};
          node = null;
          get flags() {
            return this.hb.flags;
          }
          set flags(e) {
            this.hb.flags = e;
          }
          get position() {
            return this.hb.position;
          }
          set position(e) {
            this.hb.position = e;
          }
        }, zt = class {
          La = {};
          Ma = {};
          bb = null;
          constructor(e, r, i, d) {
            e ||= this, this.parent = e, this.Xa = e.Xa, this.id = Rt++, this.name = r, this.mode = i, this.rdev = d, this.atime = this.mtime = this.ctime = Date.now();
          }
          get read() {
            return (this.mode & 365) === 365;
          }
          set read(e) {
            e ? this.mode |= 365 : this.mode &= -366;
          }
          get write() {
            return (this.mode & 146) === 146;
          }
          set write(e) {
            e ? this.mode |= 146 : this.mode &= -147;
          }
        };
        function ht(e, r = {}) {
          if (!e) throw new J(44);
          r.pb ?? (r.pb = !0), e.charAt(0) === "/" || (e = "//" + e);
          var i = 0;
          e: for (; 40 > i; i++) {
            e = e.split("/").filter((Ne) => !!Ne);
            for (var d = St, w = "/", N = 0; N < e.length; N++) {
              var W = N === e.length - 1;
              if (W && r.parent) break;
              if (e[N] !== ".") if (e[N] === "..") if (w = fe(w), d === d.parent) {
                e = w + "/" + e.slice(N + 1).join("/"), i--;
                continue e;
              } else d = d.parent;
              else {
                w = $(w + "/" + e[N]);
                try {
                  d = Zt(d, e[N]);
                } catch (Ne) {
                  if (Ne?.Pa === 44 && W && r.Wb) return { path: w };
                  throw Ne;
                }
                if (!d.bb || W && !r.pb || (d = d.bb.root), (d.mode & 61440) === 40960 && (!W || r.ab)) {
                  if (!d.La.readlink) throw new J(52);
                  d = d.La.readlink(d), d.charAt(0) === "/" || (d = fe(w) + "/" + d), e = d + "/" + e.slice(N + 1).join("/");
                  continue e;
                }
              }
            }
            return { path: w, node: d };
          }
          throw new J(32);
        }
        function Qt(e) {
          for (var r; ; ) {
            if (e === e.parent) return e = e.Xa.Db, r ? e[e.length - 1] !== "/" ? `${e}/${r}` : e + r : e;
            r = r ? `${e.name}/${r}` : e.name, e = e.parent;
          }
        }
        function _r(e, r) {
          for (var i = 0, d = 0; d < r.length; d++) i = (i << 5) - i + r.charCodeAt(d) | 0;
          return (e + i >>> 0) % gt.length;
        }
        function br(e) {
          var r = _r(e.parent.id, e.name);
          if (gt[r] === e) gt[r] = e.cb;
          else for (r = gt[r]; r; ) {
            if (r.cb === e) {
              r.cb = e.cb;
              break;
            }
            r = r.cb;
          }
        }
        function Zt(e, r) {
          var i = Qe(e.mode) ? (i = or(e, "x")) ? i : e.La.lookup ? 0 : 2 : 54;
          if (i) throw new J(i);
          for (i = gt[_r(e.id, r)]; i; i = i.cb) {
            var d = i.name;
            if (i.parent.id === e.id && d === r) return i;
          }
          return e.La.lookup(e, r);
        }
        function Br(e, r, i, d) {
          return e = new zt(e, r, i, d), r = _r(e.parent.id, e.name), e.cb = gt[r], gt[r] = e;
        }
        function Qe(e) {
          return (e & 61440) === 16384;
        }
        function or(e, r) {
          return fr ? 0 : r.includes("r") && !(e.mode & 292) || r.includes("w") && !(e.mode & 146) || r.includes("x") && !(e.mode & 73) ? 2 : 0;
        }
        function s(e, r) {
          if (!Qe(e.mode)) return 54;
          try {
            return Zt(e, r), 20;
          } catch {
          }
          return or(e, "wx");
        }
        function f(e, r, i) {
          try {
            var d = Zt(e, r);
          } catch (w) {
            return w.Pa;
          }
          if (e = or(e, "wx")) return e;
          if (i) {
            if (!Qe(d.mode)) return 54;
            if (d === d.parent || Qt(d) === "/") return 10;
          } else if (Qe(d.mode)) return 31;
          return 0;
        }
        function o(e) {
          if (!e) throw new J(63);
          return e;
        }
        function t(e) {
          if (e = xt[e], !e) throw new J(8);
          return e;
        }
        function h(e, r = -1) {
          if (e = Object.assign(new Or(), e), r == -1) e: {
            for (r = 0; 4096 >= r; r++) if (!xt[r]) break e;
            throw new J(33);
          }
          return e.fd = r, xt[r] = e;
        }
        function E(e, r = -1) {
          return e = h(e, r), e.Ma?.ec?.(e), e;
        }
        function S(e, r, i) {
          var d = e?.Ma.Ua;
          e = d ? e : r, d ??= r.La.Ua, o(d), d(e, i);
        }
        var j = { open(e) {
          e.Ma = $t[e.node.rdev].Ma, e.Ma.open?.(e);
        }, Va() {
          throw new J(70);
        } };
        function G(e, r) {
          $t[e] = { Ma: r };
        }
        function de(e, r) {
          var i = r === "/";
          if (i && St) throw new J(10);
          if (!i && r) {
            var d = ht(r, { pb: !1 });
            if (r = d.path, d = d.node, d.bb) throw new J(10);
            if (!Qe(d.mode)) throw new J(54);
          }
          r = { type: e, kc: {}, Db: r, Vb: [] }, e = e.Xa(r), e.Xa = r, r.root = e, i ? St = e : d && (d.bb = r, d.Xa && d.Xa.Vb.push(r));
        }
        function ne(e, r, i) {
          var d = ht(e, { parent: !0 }).node;
          if (e = be(e), !e) throw new J(28);
          if (e === "." || e === "..") throw new J(20);
          var w = s(d, e);
          if (w) throw new J(w);
          if (!d.La.ib) throw new J(63);
          return d.La.ib(d, e, r, i);
        }
        function He(e, r = 438) {
          return ne(e, r & 4095 | 32768, 0);
        }
        function re(e, r = 511) {
          return ne(e, r & 1023 | 16384, 0);
        }
        function we(e, r, i) {
          typeof i > "u" && (i = r, r = 438), ne(e, r | 8192, i);
        }
        function Ee(e, r) {
          if (!kt(e)) throw new J(44);
          var i = ht(r, { parent: !0 }).node;
          if (!i) throw new J(44);
          r = be(r);
          var d = s(i, r);
          if (d) throw new J(d);
          if (!i.La.symlink) throw new J(63);
          i.La.symlink(i, r, e);
        }
        function Ce(e) {
          var r = ht(e, { parent: !0 }).node;
          e = be(e);
          var i = Zt(r, e), d = f(r, e, !0);
          if (d) throw new J(d);
          if (!r.La.rmdir) throw new J(63);
          if (i.bb) throw new J(10);
          r.La.rmdir(r, e), br(i);
        }
        function Oe(e) {
          var r = ht(e, { parent: !0 }).node;
          if (!r) throw new J(44);
          e = be(e);
          var i = Zt(r, e), d = f(r, e, !1);
          if (d) throw new J(d);
          if (!r.La.unlink) throw new J(63);
          if (i.bb) throw new J(10);
          r.La.unlink(r, e), br(i);
        }
        function ge(e, r) {
          return e = ht(e, { ab: !r }).node, o(e.La.Ta)(e);
        }
        function Te(e, r, i, d) {
          S(e, r, { mode: i & 4095 | r.mode & -4096, ctime: Date.now(), Lb: d });
        }
        function ve(e, r) {
          e = typeof e == "string" ? ht(e, { ab: !0 }).node : e, Te(null, e, r);
        }
        function ue(e, r, i) {
          if (Qe(r.mode)) throw new J(31);
          if ((r.mode & 61440) !== 32768) throw new J(28);
          var d = or(r, "w");
          if (d) throw new J(d);
          S(e, r, { size: i, timestamp: Date.now() });
        }
        function pe(e, r, i = 438) {
          if (e === "") throw new J(44);
          if (typeof r == "string") {
            var d = { r: 0, "r+": 2, w: 577, "w+": 578, a: 1089, "a+": 1090 }[r];
            if (typeof d > "u") throw Error(`Unknown file open mode: ${r}`);
            r = d;
          }
          if (i = r & 64 ? i & 4095 | 32768 : 0, typeof e == "object") d = e;
          else {
            var w = e.endsWith("/"), N = ht(e, { ab: !(r & 131072), Wb: !0 });
            d = N.node, e = N.path;
          }
          if (N = !1, r & 64) if (d) {
            if (r & 128) throw new J(20);
          } else {
            if (w) throw new J(31);
            d = ne(e, i | 511, 0), N = !0;
          }
          if (!d) throw new J(44);
          if ((d.mode & 61440) === 8192 && (r &= -513), r & 65536 && !Qe(d.mode)) throw new J(54);
          if (!N && (d ? (d.mode & 61440) === 40960 ? w = 32 : (w = ["r", "w", "rw"][r & 3], r & 512 && (w += "w"), w = Qe(d.mode) && (w !== "r" || r & 576) ? 31 : or(d, w)) : w = 44, w)) throw new J(w);
          return r & 512 && !N && (w = d, w = typeof w == "string" ? ht(w, { ab: !0 }).node : w, ue(null, w, 0)), r = h({ node: d, path: Qt(d), flags: r & -131713, seekable: !0, position: 0, Ma: d.Ma, Yb: [], error: !1 }), r.Ma.open && r.Ma.open(r), N && ve(d, i & 511), r;
        }
        function oe(e) {
          if (e.fd === null) throw new J(8);
          e.rb && (e.rb = null);
          try {
            e.Ma.close && e.Ma.close(e);
          } catch (r) {
            throw r;
          } finally {
            xt[e.fd] = null;
          }
          e.fd = null;
        }
        function le(e, r, i) {
          if (e.fd === null) throw new J(8);
          if (!e.seekable || !e.Ma.Va) throw new J(70);
          if (i != 0 && i != 1 && i != 2) throw new J(28);
          e.position = e.Ma.Va(e, r, i), e.Yb = [];
        }
        function he(e, r, i, d, w) {
          if (0 > d || 0 > w) throw new J(28);
          if (e.fd === null) throw new J(8);
          if ((e.flags & 2097155) === 1) throw new J(8);
          if (Qe(e.node.mode)) throw new J(31);
          if (!e.Ma.read) throw new J(28);
          var N = typeof w < "u";
          if (!N) w = e.position;
          else if (!e.seekable) throw new J(70);
          return r = e.Ma.read(e, r, i, d, w), N || (e.position += r), r;
        }
        function ie(e, r, i, d, w) {
          if (0 > d || 0 > w) throw new J(28);
          if (e.fd === null) throw new J(8);
          if ((e.flags & 2097155) === 0) throw new J(8);
          if (Qe(e.node.mode)) throw new J(31);
          if (!e.Ma.write) throw new J(28);
          e.seekable && e.flags & 1024 && le(e, 0, 2);
          var N = typeof w < "u";
          if (!N) w = e.position;
          else if (!e.seekable) throw new J(70);
          return r = e.Ma.write(e, r, i, d, w, void 0), N || (e.position += r), r;
        }
        function L(e) {
          var r = r || 0;
          r = pe(e, r), e = ge(e).size;
          var i = new Uint8Array(e);
          return he(r, i, 0, e, 0), oe(r), i;
        }
        function C(e, r, i) {
          e = $("/dev/" + e);
          var d = Ot(!!r, !!i);
          C.Cb ?? (C.Cb = 64);
          var w = C.Cb++ << 8 | 0;
          G(w, { open(N) {
            N.seekable = !1;
          }, close() {
            i?.buffer?.length && i(10);
          }, read(N, W, Ne, Xe) {
            for (var Pe = 0, nt = 0; nt < Xe; nt++) {
              try {
                var vt = r();
              } catch {
                throw new J(29);
              }
              if (vt === void 0 && Pe === 0) throw new J(6);
              if (vt == null) break;
              Pe++, W[Ne + nt] = vt;
            }
            return Pe && (N.node.atime = Date.now()), Pe;
          }, write(N, W, Ne, Xe) {
            for (var Pe = 0; Pe < Xe; Pe++) try {
              i(W[Ne + Pe]);
            } catch {
              throw new J(29);
            }
            return Xe && (N.node.mtime = N.node.ctime = Date.now()), Pe;
          } }), we(e, d, w);
        }
        var P = {};
        function B(e, r, i) {
          if (r.charAt(0) === "/") return r;
          if (e = e === -100 ? "/" : t(e).path, r.length == 0) {
            if (!i) throw new J(44);
            return e;
          }
          return e + "/" + r;
        }
        function F(e, r) {
          se[e >> 2] = r.dev, se[e + 4 >> 2] = r.mode, se[e + 8 >> 2] = r.nlink, se[e + 12 >> 2] = r.uid, se[e + 16 >> 2] = r.gid, se[e + 20 >> 2] = r.rdev, Ye[e + 24 >> 3] = BigInt(r.size), Se[e + 32 >> 2] = 4096, Se[e + 36 >> 2] = r.blocks;
          var i = r.atime.getTime(), d = r.mtime.getTime(), w = r.ctime.getTime();
          return Ye[e + 40 >> 3] = BigInt(Math.floor(i / 1e3)), se[e + 48 >> 2] = i % 1e3 * 1e6, Ye[e + 56 >> 3] = BigInt(Math.floor(d / 1e3)), se[e + 64 >> 2] = d % 1e3 * 1e6, Ye[e + 72 >> 3] = BigInt(Math.floor(w / 1e3)), se[e + 80 >> 2] = w % 1e3 * 1e6, Ye[e + 88 >> 3] = BigInt(r.ino), 0;
        }
        var K = void 0, xe = () => {
          var e = Se[+K >> 2];
          return K += 4, e;
        }, Ae = 0, Le = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335], De = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334], y = {}, Re = (e) => {
          U = e, Pt || 0 < Ae || (u.onExit?.(e), M = !0), Y(e, new bt(e));
        }, Ke = (e) => {
          if (!M) try {
            e();
          } catch (r) {
            r instanceof bt || r == "unwind" || Y(1, r);
          } finally {
            if (!(Pt || 0 < Ae)) try {
              U = e = U, Re(e);
            } catch (r) {
              r instanceof bt || r == "unwind" || Y(1, r);
            }
          }
        }, Fe = {}, Me = () => {
          if (!Be) {
            var e = { USER: "web_user", LOGNAME: "web_user", PATH: "/", PWD: "/", HOME: "/home/web_user", LANG: (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8", _: k || "./this.program" }, r;
            for (r in Fe) Fe[r] === void 0 ? delete e[r] : e[r] = Fe[r];
            var i = [];
            for (r in e) i.push(`${r}=${e[r]}`);
            Be = i;
          }
          return Be;
        }, Be, We = (e, r, i, d) => {
          var w = { string: (Pe) => {
            var nt = 0;
            if (Pe != null && Pe !== 0) {
              nt = Nt(Pe) + 1;
              var vt = wr(nt);
              wt(Pe, ee, vt, nt), nt = vt;
            }
            return nt;
          }, array: (Pe) => {
            var nt = wr(Pe.length);
            return H.set(Pe, nt), nt;
          } };
          e = u["_" + e];
          var N = [], W = 0;
          if (d) for (var Ne = 0; Ne < d.length; Ne++) {
            var Xe = w[i[Ne]];
            Xe ? (W === 0 && (W = jr()), N[Ne] = Xe(d[Ne])) : N[Ne] = d[Ne];
          }
          return i = e(...N), i = (function(Pe) {
            return W !== 0 && Fr(W), r === "string" ? tt(Pe) : r === "boolean" ? !!Pe : Pe;
          })(i);
        }, Ze = (e) => {
          var r = Nt(e) + 1, i = ct(r);
          return i && wt(e, ee, i, r), i;
        }, je, et = [], Ve = (e) => {
          je.delete(cr.get(e)), cr.set(e, null), et.push(e);
        }, rt = (e) => {
          const r = e.length;
          return [r % 128 | 128, r >> 7, ...e];
        }, ft = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 }, mt = (e) => rt(Array.from(e, (r) => ft[r])), st = (e, r) => {
          if (!je) {
            je = /* @__PURE__ */ new WeakMap();
            var i = cr.length;
            if (je) for (var d = 0; d < 0 + i; d++) {
              var w = cr.get(d);
              w && je.set(w, d);
            }
          }
          if (i = je.get(e) || 0) return i;
          i = et.length ? et.pop() : cr.grow(1);
          try {
            cr.set(i, e);
          } catch (N) {
            if (!(N instanceof TypeError)) throw N;
            r = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...rt([1, 96, ...mt(r.slice(1)), ...mt(r[0] === "v" ? "" : r[0])]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0), r = new WebAssembly.Module(r), r = new WebAssembly.Instance(r, { e: { f: e } }).exports.f, cr.set(i, r);
          }
          return je.set(e, i), i;
        };
        if (gt = Array(4096), de(me, "/"), re("/tmp"), re("/home"), re("/home/web_user"), (function() {
          re("/dev"), G(259, { read: () => 0, write: (d, w, N, W) => W, Va: () => 0 }), we("/dev/null", 259), Wt(1280, it), Wt(1536, ze), we("/dev/tty", 1280), we("/dev/tty1", 1536);
          var e = new Uint8Array(1024), r = 0, i = () => (r === 0 && ($e(e), r = e.byteLength), e[--r]);
          C("random", i), C("urandom", i), re("/dev/shm"), re("/dev/shm/tmp");
        })(), (function() {
          re("/proc");
          var e = re("/proc/self");
          re("/proc/self/fd"), de({ Xa() {
            var r = Br(e, "fd", 16895, 73);
            return r.Ma = { Va: me.Ma.Va }, r.La = { lookup(i, d) {
              i = +d;
              var w = t(i);
              return i = { parent: null, Xa: { Db: "fake" }, La: { readlink: () => w.path }, id: i + 1 }, i.parent = i;
            }, readdir() {
              return Array.from(xt.entries()).filter(([, i]) => i).map(([i]) => i.toString());
            } }, r;
          } }, "/proc/self/fd");
        })(), u.noExitRuntime && (Pt = u.noExitRuntime), u.print && (V = u.print), u.printErr && (v = u.printErr), u.wasmBinary && (x = u.wasmBinary), u.thisProgram && (k = u.thisProgram), u.preInit) for (typeof u.preInit == "function" && (u.preInit = [u.preInit]); 0 < u.preInit.length; ) u.preInit.shift()();
        u.stackSave = () => jr(), u.stackRestore = (e) => Fr(e), u.stackAlloc = (e) => wr(e), u.cwrap = (e, r, i, d) => {
          var w = !i || i.every((N) => N === "number" || N === "boolean");
          return r !== "string" && w && !d ? u["_" + e] : (...N) => We(e, r, i, N);
        }, u.addFunction = st, u.removeFunction = Ve, u.UTF8ToString = tt, u.stringToNewUTF8 = Ze, u.writeArrayToMemory = (e, r) => {
          H.set(e, r);
        };
        var ct, Ar, Pn, kn, Fr, wr, jr, qr, cr, Gi = {
          a: (e, r, i, d) => _t(`Assertion failed: ${tt(e)}, at: ` + [r ? tt(r) : "unknown filename", i, d ? tt(d) : "unknown function"]),
          i: function(e, r) {
            try {
              return e = tt(e), ve(e, r), 0;
            } catch (i) {
              if (typeof P > "u" || i.name !== "ErrnoError") throw i;
              return -i.Pa;
            }
          },
          L: function(e, r, i) {
            try {
              if (r = tt(r), r = B(e, r), i & -8) return -28;
              var d = ht(r, { ab: !0 }).node;
              return d ? (e = "", i & 4 && (e += "r"), i & 2 && (e += "w"), i & 1 && (e += "x"), e && or(d, e) ? -2 : 0) : -44;
            } catch (w) {
              if (typeof P > "u" || w.name !== "ErrnoError") throw w;
              return -w.Pa;
            }
          },
          j: function(e, r) {
            try {
              var i = t(e);
              return Te(i, i.node, r, !1), 0;
            } catch (d) {
              if (typeof P > "u" || d.name !== "ErrnoError") throw d;
              return -d.Pa;
            }
          },
          h: function(e) {
            try {
              var r = t(e);
              return S(r, r.node, { timestamp: Date.now(), Lb: !1 }), 0;
            } catch (i) {
              if (typeof P > "u" || i.name !== "ErrnoError") throw i;
              return -i.Pa;
            }
          },
          b: function(e, r, i) {
            K = i;
            try {
              var d = t(e);
              switch (r) {
                case 0:
                  var w = xe();
                  if (0 > w) break;
                  for (; xt[w]; ) w++;
                  return E(d, w).fd;
                case 1:
                case 2:
                  return 0;
                case 3:
                  return d.flags;
                case 4:
                  return w = xe(), d.flags |= w, 0;
                case 12:
                  return w = xe(), Ie[w + 0 >> 1] = 2, 0;
                case 13:
                case 14:
                  return 0;
              }
              return -28;
            } catch (N) {
              if (typeof P > "u" || N.name !== "ErrnoError") throw N;
              return -N.Pa;
            }
          },
          g: function(e, r) {
            try {
              var i = t(e), d = i.node, w = i.Ma.Ta;
              e = w ? i : d, w ??= d.La.Ta, o(w);
              var N = w(e);
              return F(r, N);
            } catch (W) {
              if (typeof P > "u" || W.name !== "ErrnoError") throw W;
              return -W.Pa;
            }
          },
          H: function(e, r) {
            r = -9007199254740992 > r || 9007199254740992 < r ? NaN : Number(r);
            try {
              if (isNaN(r)) return -61;
              var i = t(e);
              if (0 > r || (i.flags & 2097155) === 0) throw new J(28);
              return ue(i, i.node, r), 0;
            } catch (d) {
              if (typeof P > "u" || d.name !== "ErrnoError") throw d;
              return -d.Pa;
            }
          },
          G: function(e, r) {
            try {
              if (r === 0) return -28;
              var i = Nt("/") + 1;
              return r < i ? -68 : (wt("/", ee, e, r), i);
            } catch (d) {
              if (typeof P > "u" || d.name !== "ErrnoError") throw d;
              return -d.Pa;
            }
          },
          K: function(e, r) {
            try {
              return e = tt(e), F(r, ge(e, !0));
            } catch (i) {
              if (typeof P > "u" || i.name !== "ErrnoError") throw i;
              return -i.Pa;
            }
          },
          C: function(e, r, i) {
            try {
              return r = tt(r), r = B(e, r), re(r, i), 0;
            } catch (d) {
              if (typeof P > "u" || d.name !== "ErrnoError") throw d;
              return -d.Pa;
            }
          },
          J: function(e, r, i, d) {
            try {
              r = tt(r);
              var w = d & 256;
              return r = B(e, r, d & 4096), F(i, w ? ge(r, !0) : ge(r));
            } catch (N) {
              if (typeof P > "u" || N.name !== "ErrnoError") throw N;
              return -N.Pa;
            }
          },
          x: function(e, r, i, d) {
            K = d;
            try {
              r = tt(r), r = B(e, r);
              var w = d ? xe() : 0;
              return pe(r, i, w).fd;
            } catch (N) {
              if (typeof P > "u" || N.name !== "ErrnoError") throw N;
              return -N.Pa;
            }
          },
          v: function(e, r, i, d) {
            try {
              if (r = tt(r), r = B(e, r), 0 >= d) return -28;
              var w = ht(r).node;
              if (!w) throw new J(44);
              if (!w.La.readlink) throw new J(28);
              var N = w.La.readlink(w), W = Math.min(d, Nt(N)), Ne = H[i + W];
              return wt(
                N,
                ee,
                i,
                d + 1
              ), H[i + W] = Ne, W;
            } catch (Xe) {
              if (typeof P > "u" || Xe.name !== "ErrnoError") throw Xe;
              return -Xe.Pa;
            }
          },
          u: function(e) {
            try {
              return e = tt(e), Ce(e), 0;
            } catch (r) {
              if (typeof P > "u" || r.name !== "ErrnoError") throw r;
              return -r.Pa;
            }
          },
          f: function(e, r) {
            try {
              return e = tt(e), F(r, ge(e));
            } catch (i) {
              if (typeof P > "u" || i.name !== "ErrnoError") throw i;
              return -i.Pa;
            }
          },
          r: function(e, r, i) {
            try {
              if (r = tt(r), r = B(e, r), i) if (i === 512) Ce(r);
              else return -28;
              else Oe(r);
              return 0;
            } catch (d) {
              if (typeof P > "u" || d.name !== "ErrnoError") throw d;
              return -d.Pa;
            }
          },
          q: function(e, r, i) {
            try {
              r = tt(r), r = B(e, r, !0);
              var d = Date.now(), w, N;
              if (i) {
                var W = se[i >> 2] + 4294967296 * Se[i + 4 >> 2], Ne = Se[i + 8 >> 2];
                Ne == 1073741823 ? w = d : Ne == 1073741822 ? w = null : w = 1e3 * W + Ne / 1e6, i += 16, W = se[i >> 2] + 4294967296 * Se[i + 4 >> 2], Ne = Se[i + 8 >> 2], Ne == 1073741823 ? N = d : Ne == 1073741822 ? N = null : N = 1e3 * W + Ne / 1e6;
              } else N = w = d;
              if ((N ?? w) !== null) {
                e = w;
                var Xe = ht(r, { ab: !0 }).node;
                o(Xe.La.Ua)(Xe, { atime: e, mtime: N });
              }
              return 0;
            } catch (Pe) {
              if (typeof P > "u" || Pe.name !== "ErrnoError") throw Pe;
              return -Pe.Pa;
            }
          },
          m: () => _t(""),
          l: () => {
            Pt = !1, Ae = 0;
          },
          A: function(e, r) {
            e = -9007199254740992 > e || 9007199254740992 < e ? NaN : Number(e), e = new Date(1e3 * e), Se[r >> 2] = e.getSeconds(), Se[r + 4 >> 2] = e.getMinutes(), Se[r + 8 >> 2] = e.getHours(), Se[r + 12 >> 2] = e.getDate(), Se[r + 16 >> 2] = e.getMonth(), Se[r + 20 >> 2] = e.getFullYear() - 1900, Se[r + 24 >> 2] = e.getDay();
            var i = e.getFullYear();
            Se[r + 28 >> 2] = (i % 4 !== 0 || i % 100 === 0 && i % 400 !== 0 ? De : Le)[e.getMonth()] + e.getDate() - 1 | 0, Se[r + 36 >> 2] = -(60 * e.getTimezoneOffset()), i = new Date(e.getFullYear(), 6, 1).getTimezoneOffset();
            var d = new Date(e.getFullYear(), 0, 1).getTimezoneOffset();
            Se[r + 32 >> 2] = (i != d && e.getTimezoneOffset() == Math.min(d, i)) | 0;
          },
          y: function(e, r, i, d, w, N, W) {
            w = -9007199254740992 > w || 9007199254740992 < w ? NaN : Number(w);
            try {
              var Ne = t(d);
              if ((r & 2) !== 0 && (i & 2) === 0 && (Ne.flags & 2097155) !== 2) throw new J(2);
              if ((Ne.flags & 2097155) === 1) throw new J(2);
              if (!Ne.Ma.jb) throw new J(43);
              if (!e) throw new J(28);
              var Xe = Ne.Ma.jb(Ne, e, w, r, i), Pe = Xe.Xb;
              return Se[N >> 2] = Xe.Eb, se[W >> 2] = Pe, 0;
            } catch (nt) {
              if (typeof P > "u" || nt.name !== "ErrnoError") throw nt;
              return -nt.Pa;
            }
          },
          z: function(e, r, i, d, w, N) {
            N = -9007199254740992 > N || 9007199254740992 < N ? NaN : Number(N);
            try {
              var W = t(w);
              if (i & 2) {
                if (i = N, (W.node.mode & 61440) !== 32768) throw new J(43);
                if (!(d & 2)) {
                  var Ne = ee.slice(e, e + r);
                  W.Ma.kb && W.Ma.kb(W, Ne, i, r, d);
                }
              }
            } catch (Xe) {
              if (typeof P > "u" || Xe.name !== "ErrnoError") throw Xe;
              return -Xe.Pa;
            }
          },
          n: (e, r) => {
            if (y[e] && (clearTimeout(y[e].id), delete y[e]), !r) return 0;
            var i = setTimeout(() => {
              delete y[e], Ke(() => kn(e, performance.now()));
            }, r);
            return y[e] = { id: i, lc: r }, 0;
          },
          B: (e, r, i, d) => {
            var w = (/* @__PURE__ */ new Date()).getFullYear(), N = new Date(w, 0, 1).getTimezoneOffset();
            w = new Date(w, 6, 1).getTimezoneOffset(), se[e >> 2] = 60 * Math.max(N, w), Se[r >> 2] = +(N != w), r = (W) => {
              var Ne = Math.abs(W);
              return `UTC${0 <= W ? "-" : "+"}${String(Math.floor(Ne / 60)).padStart(2, "0")}${String(Ne % 60).padStart(2, "0")}`;
            }, e = r(N), r = r(w), w < N ? (wt(e, ee, i, 17), wt(r, ee, d, 17)) : (wt(e, ee, d, 17), wt(r, ee, i, 17));
          },
          d: () => Date.now(),
          s: () => 2147483648,
          c: () => performance.now(),
          o: (e) => {
            var r = ee.length;
            if (e >>>= 0, 2147483648 < e) return !1;
            for (var i = 1; 4 >= i; i *= 2) {
              var d = r * (1 + 0.2 / i);
              d = Math.min(d, e + 100663296);
              e: {
                d = (Math.min(2147483648, 65536 * Math.ceil(Math.max(
                  e,
                  d
                ) / 65536)) - qr.buffer.byteLength + 65535) / 65536 | 0;
                try {
                  qr.grow(d), at();
                  var w = 1;
                  break e;
                } catch {
                }
                w = void 0;
              }
              if (w) return !0;
            }
            return !1;
          },
          E: (e, r) => {
            var i = 0, d = 0, w;
            for (w of Me()) {
              var N = r + i;
              se[e + d >> 2] = N, i += wt(w, ee, N, 1 / 0) + 1, d += 4;
            }
            return 0;
          },
          F: (e, r) => {
            var i = Me();
            se[e >> 2] = i.length, e = 0;
            for (var d of i) e += Nt(d) + 1;
            return se[r >> 2] = e, 0;
          },
          e: function(e) {
            try {
              var r = t(e);
              return oe(r), 0;
            } catch (i) {
              if (typeof P > "u" || i.name !== "ErrnoError") throw i;
              return i.Pa;
            }
          },
          p: function(e, r) {
            try {
              var i = t(e);
              return H[r] = i.tty ? 2 : Qe(i.mode) ? 3 : (i.mode & 61440) === 40960 ? 7 : 4, Ie[r + 2 >> 1] = 0, Ye[r + 8 >> 3] = BigInt(0), Ye[r + 16 >> 3] = BigInt(0), 0;
            } catch (d) {
              if (typeof P > "u" || d.name !== "ErrnoError") throw d;
              return d.Pa;
            }
          },
          w: function(e, r, i, d) {
            try {
              e: {
                var w = t(e);
                e = r;
                for (var N, W = r = 0; W < i; W++) {
                  var Ne = se[e >> 2], Xe = se[e + 4 >> 2];
                  e += 8;
                  var Pe = he(w, H, Ne, Xe, N);
                  if (0 > Pe) {
                    var nt = -1;
                    break e;
                  }
                  if (r += Pe, Pe < Xe) break;
                  typeof N < "u" && (N += Pe);
                }
                nt = r;
              }
              return se[d >> 2] = nt, 0;
            } catch (vt) {
              if (typeof P > "u" || vt.name !== "ErrnoError") throw vt;
              return vt.Pa;
            }
          },
          D: function(e, r, i, d) {
            r = -9007199254740992 > r || 9007199254740992 < r ? NaN : Number(r);
            try {
              if (isNaN(r)) return 61;
              var w = t(e);
              return le(w, r, i), Ye[d >> 3] = BigInt(w.position), w.rb && r === 0 && i === 0 && (w.rb = null), 0;
            } catch (N) {
              if (typeof P > "u" || N.name !== "ErrnoError") throw N;
              return N.Pa;
            }
          },
          I: function(e) {
            try {
              var r = t(e);
              return r.Ma?.fsync?.(r);
            } catch (i) {
              if (typeof P > "u" || i.name !== "ErrnoError") throw i;
              return i.Pa;
            }
          },
          t: function(e, r, i, d) {
            try {
              e: {
                var w = t(e);
                e = r;
                for (var N, W = r = 0; W < i; W++) {
                  var Ne = se[e >> 2], Xe = se[e + 4 >> 2];
                  e += 8;
                  var Pe = ie(w, H, Ne, Xe, N);
                  if (0 > Pe) {
                    var nt = -1;
                    break e;
                  }
                  if (r += Pe, Pe < Xe) break;
                  typeof N < "u" && (N += Pe);
                }
                nt = r;
              }
              return se[d >> 2] = nt, 0;
            } catch (vt) {
              if (typeof P > "u" || vt.name !== "ErrnoError") throw vt;
              return vt.Pa;
            }
          },
          k: Re
        };
        function Jr() {
          function e() {
            if (u.calledRun = !0, !M) {
              if (!u.noFSInit && !Jt) {
                var r, i;
                Jt = !0, r ??= u.stdin, i ??= u.stdout, d ??= u.stderr, r ? C("stdin", r) : Ee("/dev/tty", "/dev/stdin"), i ? C("stdout", null, i) : Ee("/dev/tty", "/dev/stdout"), d ? C("stderr", null, d) : Ee("/dev/tty1", "/dev/stderr"), pe("/dev/stdin", 0), pe("/dev/stdout", 1), pe("/dev/stderr", 1);
              }
              if (Qr.N(), fr = !1, u.onRuntimeInitialized?.(), u.postRun) for (typeof u.postRun == "function" && (u.postRun = [u.postRun]); u.postRun.length; ) {
                var d = u.postRun.shift();
                yt.push(d);
              }
              Ue(yt);
            }
          }
          if (0 < At) Lt = Jr;
          else {
            if (u.preRun) for (typeof u.preRun == "function" && (u.preRun = [u.preRun]); u.preRun.length; ) Tr();
            Ue(yr), 0 < At ? Lt = Jr : u.setStatus ? (u.setStatus("Running..."), setTimeout(() => {
              setTimeout(() => u.setStatus(""), 1), e();
            }, 1)) : e();
          }
        }
        var Qr;
        return (async function() {
          function e(i) {
            return i = Qr = i.exports, u._sqlite3_free = i.P, u._sqlite3_value_text = i.Q, u._sqlite3_prepare_v2 = i.R, u._sqlite3_step = i.S, u._sqlite3_reset = i.T, u._sqlite3_exec = i.U, u._sqlite3_finalize = i.V, u._sqlite3_column_name = i.W, u._sqlite3_column_text = i.X, u._sqlite3_column_type = i.Y, u._sqlite3_errmsg = i.Z, u._sqlite3_clear_bindings = i._, u._sqlite3_value_blob = i.$, u._sqlite3_value_bytes = i.aa, u._sqlite3_value_double = i.ba, u._sqlite3_value_int = i.ca, u._sqlite3_value_type = i.da, u._sqlite3_result_blob = i.ea, u._sqlite3_result_double = i.fa, u._sqlite3_result_error = i.ga, u._sqlite3_result_int = i.ha, u._sqlite3_result_int64 = i.ia, u._sqlite3_result_null = i.ja, u._sqlite3_result_text = i.ka, u._sqlite3_aggregate_context = i.la, u._sqlite3_column_count = i.ma, u._sqlite3_data_count = i.na, u._sqlite3_column_blob = i.oa, u._sqlite3_column_bytes = i.pa, u._sqlite3_column_double = i.qa, u._sqlite3_bind_blob = i.ra, u._sqlite3_bind_double = i.sa, u._sqlite3_bind_int = i.ta, u._sqlite3_bind_text = i.ua, u._sqlite3_bind_parameter_index = i.va, u._sqlite3_sql = i.wa, u._sqlite3_normalized_sql = i.xa, u._sqlite3_changes = i.ya, u._sqlite3_close_v2 = i.za, u._sqlite3_create_function_v2 = i.Aa, u._sqlite3_update_hook = i.Ba, u._sqlite3_open = i.Ca, ct = u._malloc = i.Da, Ar = u._free = i.Ea, u._RegisterExtensionFunctions = i.Fa, Pn = i.Ga, kn = i.Ha, Fr = i.Ia, wr = i.Ja, jr = i.Ka, qr = i.M, cr = i.O, at(), At--, u.monitorRunDependencies?.(At), At == 0 && Lt && (i = Lt, Lt = null, i()), Qr;
          }
          At++, u.monitorRunDependencies?.(At);
          var r = { a: Gi };
          return u.instantiateWasm ? new Promise((i) => {
            u.instantiateWasm(r, (d, w) => {
              i(e(d));
            });
          }) : (Xt ??= u.locateFile ? u.locateFile("sql-wasm.wasm", Z) : Z + "sql-wasm.wasm", e((await It(r)).instance));
        })(), Jr(), _;
      }), a);
    };
    l.exports = c, l.exports.default = c;
  })(xn)), xn.exports;
}
var Ao = Oo();
const Co = /* @__PURE__ */ Rr(Ao), No = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL CHECK(type IN ('need', 'offer')),
  raw_text_encrypted   BLOB NOT NULL,
  raw_text_nonce       BLOB NOT NULL,
  embedding_encrypted  BLOB NOT NULL,
  embedding_nonce      BLOB NOT NULL,
  perturbed            BLOB,
  privacy_level        TEXT NOT NULL DEFAULT 'medium' CHECK(privacy_level IN ('low', 'medium', 'high')),
  epsilon              REAL,
  status               TEXT NOT NULL DEFAULT 'local' CHECK(status IN ('local', 'published', 'withdrawn')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id),
  partner_did  TEXT NOT NULL,
  similarity   REAL NOT NULL,
  relay_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'consented', 'confirmed', 'rejected', 'expired')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id                   TEXT PRIMARY KEY,
  match_id             TEXT NOT NULL REFERENCES matches(id),
  partner_did          TEXT NOT NULL,
  shared_key_encrypted BLOB,
  shared_key_nonce     BLOB,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'closed')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_matches_item_id ON matches(item_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
`;
function _n(l) {
  return new Uint8Array(l.buffer, l.byteOffset, l.byteLength);
}
function hi(l) {
  const n = new ArrayBuffer(l.byteLength);
  return new Uint8Array(n).set(l), new Float32Array(n);
}
function $r(l, n) {
  const a = Nn(l, n);
  return { encrypted: a.ciphertext, nonce: a.nonce };
}
function bn(l, n, a) {
  const c = Dn(l, n, a);
  if (!c) throw new Error("Decryption failed — wrong key or corrupted data");
  return c;
}
let wn = null;
function Do() {
  return wn || (wn = Co()), wn;
}
function Lo(l) {
  const n = l.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'");
  if (n.length === 0 || n[0].values.length === 0) {
    l.run(No), l.run("INSERT INTO schema_version (version) VALUES (?)", [1]);
    return;
  }
}
function zr(l, n, a = []) {
  const c = l.prepare(n);
  if (c.bind(a), !c.step())
    return c.free(), null;
  const p = c.getAsObject();
  return c.free(), p;
}
function di(l, n, a = []) {
  const c = l.prepare(n);
  c.bind(a);
  const p = [];
  for (; c.step(); )
    p.push(c.getAsObject());
  return c.free(), p;
}
async function Pi(l, n) {
  const a = await Do();
  let c;
  if (l === ":memory:")
    c = new a.Database();
  else if (jt(l)) {
    const u = Gt(l);
    c = new a.Database(u);
  } else
    c = new a.Database();
  c.run("PRAGMA foreign_keys = ON"), Lo(c);
  const p = n, b = l === ":memory:" ? null : l;
  function m() {
    if (!b) return;
    const u = c.export();
    ar(b, Buffer.from(u));
  }
  function _(u) {
    const O = bn(
      new Uint8Array(u.raw_text_encrypted),
      new Uint8Array(u.raw_text_nonce),
      p
    ), T = bn(
      new Uint8Array(u.embedding_encrypted),
      new Uint8Array(u.embedding_nonce),
      p
    );
    return {
      id: u.id,
      type: u.type,
      rawText: Cn(O),
      embedding: hi(T),
      perturbed: u.perturbed ? hi(new Uint8Array(u.perturbed)) : null,
      privacyLevel: u.privacy_level,
      epsilon: u.epsilon,
      status: u.status,
      createdAt: u.created_at,
      updatedAt: u.updated_at
    };
  }
  function g(u) {
    let O = null;
    return u.shared_key_encrypted && u.shared_key_nonce && (O = bn(
      new Uint8Array(u.shared_key_encrypted),
      new Uint8Array(u.shared_key_nonce),
      p
    )), {
      id: u.id,
      matchId: u.match_id,
      partnerDID: u.partner_did,
      sharedKey: O,
      status: u.status,
      createdAt: u.created_at
    };
  }
  return {
    insertItem(u) {
      const O = $r(Sr(u.rawText), p), T = $r(_n(u.embedding), p), A = u.perturbed ? _n(u.perturbed) : null;
      c.run(
        `INSERT INTO items (id, type, raw_text_encrypted, raw_text_nonce, embedding_encrypted, embedding_nonce, perturbed, privacy_level, epsilon, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          u.id,
          u.type,
          O.encrypted,
          O.nonce,
          T.encrypted,
          T.nonce,
          A,
          u.privacyLevel,
          u.epsilon ?? null,
          "local"
        ]
      ), m();
    },
    getItem(u) {
      const O = zr(c, "SELECT * FROM items WHERE id = ?", [u]);
      return O ? _(O) : null;
    },
    listItems(u) {
      let O = "SELECT * FROM items";
      const T = [], A = [];
      return u?.type && (T.push("type = ?"), A.push(u.type)), u?.status && (T.push("status = ?"), A.push(u.status)), T.length > 0 && (O += " WHERE " + T.join(" AND ")), O += " ORDER BY created_at DESC", di(c, O, A).map(_);
    },
    updateItemStatus(u, O) {
      c.run("UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?", [O, u]), m();
    },
    setPerturbed(u, O, T) {
      c.run(
        "UPDATE items SET perturbed = ?, epsilon = ?, updated_at = datetime('now') WHERE id = ?",
        [_n(O), T, u]
      ), m();
    },
    // --- Match methods ---
    insertMatch(u) {
      c.run(
        "INSERT INTO matches (id, item_id, partner_did, similarity, relay_id, status) VALUES (?, ?, ?, ?, ?, ?)",
        [u.id, u.itemId, u.partnerDID, u.similarity, u.relayId ?? null, "pending"]
      ), m();
    },
    getMatch(u) {
      const O = zr(c, "SELECT * FROM matches WHERE id = ?", [u]);
      return O ? {
        id: O.id,
        itemId: O.item_id,
        partnerDID: O.partner_did,
        similarity: O.similarity,
        relayId: O.relay_id,
        status: O.status,
        createdAt: O.created_at
      } : null;
    },
    listMatches(u) {
      let O = "SELECT * FROM matches";
      const T = [];
      return u?.status && (O += " WHERE status = ?", T.push(u.status)), O += " ORDER BY created_at DESC", di(c, O, T).map((A) => ({
        id: A.id,
        itemId: A.item_id,
        partnerDID: A.partner_did,
        similarity: A.similarity,
        relayId: A.relay_id,
        status: A.status,
        createdAt: A.created_at
      }));
    },
    updateMatchStatus(u, O) {
      c.run("UPDATE matches SET status = ? WHERE id = ?", [O, u]), m();
    },
    // --- Channel methods ---
    insertChannel(u) {
      let O = null, T = null;
      if (u.sharedKey) {
        const A = $r(u.sharedKey, p);
        O = A.encrypted, T = A.nonce;
      }
      c.run(
        "INSERT INTO channels (id, match_id, partner_did, shared_key_encrypted, shared_key_nonce, status) VALUES (?, ?, ?, ?, ?, ?)",
        [u.id, u.matchId, u.partnerDID, O, T, "pending"]
      ), m();
    },
    getChannel(u) {
      const O = zr(c, "SELECT * FROM channels WHERE id = ?", [u]);
      return O ? g(O) : null;
    },
    getChannelByMatchId(u) {
      const O = zr(c, "SELECT * FROM channels WHERE match_id = ?", [u]);
      return O ? g(O) : null;
    },
    updateChannelStatus(u, O) {
      c.run("UPDATE channels SET status = ? WHERE id = ?", [O, u]), m();
    },
    updateChannelSharedKey(u, O) {
      const T = $r(O, p);
      c.run(
        "UPDATE channels SET shared_key_encrypted = ?, shared_key_nonce = ? WHERE id = ?",
        [T.encrypted, T.nonce, u]
      ), m();
    },
    close() {
      m(), c.close();
    }
  };
}
const Mo = ".resonance", Ro = "resonance.db", Uo = "identity.json";
function kr() {
  return pt(Ps(), Mo);
}
function ki() {
  return pt(kr(), Ro);
}
function Po() {
  return pt(kr(), Uo);
}
function Ln() {
  Yr(kr(), { recursive: !0 });
}
function Bi(l) {
  const n = new TextEncoder().encode("resonance-store-key-v1"), a = new Uint8Array(l.secretKey.length + n.length);
  return a.set(l.secretKey), a.set(n, l.secretKey.length), Dt.hash(a).slice(0, Dt.secretbox.keyLength);
}
function Mn(l) {
  const n = Po();
  return {
    async create(a) {
      const c = Ni();
      return await this.save(c, a), c;
    },
    async load(a) {
      const c = Gt(n, "utf-8");
      return To(c, a);
    },
    async save(a, c) {
      Ln();
      const p = await So(a, c);
      ar(n, p, "utf-8");
    },
    exists() {
      return jt(n);
    }
  };
}
function Fi(l) {
  let n = null, a = !1, c = !1, p = 1e3, b = null, m = l.relayUrl;
  const _ = [l.relayUrl, ...l.fallbackUrls ?? []];
  let g = 0;
  const u = {}, O = /* @__PURE__ */ new Map();
  let T = null;
  function A() {
    !l.autoReconnect || c || (b = setTimeout(async () => {
      g = (g + 1) % _.length, m = _[g];
      try {
        await Z(m), p = 1e3, u.onReconnect?.();
      } catch {
        p = Math.min(p * 2, 3e4), A();
      }
    }, p));
  }
  function k(q, D) {
    if (!n || n.readyState !== si.OPEN) throw new Error("Not connected");
    const X = Yt(q, D, l.identity);
    n.send(Er(X));
  }
  function Y(q, D = 1e4) {
    return new Promise((X, V) => {
      const v = setTimeout(() => {
        O.delete(q), V(new Error(`Timeout waiting for ACK: ${q}`));
      }, D);
      O.set(q, { resolve: X, reject: V, timeout: v });
    });
  }
  function Q(q) {
    let D;
    try {
      D = Sn(q.toString("utf-8"));
    } catch {
      return;
    }
    switch (D.type) {
      case ke.ACK: {
        const X = D.payload, V = O.get(X.ref);
        V && (clearTimeout(V.timeout), O.delete(X.ref), V.resolve(X));
        break;
      }
      case ke.MATCH:
        u.onMatch?.(D.payload);
        break;
      case ke.CONSENT_FORWARD:
        u.onConsentForward?.(D.payload);
        break;
      case ke.CHANNEL_FORWARD:
        u.onChannelForward?.(D.payload);
        break;
      case ke.SEARCH_RESULTS:
        T && (T(D.payload), T = null);
        break;
    }
  }
  function Z(q) {
    return new Promise((D, X) => {
      n = new si(q), n.on("open", () => {
        k(ke.AUTH, {});
      }), n.on("message", (V) => {
        let v;
        try {
          v = Sn(V.toString("utf-8"));
        } catch {
          return;
        }
        if (v.type === ke.ACK && v.payload.ref === "auth") {
          const x = v.payload;
          x.status === "ok" ? (a = !0, c = !1, n.removeAllListeners("message"), n.on("message", Q), D()) : X(new Error(`Auth failed: ${x.message}`));
          return;
        }
      }), n.on("close", (V, v) => {
        a = !1, u.onDisconnect?.(v.toString() || `code:${V}`), A();
      }), n.on("error", (V) => {
        a || X(V);
      }), setTimeout(() => {
        a || X(new Error("Connection timeout"));
      }, 1e4);
    });
  }
  return {
    async connect() {
      c = !1;
      for (let q = 0; q < _.length; q++)
        try {
          m = _[q], await Z(m), g = q;
          return;
        } catch {
        }
      throw new Error("All relay URLs failed");
    },
    disconnect() {
      c = !0, b && (clearTimeout(b), b = null), n && (n.close(), n = null, a = !1);
    },
    async publish(q) {
      return k(ke.PUBLISH, q), Y(q.itemId);
    },
    search(q) {
      return new Promise((D, X) => {
        T = D, k(ke.SEARCH, q), Y("search").catch(() => {
        }), setTimeout(() => {
          T && (T = null, X(new Error("Search timeout")));
        }, 1e4);
      });
    },
    async sendConsent(q) {
      return k(ke.CONSENT, q), Y(q.matchId);
    },
    sendChannelMessage(q) {
      k(ke.CHANNEL_MESSAGE, q);
    },
    async withdraw(q) {
      return k(ke.WITHDRAW, q), Y(q.itemId);
    },
    isConnected() {
      return a;
    },
    on(q) {
      Object.assign(u, q);
    }
  };
}
function pi(l, n, a, c) {
  const p = JSON.stringify({
    ephemeralPublicKey: Ft(l),
    matchId: n,
    partnerDID: a
  }), b = Li(Sr(p), c.secretKey);
  return JSON.stringify({
    payload: p,
    signature: Ft(b),
    senderDID: c.did
  });
}
function ko(l, n) {
  const a = JSON.parse(l), { payload: c, signature: p, senderDID: b } = a, m = Di(b);
  if (!Mi(Sr(c), tr(p), m)) throw new Error("Invalid consent signature — possible MITM");
  const g = JSON.parse(c);
  if (g.matchId !== n) throw new Error("Consent matchId mismatch");
  return {
    ephemeralPublicKey: tr(g.ephemeralPublicKey),
    senderDID: b
  };
}
function Bo(l) {
  const { identity: n, store: a, relayClient: c } = l, p = l.confirmThreshold ?? Qs.confirmThreshold, b = /* @__PURE__ */ new Map(), m = /* @__PURE__ */ new Map(), _ = {};
  function g(T) {
    T.sharedSecret?.fill(0), T.myKeyPair?.secretKey.fill(0), T.myEmbedding = null, T.partnerEmbedding = null, b.delete(T.id);
  }
  function u(T, A, k) {
    if (!T.sharedSecret) throw new Error("No shared secret");
    const Y = JSON.stringify({ type: A, payload: k }), { nonce: Q, ciphertext: Z } = Nn(Sr(Y), T.sharedSecret);
    c.sendChannelMessage({
      matchId: T.matchId,
      encrypted: Ft(Z),
      nonce: Ft(Q)
    });
  }
  function O(T) {
    if (!T.myEmbedding || !T.partnerEmbedding) return;
    const A = ro(T.myEmbedding, T.partnerEmbedding), k = A >= p;
    T.similarity = A, T.confirmed = k, u(T, ke.CONFIRM_RESULT, { similarity: A, confirmed: k }), k ? (T.state = "active", a.updateChannelStatus(T.id, "active"), _.onConfirmResult?.(T.id, A, !0)) : (T.state = "closed", a.updateChannelStatus(T.id, "closed"), _.onConfirmResult?.(T.id, A, !1));
  }
  return {
    async initiateChannel(T, A) {
      const k = Kr(), Y = ci(), Q = {
        id: k,
        matchId: T,
        partnerDID: A,
        state: "handshaking",
        myKeyPair: Y,
        sharedSecret: null,
        similarity: null,
        confirmed: null,
        myEmbedding: null,
        partnerEmbedding: null
      };
      return b.set(k, Q), m.set(T, k), a.insertChannel({ id: k, matchId: T, partnerDID: A }), await c.sendConsent({
        matchId: T,
        accept: !0,
        encryptedForPartner: pi(Y.publicKey, T, A, n)
      }), a.updateMatchStatus(T, "consented"), k;
    },
    async handleConsentForward(T) {
      const { ephemeralPublicKey: A } = ko(
        T.encrypted,
        T.matchId
      ), k = m.get(T.matchId);
      if (k) {
        const Y = b.get(k);
        Y.sharedSecret = ui(Y.myKeyPair.secretKey, A), Y.state = "confirming", a.updateChannelSharedKey(Y.id, Y.sharedSecret), _.onChannelReady?.(Y.id, Y.matchId);
      } else {
        const Y = Kr(), Q = ci(), Z = ui(Q.secretKey, A), q = {
          id: Y,
          matchId: T.matchId,
          partnerDID: T.fromDID,
          state: "confirming",
          myKeyPair: Q,
          sharedSecret: Z,
          similarity: null,
          confirmed: null,
          myEmbedding: null,
          partnerEmbedding: null
        };
        b.set(Y, q), m.set(T.matchId, Y), a.insertChannel({ id: Y, matchId: T.matchId, partnerDID: T.fromDID, sharedKey: Z }), await c.sendConsent({
          matchId: T.matchId,
          accept: !0,
          encryptedForPartner: pi(Q.publicKey, T.matchId, T.fromDID, n)
        }), a.updateMatchStatus(T.matchId, "consented"), _.onChannelReady?.(Y, T.matchId);
      }
    },
    async handleChannelForward(T) {
      const A = m.get(T.matchId);
      if (!A) return;
      const k = b.get(A);
      if (!k?.sharedSecret) return;
      const Y = Dn(
        tr(T.encrypted),
        tr(T.nonce),
        k.sharedSecret
      );
      if (!Y) return;
      const Q = JSON.parse(Cn(Y));
      switch (Q.type) {
        case ke.CONFIRM_EMBEDDING: {
          const Z = Q.payload;
          k.partnerEmbedding = new Float32Array(Z.vector), O(k);
          break;
        }
        case ke.CONFIRM_RESULT: {
          const Z = Q.payload;
          k.confirmed === null && (k.similarity = Z.similarity, k.confirmed = Z.confirmed, Z.confirmed ? (k.state = "active", a.updateChannelStatus(k.id, "active")) : (k.state = "closed", a.updateChannelStatus(k.id, "closed")), _.onConfirmResult?.(k.id, Z.similarity, Z.confirmed));
          break;
        }
        case ke.DISCLOSURE: {
          const Z = Q.payload;
          _.onDisclosure?.(k.id, Z.text, Z.level);
          break;
        }
        case ke.ACCEPT: {
          const Z = Q.payload;
          _.onAccept?.(k.id, Z.message);
          break;
        }
        case ke.REJECT: {
          const Z = Q.payload;
          k.state = "closed", a.updateChannelStatus(k.id, "closed"), _.onReject?.(k.id, Z.reason), g(k);
          break;
        }
        case ke.CLOSE: {
          k.state = "closed", a.updateChannelStatus(k.id, "closed"), _.onClose?.(k.id), g(k);
          break;
        }
      }
    },
    async sendConfirmEmbedding(T, A) {
      const k = b.get(T);
      if (!k) throw new Error("Channel not found");
      k.myEmbedding = A, u(k, ke.CONFIRM_EMBEDDING, { vector: Array.from(A) });
    },
    async sendDisclosure(T, A, k) {
      const Y = b.get(T);
      if (!Y || Y.state !== "active") throw new Error("Channel not active");
      u(Y, ke.DISCLOSURE, { text: A, level: k });
    },
    async sendAccept(T, A) {
      const k = b.get(T);
      if (!k || k.state !== "active") throw new Error("Channel not active");
      u(k, ke.ACCEPT, { message: A });
    },
    async sendReject(T, A) {
      const k = b.get(T);
      if (!k) throw new Error("Channel not found");
      u(k, ke.REJECT, { reason: A }), k.state = "closed", a.updateChannelStatus(k.id, "closed"), g(k);
    },
    async sendClose(T) {
      const A = b.get(T);
      if (!A) throw new Error("Channel not found");
      u(A, ke.CLOSE, {}), A.state = "closed", a.updateChannelStatus(A.id, "closed"), g(A);
    },
    getChannel(T) {
      const A = b.get(T);
      return A ? {
        id: A.id,
        matchId: A.matchId,
        partnerDID: A.partnerDID,
        state: A.state,
        similarity: A.similarity,
        confirmed: A.confirmed
      } : null;
    },
    listChannels() {
      return Array.from(b.values()).map((T) => ({
        id: T.id,
        matchId: T.matchId,
        partnerDID: T.partnerDID,
        state: T.state,
        similarity: T.similarity,
        confirmed: T.confirmed
      }));
    },
    on(T) {
      Object.assign(_, T);
    }
  };
}
class mi {
  hashes = [];
  metadata = [];
  createdAt = [];
  addHash(n, a) {
    const c = this.hashes.length;
    return this.hashes.push(n), this.metadata.push(a), this.createdAt.push(Date.now()), c;
  }
  search(n, a, c) {
    const p = [];
    for (let b = 0; b < this.hashes.length; b++) {
      const m = jo(n, this.hashes[b]);
      m >= c && p.push({ id: b, similarity: m, metadata: this.metadata[b] });
    }
    return p.sort((b, m) => m.similarity - b.similarity), p.slice(0, a);
  }
  getMetadata(n) {
    return this.metadata[n];
  }
  /** Remove entries older than ttlMs. */
  expireOlderThan(n) {
    const a = Date.now() - n;
    let c = 0;
    for (let p = this.hashes.length - 1; p >= 0; p--)
      this.createdAt[p] < a && (this.hashes.splice(p, 1), this.metadata.splice(p, 1), this.createdAt.splice(p, 1), c++);
    return c;
  }
  getCount() {
    return this.hashes.length;
  }
  save(n, a) {
    Yr(n, { recursive: !0 });
    const c = {
      hashes: this.hashes.map((p) => Array.from(p)),
      metadata: this.metadata,
      createdAt: this.createdAt
    };
    ar(pt(n, `${a}-hamming.json`), JSON.stringify(c));
  }
  load(n, a) {
    const c = pt(n, `${a}-hamming.json`);
    if (!jt(c)) return;
    const p = JSON.parse(Gt(c, "utf-8"));
    this.hashes = p.hashes.map((b) => new Uint8Array(b)), this.metadata = p.metadata, this.createdAt = p.createdAt ?? p.hashes.map(() => Date.now());
  }
}
class Fo {
  needsIndex = new mi();
  offersIndex = new mi();
  addAndMatch(n, a, c = 10, p = 0.7) {
    if (a.itemType === "need") {
      const b = this.needsIndex.addHash(n, a), m = this.offersIndex.search(n, c, p);
      return { id: b, matches: m };
    } else {
      const b = this.offersIndex.addHash(n, a), m = this.needsIndex.search(n, c, p);
      return { id: b, matches: m };
    }
  }
  addHash(n, a) {
    return a.itemType === "need" ? this.needsIndex.addHash(n, a) : this.offersIndex.addHash(n, a);
  }
  search(n, a, c = 10, p = 0.7) {
    return a === "need" ? this.offersIndex.search(n, c, p) : this.needsIndex.search(n, c, p);
  }
  getMetadata(n, a) {
    return a === "need" ? this.needsIndex.getMetadata(n) : this.offersIndex.getMetadata(n);
  }
  getCount() {
    const n = this.needsIndex.getCount(), a = this.offersIndex.getCount();
    return { needs: n, offers: a, total: n + a };
  }
  /** Remove expired items from both indexes. */
  expireOlderThan(n) {
    return this.needsIndex.expireOlderThan(n) + this.offersIndex.expireOlderThan(n);
  }
  save(n) {
    this.needsIndex.save(n, "needs"), this.offersIndex.save(n, "offers");
  }
  load(n) {
    this.needsIndex.load(n, "needs"), this.offersIndex.load(n, "offers");
  }
}
function jo(l, n) {
  let a = 0;
  for (let c = 0; c < l.length; c++) {
    let p = l[c] ^ n[c];
    for (; p; )
      a += p & 1, p >>>= 1;
  }
  return 1 - a / (l.length * 8);
}
const qo = 0.7;
class Wo {
  index = new Fo();
  notifiedPairs = /* @__PURE__ */ new Set();
  withdrawnItems = /* @__PURE__ */ new Set();
  pendingNotifications = [];
  matchesToday = 0;
  matchesTodayDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  matchExpiryMs;
  matchThreshold;
  constructor(n) {
    this.matchExpiryMs = n?.matchExpiryMs ?? 10080 * 60 * 1e3, this.matchThreshold = n?.matchThreshold ?? qo;
  }
  initialize() {
  }
  /** Insert a hash and return match notifications for complementary items. */
  insertAndMatch(n, a, c = 10, p) {
    const b = p ?? this.matchThreshold, { matches: m } = this.index.addAndMatch(n, a, c, b), _ = [], g = Date.now();
    for (const u of m) {
      const O = u.metadata;
      if (!O || this.withdrawnItems.has(O.itemId)) continue;
      const T = [a.did, O.did].sort().join(":");
      if (this.notifiedPairs.has(T)) continue;
      this.notifiedPairs.add(T);
      const A = Kr();
      _.push({
        matchId: A,
        publisherDID: a.did,
        publisherItemId: a.itemId,
        publisherItemType: a.itemType,
        matchedDID: O.did,
        matchedItemId: O.itemId,
        matchedItemType: O.itemType,
        similarity: u.similarity,
        expiry: g + this.matchExpiryMs
      });
    }
    return this.updateDayCounter(_.length), this.pendingNotifications.push(..._), _;
  }
  /** Get pending notifications for a DID. */
  getPendingForDID(n) {
    const a = Date.now();
    return this.pendingNotifications.filter(
      (c) => (c.publisherDID === n || c.matchedDID === n) && c.expiry > a
    );
  }
  /** Remove a notification from the queue. */
  removeNotification(n, a) {
    this.pendingNotifications = this.pendingNotifications.filter(
      (c) => !(c.matchId === n && (c.publisherDID === a || c.matchedDID === a))
    );
  }
  /** Ephemeral search — does NOT index the query. */
  search(n, a, c = 10, p) {
    const b = p ?? this.matchThreshold, m = this.index.search(n, a, c, b), _ = [];
    for (const g of m)
      this.withdrawnItems.has(g.metadata.itemId) || _.push({
        did: g.metadata.did,
        similarity: g.similarity,
        itemType: g.metadata.itemType
      });
    return _;
  }
  /** Expire items older than ttlMs from the index. */
  expireItems(n) {
    return this.index.expireOlderThan(n);
  }
  /** Mark an item as withdrawn. */
  withdraw(n, a) {
    return this.withdrawnItems.add(a), !0;
  }
  /** Save index + state to disk. */
  save(n) {
    Yr(n, { recursive: !0 }), this.index.save(n), ar(pt(n, "dedup.json"), JSON.stringify(Array.from(this.notifiedPairs))), ar(pt(n, "withdrawn.json"), JSON.stringify(Array.from(this.withdrawnItems))), ar(pt(n, "stats.json"), JSON.stringify({
      matchesToday: this.matchesToday,
      matchesTodayDate: this.matchesTodayDate
    })), ar(pt(n, "queue.json"), JSON.stringify(this.pendingNotifications));
  }
  /** Load index + state from disk. */
  load(n) {
    this.index.load(n);
    const a = pt(n, "dedup.json");
    jt(a) && (this.notifiedPairs = new Set(JSON.parse(Gt(a, "utf-8"))));
    const c = pt(n, "withdrawn.json");
    jt(c) && (this.withdrawnItems = new Set(JSON.parse(Gt(c, "utf-8"))));
    const p = pt(n, "stats.json");
    if (jt(p)) {
      const m = JSON.parse(Gt(p, "utf-8"));
      this.matchesToday = m.matchesToday, this.matchesTodayDate = m.matchesTodayDate;
    }
    const b = pt(n, "queue.json");
    jt(b) && (this.pendingNotifications = JSON.parse(Gt(b, "utf-8")));
  }
  getStats() {
    const n = this.index.getCount();
    return this.resetDayCounterIfNeeded(), { ...n, matchesToday: this.matchesToday };
  }
  updateDayCounter(n) {
    this.resetDayCounterIfNeeded(), this.matchesToday += n;
  }
  resetDayCounterIfNeeded() {
    const n = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    n !== this.matchesTodayDate && (this.matchesToday = 0, this.matchesTodayDate = n);
  }
}
class $o {
  windows = /* @__PURE__ */ new Map();
  config;
  constructor(n) {
    this.config = {
      maxPublishesPerMin: n?.maxPublishesPerMin ?? 10,
      maxSearchesPerMin: n?.maxSearchesPerMin ?? 30,
      windowMs: n?.windowMs ?? 6e4
    };
  }
  /** Returns true if the action is allowed, false if rate limited. */
  check(n, a) {
    const c = Date.now();
    let p = this.windows.get(n);
    (!p || c - p.start > this.config.windowMs) && (p = { publish: 0, search: 0, start: c }, this.windows.set(n, p));
    const b = a === "publish" ? this.config.maxPublishesPerMin : this.config.maxSearchesPerMin;
    return p[a] >= b ? !1 : (p[a]++, !0);
  }
  /** Remove expired windows to prevent memory growth. */
  cleanup() {
    const n = Date.now();
    for (const [a, c] of this.windows)
      n - c.start > this.config.windowMs && this.windows.delete(a);
  }
}
function zo(l) {
  const n = {};
  for (const [a, c] of Object.entries(l))
    a === "vector" || a === "embedding" || a === "perturbed" || (n[a] = c);
  return n;
}
function Tt(l, n, a) {
  const c = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level: l,
    event: n,
    ...a ? zo(a) : {}
  };
  process.stdout.write(JSON.stringify(c) + `
`);
}
function pr(l, n, a, c, p) {
  const b = Yt(ke.ACK, { ref: a, status: c, message: p }, l.relayIdentity);
  n.send(Er(b));
}
function Lr(l, n, a) {
  const c = l.clients.get(n);
  c?.ws.readyState === 1 && c.ws.send(Er(a));
}
function Ho(l, n, a) {
  const { payload: c } = a;
  if (!l.rateLimiter.check(n.did, "publish")) {
    pr(l, n.ws, c.itemId, "error", "rate_limited");
    return;
  }
  const p = Uint8Array.from(Buffer.from(c.hash, "base64")), b = l.engine.insertAndMatch(
    p,
    { did: n.did, itemType: c.itemType, itemId: c.itemId },
    l.matchK,
    l.matchThreshold
  );
  for (const m of b) {
    l.matchRegistry.set(m.matchId, { publisherDID: m.publisherDID, matchedDID: m.matchedDID, createdAt: Date.now() });
    const _ = Yt(ke.MATCH, {
      matchId: m.matchId,
      partnerDID: m.matchedDID,
      similarity: m.similarity,
      yourItemId: m.publisherItemId,
      partnerItemType: m.matchedItemType,
      expiry: m.expiry
    }, l.relayIdentity);
    Lr(l, m.publisherDID, _);
    const g = Yt(ke.MATCH, {
      matchId: m.matchId,
      partnerDID: m.publisherDID,
      similarity: m.similarity,
      yourItemId: m.matchedItemId,
      partnerItemType: m.publisherItemType,
      expiry: m.expiry
    }, l.relayIdentity);
    Lr(l, m.matchedDID, g), Tt("info", "match", { matchId: m.matchId, similarity: m.similarity });
  }
  pr(l, n.ws, c.itemId, "ok"), Tt("info", "publish", { did: n.did, itemType: c.itemType, itemId: c.itemId });
}
function Ko(l, n, a) {
  const { payload: c } = a;
  if (!l.rateLimiter.check(n.did, "search")) {
    pr(l, n.ws, "search", "error", "rate_limited");
    return;
  }
  const p = Uint8Array.from(Buffer.from(c.hash, "base64")), b = l.engine.search(p, "need", c.k, c.threshold), m = Yt(ke.SEARCH_RESULTS, {
    results: b.map((_) => ({ did: _.did, similarity: _.similarity, itemType: _.itemType }))
  }, l.relayIdentity);
  Lr(l, n.did, m), pr(l, n.ws, "search", "ok"), Tt("info", "search", { did: n.did, resultCount: b.length });
}
function Go(l, n, a) {
  const { payload: c } = a, p = l.matchRegistry.get(c.matchId);
  if (!p) {
    pr(l, n.ws, c.matchId, "error", "unknown_match");
    return;
  }
  const b = n.did === p.publisherDID ? p.matchedDID : p.publisherDID, m = Yt(ke.CONSENT_FORWARD, {
    matchId: c.matchId,
    fromDID: n.did,
    encrypted: c.encryptedForPartner
  }, l.relayIdentity);
  Lr(l, b, m), pr(l, n.ws, c.matchId, "ok"), Tt("info", "consent", { matchId: c.matchId, from: n.did, accept: c.accept });
}
function Yo(l, n, a) {
  const { payload: c } = a;
  l.engine.withdraw(n.did, c.itemId), pr(l, n.ws, c.itemId, "ok"), Tt("info", "withdraw", { did: n.did, itemId: c.itemId });
}
function Vo(l, n, a) {
  const { payload: c } = a, p = l.matchRegistry.get(c.matchId);
  if (!p) {
    pr(l, n.ws, c.matchId, "error", "unknown_match");
    return;
  }
  const b = n.did === p.publisherDID ? p.matchedDID : p.publisherDID, m = Yt(ke.CHANNEL_FORWARD, {
    matchId: c.matchId,
    fromDID: n.did,
    encrypted: c.encrypted,
    nonce: c.nonce
  }, l.relayIdentity);
  Lr(l, b, m), Tt("info", "channel_forward", { matchId: c.matchId, from: n.did });
}
const Xo = {
  port: 9090,
  host: "0.0.0.0",
  persistDir: "./data",
  persistIntervalMs: 6e4,
  matchThreshold: 0.7,
  // Hamming similarity threshold for LSH matching
  matchK: 10,
  matchExpiryMs: 10080 * 60 * 1e3,
  maxPublishesPerMin: 10,
  maxSearchesPerMin: 30,
  authWindowMs: 3e4,
  adminApiKey: null,
  maxAuthAttemptsPerMin: 5
};
function Jo(l) {
  const n = { ...Xo, ...l }, a = new Wo({ matchExpiryMs: n.matchExpiryMs, matchThreshold: n.matchThreshold });
  a.initialize();
  const c = new $o({
    maxPublishesPerMin: n.maxPublishesPerMin,
    maxSearchesPerMin: n.maxSearchesPerMin
  }), p = pt(n.persistDir, "relay-identity.json");
  let b;
  if (Yr(n.persistDir, { recursive: !0 }), jt(p)) {
    const D = JSON.parse(Gt(p, "utf-8"));
    b = {
      publicKey: Uint8Array.from(Object.values(D.publicKey)),
      secretKey: Uint8Array.from(Object.values(D.secretKey)),
      did: D.did
    };
  } else
    b = Ni(), ar(p, JSON.stringify({
      publicKey: Array.from(b.publicKey),
      secretKey: Array.from(b.secretKey),
      did: b.did
    }));
  const m = /* @__PURE__ */ new Map(), _ = /* @__PURE__ */ new Map(), g = /* @__PURE__ */ new Map(), u = {
    engine: a,
    rateLimiter: c,
    clients: m,
    relayIdentity: b,
    matchThreshold: n.matchThreshold,
    matchK: n.matchK,
    matchRegistry: _
  };
  let O, T, A = null, k = null;
  const Y = Date.now();
  function Q() {
    try {
      a.save(n.persistDir), Tt("info", "persist", { dir: n.persistDir });
    } catch (D) {
      Tt("error", "persist_failed", { error: String(D) });
    }
  }
  function Z(D, X) {
    if (D.url === "/health" && D.method === "GET") {
      X.writeHead(200, { "Content-Type": "application/json" }), X.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (D.url?.startsWith("/stats") && D.method === "GET") {
      if (n.adminApiKey && new URL(D.url, "http://localhost").searchParams.get("key") !== n.adminApiKey) {
        X.writeHead(401, { "Content-Type": "application/json" }), X.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const V = a.getStats();
      X.writeHead(200, { "Content-Type": "application/json" }), X.end(JSON.stringify({
        indexed_embeddings: V.total,
        connected_nodes: m.size,
        matches_today: V.matchesToday,
        uptime: Math.floor((Date.now() - Y) / 1e3)
      }));
      return;
    }
    X.writeHead(404), X.end();
  }
  function q(D, X) {
    let V = null;
    const v = X?.socket?.remoteAddress ?? "unknown", x = Date.now();
    let M = g.get(v);
    if ((!M || x - M.start > 6e4) && (M = { count: 0, start: x }, g.set(v, M)), M.count++, M.count > n.maxAuthAttemptsPerMin) {
      D.close(4029, "too_many_auth_attempts");
      return;
    }
    const U = setTimeout(() => {
      V?.authenticated || D.close(4001, "auth_timeout");
    }, 1e4);
    D.on("message", (te) => {
      let H;
      try {
        H = te.toString("utf-8");
      } catch {
        D.close(4e3, "invalid_encoding");
        return;
      }
      let ee;
      try {
        ee = Sn(H);
      } catch {
        D.close(4e3, "invalid_message");
        return;
      }
      if (!Io(ee)) {
        D.close(4002, "invalid_signature");
        return;
      }
      if (ee.type === ke.AUTH) {
        if (clearTimeout(U), Math.abs(Date.now() - ee.timestamp) > n.authWindowMs) {
          const Ge = Yt(ke.ACK, {
            ref: "auth",
            status: "error",
            message: "stale_timestamp"
          }, b);
          D.send(Er(Ge)), D.close(4003, "stale_timestamp");
          return;
        }
        V = { did: ee.from, ws: D, authenticated: !0 }, m.set(ee.from, V);
        const Se = Yt(ke.ACK, {
          ref: "auth",
          status: "ok"
        }, b);
        D.send(Er(Se));
        const se = a.getPendingForDID(ee.from);
        for (const Ge of se) {
          const ae = Ge.publisherDID === ee.from, Ye = Yt(ke.MATCH, {
            matchId: Ge.matchId,
            partnerDID: ae ? Ge.matchedDID : Ge.publisherDID,
            similarity: Ge.similarity,
            yourItemId: ae ? Ge.publisherItemId : Ge.matchedItemId,
            partnerItemType: ae ? Ge.matchedItemType : Ge.publisherItemType,
            expiry: Ge.expiry
          }, b);
          D.send(Er(Ye)), a.removeNotification(Ge.matchId, ee.from);
        }
        se.length > 0 && Tt("info", "delivered_pending", { did: ee.from, count: se.length }), Tt("info", "auth", { did: ee.from });
        return;
      }
      if (!V?.authenticated) {
        D.close(4001, "not_authenticated");
        return;
      }
      if (ee.from !== V.did) {
        D.close(4002, "did_mismatch");
        return;
      }
      switch (ee.type) {
        case ke.PUBLISH:
          Ho(u, V, ee);
          break;
        case ke.SEARCH:
          Ko(u, V, ee);
          break;
        case ke.CONSENT:
          Go(u, V, ee);
          break;
        case ke.WITHDRAW:
          Yo(u, V, ee);
          break;
        case ke.CHANNEL_MESSAGE:
          Vo(u, V, ee);
          break;
        default: {
          const Ie = Yt(ke.ACK, {
            ref: ee.type,
            status: "error",
            message: "unknown_message_type"
          }, b);
          D.send(Er(Ie));
        }
      }
    }), D.on("close", () => {
      clearTimeout(U), V && (m.delete(V.did), Tt("info", "disconnect", { did: V.did }));
    }), D.on("error", (te) => {
      Tt("error", "ws_error", { error: String(te), did: V?.did });
    });
  }
  return {
    async start() {
      try {
        a.load(n.persistDir), Tt("info", "loaded", { dir: n.persistDir });
      } catch {
        Tt("info", "fresh_start", { dir: n.persistDir });
      }
      O = xi(Z), T = new Si({ server: O }), T.on("connection", q), await new Promise((D) => {
        O.listen(n.port, n.host, () => {
          Tt("info", "started", { port: n.port, host: n.host, did: b.did }), D();
        });
      }), A = setInterval(Q, n.persistIntervalMs), k = setInterval(() => {
        c.cleanup();
        const D = Date.now() - n.matchExpiryMs;
        for (const [V, v] of _)
          v.createdAt < D && _.delete(V);
        const X = Date.now() - 6e4;
        for (const [V, v] of g)
          v.start < X && g.delete(V);
        a.expireItems(n.matchExpiryMs);
      }, 5 * 6e4);
    },
    async stop() {
      A && clearInterval(A), k && clearInterval(k), Q();
      for (const [, D] of m)
        D.ws.close(1001, "server_shutdown");
      m.clear(), T?.close(), await new Promise((D) => {
        O?.close(() => D());
      }), Tt("info", "stopped");
    },
    getStats() {
      const D = a.getStats();
      return {
        indexed_embeddings: D.total,
        connected_nodes: m.size,
        matches_today: D.matchesToday,
        uptime: Math.floor((Date.now() - Y) / 1e3)
      };
    }
  };
}
const { HierarchicalNSW: Ma } = ks;
let ot = null, lr = {}, Vt = null;
function ji() {
  return pt(kr(), "relay-config.json");
}
function qi() {
  const l = ji();
  if (jt(l))
    try {
      return JSON.parse(Gt(l, "utf-8"));
    } catch {
    }
  return { enabled: !1, port: An };
}
function Wi(l) {
  Ln(), ar(ji(), JSON.stringify(l));
}
async function $i(l) {
  const n = l ?? An;
  if (Vt) return { port: n };
  const a = pt(kr(), "relay-data");
  if (Vt = Jo({
    port: n,
    host: "0.0.0.0",
    // Accept connections from other machines
    persistDir: a,
    maxAuthAttemptsPerMin: 20
  }), await Vt.start(), Wi({ enabled: !0, port: n }), ot) {
    ot.relayClient.disconnect();
    const c = Fi({
      relayUrl: `ws://localhost:${n}`,
      identity: ot.identity,
      fallbackUrls: Ii,
      autoReconnect: !0
    });
    try {
      await c.connect();
    } catch {
    }
    ot.relayClient = c, Rn(ot);
  }
  return { port: n };
}
async function Qo() {
  Vt && (await Vt.stop(), Vt = null, Wi({ enabled: !1, port: An }));
}
function yi() {
  return Vt !== null;
}
function Zo() {
  return Vt ? { enabled: !0, port: qi().port, stats: Vt.getStats() } : null;
}
function ur() {
  return ot;
}
function Tn() {
  return ot !== null;
}
function gn() {
  return Mn().exists();
}
function ea(l) {
  lr = l, ot && Rn(ot);
}
function Rn(l) {
  l.relayClient.on({
    onMatch(n) {
      l.store.insertMatch({
        id: n.matchId,
        itemId: n.yourItemId,
        partnerDID: n.partnerDID,
        similarity: n.similarity
      }), lr.onMatch?.(n.matchId, n.partnerDID, n.similarity, n.yourItemId);
    },
    onConsentForward(n) {
      l.channelMgr.handleConsentForward(n);
    },
    onChannelForward(n) {
      l.channelMgr.handleChannelForward(n);
    }
  }), l.channelMgr.on({
    onChannelReady(n, a) {
      const c = l.store.getMatch(a);
      if (c) {
        const p = l.store.getItem(c.itemId);
        p && l.channelMgr.sendConfirmEmbedding(n, p.embedding);
      }
      lr.onChannelReady?.(n, a);
    },
    onConfirmResult(n, a, c) {
      lr.onConfirmResult?.(n, a, c);
    },
    onDisclosure(n, a, c) {
      lr.onDisclosure?.(n, a, c);
    },
    onAccept(n, a) {
      lr.onAccept?.(n, a);
    },
    onReject(n, a) {
      lr.onReject?.(n, a);
    },
    onClose(n) {
      lr.onClose?.(n);
    }
  });
}
async function ta(l) {
  Ln();
  const a = await Mn().create(l);
  return await new Ti().initialize(), (await Pi(ki(), Bi(a))).close(), { did: a.did };
}
async function ra(l, n) {
  if (ot) return { did: ot.identity.did };
  const a = Mn(), c = await a.load(l), p = await Pi(ki(), Bi(c)), b = new Ti();
  await b.initialize();
  const m = qi();
  if (m.enabled && !Vt)
    try {
      await $i(m.port);
    } catch {
    }
  const _ = [];
  Vt && _.push(`ws://localhost:${m.port}`), n && n !== "ws://localhost:9090" && _.push(n), _.push(...Ii.filter((O) => !_.includes(O))), _.length === 0 && _.push(n);
  const g = Fi({
    relayUrl: _[0],
    identity: c,
    fallbackUrls: _.slice(1),
    autoReconnect: !0
  }), u = Bo({ identity: c, store: p, relayClient: g });
  try {
    await g.connect();
  } catch {
  }
  return ot = { identity: c, store: p, engine: b, relayClient: g, channelMgr: u, identityMgr: a }, Rn(ot), zi(), { did: c.did };
}
const na = 1800 * 1e3;
let Ir = null;
function zi() {
  Ir && clearTimeout(Ir), ot && (Ir = setTimeout(() => Un(), na));
}
function Un() {
  Ir && (clearTimeout(Ir), Ir = null), ot && (ot.identity.secretKey.fill(0), ot.relayClient.disconnect(), ot.store.close(), ot = null);
}
async function ia(l, n, a) {
  const c = ot, p = await c.engine.embedForMatching(l, n), b = Oi(p, Ai()), m = Kr(), { perturbed: _, epsilon: g } = fo(p, a);
  c.store.insertItem({ id: m, type: n, rawText: l, embedding: p, privacyLevel: a, perturbed: _, epsilon: g });
  let u = "local";
  if (c.relayClient.isConnected())
    try {
      await c.relayClient.publish({ itemId: m, hash: Ft(b), itemType: n, ttl: 604800 }), c.store.updateItemStatus(m, "published"), u = "published";
    } catch {
    }
  return { id: m, status: u, dims: p.length };
}
async function sa(l, n) {
  const a = ot, c = await a.engine.embedForMatching(l, n), p = Oi(c, Ai());
  return a.relayClient.isConnected() ? (await a.relayClient.search({ hash: Ft(p), k: 10, threshold: 0.65 })).results : [];
}
async function oa(l) {
  const n = ot, a = n.store.getMatch(l);
  if (!a) throw new Error("Match not found");
  return { channelId: await n.channelMgr.initiateChannel(l, a.partnerDID) };
}
const Hi = "http://127.0.0.1", aa = 1024 * 1024;
let Gr = null;
function dt(l, n, a = 200) {
  l.writeHead(a, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": Hi
  }), l.end(JSON.stringify(n));
}
function ut(l, n, a = 400) {
  dt(l, { error: n }, a);
}
async function vr(l) {
  return new Promise((n, a) => {
    let c = "", p = 0;
    l.on("data", (b) => {
      if (p += b.length, p > aa) {
        l.destroy(), a(new Error("Body too large"));
        return;
      }
      c += b.toString();
    }), l.on("end", () => {
      try {
        n(JSON.parse(c));
      } catch {
        n({});
      }
    }), l.on("error", () => n({}));
  });
}
function er(l) {
  return Tn() ? !0 : (ut(l, "Session locked. POST /api/unlock first.", 401), !1);
}
async function fa(l, n, a) {
  const c = l.url ?? "", p = l.method ?? "GET";
  if (Tn() && zi(), p === "OPTIONS")
    return n.writeHead(204, {
      "Access-Control-Allow-Origin": Hi,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }), n.end(), !0;
  if (c === "/api/status" && p === "GET") {
    const m = gn(), _ = Tn(), g = ur();
    return dt(n, {
      initialized: m,
      unlocked: _,
      did: g?.identity.did ?? null,
      relayConnected: g?.relayClient.isConnected() ?? !1,
      relayMode: yi(),
      items: g ? g.store.listItems().length : 0,
      matches: g ? g.store.listMatches().length : 0
    }), !0;
  }
  if (c === "/api/init" && p === "POST") {
    if (gn())
      return ut(n, "Already initialized"), !0;
    const _ = (await vr(l)).password;
    if (!_)
      return ut(n, "Password required"), !0;
    try {
      const g = await ta(_);
      dt(n, g);
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  if (c === "/api/unlock" && p === "POST") {
    if (!gn())
      return ut(n, "Not initialized. POST /api/init first."), !0;
    const _ = (await vr(l)).password;
    if (!_)
      return ut(n, "Password required"), !0;
    try {
      const g = await ra(_, a);
      Gr = Us(32).toString("hex"), dt(n, { ...g, token: Gr });
    } catch {
      ut(n, "Wrong password or corrupted identity", 401);
    }
    return !0;
  }
  if (c === "/api/lock" && p === "POST")
    return Un(), dt(n, { locked: !0 }), !0;
  if (c === "/api/items" && p === "GET") {
    if (!er(n)) return !0;
    const m = ur().store.listItems();
    return dt(n, m.map((_) => ({
      id: _.id,
      type: _.type,
      rawText: _.rawText,
      privacyLevel: _.privacyLevel,
      epsilon: _.epsilon,
      status: _.status,
      createdAt: _.createdAt
    }))), !0;
  }
  if (c === "/api/items" && p === "POST") {
    if (!er(n)) return !0;
    const m = await vr(l), _ = m.text, g = m.type ?? "need", u = m.privacy ?? "medium";
    if (!_)
      return ut(n, "Text required"), !0;
    if (!["need", "offer"].includes(g))
      return ut(n, "Type must be need or offer"), !0;
    if (!["low", "medium", "high"].includes(u))
      return ut(n, "Privacy must be low, medium, or high"), !0;
    try {
      const O = await ia(_, g, u);
      dt(n, O);
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  if (c.startsWith("/api/items/") && p === "DELETE") {
    if (!er(n)) return !0;
    const m = c.slice(11), _ = ur();
    if (_.store.updateItemStatus(m, "withdrawn"), _.relayClient.isConnected())
      try {
        await _.relayClient.withdraw({ itemId: m });
      } catch {
      }
    return dt(n, { withdrawn: !0 }), !0;
  }
  if (c === "/api/matches" && p === "GET") {
    if (!er(n)) return !0;
    const m = ur().store.listMatches();
    return dt(n, m), !0;
  }
  if (c === "/api/search" && p === "POST") {
    if (!er(n)) return !0;
    const m = await vr(l), _ = m.text, g = m.type ?? "need";
    if (!_)
      return ut(n, "Text required"), !0;
    try {
      const u = await sa(_, g);
      dt(n, { results: u });
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  if (c === "/api/channels" && p === "GET") {
    if (!er(n)) return !0;
    const m = ur().channelMgr.listChannels();
    return dt(n, m), !0;
  }
  if (c === "/api/channels" && p === "POST") {
    if (!er(n)) return !0;
    const _ = (await vr(l)).matchId;
    if (!_)
      return ut(n, "matchId required"), !0;
    try {
      const g = await oa(_);
      dt(n, g);
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  const b = c.match(/^\/api\/channels\/([^/]+)\/(\w+)$/);
  if (b && p === "POST") {
    if (!er(n)) return !0;
    const [, m, _] = b, g = ur(), u = await vr(l);
    try {
      switch (_) {
        case "disclose":
          await g.channelMgr.sendDisclosure(m, u.text, u.level), dt(n, { sent: !0 });
          break;
        case "accept":
          await g.channelMgr.sendAccept(m, u.message), dt(n, { accepted: !0 });
          break;
        case "reject":
          await g.channelMgr.sendReject(m, u.reason), dt(n, { rejected: !0 });
          break;
        default:
          ut(n, "Unknown action", 404);
      }
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  if (c.match(/^\/api\/channels\/[^/]+$/) && p === "DELETE") {
    if (!er(n)) return !0;
    const m = c.slice(14);
    try {
      await ur().channelMgr.sendClose(m), dt(n, { closed: !0 });
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  if (c.match(/^\/api\/channels\/[^/]+$/) && p === "GET") {
    if (!er(n)) return !0;
    const m = c.slice(14), _ = ur().channelMgr.getChannel(m);
    return _ ? (dt(n, _), !0) : (ut(n, "Channel not found", 404), !0);
  }
  if (c === "/api/relay/status" && p === "GET") {
    const m = Zo();
    return dt(n, { enabled: yi(), ...m ?? { port: null, stats: null } }), !0;
  }
  if (c === "/api/relay/start" && p === "POST") {
    const _ = (await vr(l)).port;
    try {
      const g = await $i(_);
      dt(n, g);
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  if (c === "/api/relay/stop" && p === "POST") {
    try {
      await Qo(), dt(n, { stopped: !0 });
    } catch {
      ut(n, "Internal error", 500);
    }
    return !0;
  }
  return !1;
}
function ca() {
  try {
    const l = Is(new URL(import.meta.url).pathname), n = En(l, "../../dist");
    return jt(n) ? n : pt(l, "../ui");
  } catch {
    return pt(__dirname, "../../dist");
  }
}
const vn = ca(), ua = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
function la(l) {
  const { port: n, relayUrl: a } = l;
  let c, p;
  const b = /* @__PURE__ */ new Set();
  function m(_) {
    const g = JSON.stringify(_);
    for (const u of b)
      u.readyState === 1 && u.send(g);
  }
  return ea({
    onMatch(_, g, u, O) {
      m({ type: "match", matchId: _, partnerDID: g, similarity: u, yourItemId: O });
    },
    onChannelReady(_, g) {
      m({ type: "channel_ready", channelId: _, matchId: g });
    },
    onConfirmResult(_, g, u) {
      m({ type: "confirm_result", channelId: _, similarity: g, confirmed: u });
    },
    onDisclosure(_, g, u) {
      m({ type: "disclosure", channelId: _, text: g, level: u });
    },
    onAccept(_, g) {
      m({ type: "accept", channelId: _, message: g });
    },
    onReject(_, g) {
      m({ type: "reject", channelId: _, reason: g });
    },
    onClose(_) {
      m({ type: "close", channelId: _ });
    }
  }), {
    async start() {
      c = xi(async (_, g) => {
        const u = _.url ?? "/";
        if (u.startsWith("/api/")) {
          await fa(_, g, a) || (g.writeHead(404, { "Content-Type": "application/json" }), g.end(JSON.stringify({ error: "Not found" })));
          return;
        }
        const T = En(pt(vn, u === "/" ? "/index.html" : u));
        if (!T.startsWith(En(vn)) || !jt(T)) {
          const Y = pt(vn, "index.html");
          jt(Y) ? (g.writeHead(200, { "Content-Type": "text/html" }), g.end(Gt(Y))) : (g.writeHead(404), g.end("Not found"));
          return;
        }
        const A = Os(T), k = ua[A] || "application/octet-stream";
        g.writeHead(200, { "Content-Type": k }), g.end(Gt(T));
      }), p = new Si({ server: c, path: "/api/events" }), p.on("connection", (_, g) => {
        const O = new URL(g.url ?? "", `http://${g.headers.host}`).searchParams.get("token");
        if (!Gr || O !== Gr) {
          _.close(4001, "unauthorized");
          return;
        }
        b.add(_), _.on("close", () => b.delete(_));
      }), await new Promise((_) => {
        c.listen(n, "127.0.0.1", () => _());
      });
    },
    async stop() {
      for (const _ of b) _.close();
      b.clear(), p?.close(), await new Promise((_) => {
        c?.close(() => _());
      });
    }
  };
}
const Ki = 3e3, ha = "ws://localhost:9091";
let hr = null, Dr = null;
async function da() {
  await la({ port: Ki, relayUrl: ha }).start();
}
function pa() {
  hr = new gs({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: "Resonance",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#08080d",
    webPreferences: {
      nodeIntegration: !1,
      contextIsolation: !0
    }
  }), process.env.VITE_DEV_SERVER_URL ? hr.loadURL(process.env.VITE_DEV_SERVER_URL) : hr.loadURL(`http://localhost:${Ki}`), hr.on("close", (l) => {
    dr.isQuitting || (l.preventDefault(), hr?.hide());
  });
}
function ma() {
  const l = vs.createEmpty();
  Dr = new Es(l), Dr.setTitle("R"), Dr.setToolTip("Resonance");
  const n = Ss.buildFromTemplate([
    { label: "Show Resonance", click: () => hr?.show() },
    { type: "separator" },
    { label: "Quit", click: () => {
      dr.isQuitting = !0, dr.quit();
    } }
  ]);
  Dr.setContextMenu(n), Dr.on("click", () => hr?.show());
}
dr.whenReady().then(async () => {
  await da(), pa(), ma();
});
dr.on("activate", () => {
  hr?.show();
});
dr.on("before-quit", () => {
  Un();
});
dr.on("window-all-closed", () => {
  process.platform !== "darwin" && dr.quit();
});
export {
  ho as c,
  Rr as g
};
