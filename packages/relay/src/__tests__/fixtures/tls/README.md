# Public TLS test fixtures

These keys are deliberately public test material. Never use them in a deployed
relay, install this authority in a user trust store, or ship its private leaf keys
as application credentials. The authority private key was used only during
fixture generation and is not retained here.

The CA signs two different localhost certificate/key pairs, plus wrong-host,
expired (2000–2001) and future (2090–2091) leaf certificates. The latter three use
`localhost.key`. The ordinary leaf covers localhost, IPv4 127.0.0.1 and IPv6 ::1;
it and the renewal are valid until 2090/2091. All are P-256 keys generated with
OpenSSL 3.6.3 for these local tests.

The tests start a separate Node process with only this additional CA supplied
through `NODE_EXTRA_CA_CERTS`. They never disable certificate verification. The
pre-existing self-signed `../localhost-test.crt` supplies the untrusted case.
This validates real local TLS behavior, not external certificate issuance,
automatic renewal, firewall/NAT access or independent volunteer connectivity.
