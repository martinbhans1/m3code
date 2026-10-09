# Durable phone pairing

New manual phone pairings use durable device authorization when the backend advertises `durableDeviceAuthorization`. Older backends retain the existing pairing behavior. Existing saved credentials are not reset or silently promoted: pair once after installing the updated backend and mobile client to enroll the device.

The pairing code remains single-use and expires after five minutes. The resulting device authorization lasts until logout, administrative revocation, or detected refresh reuse. Its access credentials expire after 15 minutes. Refresh credentials rotate at every renewal and are never accepted as HTTP or WebSocket access credentials.

Renewal requires a fresh DPoP proof from the original P-256 device key, including the refresh credential hash, request method and endpoint. The existing DPoP replay store rejects reused proofs. SQLite stores only refresh hashes; a server-held rotation key derives the next credential for idempotent retries. Retrying the same persisted operation with a new proof returns the same next refresh credential while it is current. A different operation using a consumed credential, or reuse after another rotation, revokes that device's entire family. Invalid proofs and wrong device keys cannot revoke a legitimate device.

Rotation and access issuance share a database transaction and stable session ID. Renewal reads the original session scopes and cannot request more privilege. Existing client revocation, logout and revoke-other-clients invalidate both access and refresh. Other devices and provider sessions are unaffected.

The phone stores the device key and connection credentials in SecureStore. It persists the refresh operation ID before transmission, coalesces concurrent renewal, and stores the rotated credential before using it. Connection writes are serialized so simultaneous updates for different environments do not discard a refresh credential. Active connections renew before access expiry; reconnect and app resume also renew. Failed renewal is shown without credential-bearing request errors. Removing a durable environment requires successful server revocation; if unreachable, the app retains the connection and asks the user to reconnect and retry removal.

The access credential remains a short-lived bearer credential for compatibility with the phone's attachment, favicon and existing HTTP flows. Device-key binding applies to renewal. Managed cloud connections retain their existing DPoP and account behavior. Browser cookie sessions and desktop SSH connections retain their existing lifecycles.

Migration 043 adds only authorization and refresh-history tables. It does not modify existing sessions. No migration has been applied to the running application by this change.

Verification uses synthetic credentials, in-memory SQLite, virtual time and the isolated HTTP test server. It covers access expiry, renewal after 60 days, rotation, retry after a lost response, concurrent refresh, wrong-key rejection, proof replay, consumed-credential replay, least privilege, logout and administrative revocation.
